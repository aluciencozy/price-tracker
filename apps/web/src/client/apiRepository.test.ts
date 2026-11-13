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
  token,
} from './testFixtures';

describe('API presentation repository', () => {
  const url = 'https://store.steampowered.com/app/620/';
  const preview = { id: 'preview_example', expiresAt: csrf().expiresAt, product };
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
