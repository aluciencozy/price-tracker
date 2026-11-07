import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import mongoose from 'mongoose';
import { z, ZodError } from 'zod';
import { updateOwnedTrackerSettings } from './alertEpisodes.js';
import { publicProduct } from './history.js';
import { ProductModel, type ProductRecord } from './models/product.js';
import { NotificationDeliveryModel, TrackedItemModel } from './models/tracking.js';
import { ProductPreviewModel, TrackingIdempotencyModel } from './models/trackingApi.js';
import { notFound, TrackingError, validationError } from './trackingErrors.js';

const DAY = 86_400_000;
const PAGE_DEFAULT = 20;
const idPattern = /^[a-f0-9]{24}$/;
const moneySchema = z.strictObject({
  amountMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  currency: z.literal('USD'),
});
const alertsSchema = z.strictObject({ email: z.boolean(), push: z.boolean() });
const createSchema = z.strictObject({
  previewId: z.string().regex(idPattern),
  targetPrice: moneySchema,
  enabled: z.boolean(),
  alerts: alertsSchema,
});
const querySchema = z.strictObject({
  q: z.string().trim().min(1).max(100).optional(),
  limit: z.string().regex(/^(?:[1-9]|[1-9][0-9]|100)$/).optional(),
  cursor: z.string().min(1).max(2048).optional(),
});
const cursorSchema = z.strictObject({
  version: z.literal(1),
  userId: z.string().regex(idPattern),
  q: z.string().nullable(),
  createdAt: z.iso.datetime(),
  id: z.string().regex(idPattern),
});

type Clock = () => Date;
type ProductDoc = ProductRecord & { _id: mongoose.Types.ObjectId };
type TrackerDocument = {
  _id: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  productId: mongoose.Types.ObjectId;
  targetPriceMinor: number;
  currency: 'USD';
  enabled: boolean;
  alerts: { email: boolean; push: boolean };
  createdAt: Date;
  updatedAt: Date;
};

function safeId(value: unknown): string {
  if (typeof value !== 'string' || !idPattern.test(value)) throw notFound();
  return value;
}

function ownerId(value: string): mongoose.Types.ObjectId {
  if (!idPattern.test(value)) throw new TrackingError(401, 'AUTH_REQUIRED', 'Sign in to manage tracked items.');
  return new mongoose.Types.ObjectId(value);
}

function publicTracker(tracker: TrackerDocument, product: ProductDoc, now: Date) {
  return {
    id: String(tracker._id),
    product: publicProduct(product, now),
    targetPrice: { amountMinor: tracker.targetPriceMinor, currency: tracker.currency },
    enabled: tracker.enabled,
    alerts: { email: tracker.alerts.email, push: tracker.alerts.push },
    createdAt: tracker.createdAt.toISOString(),
    updatedAt: tracker.updatedAt.toISOString(),
  };
}

function objectProduct(value: unknown): ProductDoc {
  if (!value || typeof value !== 'object' || !('_id' in value) || !(value._id instanceof mongoose.Types.ObjectId)) {
    throw new TrackingError(503, 'SERVICE_UNAVAILABLE', 'The shared product is temporarily unavailable.');
  }
  return value as ProductDoc;
}

function makeCursor(secret: string) {
  if (Buffer.byteLength(secret) < 32) throw new Error('Tracking cursor signing secret must contain at least 32 bytes.');
  const sign = (body: string) => createHmac('sha256', secret).update(body).digest();
  const encode = (value: z.infer<typeof cursorSchema>) => {
    const body = Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${body}.${sign(body).toString('base64url')}`;
  };
  const decode = (token: string) => {
    try {
      if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw new Error('Bad token.');
      const [body, signature] = token.split('.');
      const actual = Buffer.from(signature!, 'base64url');
      const expected = sign(body!);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('Bad signature.');
      return cursorSchema.parse(JSON.parse(Buffer.from(body!, 'base64url').toString('utf8')));
    } catch {
      throw new TrackingError(422, 'INVALID_CURSOR', 'The list cursor is invalid for this request.');
    }
  };
  return { encode, decode };
}

function requestHash(value: z.infer<typeof createSchema>): string {
  // Build in a fixed order so key-order changes do not change the normalized request.
  const normalized = {
    previewId: value.previewId,
    targetPrice: { amountMinor: value.targetPrice.amountMinor, currency: value.targetPrice.currency },
    enabled: value.enabled,
    alerts: { email: value.alerts.email, push: value.alerts.push },
  };
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function normalizedIdempotencyKey(value: string | undefined): string {
  if (!value || !z.uuid().safeParse(value).success) {
    throw new TrackingError(422, 'VALIDATION_ERROR', 'A UUID Idempotency-Key is required.', [
      { path: '/headers/Idempotency-Key', code: 'invalid_format', message: 'Send a UUID Idempotency-Key.' },
    ]);
  }
  return value.toLowerCase();
}

function isDuplicateKey(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;
}

function asKnownUpdateError(error: unknown, input: unknown): never {
  if (error instanceof TrackingError) throw error;
  if (error instanceof ZodError) throw validationError(error, input);
  if (error instanceof Error && error.message.toLowerCase().includes('not found')) throw notFound();
  throw error;
}

export function createTrackedItemService(signingSecret: string, options: { now?: Clock } = {}) {
  const cursor = makeCursor(signingSecret);
  const now = options.now ?? (() => new Date());

  async function findOwnedItem(user: mongoose.Types.ObjectId, id: string, session?: mongoose.ClientSession) {
    const query = TrackedItemModel.findOne({ _id: id, userId: user });
    if (session) query.session(session);
    const tracker = await query.lean().exec();
    if (!tracker) throw notFound();
    const productQuery = ProductModel.findById(tracker.productId);
    if (session) productQuery.session(session);
    const product = await productQuery.lean().exec();
    if (!product) throw new TrackingError(503, 'SERVICE_UNAVAILABLE', 'The shared product is temporarily unavailable.');
    return { tracker: tracker as unknown as TrackerDocument, product: objectProduct(product) };
  }

  async function readOwnedItem(userId: string, trackerId: unknown) {
    const user = ownerId(userId);
    const id = safeId(trackerId);
    const { tracker, product } = await findOwnedItem(user, id);
    return publicTracker(tracker, product, now());
  }

  async function listOwnedItems(userId: string, rawQuery: unknown) {
    const user = ownerId(userId);
    const parsed = querySchema.safeParse(rawQuery);
    if (!parsed.success) throw validationError(parsed.error, rawQuery);
    const { q = null, cursor: rawCursor, limit: rawLimit } = parsed.data;
    const limit = Number(rawLimit ?? PAGE_DEFAULT);
    const position = rawCursor ? cursor.decode(rawCursor) : null;
    if (position && (position.userId !== String(user) || position.q !== q)) {
      throw new TrackingError(422, 'INVALID_CURSOR', 'The list cursor is invalid for this request.');
    }

    const titleFilter = q === null ? null : new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const productIds = titleFilter === null
      ? null
      : await ProductModel.find({ title: titleFilter }).distinct('_id').exec();
    const conditions: Record<string, unknown>[] = [{ userId: user }];
    if (productIds !== null) {
      if (productIds.length === 0) return { items: [], page: { limit, nextCursor: null } };
      conditions.push({ productId: { $in: productIds } });
    }
    if (position) {
      const createdAt = new Date(position.createdAt);
      conditions.push({ $or: [
        { createdAt: { $lt: createdAt } },
        { createdAt, _id: { $lt: new mongoose.Types.ObjectId(position.id) } },
      ] });
    }
    const rows = await TrackedItemModel.find({ $and: conditions })
      .sort({ createdAt: -1, _id: -1 }).limit(limit + 1).lean().exec();
    const items = rows.slice(0, limit) as unknown as TrackerDocument[];
    const products = await ProductModel.find({ _id: { $in: items.map(item => item.productId) } }).lean().exec();
    const byId = new Map(products.map(product => [String(product._id), objectProduct(product)]));
    const at = now();
    const mapped = items.map(item => {
      const product = byId.get(String(item.productId));
      if (!product) throw new TrackingError(503, 'SERVICE_UNAVAILABLE', 'The shared product is temporarily unavailable.');
      return publicTracker(item, product, at);
    });
    const last = items.at(-1);
    return {
      items: mapped,
      page: { limit, nextCursor: rows.length > limit && last ? cursor.encode({
        version: 1, userId: String(user), q, createdAt: last.createdAt.toISOString(), id: String(last._id),
      }) : null },
    };
  }

  async function createOwnedItem(userId: string, rawBody: unknown, rawKey: string | undefined) {
    const user = ownerId(userId);
    const parsed = createSchema.safeParse(rawBody);
    if (!parsed.success) throw validationError(parsed.error, rawBody);
    const input = parsed.data;
    const key = normalizedIdempotencyKey(rawKey);
    const hash = requestHash(input);
    const at = now();

    async function replayIfPresent() {
      const existing = await TrackingIdempotencyModel.findOne({ userId: user, key, expiresAt: { $gt: at } }).lean().exec();
      if (!existing) return null;
      if (existing.requestHash !== hash) throw new TrackingError(409, 'IDEMPOTENCY_CONFLICT', 'This Idempotency-Key was used for a different request.');
      return { status: 201 as const, body: existing.response, location: existing.location };
    }

    const replay = await replayIfPresent();
    if (replay) return replay;

    try {
      return await mongoose.connection.transaction(async session => {
        const existing = await TrackingIdempotencyModel.findOne({ userId: user, key, expiresAt: { $gt: at } }).session(session).lean().exec();
        if (existing) {
          if (existing.requestHash !== hash) throw new TrackingError(409, 'IDEMPOTENCY_CONFLICT', 'This Idempotency-Key was used for a different request.');
          return { status: 201 as const, body: existing.response, location: existing.location };
        }
        await TrackingIdempotencyModel.deleteOne({ userId: user, key, expiresAt: { $lte: at } }).session(session).exec();
        const [idempotency] = await TrackingIdempotencyModel.create([{
          userId: user, key, requestHash: hash,
          response: { pending: true }, location: '/api/tracked-items/pending', expiresAt: new Date(at.getTime() + DAY),
        }], { session });

        const preview = await ProductPreviewModel.findOne({ _id: input.previewId, userId: user }).session(session).lean().exec();
        if (!preview) throw new TrackingError(404, 'NOT_FOUND', 'Product preview not found.');
        if (preview.expiresAt.getTime() <= at.getTime()) throw new TrackingError(410, 'PREVIEW_EXPIRED', 'The product preview has expired.');

        const duplicate = await TrackedItemModel.findOne({ userId: user, productId: preview.productId }).session(session).lean().exec();
        if (duplicate) throw new TrackingError(409, 'DUPLICATE_TRACKED_ITEM', 'This game is already in your watchlist.', [], null, String(duplicate._id));
        const [created] = await TrackedItemModel.create([{
          userId: user,
          productId: preview.productId,
          targetPriceMinor: input.targetPrice.amountMinor,
          currency: 'USD',
          enabled: input.enabled,
          alerts: input.alerts,
        }], { session });
        const product = await ProductModel.findById(preview.productId).session(session).lean().exec();
        if (!product) throw new TrackingError(503, 'SERVICE_UNAVAILABLE', 'The shared product is temporarily unavailable.');
        const body = publicTracker(created!.toObject() as TrackerDocument, objectProduct(product), at);
        const location = `/api/tracked-items/${String(created!._id)}`;
        idempotency!.response = body;
        idempotency!.location = location;
        await idempotency!.save({ session });
        return { status: 201 as const, body, location };
      });
    } catch (error) {
      if (error instanceof TrackingError) throw error;
      if (isDuplicateKey(error)) {
        const racedReplay = await replayIfPresent();
        if (racedReplay) return racedReplay;
        const preview = await ProductPreviewModel.findOne({ _id: input.previewId, userId: user }).lean().exec();
        if (preview && preview.expiresAt.getTime() > at.getTime()) {
          const duplicate = await TrackedItemModel.findOne({ userId: user, productId: preview.productId }).lean().exec();
          if (duplicate) throw new TrackingError(409, 'DUPLICATE_TRACKED_ITEM', 'This game is already in your watchlist.', [], null, String(duplicate._id));
        }
      }
      throw error;
    }
  }

  async function updateOwnedItem(userId: string, trackerId: unknown, rawBody: unknown) {
    const id = safeId(trackerId);
    ownerId(userId);
    try {
      await updateOwnedTrackerSettings(userId, id, rawBody);
      return await readOwnedItem(userId, id);
    } catch (error) {
      return asKnownUpdateError(error, rawBody);
    }
  }

  async function deleteOwnedItem(userId: string, trackerId: unknown) {
    const user = ownerId(userId);
    const id = safeId(trackerId);
    await mongoose.connection.transaction(async session => {
      const tracker = await TrackedItemModel.findOne({ _id: id, userId: user }).session(session).exec();
      if (!tracker) throw notFound();
      await NotificationDeliveryModel.updateMany(
        { trackedItemId: tracker._id, status: { $in: ['pending', 'retryable'] } },
        { $set: { status: 'cancelled' } }, { session },
      ).exec();
      await TrackedItemModel.deleteOne({ _id: tracker._id, userId: user }, { session }).exec();
    });
  }

  return { readOwnedItem, listOwnedItems, createOwnedItem, updateOwnedItem, deleteOwnedItem };
}

export type TrackedItemService = ReturnType<typeof createTrackedItemService>;
