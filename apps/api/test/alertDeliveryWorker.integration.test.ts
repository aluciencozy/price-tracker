import { randomUUID } from 'node:crypto';
import mongoose, { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { evaluateTrackerObservation } from '../src/alertEpisodes.js';
import { createPriceAlertDeliveryWorker, type AlertDeliveryWorkerOptions } from '../src/alertDeliveryWorker.js';
import { DeviceModel } from '../src/models/device.js';
import { SessionModel, UserModel } from '../src/models/account.js';
import { ProductModel } from '../src/models/product.js';
import { NotificationDeliveryModel, PriceHistoryModel, TrackedItemModel } from '../src/models/tracking.js';
import { createDatabaseIndexes } from '../src/models/index.js';
import { cheapSharkPurchaseUrl } from '../src/cheapshark.js';
import type { DeliveryOutcome } from '../src/emails.js';

const uri = process.env.TEST_MONGODB_URI;
describe.skipIf(!uri)('durable price-alert delivery worker', () => {
  // Always override the URI's path with a fresh test-only DB; never use the demo DB.
  const dbName = `price_tracker_test_${randomUUID().replaceAll('-', '')}`;
  let instant: Date;

  async function clearFixtures() {
    await Promise.all([
      NotificationDeliveryModel.deleteMany({}), PriceHistoryModel.deleteMany({}),
      TrackedItemModel.deleteMany({}), ProductModel.deleteMany({}), DeviceModel.deleteMany({}),
      SessionModel.deleteMany({}), UserModel.deleteMany({}),
    ]);
  }

  beforeAll(async () => {
    await mongoose.connect(uri!, { dbName, autoIndex: false, serverSelectionTimeoutMS: 5000 });
    await createDatabaseIndexes();
  }, 30_000);
  beforeEach(async () => {
    await clearFixtures();
    instant = new Date();
  });
  afterAll(async () => {
    if (mongoose.connection.name === dbName && dbName !== 'price_tracker27051') await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  async function fixture(alerts = { email: true, push: false }) {
    const user = await UserModel.create({ email: `${randomUUID()}@example.invalid`, passwordHash: 'fixture-hash', emailVerifiedAt: instant });
    const product = await ProductModel.create({
      provider: 'cheapshark', providerGameId: '36', steamAppId: '620', storeId: '1', market: 'US', currency: 'USD',
      canonicalSteamUrl: 'https://store.steampowered.com/app/620/', title: 'Portal 2',
    });
    const tracker = await TrackedItemModel.create({
      userId: user._id, productId: product._id, targetPriceMinor: 1000, alerts,
    });
    const observedAt = new Date(instant.getTime() - 1000);
    await ProductModel.updateOne({ _id: product._id }, {
      $set: { currentPriceMinor: 999, lastSuccessfulCheckAt: observedAt, lastError: null,
        dealId: 'fixture-deal', purchaseUrl: cheapSharkPurchaseUrl('fixture-deal') },
    });
    const observation = await PriceHistoryModel.create({
      productId: product._id, checkId: randomUUID(), priceMinor: 999, currency: 'USD', observedAt,
      source: 'CheapShark', dealId: 'fixture-deal',
    });
    const evaluated = await evaluateTrackerObservation(String(tracker._id), String(observation._id), instant);
    expect(evaluated.status).toBe('opened');
    return { user, product, tracker, observation, episodeId: evaluated.episodeId! };
  }

  async function registerDevice(userId: Types.ObjectId, token: string, sessionId?: Types.ObjectId) {
    const session = sessionId
      ? await SessionModel.findById(sessionId).orFail()
      : await SessionModel.create({ userId, transport: 'mobile', expiresAt: new Date(instant.getTime() + 7 * 86400000) });
    const device = await DeviceModel.create({
      userId, sessionId: session._id, installationId: randomUUID(), platform: 'android', pushToken: token,
    });
    return { session, device };
  }

  const worker = (overrides: Partial<AlertDeliveryWorkerOptions> = {}) => createPriceAlertDeliveryWorker({
    pushSender: vi.fn().mockResolvedValue({ kind: 'accepted', providerMessageId: 'fixture-fcm-message' }),
    now: () => new Date(instant),
    ...overrides,
  });

  it('keeps email and push independent and does not retry an uncertain FCM send', async () => {
    const data = await fixture({ email: true, push: true });
    const { session } = await registerDevice(data.user._id, 'fixture-token');
    const emailSender = vi.fn().mockResolvedValue({ status: 'success', messageId: 'fixture-resend-message', attempts: 1 });
    const pushSender = vi.fn().mockResolvedValue({ kind: 'unknown', code: 'FCM_SEND_UNKNOWN' });
    const service = worker({ emailSender, pushSender });

    const result = await service.runBatch();
    expect(result.claimed).toBe(2);
    expect(emailSender).toHaveBeenCalledTimes(1);
    expect(pushSender).toHaveBeenCalledTimes(1);
    expect(emailSender).toHaveBeenCalledWith(expect.any(String), {
      gameTitle: 'Portal 2', currentPriceCents: 999, targetPriceCents: 1000,
      purchaseUrl: 'https://www.cheapshark.com/redirect?dealID=fixture-deal',
    }, expect.stringMatching(/^price-alert-/));
    const event = pushSender.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(event).toMatchObject({ eventId: data.episodeId, recipientSessionId: String(session._id) });
    expect(event).not.toHaveProperty('purchaseUrl');
    expect(event).not.toHaveProperty('currentPriceCents');
    expect((await NotificationDeliveryModel.findOne({ channel: 'email' }))?.status).toBe('sent');
    const pushRow = await NotificationDeliveryModel.findOne({ channel: 'push' }).select('+pushDevices').orFail();
    expect(pushRow.status).toBe('unknown');
    expect(pushRow.pushDevices?.[0]).toMatchObject({ status: 'unknown', attempts: 1, lastErrorCode: 'FCM_SEND_UNKNOWN' });
    expect(pushRow.toObject()).not.toHaveProperty('tokenHash');

    instant = new Date(instant.getTime() + 10 * 60_000);
    await Promise.all([service.runBatch(), worker({ pushSender }).runBatch()]);
    expect(emailSender).toHaveBeenCalledTimes(1);
    expect(pushSender).toHaveBeenCalledTimes(1);
  });

  it('reconciles an uncertain Resend outcome after restart with the same payload and key', async () => {
    await fixture();
    const calls: Array<{ recipient: string; alert: unknown; key: string }> = [];
    const first = worker({ emailSender: vi.fn(async (recipient, alert, key) => {
      calls.push({ recipient, alert, key });
      return { status: 'unknown' as const, code: 'provider_outcome_unknown', attempts: 1, retryAfterMs: 1000 };
    }) });
    await first.runBatch();
    const row = await NotificationDeliveryModel.findOne({ channel: 'email' }).orFail();
    const firstAttemptAt = row.firstAttemptAt;
    instant = new Date(instant.getTime() + 60_000);
    await NotificationDeliveryModel.updateOne({ _id: row._id }, { $set: { availableAt: instant } });

    const restarted = worker({ emailSender: vi.fn(async (recipient, alert, key) => {
      calls.push({ recipient, alert, key });
      return { status: 'success' as const, messageId: 'confirmed-after-reconcile', attempts: 1 };
    }) });
    await restarted.runBatch();

    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
    const settled = await NotificationDeliveryModel.findById(row._id).orFail();
    expect(settled.status).toBe('sent');
    expect(settled.firstAttemptAt).toEqual(firstAttemptAt);
    expect(settled.attempts).toBe(2);
  });

  it('never retries an uncertain email outside the safe Resend idempotency window', async () => {
    await fixture();
    const emailSender = vi.fn().mockResolvedValue({ status: 'unknown', code: 'provider_outcome_unknown', attempts: 1 });
    await worker({ emailSender }).runBatch();
    const row = await NotificationDeliveryModel.findOne({ channel: 'email' }).orFail();
    instant = new Date(row.firstAttemptAt!.getTime() + 24 * 60 * 60_000 - 20_000);
    await NotificationDeliveryModel.updateOne({ _id: row._id }, { $set: { availableAt: instant } });

    await worker({ emailSender }).runBatch();
    expect(emailSender).toHaveBeenCalledTimes(1);
    expect((await NotificationDeliveryModel.findById(row._id))?.status).toBe('unknown');
  });

  it.each([
    { status: 'permanent_failure', code: 'resend_api_key_missing', attempts: 0 },
    { status: 'retryable_failure', code: 'EXPLICIT_REJECTION', attempts: 1 },
    { status: 'unknown', code: 'network_outcome_unknown', attempts: 1 },
  ] satisfies DeliveryOutcome[])('retains earlier acceptance uncertainty after restart and later $status', async later => {
    await fixture();
    const firstSender = vi.fn().mockResolvedValue({ status: 'unknown', code: 'provider_outcome_unknown', attempts: 1 });
    await worker({ emailSender: firstSender, maxAttempts: 2 }).runBatch();
    const before = await NotificationDeliveryModel.findOne({ channel: 'email' }).select('+emailPayload +idempotencyKey').orFail();
    expect(before.emailUncertain).toBe(true);
    instant = new Date(instant.getTime() + 60_000);
    await mongoose.disconnect();
    await mongoose.connect(uri!, { dbName, autoIndex: false });
    const laterSender = vi.fn().mockResolvedValue(later);
    await Promise.all([
      worker({ emailSender: laterSender, maxAttempts: 2 }).runBatch(),
      worker({ emailSender: laterSender, maxAttempts: 2 }).runBatch(),
    ]);
    const after = await NotificationDeliveryModel.findById(before._id).select('+emailPayload +idempotencyKey').orFail();
    expect(laterSender).toHaveBeenCalledTimes(1);
    expect(laterSender).toHaveBeenCalledWith(before.emailPayload!.recipient, {
      gameTitle: before.emailPayload!.gameTitle, currentPriceCents: before.emailPayload!.currentPriceCents,
      targetPriceCents: before.emailPayload!.targetPriceCents, purchaseUrl: before.emailPayload!.purchaseUrl,
    }, before.idempotencyKey);
    expect(after.status).toBe('unknown');
    expect(after.emailUncertain).toBe(true);
    expect(after.attempts).toBe(2);
    expect(after.firstAttemptAt).toEqual(before.firstAttemptAt);
    expect(after.toObject().emailPayload).toEqual(before.toObject().emailPayload);
    instant = new Date(before.firstAttemptAt!.getTime() + 25 * 60 * 60_000);
    await worker({ emailSender: laterSender }).runBatch();
    expect(laterSender).toHaveBeenCalledTimes(1);
    expect((await NotificationDeliveryModel.findById(before._id))?.status).toBe('unknown');
  });

  it('only a same-key confirmed success resolves prior uncertainty, even after the original quote becomes stale', async () => {
    const data = await fixture();
    instant = new Date(instant.getTime() + 23 * 60 * 60_000);
    const firstSender = vi.fn().mockResolvedValue({ status: 'unknown', code: 'provider_outcome_unknown', attempts: 1 });
    await worker({ emailSender: firstSender }).runBatch();
    const before = await NotificationDeliveryModel.findOne({ channel: 'email' }).select('+emailPayload +idempotencyKey').orFail();
    await ProductModel.updateOne({ _id: data.product._id }, { $set: { lastError: 'MISSING_STEAM_OFFER', currentPriceMinor: null } });
    instant = new Date(instant.getTime() + 2 * 60 * 60_000);
    const success = vi.fn().mockResolvedValue({ status: 'success', messageId: 'same-key-confirmed', attempts: 1 });
    await worker({ emailSender: success }).runBatch();
    const after = await NotificationDeliveryModel.findById(before._id).select('+emailPayload +idempotencyKey +providerMessageId').orFail();
    expect(success).toHaveBeenCalledTimes(1);
    expect(success.mock.calls[0]).toEqual(firstSender.mock.calls[0]);
    expect(after.toObject().emailPayload).toEqual(before.toObject().emailPayload);
    expect(after.idempotencyKey).toBe(before.idempotencyKey);
    expect(after.emailUncertain).toBe(false);
    expect(after.status).toBe('sent');
    expect(after.providerMessageId).toBe('same-key-confirmed');
  });

  it('keeps uncertainty rather than cancelling an attempted email when its tracker is deleted', async () => {
    const data = await fixture();
    const emailSender = vi.fn().mockResolvedValue({ status: 'unknown', code: 'provider_outcome_unknown', attempts: 1 });
    await worker({ emailSender }).runBatch();
    const before = await NotificationDeliveryModel.findOne({ channel: 'email' }).select('+emailPayload').orFail();
    await TrackedItemModel.deleteOne({ _id: data.tracker._id });
    instant = new Date(instant.getTime() + 60_000);
    await worker({ emailSender }).runBatch();
    const after = await NotificationDeliveryModel.findById(before._id).select('+emailPayload').orFail();
    expect(emailSender).toHaveBeenCalledTimes(1);
    expect(after.status).toBe('unknown');
    expect(after.emailUncertain).toBe(true);
    expect(after.toObject().emailPayload).toEqual(before.toObject().emailPayload);
  });

  it('normalizes already-encoded CheapShark deal IDs without encoding percent escapes twice', async () => {
    const data = await fixture();
    const dealId = 'fixture%2Bencoded%3D';
    await PriceHistoryModel.collection.updateOne({ _id: data.observation._id }, { $set: { dealId } });
    await ProductModel.updateOne({ _id: data.product._id }, { $set: { dealId, purchaseUrl: cheapSharkPurchaseUrl(dealId) } });
    const emailSender = vi.fn().mockResolvedValue({ status: 'success', messageId: 'encoded-deal-message', attempts: 1 });
    await worker({ emailSender }).runBatch();
    expect(emailSender).toHaveBeenCalledTimes(1);
    expect(emailSender.mock.calls[0]?.[1].purchaseUrl).toBe('https://www.cheapshark.com/redirect?dealID=fixture%2Bencoded%3D');
  });

  it.each(['two_days_old', 'failed_check', 'missing_offer', 'newer_same_time_success'])(
    'defers an unsent episode until its recorded offer is current again: %s', async scenario => {
      const data = await fixture({ email: true, push: true });
      await registerDevice(data.user._id, 'freshness-token');
      if (scenario === 'two_days_old') instant = new Date(instant.getTime() + 2 * 86400000);
      if (scenario === 'failed_check') await ProductModel.updateOne({ _id: data.product._id }, {
        $set: { lastError: 'PROVIDER_FAILED', lastAttemptAt: instant },
      });
      if (scenario === 'missing_offer') await ProductModel.updateOne({ _id: data.product._id }, {
        $set: { dealId: null, purchaseUrl: null },
      });
      if (scenario === 'newer_success' || scenario === 'newer_same_time_success') {
        const observedAt = scenario === 'newer_success' ? instant : data.observation.observedAt;
        await PriceHistoryModel.create({
          productId: data.product._id, checkId: randomUUID(), priceMinor: 900, currency: 'USD',
          observedAt, source: 'CheapShark', dealId: 'newer-deal',
        });
        if (scenario === 'newer_success') await ProductModel.updateOne({ _id: data.product._id }, {
          $set: { lastSuccessfulCheckAt: observedAt, currentPriceMinor: 900, dealId: 'newer-deal', purchaseUrl: cheapSharkPurchaseUrl('newer-deal') },
        });
      }
      const emailSender = vi.fn();
      const pushSender = vi.fn();
      await worker({ emailSender, pushSender }).runBatch();
      expect(emailSender).not.toHaveBeenCalled();
      expect(pushSender).not.toHaveBeenCalled();
      const rows = await NotificationDeliveryModel.find({}).lean();
      expect(rows).toHaveLength(2);
      expect(rows.every(row => row.status === 'retryable' && row.firstAttemptAt === null)).toBe(true);
      expect(rows.every(row => row.attempts === 0)).toBe(true);
    },
  );

  it('sends the newest qualifying observation once after an unsent episode waits across checks', async () => {
    const data = await fixture({ email: true, push: true });
    await registerDevice(data.user._id, 'new-quote-token');
    const deliveryIds = (await NotificationDeliveryModel.find({}).lean()).map(row => String(row._id)).sort();
    const observedAt = new Date(instant.getTime() + 60_000);
    instant = observedAt;
    const newer = await PriceHistoryModel.create({ productId: data.product._id, checkId: randomUUID(),
      priceMinor: 800, currency: 'USD', observedAt, source: 'CheapShark', dealId: 'newer-deal' });
    await ProductModel.updateOne({ _id: data.product._id }, { $set: {
      currentPriceMinor: 800, lastSuccessfulCheckAt: observedAt, dealId: 'newer-deal', purchaseUrl: cheapSharkPurchaseUrl('newer-deal'),
    } });
    expect((await evaluateTrackerObservation(String(data.tracker._id), String(newer._id), instant)).status).toBe('below_target');
    const emailSender = vi.fn().mockResolvedValue({ status: 'success', messageId: 'latest', attempts: 1 });
    const pushSender = vi.fn().mockResolvedValue({ kind: 'accepted', providerMessageId: 'latest' });
    await Promise.all([worker({ emailSender, pushSender }).runBatch(), worker({ emailSender, pushSender }).runBatch()]);
    expect(emailSender).toHaveBeenCalledTimes(1);
    expect(emailSender.mock.calls[0]?.[1]).toMatchObject({ currentPriceCents: 800, purchaseUrl: cheapSharkPurchaseUrl('newer-deal') });
    expect(pushSender).toHaveBeenCalledTimes(1);
    expect(pushSender.mock.calls[0]?.[1]).toMatchObject({ eventId: data.episodeId, observedAt: observedAt.toISOString() });
    const rows = await NotificationDeliveryModel.find({}).lean();
    expect(rows.map(row => String(row._id)).sort()).toEqual(deliveryIds);
    expect(rows.every(row => row.status === 'sent' && String(row.observationId) === String(newer._id))).toBe(true);
    await worker({ emailSender, pushSender }).runBatch();
    expect(emailSender).toHaveBeenCalledTimes(1);
    expect(pushSender).toHaveBeenCalledTimes(1);
  });

  it('preserves unsent channels through a failed check and sends after a fresh success', async () => {
    const data = await fixture({ email: true, push: true });
    await registerDevice(data.user._id, 'recovery-token');
    await ProductModel.updateOne({ _id: data.product._id }, { $set: { lastError: 'CHECK_FAILED' } });
    const emailSender = vi.fn().mockResolvedValue({ status: 'success', messageId: 'recovered', attempts: 1 });
    const pushSender = vi.fn().mockResolvedValue({ kind: 'accepted', providerMessageId: 'recovered' });
    await worker({ emailSender, pushSender }).runBatch();
    expect(emailSender).not.toHaveBeenCalled();
    expect(pushSender).not.toHaveBeenCalled();
    instant = new Date(instant.getTime() + 60_000);
    await ProductModel.updateOne({ _id: data.product._id }, { $set: { lastError: null, lastSuccessfulCheckAt: instant } });
    const observation = await PriceHistoryModel.create({ productId: data.product._id, checkId: randomUUID(),
      priceMinor: 999, currency: 'USD', observedAt: instant, source: 'CheapShark', dealId: 'fixture-deal' });
    await evaluateTrackerObservation(String(data.tracker._id), String(observation._id), instant);
    await worker({ emailSender, pushSender }).runBatch();
    expect(emailSender).toHaveBeenCalledTimes(1);
    expect(pushSender).toHaveBeenCalledTimes(1);
    expect(await NotificationDeliveryModel.countDocuments()).toBe(2);
  });

  it('stores and sends a canonical purchase URL longer than 2048 characters', async () => {
    const data = await fixture();
    const dealId = '一'.repeat(256);
    const purchaseUrl = cheapSharkPurchaseUrl(dealId);
    expect(purchaseUrl.length).toBeGreaterThan(2048);
    expect(purchaseUrl.length).toBeLessThanOrEqual(4096);
    await PriceHistoryModel.collection.updateOne({ _id: data.observation._id }, { $set: { dealId } });
    await ProductModel.updateOne({ _id: data.product._id }, { $set: { dealId, purchaseUrl } });
    const emailSender = vi.fn().mockResolvedValue({ status: 'success', messageId: 'long-url', attempts: 1 });
    await worker({ emailSender }).runBatch();
    expect(emailSender).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ purchaseUrl }), expect.any(String));
    expect((await NotificationDeliveryModel.findOne().orFail()).status).toBe('sent');
  });

  it('preserves an accepted device when freshness changes before another device is invoked', async () => {
    const data = await fixture({ email: false, push: true });
    const { session } = await registerDevice(data.user._id, 'freshness-device-a');
    await registerDevice(data.user._id, 'freshness-device-b', session._id);
    const pushSender = vi.fn(async () => {
      await ProductModel.updateOne({ _id: data.product._id }, { $set: { lastError: 'CONCURRENT_FAILURE' } });
      return { kind: 'accepted' as const, providerMessageId: 'accepted-before-change' };
    });
    await worker({ pushSender }).runBatch();
    expect(pushSender).toHaveBeenCalledTimes(1);
    const deferred = await NotificationDeliveryModel.findOne().select('+pushDevices').orFail();
    expect(deferred.status).toBe('retryable');
    expect(deferred.attempts).toBe(1);
    expect(deferred.pushDevices?.map(device => device.status).sort()).toEqual(['accepted', 'pending']);
    expect(deferred.pushDevices?.find(device => device.status === 'pending')?.attempts).toBe(0);
    instant = new Date(instant.getTime() + 60_000);
    const retry = vi.fn().mockResolvedValue({ kind: 'accepted', providerMessageId: 'remaining-device' });
    await worker({ pushSender: retry }).runBatch();
    expect(retry).toHaveBeenCalledTimes(1);
    expect((await NotificationDeliveryModel.findOne().orFail()).status).toBe('sent');
  });

  it('persists push outcomes per device and never resends a successful device', async () => {
    const data = await fixture({ email: false, push: true });
    const { session } = await registerDevice(data.user._id, 'fixture-token-a');
    await registerDevice(data.user._id, 'fixture-token-b', session._id);
    let retryB = true;
    const calls: Array<{ token: string; event: unknown }> = [];
    const pushSender = vi.fn(async (token: string, event: unknown) => {
      calls.push({ token, event });
      if (token === 'fixture-token-b' && retryB) {
        retryB = false;
        return { kind: 'retryable' as const, code: 'FCM_RETRY_LATER', retryAfterSeconds: 60 };
      }
      return { kind: 'accepted' as const, providerMessageId: `accepted-${token}` };
    });
    const service = worker({ pushSender });

    await Promise.all([service.runBatch(), worker({ pushSender }).runBatch()]);
    const row = await NotificationDeliveryModel.findOne({ channel: 'push' }).select('+pushDevices +pushPayload').orFail();
    expect(row.status).toBe('retryable');
    expect(row.pushDevices?.filter(device => device.status === 'accepted')).toHaveLength(1);
    expect(row.pushDevices?.filter(device => device.status === 'retryable')).toHaveLength(1);
    const retryDevice = row.pushDevices!.find(device => device.status === 'retryable')!;
    expect(retryDevice.availableAt.getTime()).toBe(instant.getTime() + 60_000);
    expect(retryDevice.lastErrorCode).toBe('FCM_RETRY_LATER');
    const deliveryId = String(row._id);
    instant = new Date(instant.getTime() + 60_000);
    await mongoose.disconnect();
    await mongoose.connect(uri!, { dbName, autoIndex: false });
    await worker({ pushSender }).runBatch();

    expect(calls.filter(call => call.token === 'fixture-token-a')).toHaveLength(1);
    expect(calls.filter(call => call.token === 'fixture-token-b')).toHaveLength(2);
    expect((await NotificationDeliveryModel.findById(row._id))?.status).toBe('sent');
    const finalDevices = (await NotificationDeliveryModel.findById(row._id).select('+pushDevices').orFail()).pushDevices!;
    expect(finalDevices.every(device => device.status === 'accepted' && device.providerMessageId?.startsWith('accepted-'))).toBe(true);
    expect(finalDevices.map(device => device.attempts).sort()).toEqual([1, 2]);
    for (const call of calls) {
      expect(call.event).toMatchObject({ eventId: data.episodeId, deliveryId, recipientSessionId: String(session._id) });
    }
  });

  it('deactivates only an invalid token and retains terminal per-device state', async () => {
    const data = await fixture({ email: false, push: true });
    const { device } = await registerDevice(data.user._id, 'fixture-invalid-token');
    const pushSender = vi.fn().mockResolvedValue({ kind: 'permanent_failure', code: 'FCM_INVALID_TOKEN', invalidToken: true });
    await worker({ pushSender }).runBatch();
    expect((await DeviceModel.findById(device._id))?.active).toBe(false);
    expect((await NotificationDeliveryModel.findOne({ channel: 'push' }))?.status).toBe('permanent_failure');
    expect(pushSender).toHaveBeenCalledTimes(1);
  });

  it('stops retrying a device after the configured explicit-rejection attempt limit', async () => {
    const data = await fixture({ email: false, push: true });
    await registerDevice(data.user._id, 'fixture-rate-limited-token');
    const pushSender = vi.fn().mockResolvedValue({ kind: 'retryable', code: 'FCM_RETRY_LATER', retryAfterSeconds: 60 });
    const service = worker({ pushSender, maxAttempts: 3 });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await service.runBatch();
      if (attempt < 2) instant = new Date(instant.getTime() + 60_000 * 2 ** attempt);
    }

    const row = await NotificationDeliveryModel.findOne({ channel: 'push' }).select('+pushDevices').orFail();
    expect(pushSender).toHaveBeenCalledTimes(3);
    expect(row.status).toBe('permanent_failure');
    expect(row.pushDevices?.[0]?.status).toBe('permanent_failure');
    expect(row.pushDevices?.[0]?.attempts).toBe(3);
  });

  it('does not send after the tracker is disabled before claim', async () => {
    const data = await fixture();
    const emailSender = vi.fn();
    await TrackedItemModel.updateOne({ _id: data.tracker._id }, { $set: { enabled: false } });
    await NotificationDeliveryModel.updateMany({ trackedItemId: data.tracker._id }, { $set: { status: 'pending' } });
    await worker({ emailSender }).runBatch();
    expect(emailSender).not.toHaveBeenCalled();
    expect((await NotificationDeliveryModel.findOne({ channel: 'email' }))?.status).toBe('cancelled');
  });

  it('atomically claims overlapping email work once', async () => {
    await fixture();
    const emailSender = vi.fn().mockResolvedValue({ status: 'success', messageId: 'one-claim', attempts: 1 });
    const first = worker({ emailSender });
    const second = worker({ emailSender });
    const results = await Promise.all([first.runBatch(), second.runBatch()]);
    expect(results.reduce((sum, result) => sum + result.claimed, 0)).toBe(1);
    expect(emailSender).toHaveBeenCalledTimes(1);
    expect((await NotificationDeliveryModel.findOne({ channel: 'email' }))?.status).toBe('sent');
  });

  it('recovers an expired email claim by same-key reconciliation and fences its old owner', async () => {
    await fixture();
    let releaseFirst!: (value: { status: 'success'; messageId: string; attempts: number }) => void;
    let notifyFirst!: () => void;
    const entered = new Promise<void>(resolve => { notifyFirst = resolve; });
    const calls: Array<{ recipient: string; alert: unknown; key: string }> = [];
    const firstSender = vi.fn((recipient: string, alert: unknown, key: string) => {
      calls.push({ recipient, alert, key });
      notifyFirst();
      return new Promise<{ status: 'success'; messageId: string; attempts: number }>(resolve => { releaseFirst = resolve; });
    });
    const firstRun = worker({ emailSender: firstSender }).runBatch();
    await entered;
    const row = await NotificationDeliveryModel.findOne({ channel: 'email' }).orFail();
    await NotificationDeliveryModel.updateOne({ _id: row._id }, { $set: { leaseUntil: new Date(instant.getTime() - 1) } });

    const recoverySender = vi.fn(async (recipient, alert, key) => {
      calls.push({ recipient, alert, key });
      return { status: 'success' as const, messageId: 'reconciled', attempts: 1 };
    });
    await worker({ emailSender: recoverySender }).runBatch();
    releaseFirst({ status: 'success', messageId: 'late-old-owner', attempts: 1 });
    await firstRun;

    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
    expect((await NotificationDeliveryModel.findById(row._id).select('+providerMessageId'))?.providerMessageId).toBe('reconciled');
    expect((await NotificationDeliveryModel.findById(row._id))?.status).toBe('sent');
  });

  it('marks an expired in-flight FCM attempt unknown and never resends it', async () => {
    const data = await fixture({ email: false, push: true });
    await registerDevice(data.user._id, 'fixture-slow-token');
    let release!: (value: { kind: 'accepted'; providerMessageId: string }) => void;
    let notify!: () => void;
    const entered = new Promise<void>(resolve => { notify = resolve; });
    const slowSender = vi.fn(() => {
      notify();
      return new Promise<{ kind: 'accepted'; providerMessageId: string }>(resolve => { release = resolve; });
    });
    const firstRun = worker({ pushSender: slowSender }).runBatch();
    await entered;
    const row = await NotificationDeliveryModel.findOne({ channel: 'push' }).orFail();
    await NotificationDeliveryModel.updateOne({ _id: row._id }, { $set: { leaseUntil: new Date(instant.getTime() - 1) } });

    const recoverySender = vi.fn().mockResolvedValue({ kind: 'accepted', providerMessageId: 'must-not-send-again' });
    await worker({ pushSender: recoverySender }).runBatch();
    release({ kind: 'accepted', providerMessageId: 'late-provider-acceptance' });
    await firstRun;

    expect(slowSender).toHaveBeenCalledTimes(1);
    expect(recoverySender).not.toHaveBeenCalled();
    expect((await NotificationDeliveryModel.findById(row._id))?.status).toBe('unknown');
  });
});
