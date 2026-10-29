import { attribution, type Product, type TrackedItem, type User } from './dto';

// Offline fixtures. October 26 quote/identity, not a current price or service result.
export const observedAt = '2026-10-26T16:34:42.829Z';
export const later = '2099-10-28T12:00:00Z';
export const token = 'illustrative_only_not_a_real_token_000000000000';
export const accepted = { message: 'If eligible, you will receive an email with next steps.' };
export const product: Product = {
  id: 'product_example', identity: { provider: 'cheapshark', providerGameId: '36', storeId: '1', market: 'US', currency: 'USD' },
  steamAppId: '620', canonicalSteamUrl: 'https://store.steampowered.com/app/620/', title: 'Portal 2', storeName: 'Steam', imageUrl: null,
  source: { name: 'CheapShark', url: 'https://www.cheapshark.com/', attribution },
  currentPrice: { amountMinor: 999, currency: 'USD' }, retailPrice: null,
  dealId: 'a+b/c=', purchaseUrl: 'https://www.cheapshark.com/redirect?dealID=a%2Bb%2Fc%3D',
  observedAt, providerChangedAt: null, freshness: 'stale', staleAt: '2026-10-27T16:34:42.829Z',
  lastAttemptAt: '2026-10-28T12:00:00Z', nextCheckAt: later,
  lastError: { code: 'PROVIDER_UNAVAILABLE', message: 'Illustrative failure.', occurredAt: '2026-10-28T12:00:00Z', retryAt: null },
};
export const unavailableProduct: Product = {
  ...product, freshness: 'unavailable', currentPrice: null, retailPrice: null, dealId: null, purchaseUrl: null,
  observedAt: null, providerChangedAt: null, staleAt: null,
};
export const user: User = { id: 'user_example', email: 'player@example.com', name: null, emailVerified: true, role: 'user', createdAt: observedAt };
export const item: TrackedItem = {
  id: 'tracker_example', product, targetPrice: { amountMinor: 0, currency: 'USD' }, enabled: true,
  alerts: { email: true, push: false }, createdAt: observedAt, updatedAt: observedAt,
};
export const page = { limit: 20, nextCursor: null };
export const window = { from: '2026-10-01T00:00:00Z', to: '2026-10-28T12:00:00Z' };
export const history = {
  trackedItemId: item.id, product, window, retainedFrom: window.from,
  items: [{ id: 'observation_example', price: { amountMinor: 999, currency: 'USD' }, observedAt, providerChangedAt: null }], page,
};
export const login = { user, sessionId: 'session_example', expiresAt: later };
export const key = '624031ba-726a-454d-8308-909b1b0a0031';
export const create = { previewId: 'preview_example', targetPrice: item.targetPrice, enabled: item.enabled, alerts: item.alerts };
export const csrf = (csrfToken = token) => ({ csrfToken, expiresAt: later });
export const error = (code: string, retryAfterSeconds: number | null = null) => ({
  error: { code, message: 'Illustrative error.', fields: [], requestId: 'request_example', retryAfterSeconds, resourceId: null },
});
export function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}
