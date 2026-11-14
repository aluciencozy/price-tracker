import { describe, expect, it, vi } from 'vitest';
import { WebClient } from './webClient';
import { createApiRepository } from './apiRepository';
import {
  csrf,
  create,
  error,
  history,
  item,
  json,
  page,
  product,
  refreshFixture,
  token,
} from './testFixtures';

describe('API presentation repository', () => {
  const url = 'https://store.steampowered.com/app/620/';
  const preview = { id: 'preview_example', expiresAt: csrf().expiresAt, product };
  it('polls queued work no faster than Retry-After and enforces the terminal cooldown', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-28T12:00:00.000Z'));
    const queued = refreshFixture('queued');
    const refreshed = refreshFixture('refreshed');
    let polls = 0;
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (path) => {
      if (path === '/api/auth/web/csrf') return json(csrf());
      if (path === `/api/tracked-items/${item.id}/refresh`)
        return json(queued, 202, { Location: `/api/tracked-item-refreshes/${queued.id}`, 'Retry-After': '10' });
      if (path === `/api/tracked-item-refreshes/${queued.id}`) {
        polls++;
        return polls === 1
          ? json({ ...queued, status: 'running', startedAt: '2026-10-28T12:00:05.000Z' }, 200, { 'Retry-After': '15' })
          : json(refreshed);
      }
      throw new Error(`Unexpected request: ${String(path)}`);
    });
    const repository = createApiRepository(new WebClient({ fetch }));
    const pending = repository.refreshPrice(item.id);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(fetch.mock.calls.filter(([path]) => String(path).includes('/tracked-item-refreshes/'))).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(polls).toBe(1);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(polls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ status: 'refreshed' });
    await expect(repository.refreshPrice(item.id)).rejects.toMatchObject({ details: { retryAfterSeconds: expect.any(Number) } });
    expect(fetch.mock.calls.filter(([path]) => String(path).endsWith('/refresh'))).toHaveLength(1);
    vi.useRealTimers();
  });
  it('stops queued polling at the bounded minute without replaying the POST', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-28T12:00:00.000Z'));
    const queued = refreshFixture('queued');
    const cached = refreshFixture('cached');
    let completed = false;
    let posts = 0;
    let polls = 0;
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (path) => {
      if (path === '/api/auth/web/csrf') return json(csrf());
      if (path === `/api/tracked-items/${item.id}/refresh`) {
        posts++;
        return json(queued, 202, { Location: `/api/tracked-item-refreshes/${queued.id}`, 'Retry-After': '5' });
      }
      if (path === `/api/tracked-item-refreshes/${queued.id}`) {
        polls++;
        if (completed) return json(cached);
        return json({ ...queued, status: 'running', startedAt: '2026-10-28T12:00:01.000Z' }, 200, { 'Retry-After': '5' });
      }
      throw new Error(`Unexpected request: ${String(path)}`);
    });
    const repository = createApiRepository(new WebClient({ fetch }));
    const pending = repository.refreshPrice(item.id);
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(pending).resolves.toMatchObject({ status: 'running' });
    expect(posts).toBe(1);
    expect(polls).toBe(12);
    completed = true;
    await expect(repository.resumeRefresh(queued.id, item.id)).resolves.toMatchObject({
      id: queued.id,
      status: 'cached',
    });
    expect(posts).toBe(1);
    expect(polls).toBe(13);
    vi.useRealTimers();
  });
  it('returns a terminal 202 immediately without a status GET or a second POST', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-28T12:00:30.000Z'));
    const cached = refreshFixture('cached');
    let posts = 0;
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (path) => {
      if (path === '/api/auth/web/csrf') return json(csrf());
      if (path === `/api/tracked-items/${item.id}/refresh`) {
        posts++;
        return json(cached, 202, {
          Location: `/api/tracked-item-refreshes/${cached.id}`,
          'Retry-After': '5',
        });
      }
      throw new Error(`Unexpected request: ${String(path)}`);
    });
    const repository = createApiRepository(new WebClient({ fetch }));
    await expect(repository.refreshPrice(item.id)).resolves.toMatchObject({
      status: 'cached',
    });
    expect(posts).toBe(1);
    expect(fetch.mock.calls.filter(([path]) => String(path).includes('/tracked-item-refreshes/'))).toHaveLength(0);
    vi.useRealTimers();
  });
  it('keeps server refresh cooldowns scoped to each tracked item', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-28T12:00:30.000Z'));
    const posts: string[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (path, init) => {
      const url = String(path);
      if (url === '/api/auth/web/csrf') return json(csrf());
      const trackerId = url.match(/tracked-items\/([^/]+)\/refresh/)?.[1];
      if (init?.method === 'POST' && trackerId) {
        posts.push(trackerId);
        const requestId = `refresh_${trackerId}`;
        return json(refreshFixture('queued', requestId, trackerId), 202, {
          Location: `/api/tracked-item-refreshes/${requestId}`,
          'Retry-After': '5',
        });
      }
      const requestId = url.split('/').at(-1)!;
      const owner = requestId.slice('refresh_'.length);
      return json(refreshFixture('cached', requestId, owner));
    });
    const repository = createApiRepository(new WebClient({ fetch }));
    const first = repository.refreshPrice(item.id);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(first).resolves.toMatchObject({ status: 'cached' });
    const second = repository.refreshPrice('tracker_other');
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(second).resolves.toMatchObject({ status: 'cached' });
    await expect(repository.refreshPrice(item.id)).rejects.toMatchObject({
      details: { retryAfterSeconds: expect.any(Number) },
    });
    expect(posts).toEqual([item.id, 'tracker_other']);
    vi.useRealTimers();
  });
  it('stops at a deferred state and honors its provider retry time without another POST', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-28T12:00:00.000Z'));
    let posts = 0, polls = 0;
    const queued = refreshFixture('queued');
    const deferred = refreshFixture('deferred');
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (path) => {
      if (path === '/api/auth/web/csrf') return json(csrf());
      if (path === `/api/tracked-items/${item.id}/refresh`) {
        posts++;
        return json(queued, 202, {
          Location: `/api/tracked-item-refreshes/${queued.id}`,
          'Retry-After': '5',
        });
      }
      if (path === `/api/tracked-item-refreshes/${queued.id}`) {
        polls++;
        return json(deferred, 200, { 'Retry-After': '5' });
      }
      throw new Error(`Unexpected request: ${String(path)}`);
    });
    const repository = createApiRepository(new WebClient({ fetch }));
    const pending = repository.refreshPrice(item.id);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(pending).resolves.toMatchObject({ status: 'deferred' });
    expect(polls).toBe(1);
    await expect(repository.refreshPrice(item.id)).rejects.toMatchObject({
      details: { retryAfterSeconds: expect.any(Number) },
    });
    expect(posts).toBe(1);
    vi.useRealTimers();
  });
  function previewRepository(
    list: (path: string) => Response | Promise<Response>,
    previewValue = preview,
  ) {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (path) => {
      if (String(path) === '/api/auth/web/csrf') return json(csrf());
      if (String(path) === '/api/product-previews') return json({ ...previewValue, expiresAt: new Date(Date.now() + 600_000).toISOString() }, 201);
      return list(String(path));
    });
    return { fetch, repository: createApiRepository(new WebClient({ fetch })) };
  }
  it('passes through a synthetic Brotato preview without substituting a sample product', async () => {
    const brotatoUrl = 'https://store.steampowered.com/app/1942280/';
    const brotatoProduct = {
      ...product,
      id: 'product_brotato_fixture',
      identity: { ...product.identity, providerGameId: '90001' },
      steamAppId: '1942280',
      canonicalSteamUrl: brotatoUrl,
      title: 'Brotato',
      currentPrice: { amountMinor: 0, currency: 'USD' as const },
      imageUrl: null,
    };
    const brotatoPreview = {
      id: 'preview_brotato_fixture',
      expiresAt: csrf().expiresAt,
      product: brotatoProduct,
    };
    // Synthetic provider ID and zero price exercise client shape only, not source support.
    const { fetch, repository } = previewRepository(
      () => json({ items: [], page }),
      brotatoPreview,
    );

    const result = await repository.preview(brotatoUrl);

    expect(result.product).toMatchObject({
      steamAppId: '1942280',
      title: 'Brotato',
      currentPrice: { amountMinor: 0, currency: 'USD' },
      identity: { providerGameId: '90001', storeId: '1', market: 'US', currency: 'USD' },
      imageUrl: '/art/fallback.svg',
    });
    const request = fetch.mock.calls.find(
      ([path]) => path === '/api/product-previews',
    );
    expect(request?.[1]?.method).toBe('POST');
    expect(JSON.parse(request?.[1]?.body as string)).toEqual({ url: brotatoUrl });
    expect(fetch.mock.calls.every(([path]) => String(path).startsWith('/api/'))).toBe(true);
  });
  it('finds an owned duplicate on a later page before returning a preview', async () => {
    const { repository, fetch } = previewRepository((path) => json(path.includes('cursor=')
      ? { items: [item], page: { limit: 100, nextCursor: 'unused' } }
      : { items: [], page: { limit: 100, nextCursor: 'next' } }));
    const checking = vi.fn();
    await expect(repository.preview(url, checking)).rejects.toMatchObject({ code: 'duplicate', resourceId: item.id });
    expect(checking).toHaveBeenCalledOnce();
    expect(fetch.mock.calls.filter(([path]) => String(path).startsWith('/api/tracked-items'))).toHaveLength(2);
    expect(fetch.mock.calls.some(([path]) => String(path).includes('q='))).toBe(false);
  });
  it('compares exact offer identity rather than matching titles or product IDs', async () => {
    const sameTitle = { ...item, product: { ...product, identity: { ...product.identity, providerGameId: '59' } } };
    const { repository } = previewRepository(() => json({ items: [sameTitle], page }));
    await expect(repository.preview(url)).resolves.toMatchObject({ id: preview.id });
    const { repository: sameIdentity } = previewRepository(() => json({ items: [{ ...item, product: { ...product, id: 'different_id' } }], page }));
    await expect(sameIdentity.preview(url)).rejects.toMatchObject({ code: 'duplicate' });
  });
  it('requires a successful lookup and reuses a valid preview after lookup failure', async () => {
    let lookups = 0;
    const { repository, fetch } = previewRepository(() => ++lookups <= 3
      ? Promise.reject(new TypeError('offline')) : json({ items: [], page }));
    await expect(repository.preview(url)).rejects.toMatchObject({ code: 'offline' });
    await expect(repository.preview(url)).resolves.toMatchObject({ id: preview.id });
    expect(fetch.mock.calls.filter(([path]) => path === '/api/product-previews')).toHaveLength(1);
    expect(lookups).toBe(4);
  });
  it('refreshes an expired preview on retry and discards it when the URL is edited', async () => {
    const { repository, fetch } = previewRepository(() => Promise.reject(new TypeError('offline')));
    await expect(repository.preview(url)).rejects.toMatchObject({ code: 'offline' });
    const time = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 600_001);
    try {
      await expect(repository.preview(url)).rejects.toMatchObject({ code: 'offline' });
    } finally { time.mockRestore(); }
    expect(fetch.mock.calls.filter(([path]) => path === '/api/product-previews')).toHaveLength(2);
    repository.clearPreview?.();
    await expect(repository.preview(url)).rejects.toMatchObject({ code: 'offline' });
    expect(fetch.mock.calls.filter(([path]) => path === '/api/product-previews')).toHaveLength(3);
  });
  it('does not treat repeated cursors or an exhausted page budget as a successful duplicate check', async () => {
    const repeated = previewRepository(() => json({ items: [], page: { limit: 100, nextCursor: 'same' } }));
    await expect(repeated.repository.preview(url)).rejects.toThrow('pagination');
    let cursor = 0;
    const bounded = previewRepository(() => json({ items: [], page: { limit: 100, nextCursor: `page${++cursor}` } }));
    await expect(bounded.repository.preview(url)).rejects.toThrow('bounded page limit');
    expect(cursor).toBe(100);
  });
  it('honors Retry-After before retrying a duplicate lookup', async () => {
    const { repository, fetch } = previewRepository(() => json(error('RATE_LIMITED', 2), 429, { 'Retry-After': '2' }));
    await expect(repository.preview(url)).rejects.toMatchObject({ details: { retryAfterSeconds: 2 } });
    const calls = fetch.mock.calls.length;
    await expect(repository.preview(url)).rejects.toMatchObject({ details: { retryAfterSeconds: 2 } });
    expect(fetch).toHaveBeenCalledTimes(calls);
  });
  it('aborts duplicate lookups on disposal and never revives the cached preview', async () => {
    let resolve!: (value: Response) => void;
    const pending = new Promise<Response>((r) => { resolve = r; });
    const { repository, fetch } = previewRepository(() => pending);
    const checking = vi.fn();
    const result = repository.preview(url, checking);
    await vi.waitFor(() => expect(checking).toHaveBeenCalled());
    repository.cancelPending();
    const lookup = fetch.mock.calls.find(([path]) => String(path).startsWith('/api/tracked-items'));
    expect(lookup?.[1]?.signal?.aborted).toBe(true);
    resolve(json({ items: [], page }));
    await expect(result).rejects.toMatchObject({ kind: 'aborted' });
    await expect(repository.preview(url)).resolves.toMatchObject({ id: preview.id });
    expect(fetch.mock.calls.filter(([path]) => path === '/api/product-previews')).toHaveLength(2);
  });
  it('loads every watchlist page with literal search and only local art', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        json({
          items: [
            {
              ...item,
              product: {
                ...item.product,
                imageUrl: 'https://untrusted.example/image.png',
              },
            },
          ],
          page: { limit: 100, nextCursor: 'next+/=' },
        }),
      )
      .mockResolvedValueOnce(
        json({ items: [{ ...item, id: 'second' }], page }),
      );
    const repository = createApiRepository(new WebClient({ fetch }));
    const result = await repository.list('Portal & 2');
    expect(result).toHaveLength(2);
    expect(result[0]?.product.imageUrl).toBe('/art/620.jpg');
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      '/api/tracked-items?limit=100&q=Portal+%26+2',
      '/api/tracked-items?limit=100&cursor=next%2B%2F%3D&q=Portal+%26+2',
    ]);
  });
  it('preserves normalized history window and retention across every page without illustrative data', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        json({ ...history, page: { limit: 100, nextCursor: 'continue' } }),
      )
      .mockResolvedValueOnce(json({ ...history, items: [], page }));
    const repository = createApiRepository(new WebClient({ fetch }));
    expect(await repository.history(item.id)).toEqual({
      illustrative: false,
      items: history.items,
      window: history.window,
      retainedFrom: history.retainedFrom,
    });
    expect(fetch.mock.calls[1]?.[0]).toBe(
      '/api/tracked-items/tracker_example/history?limit=100&cursor=continue&from=2026-10-01T00%3A00%3A00Z&to=2026-10-28T12%3A00%3A00Z',
    );
  });
  it('rejects repeated pagination rather than truncating or looping', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () =>
        json({ items: [], page: { limit: 100, nextCursor: 'same' } }),
      );
    await expect(
      createApiRepository(new WebClient({ fetch })).list(),
    ).rejects.toThrow('pagination');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('reuses a save key after uncertain failure, maps owned duplicates, and never fetches a provider', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json(csrf()))
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(
        json(
          {
            error: {
              ...error('DUPLICATE_TRACKED_ITEM').error,
              resourceId: item.id,
            },
          },
          409,
        ),
      );
    const repository = createApiRepository(new WebClient({ fetch }));
    await expect(repository.create(create)).rejects.toMatchObject({
      code: 'offline',
    });
    await expect(repository.create(create)).rejects.toMatchObject({
      code: 'duplicate',
      resourceId: item.id,
    });
    expect(fetch.mock.calls[1]?.[1]?.headers).toEqual(
      fetch.mock.calls[2]?.[1]?.headers,
    );
    expect(fetch.mock.calls[1]?.[1]?.headers).toMatchObject({
      'X-CSRF-Token': token,
      'Idempotency-Key': expect.any(String),
    });
    expect(fetch.mock.calls[1]?.[1]?.body).toBe(JSON.stringify(create));
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it('issues a new save key after preferences change, even when values later return to an earlier payload', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (path) =>
      String(path) === '/api/auth/web/csrf'
        ? json(csrf())
        : Promise.reject(new TypeError('offline')),
    );
    const repository = createApiRepository(new WebClient({ fetch }));
    const changed = { ...create, targetPrice: { amountMinor: 250, currency: 'USD' as const } };

    await expect(repository.create(create)).rejects.toMatchObject({ code: 'offline' });
    await expect(repository.create(changed)).rejects.toMatchObject({ code: 'offline' });
    await expect(repository.create(create)).rejects.toMatchObject({ code: 'offline' });

    const requests = fetch.mock.calls.filter(([, init]) => init?.method === 'POST');
    const keys = requests.map(([, init]) => (init?.headers as Record<string, string>)['Idempotency-Key']);
    expect(requests.map(([, init]) => init?.body)).toEqual([
      JSON.stringify(create),
      JSON.stringify(changed),
      JSON.stringify(create),
    ]);
    expect(new Set(keys).size).toBe(3);
  });
  it('cancels route requests and hides late errors on disposal', async () => {
    let resolve!: (value: Response) => void;
    const fetch = vi.fn<typeof globalThis.fetch>().mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const repository = createApiRepository(new WebClient({ fetch }));
    const pending = repository.get(item.id);
    repository.cancelPending();
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    resolve(json(error('NOT_FOUND'), 404));
    await expect(pending).rejects.toMatchObject({ kind: 'aborted' });
  });
});
