import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHttp, ClientError, type HttpOptions } from './http';
import { trackedItems } from './dto';
import { error, json, page } from './testFixtures';

function setup(responses: Response[] = [], options: HttpOptions = {}) {
  const fetch = vi.fn<typeof globalThis.fetch>();
  for (const response of responses) fetch.mockResolvedValueOnce(response);
  const request = createHttp({ baseUrl: 'https://api.example.test', development: false, ...options, fetch });
  return { request, fetch };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('bounded JSON HTTP transport', () => {
  it('honors a server wait across requests without carrying private details between routes', async () => {
    vi.useFakeTimers();
    const { request, fetch } = setup([json(error('RATE_LIMITED', 60), 429), json({ items: [], page })]);
    await expect(request('GET', '/tracked-items', 200, trackedItems)).rejects.toMatchObject({ kind: 'http', details: { retryAfterSeconds: 60 } });
    await expect(request('POST', '/product-previews', 201, (v) => v)).rejects.toMatchObject({
      message: 'The API asked us to wait before another request.', details: { code: 'RATE_LIMITED', retryAfterSeconds: 60 },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await request('GET', '/tracked-items', 200, trackedItems)).toEqual({ items: [], page });
  });
  it.each([
    { ...error('UNKNOWN_RATE_LIMIT', 1), status: 429 },
    { ...error('SESSION_EXPIRED', 1), status: 429 },
    { ...error('RATE_LIMITED', 1), status: 401 },
    { ...error('RATE_LIMITED'), status: 429 },
    { error: { ...error('RATE_LIMITED', 1).error, fields: [{ path: '/query/limit', code: 'unknown', message: 'Invalid.' }] }, status: 429 },
  ])('rejects invalid contract error codes before retrying %#', async ({ status, ...body }) => {
    const { request, fetch } = setup([json(body, status)]);
    await expect(request('GET', '/tracked-items', 200, trackedItems)).rejects.toMatchObject({ kind: 'invalid-response', details: { status } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('uses credentials, explicit JSON, no auth/origin spoofing, and refuses redirect following', async () => {
    const { request, fetch } = setup([json({ items: [], page })]);
    expect(fetch).not.toHaveBeenCalled();
    await request('GET', '/tracked-items?cursor=a%2B%2F', 200, trackedItems);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://api.example.test/api/tracked-items?cursor=a%2B%2F');
    expect(init).toMatchObject({ method: 'GET', credentials: 'include', redirect: 'error', cache: 'no-store', headers: { Accept: 'application/json' } });
    expect(init?.headers).toEqual({ Accept: 'application/json' });
    expect(init?.body).toBeUndefined();
    expect(init?.signal).toBeDefined();
  });
  it('serializes JSON mutations exactly and handles bodyless 204 without JSON parsing', async () => {
    const { request, fetch } = setup([json({ id: 'preview' }, 201), new Response(null, { status: 204 })]);
    const body = { url: 'https://store.steampowered.com/app/620/' };
    await request('POST', '/product-previews', 201, (v) => v, { body, headers: { 'X-CSRF-Token': 'test-only' } });
    await request('DELETE', '/tracked-items/opaque', 204, () => undefined, { headers: { 'X-CSRF-Token': 'test-only' } });
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST', body: JSON.stringify(body), headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF-Token': 'test-only' },
    });
    expect(fetch.mock.calls[1]?.[1]?.body).toBeUndefined();
    expect(fetch.mock.calls[1]?.[1]?.headers).toEqual({ Accept: 'application/json', 'X-CSRF-Token': 'test-only' });
  });
  it.each([
    new Response('<html>proxy</html>', { headers: { 'Content-Type': 'text/html' } }),
    new Response('{bad', { headers: { 'Content-Type': 'application/json' } }),
    json({ items: [], page }, 201), new Response(null, { status: 204 }),
    json({ items: [], page: { limit: 20, nextCursor: 123 } }),
    new Response('x'.repeat(1_048_577), { headers: { 'Content-Type': 'application/json' } }),
  ])('rejects malformed/unexpected success without sample fallback %#', async (response) => {
    const { request, fetch } = setup([response]);
    await expect(request('GET', '/tracked-items', 200, trackedItems)).rejects.toMatchObject({ kind: 'invalid-response' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('preserves validation/duplicate details and never retries uncertain mutations', async () => {
    const detail = { ...error('DUPLICATE_TRACKED_ITEM').error, resourceId: 'owned_tracker', fields: [{ path: '/previewId', code: 'invalid_value', message: 'Already tracked.' }] };
    const { request, fetch } = setup([json({ error: detail }, 409)]);
    await expect(request('POST', '/tracked-items', 201, (v) => v)).rejects.toMatchObject({ kind: 'http', message: detail.message, details: { ...detail, status: 409 } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('keeps status on invalid HTML error bodies and notifies session loss immediately', async () => {
    const unauthorized = vi.fn();
    const { request } = setup([new Response('<html>private proxy details</html>', { status: 401 })]);
    await expect(request('GET', '/auth/web/me', 200, (v) => v, { onUnauthorized: unauthorized })).rejects.toMatchObject({
      kind: 'invalid-response', message: 'Unexpected API response.', details: { status: 401 },
    });
    expect(unauthorized).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['120', 120], [' 0 ', 0], ['Wed, 28 Oct 2026 12:01:00 GMT', 60],
    ['Wed, 28 Oct 2026 11:59:00 GMT', 0], ['-2', null], ['1.5', null],
    ['Infinity', null], ['9007199254740992', null], ['tomorrow', null],
  ])('parses Retry-After safely: %s', async (header, expected) => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-28T12:00:00Z'));
    const { request, fetch } = setup([json(error('SERVICE_UNAVAILABLE'), 503, { 'Retry-After': header! })]);
    await expect(request('POST', '/product-previews', 201, (v) => v)).rejects.toMatchObject({ details: { status: 503, retryAfterSeconds: expected } });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('honors the larger body/header wait and returns long waits without retrying early', async () => {
    const { request, fetch } = setup([json(error('PROVIDER_RATE_LIMITED', 90), 429, { 'Retry-After': '60' })]);
    await expect(request('GET', '/tracked-items', 200, trackedItems)).rejects.toMatchObject({ details: { retryAfterSeconds: 90 } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('retries safe GETs after bounded jitter and at most twice', async () => {
    vi.useFakeTimers(); vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const { request, fetch } = setup();
    fetch.mockRejectedValue(new TypeError('offline'));
    const result = request('GET', '/tracked-items', 200, trackedItems);
    const assertion = expect(result).rejects.toMatchObject({ kind: 'network' });
    await vi.advanceTimersByTimeAsync(374);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(625);
    await assertion;
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('waits for Retry-After before retrying a GET, then returns the real response', async () => {
    vi.useFakeTimers(); vi.spyOn(Math, 'random').mockReturnValue(0);
    const { request, fetch } = setup([json(error('RATE_LIMITED', 2), 429, { 'Retry-After': '1' }), json({ items: [], page })]);
    const pending = request('GET', '/tracked-items', 200, trackedItems);
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ items: [], page });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('re-checks the shared cooldown before retrying a GET that is already backing off', async () => {
    vi.useFakeTimers(); vi.spyOn(Math, 'random').mockReturnValue(0);
    const { request, fetch } = setup();
    fetch.mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(json(error('RATE_LIMITED', 60), 429, { 'Retry-After': '60' }));
    const backingOff = request('GET', '/tracked-items', 200, trackedItems);
    const assertion = expect(backingOff).rejects.toMatchObject({
      kind: 'http', message: 'The API asked us to wait before another request.',
      details: { status: 429, code: 'RATE_LIMITED', retryAfterSeconds: 60 },
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(request('GET', '/tracked-items', 200, trackedItems)).rejects.toMatchObject({
      kind: 'http', details: { status: 429, code: 'RATE_LIMITED', retryAfterSeconds: 60 },
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(250);
    expect(fetch).toHaveBeenCalledTimes(2);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });
  it('never retries POST/PATCH/DELETE after a network failure', async () => {
    const { request, fetch } = setup();
    fetch.mockRejectedValue(new TypeError('offline'));
    for (const method of ['POST', 'PATCH', 'DELETE'] as const) {
      await expect(request(method, '/tracked-items/opaque', 204, () => undefined)).rejects.toMatchObject({ kind: 'network' });
    }
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it('times out the entire request, including a stalled response body', async () => {
    vi.useFakeTimers();
    const bodyCancelled = vi.fn();
    const response = new Response(new ReadableStream({ cancel: bodyCancelled }), { headers: { 'Content-Type': 'application/json' } });
    const { request } = setup([response], { timeoutMs: 25 });
    const pending = request('POST', '/product-previews', 201, (v) => v);
    const assertion = expect(pending).rejects.toMatchObject({ kind: 'timeout' });
    await vi.advanceTimersByTimeAsync(25);
    await assertion;
    expect(bodyCancelled).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not accept a valid JSON prefix when abort cancels an unfinished body', async () => {
    vi.useFakeTimers();
    const response = new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"id":"preview"}')); },
    }), { headers: { 'Content-Type': 'application/json' } });
    const { request } = setup([response], { timeoutMs: 25 });
    const pending = request('POST', '/product-previews', 201, (v) => v);
    const assertion = expect(pending).rejects.toMatchObject({ kind: 'timeout' });
    await vi.advanceTimersByTimeAsync(25);
    await assertion;
  });
  it('bounds a stalled fetch and distinguishes caller abort from timeout', async () => {
    vi.useFakeTimers();
    const { request, fetch } = setup([], { timeoutMs: 25 });
    fetch.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    const timed = request('POST', '/product-previews', 201, (v) => v);
    const assertion = expect(timed).rejects.toMatchObject({ kind: 'timeout' });
    await vi.advanceTimersByTimeAsync(25);
    await assertion;
    const controller = new AbortController();
    const aborted = request('GET', '/tracked-items', 200, trackedItems, { signal: controller.signal });
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ kind: 'aborted' });
    await expect(request('POST', '/product-previews', 201, (v) => v, { signal: controller.signal })).rejects.toMatchObject({ kind: 'aborted' });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('allows abort during retry backoff without another request', async () => {
    vi.useFakeTimers();
    const { request, fetch } = setup();
    fetch.mockRejectedValue(new TypeError('offline'));
    const controller = new AbortController();
    const pending = request('GET', '/tracked-items', 200, trackedItems, { signal: controller.signal });
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ kind: 'aborted' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('public API origin configuration', () => {
  it.each(['https://api.example.test/', '', 'http://localhost:4000', 'http://127.0.0.1:4000'])('accepts safe origins: %s', async (baseUrl) => {
    const { request, fetch } = setup([json({ items: [], page })], { baseUrl, development: true });
    await request('GET', '/tracked-items', 200, trackedItems);
    expect(fetch.mock.calls[0]?.[0]).toBe(`${baseUrl.replace(/\/$/, '')}/api/tracked-items`);
  });
  it.each([
    'https://api.example.test/api', 'https://user:pass@api.example.test', 'https://api.example.test?x=1',
    'https://api.example.test#secret', 'http://api.example.test', '//api.example.test',
    'http://localhost.evil.example', 'http://10.0.2.2:4000', 'javascript:alert(1)',
  ])('rejects unsafe/non-origin configuration: %s', (baseUrl) => {
    expect(() => setup([], { baseUrl, development: true })).toThrow(ClientError);
  });
  it('allows loopback HTTP only in development and bounds request timeouts', () => {
    expect(() => setup([], { baseUrl: 'http://127.0.0.1:4000', development: false })).toThrow(ClientError);
    expect(() => setup([], { timeoutMs: 0 })).toThrow(ClientError);
    expect(() => setup([], { timeoutMs: 30_001 })).toThrow(ClientError);
  });
});
