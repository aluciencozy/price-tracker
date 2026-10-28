export type Money = { amountMinor: number; currency: 'USD' };
export type Alerts = { email: boolean; push: boolean };
export type Product = {
  id: string;
  identity: {
    provider: 'cheapshark';
    providerGameId: string;
    storeId: string;
    market: 'US';
    currency: 'USD';
  };
  steamAppId: string;
  canonicalSteamUrl: string;
  title: string;
  storeName: 'Steam';
  imageUrl: string | null;
  source: {
    name: 'CheapShark';
    url: 'https://www.cheapshark.com/';
    attribution: string;
  };
  currentPrice: Money | null;
  retailPrice: Money | null;
  dealId: string | null;
  purchaseUrl: string | null;
  observedAt: string | null;
  providerChangedAt: string | null;
  freshness: 'fresh' | 'stale' | 'unavailable';
  staleAt: string | null;
  lastAttemptAt: string | null;
  nextCheckAt: string | null;
  lastError: {
    code: string;
    message: string;
    occurredAt: string;
    retryAt: string | null;
  } | null;
};
export type TrackedItem = {
  id: string;
  product: Product;
  targetPrice: Money;
  enabled: boolean;
  alerts: Alerts;
  createdAt: string;
  updatedAt: string;
};
export type Preferences = Pick<
  TrackedItem,
  'targetPrice' | 'enabled' | 'alerts'
>;
export type ProductPreview = {
  id: string;
  expiresAt: string;
  product: Product;
};
export type Observation = {
  id: string;
  observedAt: string;
  price: Money;
  providerChangedAt: string | null;
};
// Presentation metadata is separate from the strict HTTP History body.
export type PriceHistory = { illustrative: boolean; items: Observation[] };
export interface TrackerRepository {
  list(query?: string): Promise<TrackedItem[]>;
  get(id: string): Promise<TrackedItem>;
  preview(url: string): Promise<ProductPreview>;
  create(input: Preferences & { previewId: string }): Promise<TrackedItem>;
  update(id: string, input: Preferences): Promise<TrackedItem>;
  remove(id: string): Promise<void>;
  history(trackerId: string): Promise<PriceHistory>;
}
export class RepositoryError extends Error {
  constructor(
    public code:
      | 'validation'
      | 'unsupported'
      | 'missing-offer'
      | 'duplicate'
      | 'not-found'
      | 'offline'
      | 'save-error'
      | 'expired'
      | 'preview-expired',
    message: string,
    public resourceId?: string,
  ) {
    super(message);
    this.name = 'RepositoryError';
  }
}
