import { randomUUID } from 'node:crypto';
import mongoose, { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import express from 'express';
import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { createDatabaseIndexes } from '../src/models/index.js';
import { ProductModel } from '../src/models/product.js';
import { PriceHistoryModel, TrackedItemModel } from '../src/models/tracking.js';
import { createHistoryService, HistoryError, recordObservation } from '../src/history.js';
import { createHistoryRouter } from '../src/historyRouter.js';
import type { SteamOffer } from '../src/cheapshark.js';

const uri = process.env.TEST_MONGODB_URI;
describe.skipIf(!uri)('successful observation history and owned reads', () => {
  const dbName = `price_tracker_test_${randomUUID().replaceAll('-', '')}`;
  const owner = new Types.ObjectId();
  const stranger = new Types.ObjectId();
  const now = new Date();
  const read = createHistoryService('offline-fixture-secret-with-32-bytes');
  let productId: string;
  let trackerId: string;
  const offer = (amount = 999, at = now): SteamOffer => ({
    identity: { provider: 'cheapshark', providerGameId: '36', storeId: '1', market: 'US', currency: 'USD' },
    steamAppId: '620', canonicalSteamUrl: 'https://store.steampowered.com/app/620/', title: 'Portal 2', storeName: 'Steam',
    source: { name: 'CheapShark', url: 'https://www.cheapshark.com/', attribution: 'offline fixture' },
    currentPrice: { amountMinor: amount, currency: 'USD' }, retailPrice: null,
    dealId: 'fixture', purchaseUrl: 'https://www.cheapshark.com/redirect?dealID=fixture',
    observedAt: at.toISOString(), providerChangedAt: null,
  });
  async function claim() {
    await ProductModel.updateOne({ _id: productId }, { $set: { refreshLeaseToken: 'worker', refreshLeaseUntil: new Date(now.getTime() + 60000) } });
  }
  beforeAll(async () => {
    await mongoose.connect(uri!, { dbName, autoIndex: false, serverSelectionTimeoutMS: 5000 });
    await createDatabaseIndexes();
  });
  beforeEach(async () => {
    await Promise.all([ProductModel.deleteMany({}), TrackedItemModel.deleteMany({}), PriceHistoryModel.deleteMany({})]);
    const product = await ProductModel.create({ provider: 'cheapshark', providerGameId: '36', steamAppId: '620', storeId: '1', market: 'US', currency: 'USD', canonicalSteamUrl: 'https://store.steampowered.com/app/620/', title: 'Portal 2' });
    productId = String(product._id);
    trackerId = String((await TrackedItemModel.create({ userId: owner, productId, targetPriceMinor: 1000 }))._id);
    await claim();
  });
  afterAll(async () => {
    if (mongoose.connection.name === dbName) await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
  it('commits valid zero and cache metadata together; retries do not duplicate history', async () => {
    const first = await recordObservation(productId, 'run_one', 'worker', offer(0), now);
    const replay = await recordObservation(productId, 'run_one', 'worker', offer(0), now);
    expect(String(replay._id)).toBe(String(first._id));
    expect(await PriceHistoryModel.countDocuments()).toBe(1);
    expect((await ProductModel.findById(productId))?.currentPriceMinor).toBe(0);
    await expect(recordObservation(productId, 'run_one', 'worker', offer(1), now)).rejects.toThrow('Conflicting replay');
    expect(await PriceHistoryModel.countDocuments()).toBe(1);
  });
  it('fences a lost lease without inserting history or changing the retained price', async () => {
    await expect(recordObservation(productId, 'run_one', 'wrong-worker', offer(), now)).rejects.toThrow('lease lost');
    expect(await PriceHistoryModel.countDocuments()).toBe(0);
    expect((await ProductModel.findById(productId))?.currentPriceMinor).toBeNull();
  });
  it('rejects stale, future, malformed, wrong-store and missing prices', async () => {
    const invalid = [
      offer(0.1), offer(-1), offer(Number.MAX_SAFE_INTEGER + 1),
      offer(1, new Date(now.getTime() - 86400001)), offer(1, new Date(now.getTime() + 1)),
      { ...offer(), currentPrice: null },
      { ...offer(), identity: { ...offer().identity, storeId: '7' } },
      { ...offer(), purchaseUrl: 'https://example.invalid/' },
    ];
    for (const item of invalid) await expect(recordObservation(productId, 'bad', 'worker', item as SteamOffer, now)).rejects.toThrow();
    expect(await PriceHistoryModel.countDocuments()).toBe(0);
  });
  it('keeps product identity stable across new deals and records separate successful same-price checks', async () => {
    await recordObservation(productId, 'one', 'worker', offer(), now);
    await claim();
    await recordObservation(productId, 'two', 'worker', { ...offer(), dealId: 'new-deal', purchaseUrl: 'https://www.cheapshark.com/redirect?dealID=new-deal' }, now);
    expect(await ProductModel.countDocuments()).toBe(1);
    expect(await PriceHistoryModel.countDocuments()).toBe(2);
  });
  it('rejects wrong game identity atomically', async () => {
    await expect(recordObservation(productId, 'wrong-game', 'worker', { ...offer(), identity: { ...offer().identity, providerGameId: '59' } }, now)).rejects.toThrow();
    expect(await PriceHistoryModel.countDocuments()).toBe(0);
  });
  it('returns the same safe 404 for foreign and missing trackers', async () => {
    await expect(read(String(stranger), trackerId, {}, now)).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    await expect(read(String(owner), String(new Types.ObjectId()), {}, now)).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });
  it('paginates equal timestamps once each and keeps the original default window', async () => {
    const at = new Date(now.getTime() - 10000);
    for (let index = 0; index < 3; index++) {
      await PriceHistoryModel.create({ productId, checkId: `row${index}`, priceMinor: index, currency: 'USD', observedAt: at, source: 'CheapShark', dealId: 'fixture' });
    }
    const first = await read(String(owner), trackerId, { limit: '2' }, now);
    const second = await read(String(owner), trackerId, { limit: '2', cursor: first.page.nextCursor }, new Date(now.getTime() + 1000));
    expect(first.items).toHaveLength(2);
    expect(second.items).toHaveLength(1);
    expect(new Set([...first.items, ...second.items].map(row => row.id)).size).toBe(3);
    expect(second.window).toEqual(first.window);
    expect(second.page.nextCursor).toBeNull();
    await expect(read(String(owner), trackerId, { cursor: `${first.page.nextCursor}x` }, now)).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
    await expect(read(String(owner), trackerId, { cursor: first.page.nextCursor, from: new Date(now.getTime() - 1000).toISOString() }, now)).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
  });
  it('uses an exclusive upper bound and reports empty history without fabricating points', async () => {
    await recordObservation(productId, 'one', 'worker', offer(), now);
    const result = await read(String(owner), trackerId, { from: new Date(now.getTime() - 1000).toISOString(), to: now.toISOString() }, now);
    expect(result.items).toHaveLength(0);
    expect(result.retainedFrom).toBe(new Date(now.getTime() - 90 * 86400000).toISOString());
  });
  it('returns stale retained product data without another provider request', async () => {
    await recordObservation(productId, 'one', 'worker', offer(), now);
    await ProductModel.updateOne({ _id: productId }, { $set: { lastError: 'sanitized failure', lastAttemptAt: now } });
    const result = await read(String(owner), trackerId, {}, now);
    expect(result.product.freshness).toBe('stale');
    expect(result.product.currentPrice?.amountMinor).toBe(999);
    expect(result).not.toHaveProperty('targetPriceMinor');
  });
  it('enforces strict query bounds', async () => {
    for (const query of [{ limit: '101' }, { limit: '1e2' }, { extra: 'x' }, { from: '2026-02-30T00:00:00Z' }, { from: now.toISOString(), to: now.toISOString() }]) {
      await expect(read(String(owner), trackerId, query, now)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    }
  });
  it('requires server authentication at the router boundary and returns contract error envelopes', async () => {
    const app = express();
    app.use('/api', createHistoryRouter(async () => { throw new HistoryError(401, 'AUTH_REQUIRED', 'Sign in.'); }, 'offline-fixture-secret-with-32-bytes'));
    const response = await request(app).get(`/api/tracked-items/${trackerId}/history`);
    expect(response.status).toBe(401);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.error).toMatchObject({ code: 'AUTH_REQUIRED', resourceId: null, fields: [] });
  });
  it('serializes overlapping writes of the same observation', async () => {
    const results = await Promise.all(Array.from({ length: 4 }, () => recordObservation(productId, 'concurrent', 'worker', offer(), now)));
    expect(new Set(results.map(row => String(row._id))).size).toBe(1);
    expect(await PriceHistoryModel.countDocuments()).toBe(1);
  });
  it('returns history matching the shared OpenAPI schema', async () => {
    const contract = JSON.parse(readFileSync(new URL('../../../docs/api/openapi.json', import.meta.url), 'utf8'));
    const definitions = JSON.parse(JSON.stringify(contract.components.schemas).replaceAll('#/components/schemas/', '#/$defs/'));
    const ajv = new Ajv2020({ strict: true, strictTypes: false });
    addFormats.default(ajv);
    const validate = ajv.compile({ $defs: definitions, $ref: '#/$defs/History' });
    await recordObservation(productId, 'contract', 'worker', offer(), now);
    const result = await read(String(owner), trackerId, {}, new Date(now.getTime() + 1));
    expect(validate(result), JSON.stringify(validate.errors)).toBe(true);
  });
});
