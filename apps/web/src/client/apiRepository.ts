import {
  RepositoryError,
  type TrackerRepository,
  type Product,
  type Preferences,
} from '../data/types';
import { parseSteamUrl } from '../data/validation';
import { ClientError } from './http';
import { WebClient } from './webClient';

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
): TrackerRepository & { cancelPending(): void } {
  let controller = new AbortController();
  let generation = 0;
  let retryAt = 0;
  let listController: AbortController | undefined;
  const keys = new Map<string, string>();
  async function run<T>(
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const current = generation;
    if (Date.now() < retryAt)
      throw new RepositoryError(
        'save-error',
        'Please wait before trying again.',
        undefined,
        { retryAfterSeconds: Math.ceil((retryAt - Date.now()) / 1000) },
      );
    try {
      const result = await operation(controller.signal);
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
  const itemView = <T extends { product: Product }>(item: T): T => ({
    ...item,
    product: localProduct(item.product),
  });
  return {
    cancelPending() {
      generation++;
      controller.abort();
      controller = new AbortController();
      keys.clear();
    },
    list(query) {
      listController?.abort();
      const currentList = new AbortController();
      listController = currentList;
      return run(async (signal) => {
        signal = AbortSignal.any([signal, currentList.signal]);
        const result = [];
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
          result.push(...response.items.map(itemView));
          if (response.page.nextCursor === null) return result;
          if (seen.has(response.page.nextCursor))
            throw new ClientError(
              'invalid-response',
              'Invalid watchlist pagination.',
            );
          cursor = response.page.nextCursor;
          seen.add(cursor);
        }
        throw new ClientError(
          'invalid-response',
          'Watchlist exceeds the bounded page limit. Narrow your search.',
        );
      });
    },
    get: (id) =>
      run(async (signal) =>
        itemView(await client.getTrackedItem(id, { signal })),
      ),
    preview(url) {
      parseSteamUrl(url);
      return run(async (signal) =>
        itemView(await client.preview(url.trim(), { signal })),
      );
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
      const key = keys.get(signature) ?? crypto.randomUUID();
      keys.set(signature, key);
      return run(async (signal) => {
        const item = await client.createTrackedItem(input, key, { signal });
        keys.delete(signature);
        return itemView(item);
      });
    },
    update: (id: string, input: Preferences) =>
      run(async (signal) =>
        itemView(await client.updateTrackedItem(id, input, { signal })),
      ),
    remove: (id) => run((signal) => client.deleteTrackedItem(id, { signal })),
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
