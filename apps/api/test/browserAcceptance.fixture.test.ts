import { randomUUID } from 'node:crypto';
import express from 'express';
import mongoose, { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedBrowserProducts } from './fixtures/browserAcceptance.js';
import { createDatabaseIndexes } from '../src/models/index.js';
import { ProductModel } from '../src/models/product.js';
import { PriceHistoryModel, TrackedItemModel } from '../src/models/tracking.js';
import { createHistoryRouter } from '../src/historyRouter.js';

const uri = 'mongodb://127.0.0.1:27119/?replicaSet=pt_mvp_test';
describe.skipIf(process.env.TEST_MONGODB_URI !== uri)('guarded browser history fixture', () => {
  const dbName = `price_tracker_test_browser_${randomUUID().replaceAll('-', '')}`;
  const owner = new Types.ObjectId();
  const stranger = new Types.ObjectId();
  const app = (userId: Types.ObjectId) => express().use('/api', createHistoryRouter(
    async () => ({ userId: String(userId) }), 'browser-fixture-cursor-secret-at-least-32-bytes'));
  beforeAll(async () => {
    process.env.BROWSER_TEST_DISPOSABLE = '1';
    await mongoose.connect(uri, { dbName, autoIndex: false, serverSelectionTimeoutMS: 5000 });
    await createDatabaseIndexes();
  });
  beforeEach(async () => {
    await Promise.all([ProductModel.deleteMany({}), PriceHistoryModel.deleteMany({}), TrackedItemModel.deleteMany({})]);
  });
  afterAll(async () => {
    if (mongoose.connection.name === dbName) await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
    delete process.env.BROWSER_TEST_DISPOSABLE;
  });
  it('refuses an unexpected database or missing disposable opt-in', async () => {
    await expect(seedBrowserProducts('production', true)).rejects.toThrow('Refusing');
    delete process.env.BROWSER_TEST_DISPOSABLE;
    await expect(seedBrowserProducts(dbName, true)).rejects.toThrow('Refusing');
    process.env.BROWSER_TEST_DISPOSABLE = '1';
    expect(await ProductModel.countDocuments()).toBe(0);
  });
  it('keeps the default history empty', async () => {
    await seedBrowserProducts(dbName, false);
    expect(await ProductModel.countDocuments()).toBe(2);
    expect(await PriceHistoryModel.countDocuments()).toBe(0);
  });
  it('returns only ordered, bounded exact-product rows to the tracker owner', async () => {
    const now = new Date();
    await seedBrowserProducts(dbName, true, now);
    for (const [steamAppId, prices] of [['620', [1499, 1199, 999]], ['220', [799, 1299, 999]]] as const) {
      const product = await ProductModel.findOne({ steamAppId }).orFail();
      const tracker = await TrackedItemModel.create({ userId: owner, productId: product._id, targetPriceMinor: 1000 });
      // A row for a different product/store identity must not leak into this tracker.
      await PriceHistoryModel.create({ productId: new Types.ObjectId(), checkId: `wrong-store-${steamAppId}`,
        priceMinor: 1, currency: 'USD', observedAt: new Date(now.getTime() - 1000), source: 'CheapShark', dealId: 'fixture' });
      const response = await request(app(owner)).get(`/api/tracked-items/${tracker._id}/history`).expect(200);
      expect(response.body.product).toMatchObject({ steamAppId, currentPrice: { amountMinor: 999, currency: 'USD' } });
      expect(response.body.items.map((row: { price: { amountMinor: number; currency: string } }) => row.price))
        .toEqual(prices.map(amountMinor => ({ amountMinor, currency: 'USD' })));
      expect(response.body.items.map((row: { observedAt: string }) => row.observedAt)).toEqual([2, 1, 0].map(days => new Date(now.getTime() - days * 86400000 - 60000).toISOString()));
      expect(response.body.items.every((row: { providerChangedAt: null }) => row.providerChangedAt === null)).toBe(true);
      expect(response.body.page.nextCursor).toBeNull();
      const bounded = await request(app(owner)).get(`/api/tracked-items/${tracker._id}/history`)
        .query({ from: new Date(now.getTime() - 86400000 - 60000).toISOString(), to: now.toISOString() }).expect(200);
      expect(bounded.body.items).toHaveLength(2);
      await request(app(stranger)).get(`/api/tracked-items/${tracker._id}/history`).expect(404);
      const rows = await PriceHistoryModel.find({ productId: product._id }).sort({ observedAt: 1 });
      expect(rows.map(row => row.checkId)).toEqual([1, 2, 3].map(n => `browser-qa-${steamAppId}-${n}`));
    }
  });
});
