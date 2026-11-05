import { randomUUID } from 'node:crypto';
import mongoose, { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabaseIndexes } from '../src/models/index.js';
import { ProductModel } from '../src/models/product.js';
import { NotificationDeliveryModel, PriceHistoryModel, TrackedItemModel } from '../src/models/tracking.js';
import { evaluateTrackerObservation, updateOwnedTrackerSettings } from '../src/alertEpisodes.js';

const uri = process.env.TEST_MONGODB_URI;
describe.skipIf(!uri)('durable alert episodes', () => {
  const dbName = `price_tracker_test_${randomUUID().replaceAll('-', '')}`;
  const owner = new Types.ObjectId();
  const now = new Date();
  let productId: string;
  let trackerId: string;
  let clock: number;
  async function observe(priceMinor: number) {
    const at = new Date(clock++);
    await ProductModel.updateOne({ _id: productId }, { $set: { currentPriceMinor: priceMinor, lastSuccessfulCheckAt: at, lastError: null } });
    return String((await PriceHistoryModel.create({ productId, checkId: randomUUID(), priceMinor, currency: 'USD', observedAt: at, source: 'CheapShark', dealId: 'fixture' }))._id);
  }
  const evaluate = (observationId: string, tracker = trackerId) => evaluateTrackerObservation(tracker, observationId, now);
  beforeAll(async () => {
    await mongoose.connect(uri!, { dbName, autoIndex: false, serverSelectionTimeoutMS: 5000 });
    await createDatabaseIndexes();
  });
  beforeEach(async () => {
    await Promise.all([ProductModel.deleteMany({}), TrackedItemModel.deleteMany({}), PriceHistoryModel.deleteMany({}), NotificationDeliveryModel.deleteMany({})]);
    clock = now.getTime() - 100000;
    const product = await ProductModel.create({ provider: 'cheapshark', providerGameId: '36', steamAppId: '620', storeId: '1', market: 'US', currency: 'USD', canonicalSteamUrl: 'https://store.steampowered.com/app/620/', title: 'Portal 2' });
    productId = String(product._id);
    trackerId = String((await TrackedItemModel.create({ userId: owner, productId, targetPriceMinor: 1000, alerts: { email: true, push: true } }))._id);
  });
  afterAll(async () => {
    if (mongoose.connection.name === dbName) await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
  it('opens once at equal target; repeated and sustained-low observations do not repeat', async () => {
    const observation = await observe(1000);
    const first = await evaluate(observation);
    expect(first.status).toBe('opened');
    expect(first.deliveryIds).toHaveLength(2);
    expect((await evaluate(observation)).status).toBe('already_evaluated');
    expect((await evaluate(await observe(900))).status).toBe('below_target');
    expect(await NotificationDeliveryModel.countDocuments()).toBe(2);
  });
  it('rearms only on a successful above-target observation and starts a new episode', async () => {
    const first = await evaluate(await observe(999));
    expect((await evaluate(await observe(1001))).status).toBe('rearmed');
    const second = await evaluate(await observe(1000));
    expect(second.status).toBe('opened');
    expect(second.episodeId).not.toBe(first.episodeId);
    expect(await NotificationDeliveryModel.countDocuments({ status: 'pending' })).toBe(2);
    expect(await NotificationDeliveryModel.countDocuments({ status: 'cancelled' })).toBe(2);
  });
  it('does not rearm or enqueue from a failed check or stale/future observation', async () => {
    const low = await observe(999);
    const first = await evaluate(low);
    const high = await observe(2000);
    await ProductModel.updateOne({ _id: productId }, { $set: { lastError: 'failure' } });
    expect((await evaluate(high)).status).toBe('ignored');
    expect((await TrackedItemModel.findById(trackerId))?.episodeId).toBe(first.episodeId);
    expect((await evaluateTrackerObservation(trackerId, high, new Date(clock - 1000))).status).toBe('ignored');
    expect((await evaluateTrackerObservation(trackerId, low, new Date(now.getTime() + 86400000))).status).toBe('ignored');
  });
  it('reevaluates a genuinely changed target, but not a replayed identical edit', async () => {
    const observation = await observe(999);
    const first = await evaluate(observation);
    await updateOwnedTrackerSettings(String(owner), trackerId, { targetPrice: { amountMinor: 1001, currency: 'USD' } });
    const second = await evaluate(observation);
    expect(second.status).toBe('opened');
    expect(second.episodeId).not.toBe(first.episodeId);
    await updateOwnedTrackerSettings(String(owner), trackerId, { targetPrice: { amountMinor: 1001, currency: 'USD' } });
    expect((await evaluate(observation)).status).toBe('already_evaluated');
    expect((await TrackedItemModel.findById(trackerId))?.targetRevision).toBe(1);
  });
  it('does not replay an episode when a second channel is enabled or a channel toggles', async () => {
    await updateOwnedTrackerSettings(String(owner), trackerId, { alerts: { email: true, push: false } });
    await evaluate(await observe(999));
    await updateOwnedTrackerSettings(String(owner), trackerId, { alerts: { email: false, push: true } });
    await evaluate(await observe(900));
    await updateOwnedTrackerSettings(String(owner), trackerId, { alerts: { email: true, push: true } });
    await evaluate(await observe(800));
    expect(await NotificationDeliveryModel.countDocuments()).toBe(1);
  });
  it('does not consume qualification while all channels are off', async () => {
    await updateOwnedTrackerSettings(String(owner), trackerId, { alerts: { email: false, push: false } });
    expect((await evaluate(await observe(999))).status).toBe('below_target');
    await updateOwnedTrackerSettings(String(owner), trackerId, { alerts: { email: true, push: false } });
    expect((await evaluate(await observe(999))).status).toBe('opened');
    expect(await NotificationDeliveryModel.countDocuments()).toBe(1);
  });
  it('cancels pending work when disabled and preserves episode on re-enable', async () => {
    const episode = await evaluate(await observe(999));
    await updateOwnedTrackerSettings(String(owner), trackerId, { enabled: false });
    expect((await evaluate(await observe(2000))).status).toBe('ignored');
    await updateOwnedTrackerSettings(String(owner), trackerId, { enabled: true });
    const result = await evaluate(await observe(999));
    expect(result.status).toBe('below_target');
    expect(result.episodeId).toBe(episode.episodeId);
    expect(await NotificationDeliveryModel.countDocuments({ status: 'pending' })).toBe(0);
  });
  it('isolates two users sharing one Product', async () => {
    const other = await TrackedItemModel.create({ userId: new Types.ObjectId(), productId, targetPriceMinor: 100, alerts: { email: true, push: true } });
    const observation = await observe(999);
    expect((await evaluate(observation)).status).toBe('opened');
    expect((await evaluate(observation, String(other._id))).status).toBe('above_target');
    expect(await NotificationDeliveryModel.countDocuments({ userId: owner })).toBe(2);
  });
  it('serializes concurrent workers and survives process connection restart', async () => {
    const observation = await observe(0);
    const results = await Promise.all(Array.from({ length: 6 }, () => evaluate(observation)));
    expect(results.filter(result => result.status === 'opened')).toHaveLength(1);
    expect(await NotificationDeliveryModel.countDocuments()).toBe(2);
    await NotificationDeliveryModel.updateOne({ channel: 'email' }, { $set: { status: 'sent' } });
    await NotificationDeliveryModel.updateOne({ channel: 'push' }, { $set: { status: 'retryable' } });
    await mongoose.disconnect();
    await mongoose.connect(uri!, { dbName, autoIndex: false });
    expect((await evaluate(observation)).status).toBe('already_evaluated');
    expect((await NotificationDeliveryModel.findOne({ channel: 'email' }))?.status).toBe('sent');
    expect((await NotificationDeliveryModel.findOne({ channel: 'push' }))?.status).toBe('retryable');
  });
  it('rejects foreign settings edits and invalid money', async () => {
    await expect(updateOwnedTrackerSettings(String(new Types.ObjectId()), trackerId, { enabled: false })).rejects.toThrow('not found');
    for (const patch of [{}, { targetPrice: { amountMinor: 0.1, currency: 'USD' } }, { targetPrice: { amountMinor: 0, currency: 'EUR' } }, { userId: String(owner) }]) {
      await expect(updateOwnedTrackerSettings(String(owner), trackerId, patch)).rejects.toThrow();
    }
  });
  it('ignores deleted trackers and replayed older observations', async () => {
    const older = await observe(999);
    const newer = await observe(900);
    await evaluate(newer);
    expect((await evaluate(older)).status).toBe('ignored');
    await TrackedItemModel.deleteOne({ _id: trackerId });
    expect((await evaluate(newer)).status).toBe('ignored');
    expect(await NotificationDeliveryModel.countDocuments()).toBe(2);
  });
});
