import { describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { UserModel, AuthTokenModel } from '../src/models/account.js';
import { TrackedItemModel, PriceHistoryModel, NotificationDeliveryModel } from '../src/models/tracking.js';
import { DeviceModel } from '../src/models/device.js';
import { ProductModel } from '../src/models/product.js';

const owner = new Types.ObjectId();
const product = new Types.ObjectId();
describe('database contract validation', () => {
  it.each([0, 999, Number.MAX_SAFE_INTEGER])('accepts USD cents %s', async (targetPriceMinor) => {
    await expect(new TrackedItemModel({ userId: owner, productId: product, targetPriceMinor }).validate()).resolves.toBeUndefined();
  });
  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid cents %s', async (targetPriceMinor) => {
    await expect(new TrackedItemModel({ userId: owner, productId: product, targetPriceMinor }).validate()).rejects.toThrow();
  });
  it('does not default a missing target to zero', async () => {
    await expect(new TrackedItemModel({ userId: owner, productId: product }).validate()).rejects.toThrow();
  });
  it('rejects another currency and unrecognized private fields', async () => {
    await expect(new TrackedItemModel({ userId: owner, productId: product, targetPriceMinor: 0, currency: 'EUR' }).validate()).rejects.toThrow();
    expect(() => new TrackedItemModel({ userId: owner, productId: product, targetPriceMinor: 0, arbitrary: true })).toThrow();
  });
  it('normalizes email and keeps sensitive fields out of default query projections', () => {
    expect(new UserModel({ email: '  TEST@EXAMPLE.INVALID ', passwordHash: 'test-only' }).email).toBe('test@example.invalid');
    expect(UserModel.schema.path('passwordHash').options.select).toBe(false);
    expect(AuthTokenModel.schema.path('tokenHash').options.select).toBe(false);
    expect(DeviceModel.schema.path('pushToken').options.select).toBe(false);
  });
  it('requires SHA-256 token hashes, never raw verification tokens', async () => {
    await expect(new AuthTokenModel({ userId: owner, purpose: 'verify_email', tokenHash: 'raw-token', expiresAt: new Date() }).validate()).rejects.toThrow();
  });
  it.each([
    '019a50a0-0000-7000-8000-000000000001',
    '019a50a0-0000-8000-8000-000000000001',
    'A19A50A0-0000-4000-8000-000000000001',
  ])('accepts and normalizes installation UUID %s', async installationId => {
    const device = new DeviceModel({ userId: owner, sessionId: new Types.ObjectId(), installationId, platform: 'android', pushToken: 'offline-fixture' });
    await expect(device.validate()).resolves.toBeUndefined();
    expect(device.installationId).toBe(installationId.toLowerCase());
  });
  it.each(['not-a-uuid', '019a50a0-0000-9000-8000-000000000001', '019a50a0-0000-7000-0000-000000000001'])('rejects malformed installation UUID %s', async installationId => {
    const device = new DeviceModel({ userId: owner, sessionId: new Types.ObjectId(), installationId, platform: 'android', pushToken: 'offline-fixture' });
    await expect(device.validate()).rejects.toThrow();
  });
  it('retains nullable prices while rejecting fractional and unsafe product prices', async () => {
    const base = { provider: 'cheapshark', providerGameId: '36', steamAppId: '620', storeId: '1', market: 'US', currency: 'USD', canonicalSteamUrl: 'https://store.steampowered.com/app/620/', title: 'Portal 2' };
    await expect(new ProductModel(base).validate()).resolves.toBeUndefined();
    for (const currentPriceMinor of [0.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(new ProductModel({ ...base, currentPriceMinor }).validate()).rejects.toThrow();
    }
  });
  it('keeps history immutable and separate from transient delivery status', () => {
    expect(PriceHistoryModel.schema.path('priceMinor').options.immutable).toBe(true);
    expect(PriceHistoryModel.schema.path('observedAt').options.immutable).toBe(true);
    expect(NotificationDeliveryModel.schema.indexes()).toContainEqual([
      { trackedItemId: 1, episodeId: 1, channel: 1 }, { unique: true },
    ]);
  });
});
