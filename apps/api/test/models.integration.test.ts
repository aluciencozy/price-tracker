import mongoose, { Types } from 'mongoose';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabaseIndexes } from '../src/models/index.js';
import { UserModel, AuthTokenModel } from '../src/models/account.js';
import { TrackedItemModel, PriceHistoryModel, NotificationDeliveryModel } from '../src/models/tracking.js';
import { DeviceModel } from '../src/models/device.js';
import { ProductModel } from '../src/models/product.js';
import { seedCatalog, verifyTransactions } from '../src/databaseSetup.js';

// Only an explicit test URI enables these tests. A fresh isolated database is
// selected regardless of the URI's path; no production database is ever dropped.
const uri = process.env.TEST_MONGODB_URI;
describe.skipIf(!uri)('MongoDB indexes and persistence', () => {
  const dbName = `price_tracker_test_${randomUUID().replaceAll('-', '')}`;
  const userId = new Types.ObjectId();
  const productId = new Types.ObjectId();
  beforeAll(async () => {
    await mongoose.connect(uri!, { dbName, serverSelectionTimeoutMS: 5000, autoIndex: false });
    await createDatabaseIndexes();
    await createDatabaseIndexes();
  }, 30000);
  afterAll(async () => {
    if (mongoose.connection.name === dbName) await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
  it('serializes concurrent creation of a user/product tracker through the unique index', async () => {
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => TrackedItemModel.create({ userId, productId, targetPriceMinor: 999 })));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(7);
    expect(await TrackedItemModel.countDocuments({ userId, productId })).toBe(1);
  });
  it('deduplicates a check without discarding another successful same-price observation', async () => {
    const row = { productId, checkId: 'run-one', priceMinor: 0, currency: 'USD' as const, observedAt: new Date(), source: 'CheapShark' as const, dealId: 'fixture-only' };
    await PriceHistoryModel.create(row);
    await expect(PriceHistoryModel.create(row)).rejects.toMatchObject({ code: 11000 });
    await PriceHistoryModel.create({ ...row, checkId: 'run-two' });
    expect(await PriceHistoryModel.countDocuments({ productId })).toBe(2);
  });
  it('deduplicates each episode/channel independently and survives reconnect', async () => {
    const tracker = await TrackedItemModel.findOne({ userId, productId }).orFail();
    const row = { trackedItemId: tracker._id, userId, productId, observationId: new Types.ObjectId(), episodeId: 'episode-one' };
    await NotificationDeliveryModel.create({ ...row, channel: 'email', status: 'sent' });
    await NotificationDeliveryModel.create({ ...row, channel: 'push', status: 'retryable' });
    await mongoose.disconnect();
    await mongoose.connect(uri!, { dbName, autoIndex: false });
    await expect(NotificationDeliveryModel.create({ ...row, channel: 'email' })).rejects.toMatchObject({ code: 11000 });
    expect((await NotificationDeliveryModel.findOne({ ...row, channel: 'push' }))?.status).toBe('retryable');
  });
  it('enforces normalized email uniqueness and excludes stored secrets by default', async () => {
    await UserModel.create({ email: ' TEST@example.invalid ', passwordHash: 'hash-fixture' });
    await expect(UserModel.create({ email: 'test@EXAMPLE.INVALID', passwordHash: 'other' })).rejects.toMatchObject({ code: 11000 });
    const found = await UserModel.findOne({ email: 'test@example.invalid' }).lean();
    expect(found).not.toHaveProperty('passwordHash');
  });
  it('prevents a push token or installation from being bound twice', async () => {
    const row = { userId, sessionId: new Types.ObjectId(), installationId: randomUUID(), platform: 'android' as const, pushToken: 'fixture-token' };
    await DeviceModel.create(row);
    await expect(DeviceModel.create({ ...row, installationId: randomUUID() })).rejects.toMatchObject({ code: 11000 });
    await expect(DeviceModel.create({ ...row, pushToken: 'another-token' })).rejects.toMatchObject({ code: 11000 });
    expect(await DeviceModel.findOne({ installationId: row.installationId }).lean()).not.toHaveProperty('pushToken');
  });
  it('installs expiry indexes while services must still check expiry at use time', async () => {
    const indexes = await AuthTokenModel.collection.indexes();
    expect(indexes.find(index => index.key.expiresAt === 1)?.expireAfterSeconds).toBe(0);
    const historyIndexes = await PriceHistoryModel.collection.indexes();
    expect(historyIndexes.find(index => index.key.observedAt === 1 && index.expireAfterSeconds)?.expireAfterSeconds).toBe(90 * 86400);
  });
  it('seeds metadata repeatably without fabricating or overwriting live observations', async () => {
    await seedCatalog();
    expect(await ProductModel.countDocuments()).toBe(2);
    const portal = await ProductModel.findOne({ steamAppId: '620' }).orFail();
    expect(portal.currentPriceMinor).toBeNull();
    expect(portal.lastSuccessfulCheckAt).toBeNull();
    await ProductModel.updateOne({ _id: portal._id }, { $set: { currentPriceMinor: 500 } });
    await seedCatalog();
    expect(await ProductModel.countDocuments()).toBe(2);
    expect((await ProductModel.findById(portal._id))?.currentPriceMinor).toBe(500);
  });
  it('proves transaction rollback and commit, then removes only its own probe', async () => {
    await verifyTransactions();
    expect(await mongoose.connection.db!.collection('infrastructureprobes').countDocuments()).toBe(0);
  });
});
