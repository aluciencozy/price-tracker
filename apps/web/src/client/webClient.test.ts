import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClientError, type HttpOptions } from './http';
import { WebClient } from './webClient';
import { accepted, create, csrf, error, history, item, json, key, login, page, product, token, unavailableProduct, user } from './testFixtures';

function setup(responses: Response[] = [], options: HttpOptions = {}) {
  const fetch = vi.fn<typeof globalThis.fetch>();
  for (const response of responses) fetch.mockResolvedValueOnce(response);
  const client = new WebClient({ baseUrl: 'https://api.example.test', development: false, ...options, fetch });
  return { client, fetch };
}
function request(fetch: ReturnType<typeof setup>['fetch'], index: number, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const [url, init] = fetch.mock.calls[index]!;
  expect(url).toBe(`https://api.example.test/api${path}`);
  expect(init).toMatchObject({ method, credentials: 'include', redirect: 'error', cache: 'no-store' });
  expect(init?.signal).toBeDefined();
  expect(init?.headers).toEqual({ Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers });
  expect(init?.body).toBe(body === undefined ? undefined : JSON.stringify(body));
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('narrow owned-resource client', () => {
  it('rejects a successful preview without a qualifying retained Steam observation', async () => {
    const { client } = setup([json(csrf()), json({ id: 'preview_example', expiresAt: csrf().expiresAt, product: unavailableProduct }, 201)]);
    await expect(client.preview(product.canonicalSteamUrl)).rejects.toMatchObject({ kind: 'invalid-response' });
  });
  it('does no I/O on construction; sample mode can remain completely untouched', () => {
    const { client, fetch } = setup();
    expect(client.getSession().status).toBe('unknown');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('encodes pagination/search and preserves stale successes and opaque IDs', async () => {
    const result = { items: [item], page: { limit: 5, nextCursor: 'next+/=' } };
    const { client, fetch } = setup([json(result), json(item)]);
    expect(await client.listTrackedItems({ limit: 5, cursor: 'a+/=?&', q: 'Portal & 2' })).toEqual(result);
    expect(await client.getTrackedItem(item.id)).toEqual(item);
    request(fetch, 0, 'GET', '/tracked-items?limit=5&cursor=a%2B%2F%3D%3F%26&q=Portal+%26+2');
    request(fetch, 1, 'GET', '/tracked-items/tracker_example');
    expect(fetch).toHaveBeenCalledTimes(2); // No Steam/artwork/purchase/source requests.
  });
  it('previews through the API and creates with a caller-held UUID key and zero target', async () => {
    const preview = { id: create.previewId, expiresAt: csrf().expiresAt, product };
    const { client, fetch } = setup([json(csrf()), json(preview, 201), json(item, 201)]);
    expect(await client.preview(product.canonicalSteamUrl)).toEqual(preview);
    expect(await client.createTrackedItem(create, key)).toEqual(item);
    request(fetch, 0, 'GET', '/auth/web/csrf');
    request(fetch, 1, 'POST', '/product-previews', { url: product.canonicalSteamUrl }, { 'X-CSRF-Token': token });
    request(fetch, 2, 'POST', '/tracked-items', create, { 'X-CSRF-Token': token, 'Idempotency-Key': key });
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it('lets an explicit create retry reuse the identical request/key after uncertain outcome', async () => {
    const { client, fetch } = setup([json(csrf())]);
    fetch.mockRejectedValueOnce(new TypeError('connection lost')).mockResolvedValueOnce(json(item, 201));
    await expect(client.createTrackedItem(create, key)).rejects.toMatchObject({ kind: 'network' });
    await client.createTrackedItem(create, key);
    expect(fetch.mock.calls[1]?.[1]?.body).toEqual(fetch.mock.calls[2]?.[1]?.body);
    expect(fetch.mock.calls[1]?.[1]?.headers).toEqual(fetch.mock.calls[2]?.[1]?.headers);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it('patches only editable values and deletes without a body', async () => {
    const changes = { targetPrice: { amountMinor: 0, currency: 'USD' as const }, enabled: false, alerts: { email: false, push: true } };
    const changed = { ...item, ...changes };
    const { client, fetch } = setup([json(csrf()), json(changed), new Response(null, { status: 204 })]);
    expect(await client.updateTrackedItem(item.id, changes)).toEqual(changed);
    await client.deleteTrackedItem(item.id);
    request(fetch, 1, 'PATCH', '/tracked-items/tracker_example', changes, { 'X-CSRF-Token': token });
    request(fetch, 2, 'DELETE', '/tracked-items/tracker_example', undefined, { 'X-CSRF-Token': token });
  });
  it('reads history through the owned tracker and repeats a returned UTC window on continuation', async () => {
    const { client, fetch } = setup([json(history)]);
    expect(await client.getHistory(item.id, { limit: 20, cursor: 'x/y', ...history.window })).toEqual(history);
    request(fetch, 0, 'GET', '/tracked-items/tracker_example/history?limit=20&cursor=x%2Fy&from=2026-10-01T00%3A00%3A00Z&to=2026-10-28T12%3A00%3A00Z');
  });
  it('rejects wrong tracker/history responses at the boundary', async () => {
    const { client } = setup([json({ ...item, id: 'different' }), json({ ...history, trackedItemId: 'different' })]);
    await expect(client.getTrackedItem(item.id)).rejects.toMatchObject({ kind: 'invalid-response' });
    await expect(client.getHistory(item.id)).rejects.toMatchObject({ kind: 'invalid-response' });
  });
  it('rejects a PATCH response for another tracker', async () => {
    const { client } = setup([json(csrf()), json({ ...item, id: 'other_tracker' })]);
    await expect(client.updateTrackedItem(item.id, { enabled: false })).rejects.toMatchObject({ kind: 'invalid-response' });
  });
  it('rejects unsafe or authoritative input before any request', () => {
    const { client, fetch } = setup();
    expect(() => client.listTrackedItems({ limit: 101 })).toThrow(ClientError);
    expect(() => client.listTrackedItems({ q: '' })).toThrow(ClientError);
    expect(() => client.getTrackedItem('../other')).toThrow(ClientError);
    expect(() => client.createTrackedItem(create, 'not-uuid')).toThrow(ClientError);
    expect(() => client.createTrackedItem({ ...create, ownerId: 'forbidden' } as never, key)).toThrow(ClientError);
    expect(() => client.createTrackedItem({ ...create, targetPrice: { amountMinor: -1, currency: 'USD' } }, key)).toThrow(ClientError);
    expect(() => client.updateTrackedItem(item.id, {})).toThrow(ClientError);
    expect(() => client.updateTrackedItem(item.id, { alerts: { email: false } } as never)).toThrow(ClientError);
    expect(() => client.updateTrackedItem(item.id, { currentPrice: 0 } as never)).toThrow(ClientError);
    expect(() => client.getHistory(item.id, { from: history.window.to, to: history.window.from })).toThrow(ClientError);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('persistent browser sessions', () => {
  it('reserves the login context before an older /me 401 arrives during login POST', async () => {
    const me = deferred<Response>(), loggingIn = deferred<Response>();
    const { client, fetch } = setup();
    fetch.mockReturnValueOnce(me.promise).mockResolvedValueOnce(json(csrf())).mockReturnValueOnce(loggingIn.promise).mockResolvedValueOnce(json(csrf()));
    const restoring = client.restoreSession();
    const restoreAssertion = expect(restoring).rejects.toMatchObject({ kind: 'aborted' });
    const signingIn = client.login({ email: user.email, password: 'password' });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    me.resolve(json(error('AUTH_REQUIRED'), 401));
    await restoreAssertion;
    expect(client.getSession().status).toBe('unknown');
    loggingIn.resolve(json(login));
    await signingIn;
    expect(client.getSession().status).toBe('authenticated');
  });
  it.each([409, 422, 503])('discards old-account failed outcomes including private duplicate IDs: %s', async (status) => {
    const late = deferred<Response>();
    const { client, fetch } = setup([json(user), json(csrf())]);
    await client.restoreSession();
    fetch.mockReturnValueOnce(late.promise).mockResolvedValueOnce(json(csrf())).mockResolvedValueOnce(json({ ...login, user: { ...user, id: 'user_B' } })).mockResolvedValueOnce(json(csrf()));
    const creating = client.createTrackedItem(create, key);
    const assertion = expect(creating).rejects.toMatchObject({ kind: 'aborted', details: {} });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    await client.login({ email: user.email, password: 'password' });
    const detail = error(status === 409 ? 'DUPLICATE_TRACKED_ITEM' : status === 422 ? 'VALIDATION_ERROR' : 'SERVICE_UNAVAILABLE').error;
    late.resolve(json({ error: { ...detail, resourceId: status === 409 ? 'private_tracker_A' : null } }, status));
    await assertion;
    expect(client.getSession().user?.id).toBe('user_B');
  });
  it('validates inputs before reserving a login context and keeps the prior snapshot on failure', async () => {
    const { client, fetch } = setup([json(user), json(csrf()), json(error('EMAIL_UNVERIFIED'), 403)]);
    await client.restoreSession();
    const previous = client.getSession();
    await expect(client.login({ email: '', password: 'password' })).rejects.toMatchObject({ kind: 'invalid-input' });
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(client.login({ email: user.email, password: 'password' })).rejects.toMatchObject({ details: { code: 'EMAIL_UNVERIFIED' } });
    expect(client.getSession()).toBe(previous);
  });
  it('restores /me, logs in without JWT/storage, rotates CSRF, then logs out bodylessly', async () => {
    const storage = vi.spyOn(Storage.prototype, 'setItem');
    const cookie = vi.spyOn(document, 'cookie', 'set');
    const { client, fetch } = setup([
      json(user), json(csrf()), json(login), json(csrf(`${token}_session`)),
      new Response(null, { status: 204 }), json(csrf(`${token}_new_prelogin`)),
    ]);
    const listener = vi.fn();
    const unsubscribe = client.subscribe(listener);
    expect(await client.restoreSession()).toEqual(user);
    expect(client.getSession()).toEqual({ status: 'authenticated', user, sessionId: null, expiresAt: null });
    const credentials = { email: user.email, password: '  preserve spaces  ' };
    expect(await client.login(credentials)).toEqual(login);
    expect(client.getSession()).toEqual({ status: 'authenticated', ...login });
    await client.logout();
    request(fetch, 0, 'GET', '/auth/web/me');
    request(fetch, 1, 'GET', '/auth/web/csrf');
    request(fetch, 2, 'POST', '/auth/web/login', credentials, { 'X-CSRF-Token': token });
    request(fetch, 3, 'GET', '/auth/web/csrf');
    request(fetch, 4, 'POST', '/auth/web/logout', undefined, { 'X-CSRF-Token': `${token}_session` });
    request(fetch, 5, 'GET', '/auth/web/csrf');
    expect(client.getSession()).toEqual({ status: 'anonymous', user: null, sessionId: null, expiresAt: null });
    expect(listener).toHaveBeenCalledTimes(3);
    unsubscribe();
    expect(storage).not.toHaveBeenCalled();
    expect(cookie).not.toHaveBeenCalled();
  });
  it('performs all account operations with the actual accepted/204 contract and no auto-login', async () => {
    const { client, fetch } = setup([
      json(csrf()), json(accepted, 202), json(accepted, 202), json(accepted, 202),
      new Response(null, { status: 204 }), new Response(null, { status: 204 }),
    ]);
    const values = { email: user.email, password: 'example-password', name: 'Example' };
    expect(await client.register(values)).toEqual(accepted);
    await client.resendVerification(user.email);
    await client.forgotPassword(user.email);
    expect(await client.verifyEmail(token)).toBeUndefined();
    expect(client.getSession().status).not.toBe('authenticated');
    expect(await client.resetPassword(token, 'changed-password')).toBeUndefined();
    const headers = { 'X-CSRF-Token': token };
    request(fetch, 1, 'POST', '/auth/web/register', values, headers);
    request(fetch, 2, 'POST', '/auth/web/resend-verification', { email: user.email }, headers);
    request(fetch, 3, 'POST', '/auth/web/forgot-password', { email: user.email }, headers);
    request(fetch, 4, 'POST', '/auth/web/verify-email', { token }, headers);
    request(fetch, 5, 'POST', '/auth/web/reset-password', { token, password: 'changed-password' }, headers);
    expect(client.getSession().status).toBe('anonymous');
  });
  it('does not turn unverified/invalid login responses into sessions or accept native JWT JSON', async () => {
    const { client } = setup([json(csrf()), json({ ...login, user: { ...user, emailVerified: false } }), json(csrf()), json({ ...login, accessToken: 'native-only' })]);
    for (let i = 0; i < 2; i++) {
      await expect(client.login({ email: user.email, password: 'password' })).rejects.toMatchObject({ kind: 'invalid-response' });
      expect(client.getSession().status).toBe('unknown');
    }
  });
  it('surfaces EMAIL_UNVERIFIED without retrying or signing in', async () => {
    const { client, fetch } = setup([json(csrf()), json(error('EMAIL_UNVERIFIED'), 403)]);
    await expect(client.login({ email: user.email, password: 'password' })).rejects.toMatchObject({ kind: 'http', details: { status: 403, code: 'EMAIL_UNVERIFIED' } });
    expect(client.getSession().status).toBe('unknown');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('treats a startup 401 as anonymous, but offline is unknown rather than a fake logout', async () => {
    vi.useFakeTimers();
    const { client, fetch } = setup();
    fetch.mockRejectedValueOnce(new TypeError('offline')).mockRejectedValueOnce(new TypeError('offline')).mockRejectedValueOnce(new TypeError('offline'));
    const pending = client.restoreSession();
    const assertion = expect(pending).rejects.toMatchObject({ kind: 'network' });
    await vi.runAllTimersAsync();
    await assertion;
    expect(client.getSession().status).toBe('unknown');
    fetch.mockResolvedValueOnce(json(error('AUTH_REQUIRED'), 401));
    expect(await client.restoreSession()).toBeNull();
    expect(client.getSession().status).toBe('anonymous');
  });
  it('retains an authenticated user on failed restore or offline logout', async () => {
    vi.useFakeTimers();
    const { client, fetch } = setup([json(user)]);
    await client.restoreSession();
    fetch.mockRejectedValueOnce(new TypeError('offline')).mockRejectedValueOnce(new TypeError('offline')).mockRejectedValueOnce(new TypeError('offline'));
    const restore = client.restoreSession();
    const assertion = expect(restore).rejects.toMatchObject({ kind: 'network' });
    await vi.runAllTimersAsync();
    await assertion;
    expect(client.getSession().status).toBe('authenticated');
    fetch.mockResolvedValueOnce(json(csrf())).mockRejectedValueOnce(new TypeError('offline'));
    await expect(client.logout()).rejects.toMatchObject({ kind: 'network' });
    expect(client.getSession().status).toBe('authenticated');
  });
  it('clears session/CSRF on any current private-resource 401, including malformed JSON', async () => {
    const { client, fetch } = setup([json(user), new Response('<html>proxy</html>', { status: 401 }), json(csrf()), json(accepted, 202)]);
    await client.restoreSession();
    await expect(client.listTrackedItems()).rejects.toMatchObject({ kind: 'invalid-response', details: { status: 401 } });
    expect(client.getSession().status).toBe('anonymous');
    await client.forgotPassword(user.email);
    request(fetch, 2, 'GET', '/auth/web/csrf');
  });
  it('does not expose a late private response after logout', async () => {
    const late = deferred<Response>();
    const { client, fetch } = setup([json(user)]);
    await client.restoreSession();
    fetch.mockReturnValueOnce(late.promise).mockResolvedValueOnce(json(csrf())).mockResolvedValueOnce(new Response(null, { status: 204 })).mockResolvedValueOnce(json(csrf()));
    const pending = client.listTrackedItems();
    await client.logout();
    late.resolve(json({ items: [item], page }));
    await expect(pending).rejects.toMatchObject({ kind: 'aborted' });
    expect(client.getSession().status).toBe('anonymous');
  });
  it('does not let an old /me 401 clear or falsely report logout for a newer login', async () => {
    const late = deferred<Response>();
    const { client, fetch } = setup();
    fetch.mockReturnValueOnce(late.promise).mockResolvedValueOnce(json(csrf())).mockResolvedValueOnce(json(login)).mockResolvedValueOnce(json(csrf(`${token}_new`)));
    const pending = client.restoreSession();
    await client.login({ email: user.email, password: 'password' });
    late.resolve(json(error('SESSION_EXPIRED'), 401));
    await expect(pending).rejects.toMatchObject({ kind: 'aborted' });
    expect(client.getSession().status).toBe('authenticated');
  });
  it('keeps a known login/logout transition even if its new CSRF bootstrap fails', async () => {
    const { client, fetch } = setup([json(csrf()), json(login), json({ csrfToken: 'invalid' })]);
    await expect(client.login({ email: user.email, password: 'password' })).rejects.toMatchObject({ kind: 'invalid-response' });
    expect(client.getSession().status).toBe('authenticated');
    fetch.mockResolvedValueOnce(json(csrf())).mockResolvedValueOnce(new Response(null, { status: 204 })).mockResolvedValueOnce(json({ csrfToken: 'invalid' }));
    await expect(client.logout()).rejects.toMatchObject({ kind: 'invalid-response' });
    expect(client.getSession().status).toBe('anonymous');
  });
});

describe('CSRF concurrency, expiration, and explicit recovery', () => {
  it('shares a concurrent bootstrap while sending each mutation only once', async () => {
    const bootstrap = deferred<Response>();
    const { client, fetch } = setup();
    fetch.mockReturnValueOnce(bootstrap.promise).mockResolvedValueOnce(json(accepted, 202)).mockResolvedValueOnce(json(accepted, 202));
    const first = client.forgotPassword(user.email), second = client.resendVerification(user.email);
    expect(fetch).toHaveBeenCalledTimes(1);
    bootstrap.resolve(json(csrf()));
    await Promise.all([first, second]);
    request(fetch, 1, 'POST', '/auth/web/forgot-password', { email: user.email }, { 'X-CSRF-Token': token });
    request(fetch, 2, 'POST', '/auth/web/resend-verification', { email: user.email }, { 'X-CSRF-Token': token });
  });
  it('does not let one cancelled waiter abort another caller’s bootstrap', async () => {
    const bootstrap = deferred<Response>(), controller = new AbortController();
    const { client, fetch } = setup();
    fetch.mockReturnValueOnce(bootstrap.promise).mockResolvedValueOnce(json(accepted, 202));
    const first = client.forgotPassword(user.email, { signal: controller.signal });
    const second = client.resendVerification(user.email);
    controller.abort();
    await expect(first).rejects.toMatchObject({ kind: 'aborted' });
    bootstrap.resolve(json(csrf()));
    await second;
    expect(fetch).toHaveBeenCalledTimes(2);
    request(fetch, 1, 'POST', '/auth/web/resend-verification', { email: user.email }, { 'X-CSRF-Token': token });
    await expect(client.forgotPassword(user.email, { signal: controller.signal })).rejects.toMatchObject({ kind: 'aborted' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('expires cached tokens and clears rejected bootstrap so an explicit retry can recover', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-28T12:00:00Z'));
    const { client, fetch } = setup([
      json({ csrfToken: token, expiresAt: '2026-10-28T12:00:01Z' }), json(accepted, 202),
      json({ csrfToken: token, expiresAt: '2026-10-28T12:00:00Z' }), json(csrf(`${token}_replacement`)), json(accepted, 202),
    ]);
    await client.forgotPassword(user.email);
    vi.advanceTimersByTime(1001);
    await expect(client.forgotPassword(user.email)).rejects.toMatchObject({ kind: 'invalid-response' });
    await client.forgotPassword(user.email);
    request(fetch, 4, 'POST', '/auth/web/forgot-password', { email: user.email }, { 'X-CSRF-Token': `${token}_replacement` });
  });
  it('invalidates CSRF_INVALID without automatically replaying an uncertain mutation', async () => {
    const { client, fetch } = setup([
      json(csrf()), json(error('CSRF_INVALID'), 403), json(csrf(`${token}_replacement`)), json(accepted, 202),
    ]);
    await expect(client.forgotPassword(user.email)).rejects.toMatchObject({ kind: 'http', details: { code: 'CSRF_INVALID' } });
    expect(fetch).toHaveBeenCalledTimes(2);
    await client.forgotPassword(user.email);
    request(fetch, 2, 'GET', '/auth/web/csrf');
    request(fetch, 3, 'POST', '/auth/web/forgot-password', { email: user.email }, { 'X-CSRF-Token': `${token}_replacement` });
  });
});
