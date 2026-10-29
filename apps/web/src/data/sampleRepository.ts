import { steamPurchaseUrl } from '../steamPurchaseUrl';
import { assertMoney, parseSteamUrl } from './validation';
import {
  RepositoryError,
  type Product,
  type Preferences,
  type ProductPreview,
  type TrackedItem,
  type TrackerRepository,
} from './types';

export const sampleScenarios = [
  'normal',
  'loading',
  'empty',
  'offline',
  'expired',
  'save-error',
  'failed-check',
  'missing-offer',
  'free',
  'unsupported-dlc',
  'unsupported-bundle',
  'unsupported-edition',
  'history-empty',
  'history-error',
] as const;
export type SampleScenario = (typeof sampleScenarios)[number];
export interface SampleRepository extends TrackerRepository {
  setScenario(value: SampleScenario): void;
}
const recorded = '2026-10-26T16:34:42.829Z';

function catalog(): Product[] {
  return [
    {
      id: 'product-portal-2',
      app: '620',
      title: 'Portal 2',
      game: '36',
      deal: 'rwQ2JCEr5NOySyBsAj6fyPuZg4qMlh9w67U%2BmM6b2VE%3D',
    },
    {
      id: 'product-half-life-2',
      app: '220',
      title: 'Half-Life 2',
      game: '59',
      deal: 'Vz5eZMF1sKvs02I4cuEgrGnmM1r%2BkWHig0YMa0lJ0vM%3D',
    },
  ].map(({ id, app, title, game, deal }) => {
    const product: Product = {
      id,
      steamAppId: app,
      title,
      identity: {
        provider: 'cheapshark',
        providerGameId: game,
        storeId: '1',
        market: 'US',
        currency: 'USD',
      },
      canonicalSteamUrl: `https://store.steampowered.com/app/${app}/`,
      storeName: 'Steam',
      imageUrl: `/art/${app}.jpg`,
      source: {
        name: 'CheapShark',
        url: 'https://www.cheapshark.com/',
        attribution:
          'Prices supplied by CheapShark; Steam US/USD base-game offer, excluding taxes and checkout adjustments.',
      },
      currentPrice: { amountMinor: 999, currency: 'USD' },
      retailPrice: { amountMinor: 999, currency: 'USD' },
      dealId: deal,
      purchaseUrl: null,
      observedAt: recorded,
      providerChangedAt: null,
      freshness: 'stale',
      staleAt: '2026-10-27T16:34:42.829Z',
      lastAttemptAt: recorded,
      nextCheckAt: null,
      lastError: null,
    };
    product.purchaseUrl = steamPurchaseUrl(product);
    return product;
  });
}

export function createSampleRepository(
  options: { empty?: boolean; delayMs?: number } = {},
): SampleRepository {
  const products = catalog();
  let scenario: SampleScenario = 'normal';
  let sequence = 0;
  const previews = new Map<string, ProductPreview>();
  let items: TrackedItem[] = options.empty
    ? []
    : products.map((product, index) => ({
        id: index ? 'tracker-half-life-2' : 'tracker-portal-2',
        product,
        targetPrice: { amountMinor: index ? 999 : 499, currency: 'USD' },
        enabled: true,
        alerts: { email: true, push: index === 1 },
        createdAt: recorded,
        updatedAt: recorded,
      }));
  async function ready(mutation = false) {
    if (options.delayMs)
      await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    if (scenario === 'loading') await new Promise<void>(() => {});
    if (scenario === 'expired')
      throw new RepositoryError(
        'expired',
        'Session-expired preview. No real session was created.',
      );
    if (scenario === 'offline')
      throw new RepositoryError(
        'offline',
        'Offline preview. Your sample changes are preserved. Choose Normal in developer scenarios to retry.',
      );
    if (mutation && scenario === 'save-error')
      throw new RepositoryError(
        'save-error',
        'Save failed in this preview. Nothing changed. Choose Normal in developer scenarios to retry.',
      );
  }
  function present(item: TrackedItem): TrackedItem {
    const result = structuredClone(item);
    if (scenario === 'missing-offer')
      Object.assign(result.product, {
        currentPrice: null,
        retailPrice: null,
        dealId: null,
        purchaseUrl: null,
        freshness: 'unavailable',
        observedAt: null,
        providerChangedAt: null,
        staleAt: null,
      });
    if (scenario === 'failed-check') {
      result.product.lastAttemptAt = '2026-10-28T16:34:42.829Z';
      result.product.lastError = {
        code: 'PROVIDER_UNAVAILABLE',
        message:
          'The latest sample check failed. The last successful price is preserved.',
        occurredAt: '2026-10-28T16:34:42.829Z',
        retryAt: null,
      };
    }
    if (scenario === 'free')
      result.product.currentPrice = { amountMinor: 0, currency: 'USD' };
    return result;
  }
  function find(id: string) {
    const item = items.find((item) => item.id === id);
    if (!item)
      throw new RepositoryError(
        'not-found',
        'This sample tracker was removed or reset on refresh. Open your watchlist to continue.',
      );
    return item;
  }
  function preferences(input: Preferences): Preferences {
    assertMoney(input.targetPrice);
    if (
      typeof input.enabled !== 'boolean' ||
      typeof input.alerts.email !== 'boolean' ||
      typeof input.alerts.push !== 'boolean'
    )
      throw new RepositoryError(
        'validation',
        'Choose tracking and both alert preferences.',
      );
    return structuredClone({
      targetPrice: input.targetPrice,
      enabled: input.enabled,
      alerts: input.alerts,
    });
  }
  return {
    setScenario(value) {
      scenario = value;
    },
    async list(query = '') {
      await ready();
      return scenario === 'empty'
        ? []
        : items
            .filter((item) =>
              item.product.title
                .toLowerCase()
                .includes(query.trim().toLowerCase()),
            )
            .map(present);
    },
    async get(id) {
      await ready();
      return present(find(id));
    },
    async preview(input) {
      const app = parseSteamUrl(input);
      await ready();
      const explanations: Partial<Record<SampleScenario, string>> = {
        'unsupported-dlc':
          'DLC preview: additional content is not a base game. Add the base game instead.',
        'unsupported-bundle':
          'Bundle preview: use an individual Steam base-game /app/ URL.',
        'unsupported-edition':
          'Edition preview: the exact base-game edition could not be verified. No alternative edition was selected.',
      };
      const explanation = explanations[scenario];
      if (explanation) throw new RepositoryError('unsupported', explanation);
      const product = products.find((product) => product.steamAppId === app);
      if (!product)
        throw new RepositoryError(
          'unsupported',
          'This sample recognizes Portal 2 (620) and Half-Life 2 (220) only. Other games, DLC, and editions need exact API validation.',
        );
      if (scenario === 'missing-offer')
        throw new RepositoryError(
          'missing-offer',
          'No eligible Steam offer in this preview. Another store’s price or historical low cannot be used.',
        );
      const preview = {
        id: `preview-sample-${++sequence}`,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        product: structuredClone(product),
      };
      previews.set(preview.id, preview);
      return structuredClone(preview);
    },
    async create(input) {
      await ready(true);
      const prefs = preferences(input);
      const preview = previews.get(input.previewId);
      if (!preview || Date.parse(preview.expiresAt) <= Date.now())
        throw new RepositoryError(
          'preview-expired',
          'Preview this Steam offer again before saving.',
        );
      if (scenario === 'missing-offer' || scenario.startsWith('unsupported-'))
        throw new RepositoryError(
          'missing-offer',
          'An eligible Steam base-game offer is required.',
        );
      const duplicate = items.find(
        (item) => item.product.id === preview.product.id,
      );
      if (duplicate)
        throw new RepositoryError(
          'duplicate',
          'This game is already in your watchlist. Edit its existing target instead.',
          duplicate.id,
        );
      const now = new Date().toISOString();
      const item = {
        id: `tracker-sample-${++sequence}`,
        product: structuredClone(preview.product),
        ...prefs,
        createdAt: now,
        updatedAt: now,
      };
      items.push(item);
      return present(item);
    },
    async update(id, input) {
      await ready(true);
      const item = find(id);
      Object.assign(item, preferences(input), {
        updatedAt: new Date().toISOString(),
      });
      return present(item);
    },
    async remove(id) {
      await ready(true);
      find(id);
      items = items.filter((item) => item.id !== id);
    },
    async history(id) {
      await ready();
      find(id);
      if (scenario === 'history-error')
        throw new RepositoryError(
          'offline',
          'Sample history could not load. The last-known price is unchanged.',
        );
      // Illustrative chart values, never claimed as actual recorded observations.
      return {
        illustrative: true,
        items:
          scenario === 'history-empty'
            ? []
            : [1299, 1299, 999, 999, 999, 999, 999].map(
                (amountMinor, index) => ({
                  id: `illustration-${index}`,
                  observedAt: `2026-10-${20 + index}T16:34:42.829Z`,
                  price: { amountMinor, currency: 'USD' },
                  providerChangedAt: null,
                }),
              ),
      };
    },
  };
}
