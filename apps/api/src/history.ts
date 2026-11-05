import { createHmac, timingSafeEqual } from 'node:crypto';
import mongoose from 'mongoose';
import { z } from 'zod';
import { cheapSharkPurchaseUrl, type SteamOffer } from './cheapshark.js';
import { ProductModel, type ProductRecord } from './models/product.js';
import { PriceHistoryModel, TrackedItemModel, HISTORY_RETENTION_DAYS } from './models/tracking.js';

const DAY = 86400000;
const timestamp = z.iso.datetime({ precision: 3 });
const isoDate = z.iso.datetime();
const querySchema = z.object({
  from: isoDate.optional(), to: isoDate.optional(),
  limit: z.string().regex(/^(?:[1-9]|[1-9][0-9]|100)$/).optional(),
  cursor: z.string().min(1).max(2048).optional(),
}).strict();
const cursorSchema = z.object({
  version: z.literal(1), userId: z.string(), trackedItemId: z.string(),
  from: timestamp, to: timestamp, at: timestamp, id: z.string().regex(/^[a-f0-9]{24}$/),
}).strict();

export class HistoryError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}

/** Called only by the validated provider/check service, never from client bodies.
 * The refresh lease fences the cache update; the history insert commits with it. */
export async function recordObservation(productId: string, checkId: string, leaseToken: string, offer: SteamOffer, now = new Date()) {
  if (!/^[a-f0-9]{24}$/.test(productId) || !/^[A-Za-z0-9_-]{1,128}$/.test(checkId) || !leaseToken) throw new Error('Invalid observation identity.');
  const at = new Date(offer.observedAt);
  if (!Number.isFinite(at.getTime()) || at > now || at.getTime() < now.getTime() - DAY ||
      offer.identity.provider !== 'cheapshark' || offer.identity.storeId !== '1' || offer.identity.market !== 'US' ||
      offer.identity.currency !== 'USD' || offer.currentPrice.currency !== 'USD' ||
      !Number.isSafeInteger(offer.currentPrice.amountMinor) || offer.currentPrice.amountMinor < 0 ||
      (offer.retailPrice !== null && (offer.retailPrice.currency !== 'USD' || !Number.isSafeInteger(offer.retailPrice.amountMinor) || offer.retailPrice.amountMinor < 0)) ||
      offer.purchaseUrl !== cheapSharkPurchaseUrl(offer.dealId) ||
      offer.canonicalSteamUrl !== `https://store.steampowered.com/app/${offer.steamAppId}/`) {
    throw new Error('Invalid successful Steam observation.');
  }
  return mongoose.connection.transaction(async session => {
    const prior = await PriceHistoryModel.findOne({ productId, checkId }).session(session).exec();
    if (prior) {
      if (prior.priceMinor !== offer.currentPrice.amountMinor || prior.observedAt.getTime() !== at.getTime() || prior.dealId !== offer.dealId ||
          (prior.providerChangedAt?.getTime() ?? null) !== (offer.providerChangedAt === null ? null : new Date(offer.providerChangedAt).getTime())) {
        throw new Error('Conflicting replay of a successful check.');
      }
      return prior;
    }
    const product = await ProductModel.findOneAndUpdate({
      _id: productId, ...offer.identity, steamAppId: offer.steamAppId,
      refreshLeaseToken: leaseToken, refreshLeaseUntil: { $gt: now },
      $or: [{ lastSuccessfulCheckAt: null }, { lastSuccessfulCheckAt: { $lte: at } }],
    }, { $set: {
      currentPriceMinor: offer.currentPrice.amountMinor, retailPriceMinor: offer.retailPrice?.amountMinor ?? null,
      dealId: offer.dealId, purchaseUrl: offer.purchaseUrl, title: offer.title,
      lastSuccessfulCheckAt: at, providerChangedAt: offer.providerChangedAt,
      lastAttemptAt: at, lastError: null, consecutiveFailures: 0,
      nextCheckAt: new Date(at.getTime() + DAY), refreshLeaseToken: null, refreshLeaseUntil: null,
    } }, { session, returnDocument: 'after', runValidators: true }).exec();
    if (!product) throw new Error('Observation is stale, identity changed, or refresh lease lost.');
    const [observation] = await PriceHistoryModel.create([{
      productId, checkId, priceMinor: offer.currentPrice.amountMinor, currency: 'USD', observedAt: at,
      providerChangedAt: offer.providerChangedAt, source: 'CheapShark', dealId: offer.dealId,
    }], { session });
    return observation!;
  });
}

export function publicProduct(product: ProductRecord & { _id: mongoose.Types.ObjectId }, now: Date) {
  const success = product.currentPriceMinor !== null && product.lastSuccessfulCheckAt !== null;
  const staleAt = success ? new Date(product.lastSuccessfulCheckAt!.getTime() + DAY) : null;
  return {
    id: String(product._id),
    identity: { provider: product.provider, providerGameId: product.providerGameId, storeId: product.storeId, market: product.market, currency: product.currency },
    steamAppId: product.steamAppId, canonicalSteamUrl: product.canonicalSteamUrl, title: product.title,
    storeName: 'Steam', imageUrl: null,
    source: { name: 'CheapShark', url: 'https://www.cheapshark.com/', attribution: 'Prices supplied by CheapShark; Steam US/USD base-game offer, excluding taxes and checkout adjustments.' },
    currentPrice: success ? { amountMinor: product.currentPriceMinor, currency: 'USD' } : null,
    retailPrice: success && product.retailPriceMinor !== null ? { amountMinor: product.retailPriceMinor, currency: 'USD' } : null,
    dealId: success ? product.dealId : null, purchaseUrl: success ? product.purchaseUrl : null,
    observedAt: success ? product.lastSuccessfulCheckAt!.toISOString() : null,
    providerChangedAt: success ? product.providerChangedAt?.toISOString() ?? null : null,
    freshness: !success ? 'unavailable' : product.lastError || staleAt! <= now ? 'stale' : 'fresh',
    staleAt: staleAt?.toISOString() ?? null,
    lastAttemptAt: product.lastAttemptAt?.toISOString() ?? null, nextCheckAt: product.nextCheckAt?.toISOString() ?? null,
    lastError: product.lastError ? { code: 'PROVIDER_UNAVAILABLE', message: 'The latest price check failed; any previous successful price is retained.', occurredAt: (product.lastAttemptAt ?? now).toISOString(), retryAt: product.nextCheckAt?.toISOString() ?? null } : null,
  };
}

export function createHistoryService(signingSecret: string) {
  if (Buffer.byteLength(signingSecret) < 32) throw new Error('History cursor signing secret must contain at least 32 bytes.');
  const sign = (body: string) => createHmac('sha256', signingSecret).update(body).digest();
  const encode = (cursor: z.infer<typeof cursorSchema>) => {
    const body = Buffer.from(JSON.stringify(cursor)).toString('base64url');
    return `${body}.${sign(body).toString('base64url')}`;
  };
  const invalidCursor = () => new HistoryError(422, 'INVALID_CURSOR', 'The history cursor is invalid for this request.');
  const decode = (token: string) => {
    try {
      if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw invalidCursor();
      const [body, signature] = token.split('.');
      const received = Buffer.from(signature!, 'base64url');
      const expected = sign(body!);
      if (received.length !== expected.length || !timingSafeEqual(received, expected)) throw invalidCursor();
      return cursorSchema.parse(JSON.parse(Buffer.from(body!, 'base64url').toString('utf8')));
    } catch { throw invalidCursor(); }
  };
  /** userId must come from a validated, active, verified server session. */
  return async function readOwnedHistory(userId: string, trackedItemId: string, rawQuery: unknown, now = new Date()) {
    if (!/^[a-f0-9]{24}$/.test(userId)) throw new HistoryError(401, 'AUTH_REQUIRED', 'Sign in to view history.');
    if (!/^[a-f0-9]{24}$/.test(trackedItemId)) throw new HistoryError(404, 'NOT_FOUND', 'Tracked item not found.');
    const tracker = await TrackedItemModel.findOne({ _id: trackedItemId, userId }).lean().exec();
    if (!tracker) throw new HistoryError(404, 'NOT_FOUND', 'Tracked item not found.');
    const parsed = querySchema.safeParse(rawQuery);
    if (!parsed.success) throw new HistoryError(422, 'VALIDATION_ERROR', 'Invalid history query.');
    const query = parsed.data;
    const cursor = query.cursor ? decode(query.cursor) : null;
    if (cursor && (cursor.userId !== userId || cursor.trackedItemId !== trackedItemId)) throw invalidCursor();
    const to = new Date(query.to ?? cursor?.to ?? now.toISOString());
    const from = new Date(query.from ?? cursor?.from ?? new Date(to.getTime() - 30 * DAY).toISOString());
    if (cursor && (from.toISOString() !== cursor.from || to.toISOString() !== cursor.to)) throw invalidCursor();
    if (from >= to || to.getTime() - from.getTime() > 90 * DAY) throw new HistoryError(422, 'VALIDATION_ERROR', 'History range must be increasing and at most 90 days.');
    const retainedFrom = new Date(now.getTime() - HISTORY_RETENTION_DAYS * DAY);
    const limit = Number(query.limit ?? 20);
    const rows = await PriceHistoryModel.find({
      productId: tracker.productId, observedAt: { $gte: new Date(Math.max(from.getTime(), retainedFrom.getTime())), $lt: to },
      ...(cursor ? { $or: [{ observedAt: { $gt: new Date(cursor.at) } }, { observedAt: new Date(cursor.at), _id: { $gt: new mongoose.Types.ObjectId(cursor.id) } }] } : {}),
    }).sort({ observedAt: 1, _id: 1 }).limit(limit + 1).lean().exec();
    const product = await ProductModel.findById(tracker.productId).lean().exec();
    if (!product) throw new HistoryError(404, 'NOT_FOUND', 'Tracked item not found.');
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return {
      trackedItemId, product: publicProduct(product, now),
      window: { from: from.toISOString(), to: to.toISOString() }, retainedFrom: retainedFrom.toISOString(),
      items: items.map(row => ({ id: String(row._id), price: { amountMinor: row.priceMinor, currency: row.currency }, observedAt: row.observedAt.toISOString(), providerChangedAt: row.providerChangedAt?.toISOString() ?? null })),
      page: { limit, nextCursor: rows.length > limit && last ? encode({ version: 1, userId, trackedItemId, from: from.toISOString(), to: to.toISOString(), at: last.observedAt.toISOString(), id: String(last._id) }) : null },
    };
  };
}
