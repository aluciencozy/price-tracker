import { describe, expect, it } from 'vitest';
import * as dto from './dto';
import { history, item, product, unavailableProduct, user } from './testFixtures';

describe('wire boundary validation', () => {
  it('preserves distinct IDs, source, retained successful price, and failed-attempt metadata', () => {
    expect(dto.trackedItem(item)).toEqual(item);
    expect(dto.history(history)).toEqual(history);
    expect(dto.user(user)).toEqual(user);
  });
  it('distinguishes free from unavailable and accepts safe integer money limits', () => {
    expect(dto.money({ amountMinor: 0, currency: 'USD' })).toEqual({ amountMinor: 0, currency: 'USD' });
    expect(dto.money({ amountMinor: Number.MAX_SAFE_INTEGER, currency: 'USD' }).amountMinor).toBe(Number.MAX_SAFE_INTEGER);
    expect(dto.product(unavailableProduct).currentPrice).toBeNull();
    expect(dto.product({ ...product, currentPrice: { amountMinor: 0, currency: 'USD' } }).currentPrice?.amountMinor).toBe(0);
  });
  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, null, '999', undefined])('rejects unsafe cents %s', (amountMinor) => {
    expect(() => dto.money({ amountMinor, currency: 'USD' })).toThrow();
  });
  it.each([
    { identity: { ...product.identity, storeId: '2' } },
    { identity: { ...product.identity, market: 'UK' } },
    { identity: { ...product.identity, currency: 'EUR' } },
    { identity: { ...product.identity, provider: 'steam' } },
    { identity: { ...product.identity, providerGameId: 36 } },
    { steamAppId: '36' }, { canonicalSteamUrl: 'https://store.steampowered.com/app/220/' },
    { currentPrice: { amountMinor: 999, currency: 'EUR' } }, { currentPrice: null },
    { purchaseUrl: 'https://evil.example/redirect?dealID=a%2Bb%2Fc%3D' },
    { purchaseUrl: 'https://www.cheapshark.com/redirect?dealID=wrong' },
    { dealId: null }, { imageUrl: 'javascript:alert(1)' },
    { source: { ...product.source, url: 'https://cheapshark.com.evil.example/' } },
    { freshness: 'fresh' }, { freshness: 'unavailable' }, { observedAt: undefined },
    { observedAt: '2026-02-30T12:00:00Z' }, { providerChangedAt: '2026-10-28T12:00:00+00:00' },
    { lastError: { code: 'PROVIDER_UNAVAILABLE', message: 'Missing timestamps.' } },
  ])('rejects invalid product %j', (changes) => {
    expect(() => dto.product({ ...product, ...changes })).toThrow();
  });
  it('encodes raw deal IDs once, including a literal percent escape in a raw ID', () => {
    expect(dto.product({ ...product, dealId: 'a%2Bb', purchaseUrl: 'https://www.cheapshark.com/redirect?dealID=a%252Bb' }).dealId).toBe('a%2Bb');
  });
  it('rejects unknown/omitted fields rather than accepting a different API schema', () => {
    expect(() => dto.user({ ...user, accessToken: 'not-a-web-response' })).toThrow();
    expect(() => dto.user({ ...user, emailVerified: false })).toThrow();
    expect(() => dto.trackedItem({ ...item, ownerId: 'forbidden' })).toThrow();
    expect(() => dto.product({ ...product, retailPrice: undefined })).toThrow();
    expect(() => dto.history({ ...history, retainedFrom: null })).toThrow();
    expect(() => dto.history({ ...history, window: { from: history.window.to, to: history.window.from } })).toThrow();
    expect(() => dto.history({ ...history, items: [{ ...history.items[0], price: null }] })).toThrow();
  });
});
