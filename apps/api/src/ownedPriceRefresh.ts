import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { PriceCheckModel } from './models/priceCheck.js';
import { ProductModel } from './models/product.js';
import { PriceHistoryModel, TrackedItemModel } from './models/tracking.js';
import { checkIdFor, runPriceChecks } from './priceChecks.js';
import { notFound, TrackingError } from './trackingErrors.js';

const objectId = /^[a-f0-9]{24}$/;
const requestId = /^user_[a-f0-9-]{36}$/;
const cooldownMs = 60_000;

export function createOwnedPriceRefresh(run: typeof runPriceChecks = runPriceChecks) {
  async function read(userId: string, id: string) {
    if (!objectId.test(userId) || !requestId.test(id)) throw notFound();
    const row = await PriceCheckModel.findOne({ entryType: 'run', runId: id, mode: 'user', ownerUserId: userId }).lean();
    if (!row?.trackedItemId) throw notFound();
    const tracker = await TrackedItemModel.findOne({ _id: row.trackedItemId, userId }).lean();
    if (!tracker) throw notFound();
    const item = await PriceCheckModel.findOne({ entryType: 'product', runId: id, productId: tracker.productId }).lean();
    if (!item) throw new TrackingError(503, 'SERVICE_UNAVAILABLE', 'Price refresh is unavailable.');
    const product = await ProductModel.findById(tracker.productId).lean();
    const observation = product?.steamTypeValidatedAt && !product.steamTypeRejected
      ? await PriceHistoryModel.findOne({ productId: tracker.productId }).sort({ observedAt: -1, _id: -1 }).lean() : null;
    const active = row.status === 'pending' || row.status === 'running';
    const deferred = row.status === 'partial';
    const success = row.status === 'complete' && item.status === 'succeeded' && item.result && item.observationId && observation;
    const status = active ? (row.status === 'pending' ? 'queued' : 'running')
      : deferred ? 'deferred' : success ? item.result! : 'failed';
    const retryDate = deferred ? row.nextRetryAt : row.status === 'complete' && row.completedAt
      ? new Date(Math.max(row.completedAt.getTime() + cooldownMs, item.status === 'failed' ? item.availableAt.getTime() : 0)) : null;
    const retryAt = retryDate?.toISOString() ?? null;
    const code = item.errorCode === 'PROVIDER_RATE_LIMITED' ? 'PROVIDER_RATE_LIMITED'
      : item.errorCode === 'UNSUPPORTED_PRODUCT' ? 'UNSUPPORTED_PRODUCT' : 'PROVIDER_UNAVAILABLE';
    return {
      id: row.runId, trackedItemId: String(row.trackedItemId), status,
      requestedAt: (row.createdAt ?? row.availableAt).toISOString(), startedAt: row.startedAt?.toISOString() ?? null,
      finishedAt: active || deferred ? null : row.completedAt?.toISOString() ?? null,
      lastObservation: observation ? { id: String(observation._id), price: { amountMinor: observation.priceMinor, currency: 'USD' as const }, observedAt: observation.observedAt.toISOString() } : null,
      retryAt,
      error: active || success ? null : { code, message: deferred ? 'Price refresh is deferred.' : 'Price refresh could not be completed.', occurredAt: (row.completedAt ?? item.startedAt ?? row.createdAt ?? row.availableAt).toISOString(), retryAt },
    };
  }

  async function enqueue(userId: string, trackerId: string) {
    if (!objectId.test(userId) || !objectId.test(trackerId)) throw notFound();
    const id = `user_${randomUUID()}`;
    const selected = await mongoose.connection.transaction(async session => {
      const tracker = await TrackedItemModel.findOne({ _id: trackerId, userId }).session(session);
      if (!tracker) throw notFound();
      if (tracker.refreshRunId) {
        const prior = await PriceCheckModel.findOne({ entryType: 'run', runId: tracker.refreshRunId, mode: 'user', ownerUserId: userId, trackedItemId: tracker._id }).session(session).lean();
        if (prior && prior.status !== 'complete') return { id: prior.runId, created: false };
        if (prior?.completedAt) {
          const child = await PriceCheckModel.findOne({ entryType: 'product', runId: prior.runId }).session(session).lean();
          const until = Math.max(prior.completedAt.getTime() + cooldownMs, child?.status === 'failed' ? child.availableAt.getTime() : 0);
          if (!tracker.refreshCooldownUntil || tracker.refreshCooldownUntil.getTime() < until) tracker.refreshCooldownUntil = new Date(until);
        }
        tracker.refreshRunId = null;
      }
      const now = new Date();
      if (tracker.refreshCooldownUntil && tracker.refreshCooldownUntil > now) {
        throw new TrackingError(429, 'RATE_LIMITED', 'Please wait before checking this game again.', [], Math.max(1, Math.ceil((tracker.refreshCooldownUntil.getTime() - now.getTime()) / 1000)));
      }
      tracker.refreshRunId = id;
      await tracker.save({ session });
      await PriceCheckModel.create([{ entryType: 'run', runId: id, mode: 'user', status: 'pending', selectionComplete: true, ownerUserId: tracker.userId, trackedItemId: tracker._id, availableAt: now },
        { entryType: 'product', runId: id, mode: 'user', status: 'pending', productId: tracker.productId, checkId: checkIdFor(id, String(tracker.productId)), availableAt: now }], { session, ordered: true });
      return { id, created: true };
    });
    if (selected.created) void run({ runId: selected.id, mode: 'user' }).catch(() => console.error('Owned price check failed; recovery will inspect persisted work.'));
    return read(userId, selected.id);
  }
  return { enqueue, read };
}
