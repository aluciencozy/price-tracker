import { describe, expect, it, vi } from 'vitest';
import { WebClient } from './webClient';
import { createApiRepository } from './apiRepository';
import { csrf, create, error, history, item, json, page, token } from './testFixtures';

describe('API presentation repository', () => {
  it('loads every watchlist page with literal search and only local art', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json({ items: [{ ...item, product: { ...item.product, imageUrl: 'https://untrusted.example/image.png' } }], page: { limit: 100, nextCursor: 'next+/=' } })).mockResolvedValueOnce(json({ items: [{ ...item, id: 'second' }], page }));
    const repository = createApiRepository(new WebClient({ fetch }));
    const result = await repository.list('Portal & 2');
    expect(result).toHaveLength(2);
    expect(result[0]?.product.imageUrl).toBe('/art/620.jpg');
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/tracked-items?limit=100&q=Portal+%26+2', '/api/tracked-items?limit=100&cursor=next%2B%2F%3D&q=Portal+%26+2']);
  });
  it('preserves normalized history window and retention across every page without illustrative data', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json({ ...history, page: { limit: 100, nextCursor: 'continue' } })).mockResolvedValueOnce(json({ ...history, items: [], page }));
    const repository = createApiRepository(new WebClient({ fetch }));
    expect(await repository.history(item.id)).toEqual({ illustrative: false, items: history.items, window: history.window, retainedFrom: history.retainedFrom });
    expect(fetch.mock.calls[1]?.[0]).toBe('/api/tracked-items/tracker_example/history?limit=100&cursor=continue&from=2026-10-01T00%3A00%3A00Z&to=2026-10-28T12%3A00%3A00Z');
  });
  it('rejects repeated pagination rather than truncating or looping', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => json({ items: [], page: { limit: 100, nextCursor: 'same' } }));
    await expect(createApiRepository(new WebClient({ fetch })).list()).rejects.toThrow('pagination');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('reuses a save key after uncertain failure, maps owned duplicates, and never fetches a provider', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json(csrf())).mockRejectedValueOnce(new TypeError('offline')).mockResolvedValueOnce(json({ error: { ...error('DUPLICATE_TRACKED_ITEM').error, resourceId: item.id } }, 409));
    const repository = createApiRepository(new WebClient({ fetch }));
    await expect(repository.create(create)).rejects.toMatchObject({ code: 'offline' });
    await expect(repository.create(create)).rejects.toMatchObject({ code: 'duplicate', resourceId: item.id });
    expect(fetch.mock.calls[1]?.[1]?.headers).toEqual(fetch.mock.calls[2]?.[1]?.headers);
    expect(fetch.mock.calls[1]?.[1]?.headers).toMatchObject({ 'X-CSRF-Token': token, 'Idempotency-Key': expect.any(String) });
    expect(fetch.mock.calls[1]?.[1]?.body).toBe(JSON.stringify(create));
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it('cancels route requests and hides late errors on disposal', async () => {
    let resolve!: (value: Response) => void;
    const fetch = vi.fn<typeof globalThis.fetch>().mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    const repository = createApiRepository(new WebClient({ fetch }));
    const pending = repository.get(item.id);
    repository.cancelPending();
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    resolve(json(error('NOT_FOUND'), 404));
    await expect(pending).rejects.toMatchObject({ kind: 'aborted' });
  });
});
