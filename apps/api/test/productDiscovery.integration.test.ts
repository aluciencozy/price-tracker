import mongoose, { Types } from 'mongoose';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cheapSharkPurchaseUrl, SteamGameUnsupportedError, type SteamOffer } from '../src/cheapshark.js';
import { createDatabaseIndexes } from '../src/models/index.js';
import { ProductModel } from '../src/models/product.js';
import { NotificationDeliveryModel, PriceHistoryModel, TrackedItemModel } from '../src/models/tracking.js';
import { ProductPreviewModel } from '../src/models/trackingApi.js';
import { discoverSteamProduct } from '../src/productDiscovery.js';
import { createProductPreviewService } from '../src/productPreviews.js';
import { ProviderRateLimitError } from '../src/providerBudget.js';
import { refreshSteamProductById } from '../src/productCatalog.js';

const provider = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock('../src/cheapshark.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/cheapshark.js')>(), lookupSteamOffer: provider.lookup,
}));

const uri = process.env.TEST_MONGODB_URI;
const url = 'https://store.steampowered.com/app/1942280/';
function fixture(appId = '1942280', gameId = '12345'): SteamOffer {
  return {
    identity: { provider: 'cheapshark', providerGameId: gameId, storeId: '1', market: 'US', currency: 'USD' },
    steamAppId: appId, canonicalSteamUrl: `https://store.steampowered.com/app/${appId}/`, title: 'Fixture game',
    storeName: 'Steam', source: { name: 'CheapShark', url: 'https://www.cheapshark.com/', attribution: 'Fixture' },
    currentPrice: { amountMinor: 499, currency: 'USD' }, retailPrice: null, dealId: 'fixture',
    purchaseUrl: cheapSharkPurchaseUrl('fixture'), observedAt: new Date().toISOString(), providerChangedAt: null,
  };
}

describe.skipIf(!uri)('discovery persistence with disposable MongoDB and offline fixtures', () => {
  const dbName = `price_tracker_test_${randomUUID().replaceAll('-', '')}`;
  beforeAll(async () => {
    await mongoose.connect(uri!, { dbName, serverSelectionTimeoutMS: 5000, autoIndex: false });
    if (mongoose.connection.name !== dbName) throw new Error('Unexpected database');
    await createDatabaseIndexes();
  }, 30_000);
  beforeEach(async () => {
    provider.lookup.mockReset();
    await Promise.all([ProductModel.deleteMany({}), ProductPreviewModel.deleteMany({}), PriceHistoryModel.deleteMany({}),
      TrackedItemModel.deleteMany({}), NotificationDeliveryModel.deleteMany({})]);
  });
  afterAll(async () => {
    if (mongoose.connection.name === dbName) await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  it('discovers once, reuses the cache, and creates no history or alerts', async () => {
    const lookup = vi.fn(async () => fixture());
    const service = createProductPreviewService({ discover: lookup,
      resolveProduct: async id => ProductModel.findById(id).orFail().lean().exec() });
    const first = await service(String(new Types.ObjectId()), { url });
    const second = await service(String(new Types.ObjectId()), { url });
    expect(first.product.steamAppId).toBe('1942280');
    expect(first.product.source.attribution).toBe('Prices supplied by CheapShark; exact Steam app US/USD offer, excluding taxes and checkout adjustments.');
    expect(second.product.currentPrice?.amountMinor).toBe(499);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(await ProductModel.countDocuments()).toBe(1);
    expect(await PriceHistoryModel.countDocuments()).toBe(0);
    expect(await NotificationDeliveryModel.countDocuments()).toBe(0);
  });

  it('converges concurrent discovery and rejects a colliding provider mapping', async () => {
    const signal = new AbortController().signal;
    const rows = await Promise.all(Array.from({ length: 4 }, () => discoverSteamProduct(url, signal, async () => fixture())));
    expect(new Set(rows.map(row => String(row._id))).size).toBe(1);
    await expect(discoverSteamProduct('https://store.steampowered.com/app/123/', signal,
      async () => fixture('123'))).rejects.toThrow();
    expect(await ProductModel.countDocuments()).toBe(1);
    expect((await ProductModel.findOne().lean())?.steamAppId).toBe('1942280');
  });

  it('retains a validated last successful quote on refresh failure', async () => {
    await discoverSteamProduct(url, new AbortController().signal, async () => fixture());
    const service = createProductPreviewService({ resolveProduct: async () => { throw new Error('offline'); } });
    const preview = await service(String(new Types.ObjectId()), { url });
    expect(preview.product.freshness).toBe('stale');
    expect(preview.product.currentPrice?.amountMinor).toBe(499);
    expect((await ProductModel.findOne().lean())?.currentPriceMinor).toBe(499);
  });

  it('rejects a newly non-game result and repeats 422 during persisted backoff', async () => {
    const row = await discoverSteamProduct(url, new AbortController().signal, async () => fixture());
    provider.lookup.mockRejectedValue(new SteamGameUnsupportedError());
    let first = true;
    const service = createProductPreviewService({ resolveProduct: async (id, signal) => {
      const force = first;
      first = false;
      return refreshSteamProductById(id, { signal, force });
    } });
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(service(String(new Types.ObjectId()), { url })).rejects.toMatchObject({ status: 422, code: 'UNSUPPORTED_PRODUCT' });
    }
    expect(provider.lookup).toHaveBeenCalledTimes(1);
    expect(await ProductModel.findById(row._id).lean()).toMatchObject({
      steamTypeValidatedAt: null, steamTypeRejected: true, currentPriceMinor: 499, dealId: 'fixture',
    });
    expect(await ProductPreviewModel.countDocuments()).toBe(0);
  });

  it('rejects a typed non-game result even when an injected resolver leaves the old row untouched', async () => {
    await discoverSteamProduct(url, new AbortController().signal, async () => fixture());
    const service = createProductPreviewService({ resolveProduct: async () => { throw new SteamGameUnsupportedError(); } });
    await expect(service(String(new Types.ObjectId()), { url })).rejects.toMatchObject({ status: 422, code: 'UNSUPPORTED_PRODUCT' });
    expect(await ProductPreviewModel.countDocuments()).toBe(0);
  });

  it('does not return an unvalidated legacy quote when validation fails', async () => {
    const row = await discoverSteamProduct(url, new AbortController().signal, async () => fixture());
    await ProductModel.updateOne({ _id: row._id }, { $set: { steamTypeValidatedAt: null } });
    const service = createProductPreviewService({ resolveProduct: async () => { throw new Error('offline'); } });
    await expect(service(String(new Types.ObjectId()), { url })).rejects.toMatchObject({ status: 503 });
    expect(await ProductPreviewModel.countDocuments()).toBe(0);
    expect((await ProductModel.findById(row._id).lean())?.currentPriceMinor).toBe(499);
  });

  it('does not insert when a provider completes after cancellation', async () => {
    const controller = new AbortController();
    await expect(discoverSteamProduct(url, controller.signal, async () => {
      controller.abort();
      return fixture();
    })).rejects.toThrow();
    expect(await ProductModel.countDocuments()).toBe(0);
  });

  it('maps typed non-game metadata to 422 but malformed and mismatched metadata to 503', async () => {
    const cases = [
      { error: new SteamGameUnsupportedError(), status: 422, code: 'UNSUPPORTED_PRODUCT' },
      { error: new Error('Steam game type is unsupported or unclassifiable'), status: 503, code: 'PROVIDER_UNAVAILABLE' },
      { error: new Error('Malformed metadata: missing type'), status: 503, code: 'PROVIDER_UNAVAILABLE' },
      { error: new Error('Metadata returned a different Steam app ID'), status: 503, code: 'PROVIDER_UNAVAILABLE' },
    ];
    for (const { error, status, code } of cases) {
      const service = createProductPreviewService({
        discover: async () => { throw error; },
        resolveProduct: async () => { throw new Error('unexpected resolver call'); },
      });
      await expect(service(String(new Types.ObjectId()), { url })).rejects.toMatchObject({ status, code });
    }
    expect(await ProductModel.countDocuments()).toBe(0);
    expect(await ProductPreviewModel.countDocuments()).toBe(0);
  });

  it('preserves provider rate limits and retry information on discovery', async () => {
    const retryAt = new Date(Date.now() + 60_000);
    const service = createProductPreviewService({
      discover: async () => { throw new ProviderRateLimitError(retryAt, '60'); },
      resolveProduct: async () => { throw new Error('unexpected resolver call'); },
    });
    const error = await service(String(new Types.ObjectId()), { url }).catch((value: unknown) => value);
    expect(error).toMatchObject({ status: 429, code: 'PROVIDER_RATE_LIMITED' });
    expect((error as { retryAfterSeconds: number }).retryAfterSeconds).toBeGreaterThan(0);
    expect((error as { retryAfterSeconds: number }).retryAfterSeconds).toBeLessThanOrEqual(60);
    expect(await ProductModel.countDocuments()).toBe(0);
    expect(await ProductPreviewModel.countDocuments()).toBe(0);
  });
});
