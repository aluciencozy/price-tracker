import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabaseIndexes } from '../src/models/index.js';
import { UserModel, AuthTokenModel } from '../src/models/account.js';
import { VerificationMailModel } from '../src/models/verificationMail.js';
import { EmailBudgetModel } from '../src/models/emailBudget.js';
import { ProductModel } from '../src/models/product.js';
import { TrackedItemModel, PriceHistoryModel, NotificationDeliveryModel } from '../src/models/tracking.js';
import { requestPasswordReset } from '../src/passwordReset.js';
import { dispatchPasswordResetMail, recoverVerificationMail } from '../src/verificationDispatch.js';
import { evaluateTrackerObservation } from '../src/alertEpisodes.js';
import { createPriceAlertDeliveryWorker } from '../src/alertDeliveryWorker.js';
import { reserveEmailSend } from '../src/emailBudget.js';
import { EmailSendDeferred, sendWithOutcome, type EmailSender } from '../src/emails.js';

const uri = process.env.TEST_MONGODB_URI;
describe.skipIf(!uri)('shared budget through real account and price queues', () => {
  const dbName = `price_tracker_test_${randomUUID().replaceAll('-', '')}`;
  const transport = vi.fn<EmailSender>(async () => ({ data: { id: 'fixture-accepted' }, error: null, headers: null }));
  const budget = () => reserveEmailSend({ dailyLimit: 3, monthlyLimit: 3 });
  const send = (key: string) => sendWithOutcome({ from: 'fixture@example.invalid', to: 'fixture@example.invalid', subject: 'Fixture', text: 'Offline' }, key, transport, budget);
  beforeAll(async () => {
    if (!/^price_tracker_test_[a-f0-9]{32}$/.test(dbName)) throw new Error('Not a disposable database');
    await mongoose.connect(uri!, { dbName, autoIndex: false, serverSelectionTimeoutMS: 5000 });
    if (mongoose.connection.name !== dbName) throw new Error('Unexpected database');
    await createDatabaseIndexes();
  }, 30_000);
  beforeEach(async () => {
    await Promise.all([UserModel.deleteMany({}), AuthTokenModel.deleteMany({}), VerificationMailModel.deleteMany({}), EmailBudgetModel.deleteMany({}),
      ProductModel.deleteMany({}), TrackedItemModel.deleteMany({}), PriceHistoryModel.deleteMany({}), NotificationDeliveryModel.deleteMany({})]);
    transport.mockClear();
  });
  afterAll(async () => {
    if (mongoose.connection.name === dbName) await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
  async function fixture() {
    const user = await UserModel.create({ email: 'fixture@example.invalid', passwordHash: 'fixture', emailVerifiedAt: new Date() });
    const product = await ProductModel.create({ provider: 'cheapshark', providerGameId: '36', steamAppId: '620', storeId: '1', market: 'US', currency: 'USD', title: 'Portal 2', canonicalSteamUrl: 'https://store.steampowered.com/app/620/', currentPriceMinor: 999, lastSuccessfulCheckAt: new Date(), lastError: null, dealId: 'fixture', purchaseUrl: 'https://www.cheapshark.com/redirect?dealID=fixture' });
    const observation = await PriceHistoryModel.create({ productId: product._id, checkId: randomUUID(), priceMinor: 999, currency: 'USD', source: 'CheapShark', dealId: 'fixture', observedAt: product.lastSuccessfulCheckAt! });
    const tracker = await TrackedItemModel.create({ userId: user._id, productId: product._id, targetPriceMinor: 1000, alerts: { email: true, push: false } });
    await evaluateTrackerObservation(String(tracker._id), String(observation._id));
    await requestPasswordReset(user.email);
    return { user };
  }
  const worker = (sender = (_recipient: string, _alert: unknown, key: string) => send(key)) => createPriceAlertDeliveryWorker({
    emailSender: sender, pushSender: async () => { throw new Error('Push must not run'); },
  });
  it('serializes account and price reservations and defers the loser without consuming an attempt', async () => {
    await fixture();
    await Promise.all([dispatchPasswordResetMail(({ token }) => send(`reset-${token}`)), worker().runBatch()]);
    expect(transport).toHaveBeenCalledTimes(1);
    expect((await EmailBudgetModel.findOne().lean())?.reservations).toHaveLength(3);
    const account = await VerificationMailModel.findOne().orFail();
    const price = await NotificationDeliveryModel.findOne().orFail();
    expect([account.status, price.status].filter(status => status === 'sent')).toHaveLength(1);
    if (account.status === 'pending') {
      expect(account.availableAt!.getTime()).toBeGreaterThan(Date.now());
      expect(account.startedAt).toBeNull();
      const token = await AuthTokenModel.findOne().select('+tokenHash').orFail();
      expect(token.tokenHash).toBe(account.generationHash);
    } else {
      expect(price.status).toBe('pending'); expect(price.attempts).toBe(0); expect(price.firstAttemptAt).toBeNull();
    }
  });
  it('preserves unknown price outcome, original snapshot, key, attempts and window on quota defer', async () => {
    await fixture();
    await worker(async () => ({ status: 'unknown', code: 'fixture_unknown', attempts: 1 })).runBatch();
    const prior = await NotificationDeliveryModel.findOne().select('+emailPayload +idempotencyKey').orFail();
    await NotificationDeliveryModel.updateOne({ _id: prior._id }, { $set: { availableAt: new Date(0) } });
    await reserveEmailSend({ dailyLimit: 3, monthlyLimit: 3 });
    await worker().runBatch();
    const after = await NotificationDeliveryModel.findById(prior._id).select('+emailPayload +idempotencyKey').orFail();
    expect(after.status).toBe('unknown'); expect(after.emailUncertain).toBe(true);
    expect(after.attempts).toBe(prior.attempts); expect(after.firstAttemptAt).toEqual(prior.firstAttemptAt);
    expect(after.toObject().emailPayload).toEqual(prior.toObject().emailPayload); expect(after.idempotencyKey).toBe(prior.idempotencyKey);
    expect(transport).not.toHaveBeenCalled();
  });
  it('keeps a deferred reset token expiry unchanged and expires pending work without sending', async () => {
    await fixture();
    const prior = await AuthTokenModel.findOne().orFail();
    await dispatchPasswordResetMail(async () => { throw new EmailSendDeferred(60_000); });
    expect((await AuthTokenModel.findById(prior._id).orFail()).expiresAt).toEqual(prior.expiresAt);
    await recoverVerificationMail(new Date(prior.expiresAt.getTime() + 1));
    expect((await VerificationMailModel.findOne().orFail()).status).toBe('superseded');
    expect(await dispatchPasswordResetMail(({ token }) => send(token))).toBe(false);
    expect(transport).not.toHaveBeenCalled();
  });
});
