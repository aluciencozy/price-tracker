import mongoose from 'mongoose';
import { z } from 'zod';
import { ProductModel } from './models/product.js';
import { NotificationDeliveryModel, PriceHistoryModel, TrackedItemModel } from './models/tracking.js';

const patchSchema = z.object({
  targetPrice: z.object({ amountMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), currency: z.literal('USD') }).strict().optional(),
  enabled: z.boolean().optional(),
  alerts: z.object({ email: z.boolean(), push: z.boolean() }).strict().optional(),
}).strict().refine(value => Object.keys(value).length > 0);
const pendingStatuses = ['pending', 'retryable'] as const;
const idPattern = /^[a-f0-9]{24}$/;

/** Call from authenticated tracker PATCH, using server-derived userId. */
export async function updateOwnedTrackerSettings(userId: string, trackedItemId: string, patch: unknown) {
  if (!idPattern.test(userId) || !idPattern.test(trackedItemId)) throw new Error('Tracked item not found.');
  const input = patchSchema.parse(patch);
  return mongoose.connection.transaction(async session => {
    const tracker = await TrackedItemModel.findOne({ _id: trackedItemId, userId }).session(session).exec();
    if (!tracker) throw new Error('Tracked item not found.');
    const targetChanged = input.targetPrice !== undefined && input.targetPrice.amountMinor !== tracker.targetPriceMinor;
    if (targetChanged) {
      tracker.targetPriceMinor = input.targetPrice!.amountMinor;
      tracker.targetRevision += 1;
      tracker.episodeOpen = false;
      tracker.episodeId = null;
      tracker.lastEvaluatedAt = null;
      tracker.lastObservationId = null;
    }
    if (input.enabled !== undefined) tracker.enabled = input.enabled;
    if (input.alerts !== undefined) tracker.alerts = input.alerts;
    const cancelledChannels = (['email', 'push'] as const).filter(channel => !tracker.alerts?.[channel]);
    if (targetChanged || !tracker.enabled || cancelledChannels.length > 0) {
      await NotificationDeliveryModel.updateMany({
        trackedItemId: tracker._id, status: { $in: pendingStatuses },
        ...(targetChanged || !tracker.enabled ? {} : { channel: { $in: cancelledChannels } }),
      }, { $set: { status: 'cancelled' } }, { session }).exec();
    }
    await tracker.save({ session });
    return tracker;
  });
}

type Evaluation = { status: 'ignored' | 'already_evaluated' | 'opened' | 'below_target' | 'above_target' | 'rearmed'; episodeId: string | null; deliveryIds: string[] };
const ignored = (): Evaluation => ({ status: 'ignored', episodeId: null, deliveryIds: [] });

/** Evaluate a persisted, current successful observation. Errors are never inputs.
 * MongoDB retries transaction write conflicts; state and outbox commit together. */
export async function evaluateTrackerObservation(trackedItemId: string, observationId: string, now = new Date()): Promise<Evaluation> {
  if (!idPattern.test(trackedItemId) || !idPattern.test(observationId)) return ignored();
  return mongoose.connection.transaction(async session => {
    const tracker = await TrackedItemModel.findById(trackedItemId).session(session).exec();
    if (!tracker || !tracker.enabled) return ignored();
    const observation = await PriceHistoryModel.findOne({ _id: observationId, productId: tracker.productId }).session(session).exec();
    if (!observation || observation.currency !== tracker.currency || !Number.isSafeInteger(observation.priceMinor) || observation.priceMinor < 0 ||
        observation.observedAt > now || observation.observedAt.getTime() + 86400000 <= now.getTime()) return ignored();
    const product = await ProductModel.findById(tracker.productId).session(session).exec();
    if (!product || product.lastError !== null || product.currency !== observation.currency ||
        product.lastSuccessfulCheckAt?.getTime() !== observation.observedAt.getTime() || product.currentPriceMinor !== observation.priceMinor) return ignored();
    // Time plus ObjectId provides deterministic ordering for equal-time successful
    // checks. Target edits clear the pointer, so a fresh retained success can be
    // reevaluated for a genuinely changed target without replaying the old episode.
    if (tracker.lastEvaluatedAt && (observation.observedAt < tracker.lastEvaluatedAt ||
        (observation.observedAt.getTime() === tracker.lastEvaluatedAt.getTime() &&
          String(observation._id) <= String(tracker.lastObservationId)))) {
      return { status: 'already_evaluated', episodeId: tracker.episodeId ?? null, deliveryIds: [] };
    }
    tracker.lastEvaluatedAt = observation.observedAt;
    tracker.lastObservationId = observation._id;
    if (observation.priceMinor > tracker.targetPriceMinor) {
      const wasOpen = tracker.episodeOpen;
      await NotificationDeliveryModel.updateMany({ trackedItemId: tracker._id, status: { $in: pendingStatuses } },
        { $set: { status: 'cancelled' } }, { session }).exec();
      tracker.episodeOpen = false;
      tracker.episodeId = null;
      await tracker.save({ session });
      return { status: wasOpen ? 'rearmed' : 'above_target', episodeId: null, deliveryIds: [] };
    }
    const channels = (['email', 'push'] as const).filter(channel => tracker.alerts?.[channel]);
    if (tracker.episodeOpen || channels.length === 0) {
      await tracker.save({ session });
      return { status: 'below_target', episodeId: tracker.episodeId ?? null, deliveryIds: [] };
    }
    tracker.episodeSequence += 1;
    const episodeId = `${tracker._id}_${tracker.targetRevision}_${tracker.episodeSequence}`;
    tracker.episodeId = episodeId;
    tracker.episodeOpen = true;
    await tracker.save({ session });
    const deliveries = await NotificationDeliveryModel.create(channels.map(channel => ({
      trackedItemId: tracker._id, userId: tracker.userId, productId: tracker.productId,
      observationId: observation._id, episodeId, channel,
      status: 'pending' as const, availableAt: now,
    })), { session, ordered: true });
    return { status: 'opened', episodeId, deliveryIds: deliveries.map(delivery => String(delivery._id)) };
  });
}
