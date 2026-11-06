import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useWatchlistSearch } from './useWatchlistSearch';
import { createSampleRepository } from './sampleRepository';
import { RepositoryError } from './types';

afterEach(() => vi.useRealTimers());
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

describe('watchlist search feedback', () => {
  it('debounces typing for 300 ms and retains labeled previous results', async () => {
    vi.useFakeTimers();
    const repository = createSampleRepository();
    const list = vi.spyOn(repository, 'list');
    const { result, rerender } = renderHook(({ query }) => useWatchlistSearch(repository, query), { initialProps: { query: '' } });
    await advance(300);
    expect(result.current.items).toHaveLength(2);
    rerender({ query: 'P' });
    await advance(200);
    rerender({ query: 'Portal' });
    expect(result.current.loading).toBe(true);
    expect(result.current.previous).toBe(true);
    expect(result.current.items).toHaveLength(2);
    await advance(299);
    expect(list).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(list).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenLastCalledWith('Portal');
    expect(result.current.previous).toBe(false);
    expect(result.current.items).toHaveLength(1);
  });

  it('keeps previous results and the failed query until a successful explicit retry', async () => {
    vi.useFakeTimers();
    const repository = createSampleRepository();
    const items = await repository.list();
    const list = vi.spyOn(repository, 'list').mockResolvedValueOnce(items)
      .mockRejectedValueOnce(new RepositoryError('offline', 'Offline'))
      .mockResolvedValueOnce([]);
    const { result, rerender } = renderHook(({ query }) => useWatchlistSearch(repository, query), { initialProps: { query: '' } });
    await advance(300);
    rerender({ query: 'missing' });
    await advance(300);
    expect(result.current.error).toMatchObject({ code: 'offline' });
    expect(result.current.previous).toBe(true);
    expect(result.current.items).toEqual(items);
    act(() => result.current.retry());
    await advance(300);
    expect(list).toHaveBeenLastCalledWith('missing');
    expect(result.current.error).toBeUndefined();
    expect(result.current.items).toEqual([]);
    expect(result.current.previous).toBe(false);
  });

  it('ignores late responses and cancels search on query changes and unmount', async () => {
    vi.useFakeTimers();
    const repository = { ...createSampleRepository(), cancelSearch: vi.fn() };
    const items = await repository.list();
    let resolve!: (value: typeof items) => void;
    vi.spyOn(repository, 'list').mockReturnValueOnce(new Promise((r) => { resolve = r; })).mockResolvedValueOnce([]);
    const { result, rerender, unmount } = renderHook(({ query }) => useWatchlistSearch(repository, query), { initialProps: { query: 'old' } });
    await advance(300);
    rerender({ query: 'new' });
    expect(repository.cancelSearch).toHaveBeenCalledOnce();
    await advance(300);
    await act(async () => resolve(items));
    expect(result.current.items).toEqual([]);
    unmount();
    expect(repository.cancelSearch).toHaveBeenCalledTimes(2);
  });
});
