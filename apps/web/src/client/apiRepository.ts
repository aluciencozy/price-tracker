import {
  RepositoryError,
  type TrackerRepository,
  type Product,
  type Preferences,
  type ProductPreview,
  type PriceRefresh,
  type RefreshTrackerRepository,
} from '../data/types';
import { parseSteamUrl } from '../data/validation';
import { ClientError } from './http';
import { WebClient } from './webClient';
import type { RefreshPoll } from './dto';

function localProduct(product: Product): Product {
  return {
    ...product,
    imageUrl: ['620', '220'].includes(product.steamAppId)
      ? `/art/${product.steamAppId}.jpg`
      : '/art/fallback.svg',
  };
}
export function repositoryError(error: unknown): unknown {
  if (!(error instanceof ClientError) || error.kind === 'aborted')
    return error;
  const { code, status, resourceId, ...details } = error.details;
  const category =
    status === 401
      ? 'expired'
      : status === 404
        ? 'not-found'
        : code === 'DUPLICATE_TRACKED_ITEM'
          ? 'duplicate'
          : code === 'PREVIEW_EXPIRED'
            ? 'preview-expired'
            : code === 'STEAM_OFFER_UNAVAILABLE'
              ? 'missing-offer'
              : [
                    'UNSUPPORTED_URL',
                    'UNSUPPORTED_PRODUCT',
                    'AMBIGUOUS_PRODUCT',
                  ].includes(code ?? '')
                ? 'unsupported'
                : status === 422 || error.kind === 'invalid-input'
                  ? 'validation'
                  : error.kind === 'network' || error.kind === 'timeout'
                    ? 'offline'
                    : 'save-error';
  return new RepositoryError(
    category,
    error.message,
    resourceId ?? undefined,
    details,
  );
}

// One instance per private route. No record cache or sample fallback.
export function createApiRepository(
  client: WebClient,
): TrackerRepository & RefreshTrackerRepository & { cancelPending(): void } {
  let controller = new AbortController();
  let generation = 0;
  let retryAt = 0;
  const refreshRetryAt = new Map<string, number>();
  let listController: AbortController | undefined;
  let pendingPreview: { url: string; value: ProductPreview } | undefined;
  let pendingCreate: { signature: string; key: string } | undefined;
  async function run<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    externalSignal?: AbortSignal,
  ): Promise<T> {
    const current = generation;
    if (externalSignal?.aborted)
      throw new ClientError('aborted', 'Request cancelled.');
    if (Date.now() < retryAt)
      throw new RepositoryError(
        'save-error',
        'Please wait before trying again.',
        undefined,
        { retryAfterSeconds: Math.ceil((retryAt - Date.now()) / 1000) },
      );
    try {
      const signal = externalSignal
        ? AbortSignal.any([controller.signal, externalSignal])
        : controller.signal;
      const result = await operation(signal);
      if (generation !== current)
        throw new ClientError('aborted', 'View changed.');
      return result;
    } catch (error) {
      if (generation !== current)
        throw new ClientError('aborted', 'View changed.');
      if (error instanceof ClientError && error.details.retryAfterSeconds)
        retryAt = Date.now() + error.details.retryAfterSeconds * 1000;
      throw repositoryError(error);
    }
  }
  function wait(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted)
      return Promise.reject(new ClientError('aborted', 'Request cancelled.'));
    return new Promise((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        reject(new ClientError('aborted', 'Request cancelled.'));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', abort);
        resolve();
      }, ms);
      signal.addEventListener('abort', abort, { once: true });
    });
  }
  function publicRefresh(refresh: RefreshPoll): PriceRefresh {
    const value: Partial<RefreshPoll> = { ...refresh };
    delete value.pollAfterSeconds;
    return value as PriceRefresh;
  }
  async function pollRefresh(
    trackerId: string,
    initial: RefreshPoll,
    signal: AbortSignal,
    onStatus?: (refresh: PriceRefresh) => void,
  ): Promise<PriceRefresh> {
    let current = initial;
    onStatus?.(publicRefresh(current));
    const deadline = Date.now() + 60_000;
    while (current.status === 'queued' || current.status === 'running') {
      const delayMs = Math.max(5, current.pollAfterSeconds) * 1000;
      if (Date.now() + delayMs > deadline) break;
      await wait(delayMs, signal);
      current = await client.getTrackedItemRefresh(current.id, trackerId, { signal });
      onStatus?.(publicRefresh(current));
    }
    const result = publicRefresh(current);
    if (result.retryAt) {
      refreshRetryAt.set(
        trackerId,
        Math.max(refreshRetryAt.get(trackerId) ?? 0, Date.parse(result.retryAt)),
      );
    }
    return result;
  }
  const itemView = <T extends { product: Product }>(item: T): T => ({
    ...item,
    product: localProduct(item.product),
  });
  async function* watchlistPages(signal: AbortSignal, query?: string) {
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 100; page++) {
      const response = await client.listTrackedItems(
        {
          ...(query?.trim() ? { q: query.trim() } : {}),
          limit: 100,
          ...(cursor ? { cursor } : {}),
        },
        { signal },
      );
      yield response.items;
      if (response.page.nextCursor === null) return;
      if (seen.has(response.page.nextCursor))
        throw new ClientError('invalid-response', 'Invalid watchlist pagination.');
      cursor = response.page.nextCursor;
      seen.add(cursor);
    }
    throw new ClientError('invalid-response', 'Watchlist exceeds the bounded page limit.');
  }
  return {
    clearPreview() {
      pendingPreview = undefined;
    },
    cancelSearch() {
      listController?.abort();
    },
    cancelPending() {
      generation++;
      controller.abort();
      controller = new AbortController();
      pendingCreate = undefined;
      pendingPreview = undefined;
      refreshRetryAt.clear();
    },
    list(query) {
      listController?.abort();
      const currentList = new AbortController();
      listController = currentList;
      return run(async (signal) => {
        signal = AbortSignal.any([signal, currentList.signal]);
        const result = [];
        for await (const items of watchlistPages(signal, query))
          result.push(...items.map(itemView));
        return result;
      });
    },
    get: (id) =>
      run(async (signal) =>
        itemView(await client.getTrackedItem(id, { signal })),
      ),
    preview(url, onChecking) {
      parseSteamUrl(url);
      const input = url.trim();
      if (pendingPreview?.url !== input) pendingPreview = undefined;
      return run(async (signal) => {
        const current = generation;
        const value = pendingPreview && Date.parse(pendingPreview.value.expiresAt) > Date.now()
          ? pendingPreview.value
          : itemView(await client.preview(input, { signal }));
        if (current !== generation || signal.aborted)
          throw new ClientError('aborted', 'View changed.');
        pendingPreview = { url: input, value };
        onChecking?.();
        for await (const items of watchlistPages(signal)) {
          const duplicate = items.find(({ product }) => {
            const existing = product.identity;
            const offer = value.product.identity;
            return existing.provider === offer.provider &&
              existing.providerGameId === offer.providerGameId &&
              existing.storeId === offer.storeId && existing.market === offer.market &&
              existing.currency === offer.currency;
          });
          if (duplicate)
            throw new RepositoryError(
              'duplicate',
              'Already in your watchlist. Open the existing tracker to edit its target.',
              duplicate.id,
            );
        }
        return value;
      });
    },
    create(input) {
      const signature = JSON.stringify([
        input.previewId,
        input.targetPrice.amountMinor,
        input.targetPrice.currency,
        input.enabled,
        input.alerts.email,
        input.alerts.push,
      ]);
      if (pendingCreate?.signature !== signature)
        pendingCreate = { signature, key: crypto.randomUUID() };
      const attempt = pendingCreate;
      return run(async (signal) => {
        const item = await client.createTrackedItem(input, attempt.key, { signal });
        if (pendingCreate?.key === attempt.key) pendingCreate = undefined;
        return itemView(item);
      });
    },
    update: (id: string, input: Preferences) =>
      run(async (signal) =>
        itemView(await client.updateTrackedItem(id, input, { signal })),
      ),
    remove: (id) => run((signal) => client.deleteTrackedItem(id, { signal })),
    refreshPrice(id: string, onStatus?: (refresh: PriceRefresh) => void, options = {}) {
      return run(async (signal) => {
        const retryAt = refreshRetryAt.get(id) ?? 0;
        if (Date.now() < retryAt) {
          throw new RepositoryError(
            'save-error',
            'Please wait before checking this game again.',
            undefined,
            { retryAfterSeconds: Math.ceil((retryAt - Date.now()) / 1000) },
          );
        }
        const accepted = await client.startTrackedItemRefresh(id, { signal });
        return pollRefresh(id, accepted, signal, onStatus);
      }, options.signal);
    },
    resumeRefresh(requestId: string, id: string, onStatus?: (refresh: PriceRefresh) => void, options = {}) {
      return run(async (signal) => {
        const current = await client.getTrackedItemRefresh(requestId, id, { signal });
        return pollRefresh(id, current, signal, onStatus);
      }, options.signal);
    },
    history(id) {
      return run(async (signal) => {
        const items = [];
        const seen = new Set<string>();
        let cursor: string | undefined;
        let window: { from: string; to: string } | undefined;
        let retainedFrom: string | undefined;
        for (let page = 0; page < 100; page++) {
          const result = await client.getHistory(
            id,
            { limit: 100, ...window, ...(cursor ? { cursor } : {}) },
            { signal },
          );
          if (
            window &&
            (window.from !== result.window.from ||
              window.to !== result.window.to)
          )
            throw new ClientError(
              'invalid-response',
              'History window changed between pages.',
            );
          window = result.window;
          retainedFrom = result.retainedFrom;
          items.push(...result.items);
          if (result.page.nextCursor === null)
            return { illustrative: false, items, window, retainedFrom };
          if (seen.has(result.page.nextCursor))
            throw new ClientError(
              'invalid-response',
              'Invalid history pagination.',
            );
          cursor = result.page.nextCursor;
          seen.add(cursor);
        }
        throw new ClientError(
          'invalid-response',
          'History exceeds the bounded page limit.',
        );
      });
    },
  };
}
