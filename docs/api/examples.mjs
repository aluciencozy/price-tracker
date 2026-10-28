// Offline illustrative examples only. Identity and dated quotes come from ../cheapshark-proof.json.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const proof = JSON.parse(readFileSync(new URL('../cheapshark-proof.json', import.meta.url)));
const observedAt = '2026-10-26T16:34:42.829Z';
const now = '2026-10-28T12:00:00Z';
const money = (amountMinor) => ({ amountMinor, currency: 'USD' });
const source = {
  name: 'CheapShark', url: 'https://www.cheapshark.com/',
  attribution: 'Prices supplied by CheapShark; Steam US/USD base-game offer, excluding taxes and checkout adjustments.',
};
export const products = proof.games.map((game, index) => ({
  id: `product_${index + 1}`,
  identity: { provider: 'cheapshark', providerGameId: game.cheapSharkGameId, storeId: '1', market: 'US', currency: 'USD' },
  steamAppId: game.steamAppId, canonicalSteamUrl: game.steamUrl,
  title: game.title, storeName: 'Steam', imageUrl: null, source,
  currentPrice: money(game.priceMinor), retailPrice: money(game.priceMinor),
  dealId: new URL(game.purchaseUrl).searchParams.get('dealID'), purchaseUrl: game.purchaseUrl,
  observedAt, providerChangedAt: null, freshness: 'stale',
  staleAt: '2026-10-27T16:34:42.829Z', lastAttemptAt: observedAt,
  nextCheckAt: '2026-10-29T12:00:00Z', lastError: null,
}));
export const user = { id: 'user_example', email: 'player@example.com', name: null, emailVerified: true, role: 'user', createdAt: now };
export const tracker = {
  id: 'tracker_example', product: products[0], targetPrice: money(500),
  enabled: true, alerts: { email: true, push: false }, createdAt: now, updatedAt: now,
};
const token = 'illustrative_only_not_a_real_token_000000000000';
const credentials = { email: user.email, password: 'illustrative-password-only' };
const accepted = { message: 'If eligible, you will receive an email with next steps.' };
const sessionId = 'session_example';
const expiresAt = '2026-11-04T12:00:00Z';
const deviceRequest = { installationId: 'b36d3290-4086-4a55-98d5-783cb9f24031', platform: 'android', pushToken: 'illustrative-fcm-token-not-real' };
const device = { id: 'device_example', installationId: deviceRequest.installationId, platform: 'android', sessionId, createdAt: now, updatedAt: now };
const run = { id: 'check_example', status: 'queued', trigger: 'manual', createdAt: now, startedAt: null, finishedAt: null, counts: { total: 0, succeeded: 0, failed: 0, skipped: 0 }, lastError: null };
const origin = 'https://tracker.example.com';
const webHeaders = { Origin: origin, 'X-CSRF-Token': token, Cookie: '__Host-price_tracker_session=illustrative-session-secret' };
const preloginHeaders = { Origin: origin, 'X-CSRF-Token': token, Cookie: '__Host-price_tracker_prelogin=illustrative-prelogin-secret' };
const mobileHeaders = { Authorization: 'Bearer illustrative-not-a-signed-jwt' };

// Each entry is a concrete HTTP exchange. OpenAPI path templates keep examples easy to look up.
export const exchanges = [];
function exchange(method, path, status, request, response, headers = mobileHeaders, extra = {}) {
  exchanges.push({ method, path, headers, ...(request === undefined ? {} : { request }), status, ...(response === undefined ? {} : { response }), ...extra });
}
exchange('get', '/api/auth/web/csrf', 200, undefined, { csrfToken: token, expiresAt: '2026-10-28T12:30:00Z' }, {});
for (const platform of ['web', 'mobile']) {
  const root = `/api/auth/${platform}`;
  const headers = platform === 'web' ? preloginHeaders : {};
  exchange('post', `${root}/register`, 202, { ...credentials, name: 'Example player' }, accepted, headers);
  exchange('post', `${root}/verify-email`, 204, { token }, undefined, headers);
  exchange('post', `${root}/resend-verification`, 202, { email: user.email }, accepted, headers);
  exchange('post', `${root}/forgot-password`, 202, { email: user.email }, accepted, headers);
  exchange('post', `${root}/reset-password`, 204, { token, password: credentials.password }, undefined, headers);
  exchange('post', `${root}/login`, 200, credentials, platform === 'web'
    ? { user, sessionId, expiresAt }
    : { accessToken: 'illustrative-not-a-signed-jwt', tokenType: 'Bearer', expiresIn: 604800, expiresAt, sessionId, user }, headers,
  platform === 'web' ? { responseHeaders: { 'Set-Cookie': '__Host-price_tracker_session=illustrative-session-secret; Path=/; Max-Age=604800; Expires=Wed, 04 Nov 2026 12:00:00 GMT; HttpOnly; Secure; SameSite=Lax' } } : {});
  exchange('get', `${root}/me`, 200, undefined, user, platform === 'web' ? { Cookie: webHeaders.Cookie } : mobileHeaders);
  exchange('post', `${root}/logout`, 204, undefined, undefined, platform === 'web' ? webHeaders : mobileHeaders);
}
exchange('post', '/api/product-previews', 201, { url: products[0].canonicalSteamUrl }, { id: 'preview_example', expiresAt: '2026-10-28T12:10:00Z', product: products[0] }, webHeaders);
exchange('post', '/api/tracked-items', 201, { previewId: 'preview_example', targetPrice: tracker.targetPrice, enabled: true, alerts: tracker.alerts }, tracker,
  { ...webHeaders, 'Idempotency-Key': '624031ba-726a-454d-8308-909b1b0a0031' }, { responseHeaders: { Location: '/api/tracked-items/tracker_example' } });
exchange('get', '/api/tracked-items', 200, undefined, { items: [tracker], page: { limit: 20, nextCursor: null } }, mobileHeaders, { query: { limit: 20, q: 'Portal' } });
exchange('get', '/api/tracked-items/{id}', 200, undefined, tracker, mobileHeaders, { params: { id: tracker.id } });
exchange('patch', '/api/tracked-items/{id}', 200, { targetPrice: money(0), alerts: { email: false, push: true } }, { ...tracker, targetPrice: money(0), alerts: { email: false, push: true } }, mobileHeaders, { params: { id: tracker.id } });
exchange('delete', '/api/tracked-items/{id}', 204, undefined, undefined, mobileHeaders, { params: { id: tracker.id } });
exchange('get', '/api/tracked-items/{id}/history', 200, undefined, {
  trackedItemId: tracker.id, product: products[0],
  window: { from: '2026-10-01T00:00:00Z', to: '2026-10-28T12:00:00Z' }, retainedFrom: '2026-10-01T00:00:00Z',
  items: [{ id: 'observation_example', price: money(999), observedAt, providerChangedAt: null }], page: { limit: 20, nextCursor: null },
}, mobileHeaders, { params: { id: tracker.id }, query: { from: '2026-10-01T00:00:00Z', to: now, limit: 20 } });
exchange('post', '/api/devices', 201, deviceRequest, device);
exchange('put', '/api/devices/{id}', 200, { ...deviceRequest, pushToken: 'illustrative-rotated-fcm-token' }, device, mobileHeaders, { params: { id: device.id } });
exchange('delete', '/api/devices/{id}', 204, undefined, undefined, mobileHeaders, { params: { id: device.id } });
exchange('post', '/api/admin/price-checks', 202, {}, run, webHeaders, { responseHeaders: { Location: '/api/admin/price-checks/check_example' } });
exchange('get', '/api/admin/price-checks/{id}', 200, undefined, { ...run, status: 'succeeded', startedAt: now, finishedAt: '2026-10-28T12:01:00Z', counts: { total: 2, succeeded: 2, failed: 0, skipped: 0 } }, mobileHeaders, { params: { id: run.id } });

export const error = (code, message, fields = [], retryAfterSeconds = null, resourceId = null) => ({ error: { code, message, fields, requestId: 'request_example', retryAfterSeconds, resourceId } });
exchange('post', '/api/auth/web/verify-email', 400, { token }, error('TOKEN_INVALID', 'This link is invalid or expired.'), preloginHeaders);
exchange('get', '/api/tracked-items', 401, undefined, error('SESSION_EXPIRED', 'Please sign in again.'));
exchange('post', '/api/admin/price-checks', 403, {}, error('ADMIN_REQUIRED', 'Administrator access is required.'));
exchange('get', '/api/tracked-items/{id}', 404, undefined, error('NOT_FOUND', 'Item not found.'), mobileHeaders, { params: { id: 'foreign_or_missing' } });
exchange('post', '/api/tracked-items', 409, { previewId: 'preview_example', targetPrice: tracker.targetPrice, enabled: true, alerts: tracker.alerts }, error('DUPLICATE_TRACKED_ITEM', 'You already track this Steam offer.', [], null, tracker.id), { ...mobileHeaders, 'Idempotency-Key': '4a0a2ac2-5030-43f0-8507-8c4bddc2e7ca' });
exchange('post', '/api/tracked-items', 410, { previewId: 'preview_example', targetPrice: tracker.targetPrice, enabled: true, alerts: tracker.alerts }, error('PREVIEW_EXPIRED', 'Preview the game again before saving.'), { ...mobileHeaders, 'Idempotency-Key': '4a0a2ac2-5030-43f0-8507-8c4bddc2e7ca' });
exchange('patch', '/api/tracked-items/{id}', 422, { targetPrice: money(-1) }, error('VALIDATION_ERROR', 'Check the highlighted fields.', [{ path: '/targetPrice/amountMinor', code: 'out_of_range', message: 'Use nonnegative integer USD cents.' }]), mobileHeaders, { params: { id: tracker.id }, invalidRequest: true });
exchange('post', '/api/product-previews', 422, { url: 'https://store.steampowered.com/app/620/' }, error('STEAM_OFFER_UNAVAILABLE', 'No supported Steam offer is available.'));
exchange('post', '/api/product-previews', 422, { url: 'https://example.com/game' }, error('UNSUPPORTED_URL', 'Use a supported Steam base-game app URL.', [{ path: '/url', code: 'unsupported', message: 'Only allowlisted Steam app URLs are supported.' }]));
exchange('post', '/api/product-previews', 429, { url: products[0].canonicalSteamUrl }, error('PROVIDER_RATE_LIMITED', 'Price source is busy. Try again later.', [], 60), mobileHeaders, { responseHeaders: { 'Retry-After': 60 } });
exchange('post', '/api/product-previews', 503, { url: products[0].canonicalSteamUrl }, error('PROVIDER_UNAVAILABLE', 'Price source is temporarily unavailable.', [], 120), mobileHeaders, { responseHeaders: { 'Retry-After': 120 } });

export const pushEvent = { schemaVersion: '1', type: 'price_target_reached', eventId: 'episode_example', deliveryId: 'delivery_push_example', recipientSessionId: sessionId, trackedItemId: tracker.id, productId: products[0].id, observedAt };
export const unavailableProduct = { ...products[0], currentPrice: null, retailPrice: null, dealId: null, purchaseUrl: null, observedAt: null, providerChangedAt: null, freshness: 'unavailable', staleAt: null, lastAttemptAt: now, lastError: { code: 'STEAM_OFFER_UNAVAILABLE', message: 'Illustrative missing-offer state, not a claim about Portal 2.', occurredAt: now, retryAt: null } };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify({ notice: 'Illustrative OFFLINE fixtures. Dated quotes are not current prices; no tokens are real.', products, exchanges, pushEvent, unavailableProduct }, null, 2));
}
