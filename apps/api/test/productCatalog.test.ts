import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SteamOffer } from '../src/cheapshark.js';

const mocks = vi.hoisted(() => ({
  findById: vi.fn(),
  findOneAndUpdate: vi.fn(),
  updateOne: vi.fn(),
  lookup: vi.fn(),
}));

vi.mock('../src/models/product.js', () => ({ ProductModel: {
  findById: mocks.findById,
  findOneAndUpdate: mocks.findOneAndUpdate,
  updateOne: mocks.updateOne,
} }));
vi.mock('../src/cheapshark.js', () => ({ lookupSteamOffer: mocks.lookup }));

import { refreshSteamProductById } from '../src/productCatalog.js';
import { ProviderDeferredError } from '../src/providerBudget.js';

function query<T>(value: T) {
  return { lean: () => ({ exec: async () => value }), exec: async () => value };
}

function product() {
  return {
    _id: 'product1',
    provider: 'cheapshark',
    providerGameId: '36',
    steamAppId: '620',
    storeId: '1',
    market: 'US',
    currency: 'USD',
    canonicalSteamUrl: 'https://store.steampowered.com/app/620/',
    currentPriceMinor: null as number | null,
    lastSuccessfulCheckAt: null as Date | null,
    nextCheckAt: null as Date | null,
    lastError: null as string | null,
    consecutiveFailures: 0,
    refreshLeaseToken: null as string | null,
    refreshLeaseUntil: null as Date | null,
  };
}

let record: ReturnType<typeof product>;

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-02T12:00:00Z'));
  record = product();
  mocks.findById.mockImplementation(() => query({ ...record }));
  mocks.findOneAndUpdate.mockImplementation((_filter, update: { $set: Partial<typeof record> }) => {
    Object.assign(record, update.$set);
    return query({ ...record });
  });
  mocks.updateOne.mockImplementation((_filter, update: { $set: Partial<typeof record> }) => {
    Object.assign(record, update.$set);
    return query({ modifiedCount: 1 });
  });
  mocks.lookup.mockRejectedValue(new Error('network failed'));
});

afterEach(() => vi.useRealTimers());

describe('product refresh retry scheduling', () => {
  it('defers a failed first observation until its retry time, then permits a retry', async () => {
    await expect(refreshSteamProductById(record._id)).rejects.toThrow('network failed');
    const retryAt = record.nextCheckAt!;
    expect(retryAt.getTime()).toBe(Date.now() + 60_000);

    await expect(refreshSteamProductById(record._id)).rejects.toMatchObject({
      name: 'ProviderDeferredError', retryAt,
    });
    expect(mocks.lookup).toHaveBeenCalledTimes(1);
    expect(mocks.findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(record.consecutiveFailures).toBe(1);

    vi.setSystemTime(retryAt);
    await expect(refreshSteamProductById(record._id)).rejects.toThrow('network failed');
    expect(mocks.lookup).toHaveBeenCalledTimes(2);
    expect(record.nextCheckAt!.getTime()).toBe(Date.now() + 120_000);
  });

  it('does not turn an expired observation into a fresh price during backoff', async () => {
    const lastSuccess = new Date('2026-10-31T12:00:00Z');
    record.currentPriceMinor = 999;
    record.lastSuccessfulCheckAt = lastSuccess;
    record.nextCheckAt = new Date('2026-11-01T12:00:00Z');

    await expect(refreshSteamProductById(record._id)).rejects.toThrow('network failed');
    await expect(refreshSteamProductById(record._id)).rejects.toBeInstanceOf(ProviderDeferredError);
    expect(record.currentPriceMinor).toBe(999);
    expect(record.lastSuccessfulCheckAt).toEqual(lastSuccess);
    expect(mocks.lookup).toHaveBeenCalledTimes(1);
  });

  it('uses the successful observation time, not a retry timestamp, for cache freshness', async () => {
    record.currentPriceMinor = 999;
    record.lastSuccessfulCheckAt = new Date(Date.now() - 60_000);
    record.nextCheckAt = new Date(Date.now() - 1);

    await expect(refreshSteamProductById(record._id)).resolves.toMatchObject({ currentPriceMinor: 999 });
    expect(mocks.lookup).not.toHaveBeenCalled();
    expect(mocks.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('allows an explicit forced retry while retaining the normal retry guard', async () => {
    record.lastError = 'Previous check failed';
    record.nextCheckAt = new Date(Date.now() + 60_000);
    await expect(refreshSteamProductById(record._id, { force: true })).rejects.toThrow('network failed');
    expect(mocks.lookup).toHaveBeenCalledTimes(1);
  });

  it('retries a failed forced refresh once due even when the retained price is less than 24 hours old', async () => {
    record.currentPriceMinor = 999;
    record.lastSuccessfulCheckAt = new Date(Date.now() - 60_000);
    await expect(refreshSteamProductById(record._id, { force: true })).rejects.toThrow('network failed');
    vi.setSystemTime(record.nextCheckAt!);
    await expect(refreshSteamProductById(record._id)).rejects.toThrow('network failed');
    expect(mocks.lookup).toHaveBeenCalledTimes(2);
  });

  it('rechecks backoff after claiming without counting the unused claim as another failure', async () => {
    const retryAt = new Date(Date.now() + 60_000);
    mocks.findOneAndUpdate.mockImplementationOnce((_filter, update: { $set: Partial<typeof record> }) => {
      Object.assign(record, update.$set, {
        lastError: 'Concurrent check failed', nextCheckAt: retryAt, consecutiveFailures: 1,
      });
      return query({ ...record });
    });
    await expect(refreshSteamProductById(record._id)).rejects.toMatchObject({ name: 'ProviderDeferredError', retryAt });
    expect(mocks.lookup).not.toHaveBeenCalled();
    expect(record.consecutiveFailures).toBe(1);
    expect(record.refreshLeaseToken).toBeNull();
    expect(record.nextCheckAt).toEqual(retryAt);
  });

  it('resets failure metadata after a successful retry and caches the observation', async () => {
    record.lastError = 'Previous check failed';
    record.nextCheckAt = new Date(Date.now());
    record.consecutiveFailures = 2;
    const offer: SteamOffer = {
      identity: { provider: 'cheapshark', providerGameId: '36', storeId: '1', market: 'US', currency: 'USD' },
      steamAppId: '620', canonicalSteamUrl: record.canonicalSteamUrl, title: 'Portal 2', storeName: 'Steam',
      source: { name: 'CheapShark', url: 'https://www.cheapshark.com/', attribution: 'Prices supplied by CheapShark' },
      currentPrice: { amountMinor: 999, currency: 'USD' }, retailPrice: null,
      dealId: 'fixture-deal', purchaseUrl: 'https://www.cheapshark.com/redirect?dealID=fixture-deal',
      observedAt: new Date().toISOString(), providerChangedAt: null,
    };
    mocks.lookup.mockResolvedValue(offer);

    await expect(refreshSteamProductById(record._id)).resolves.toMatchObject({
      currentPriceMinor: 999, lastError: null, consecutiveFailures: 0, refreshLeaseToken: null,
    });
    await refreshSteamProductById(record._id);
    expect(mocks.lookup).toHaveBeenCalledTimes(1);
    expect(record.nextCheckAt!.getTime()).toBe(Date.now() + 24 * 60 * 60 * 1_000);
  });
});
