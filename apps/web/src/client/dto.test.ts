import { describe, expect, it } from 'vitest';
import * as dto from './dto';
import { history, item, product, unavailableProduct, user } from './testFixtures';

function apiProductForDealId(dealId: string) {
  const rawDealId = decodeURIComponent(dealId);
  const purchase = new URL('/redirect', 'https://www.cheapshark.com');
  purchase.searchParams.set('dealID', rawDealId);
  return { ...product, dealId, purchaseUrl: purchase.href };
}

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
  it.each([
    ['plain-id', 'plain-id'],
    ['plus+id', 'plus%2Bid'],
    ['slash/id', 'slash%2Fid'],
    ['equals=id', 'equals%3Did'],
    ['space id', 'space+id'],
    ['already%2Fencoded', 'already%2Fencoded'],
    ['deal%2Fwith%20space%2Bplus%3D', 'deal%2Fwith+space%2Bplus%3D'],
    ['a/b', 'a%2Fb'],
    ['a%2Fb', 'a%2Fb'],
  ])('accepts the API canonical redirect for deal ID %s', (dealId, encodedDealId) => {
    const result = dto.product({
      ...product,
      dealId,
      purchaseUrl: `https://www.cheapshark.com/redirect?dealID=${encodedDealId}`,
    });
    expect(result.dealId).toBe(dealId);
  });
  it.each([
    { label: 'ASCII', dealId: 'a'.repeat(256) },
    { label: 'astral Unicode', dealId: '😀'.repeat(256) },
  ])('accepts a 256-codepoint $label deal ID and its API-canonical URL', ({ dealId }) => {
    const value = apiProductForDealId(dealId);
    expect(value.purchaseUrl!.length).toBeLessThanOrEqual(4096);
    expect(dto.product(value).dealId).toBe(dealId);
  });
  it.each([
    { label: 'ASCII', dealId: 'a'.repeat(257) },
    { label: 'astral Unicode', dealId: '😀'.repeat(257) },
  ])('rejects a 257-codepoint $label deal ID', ({ dealId }) => {
    const value = apiProductForDealId(dealId);
    expect(value.purchaseUrl!.length).toBeLessThanOrEqual(4096);
    expect(() => dto.product(value)).toThrow();
  });
  it.each(['bad%', 'bad%2', 'bad%GG'])('rejects malformed percent escapes in deal ID %s', (dealId) => {
    expect(() => dto.product({ ...product, dealId, purchaseUrl: 'https://www.cheapshark.com/redirect?dealID=bad' })).toThrow();
  });
  it.each([
    'https://cheapshark.com/redirect?dealID=offer',
    'https://www.cheapshark.com.evil.example/redirect?dealID=offer',
    'https://www.cheapshark.com@evil.example/redirect?dealID=offer',
    'https://user:pass@www.cheapshark.com/redirect?dealID=offer',
    'http://www.cheapshark.com/redirect?dealID=offer',
    'https://www.cheapshark.com/redirect/?dealID=offer',
    'https://www.cheapshark.com/other?dealID=offer',
    'https://www.cheapshark.com/redirect',
    'https://www.cheapshark.com/redirect?dealID=offer&extra=1',
    'https://www.cheapshark.com/redirect?dealID=offer&dealID=offer',
    'https://www.cheapshark.com/redirect?%64ealID=offer',
    'https://www.cheapshark.com/redirect?dealID=offer#fragment',
    'https://www.cheapshark.com/redirect?dealID=other',
  ])('rejects non-canonical or unsafe purchase URL %s', (purchaseUrl) => {
    expect(() => dto.product({ ...product, dealId: 'offer', purchaseUrl })).toThrow();
  });
  it.each([
    ['a/b', 'https://www.cheapshark.com/redirect?dealID=a%252Fb'],
    ['a%2Fb', 'https://www.cheapshark.com/redirect?dealID=a%252Fb'],
    ['a%2Fb', 'https://www.cheapshark.com/redirect?dealID=a/b'],
  ])('rejects a URL that encodes deal identity differently for %s', (dealId, purchaseUrl) => {
    expect(() => dto.product({ ...product, dealId, purchaseUrl })).toThrow();
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
