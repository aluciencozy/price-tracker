// Browser wire models for docs/api/openapi.json, not sample UI/provider payloads.
export type Money = { amountMinor: number; currency: 'USD' };
export type Alerts = { email: boolean; push: boolean };
export type User = {
  id: string; email: string; name: string | null; emailVerified: true;
  role: 'user' | 'admin'; createdAt: string;
};
export type ProductError = {
  code: 'PROVIDER_RATE_LIMITED' | 'PROVIDER_UNAVAILABLE' | 'STEAM_OFFER_UNAVAILABLE' | 'INVALID_PROVIDER_DATA' | 'UNSUPPORTED_PRODUCT';
  message: string; occurredAt: string; retryAt: string | null;
};
export type Product = {
  id: string;
  identity: { provider: 'cheapshark'; providerGameId: string; storeId: '1'; market: 'US'; currency: 'USD' };
  steamAppId: string; canonicalSteamUrl: string; title: string; storeName: 'Steam'; imageUrl: string | null;
  source: { name: 'CheapShark'; url: 'https://www.cheapshark.com/'; attribution: string };
  currentPrice: Money | null; retailPrice: Money | null; dealId: string | null; purchaseUrl: string | null;
  observedAt: string | null; providerChangedAt: string | null; freshness: 'fresh' | 'stale' | 'unavailable';
  staleAt: string | null; lastAttemptAt: string | null; nextCheckAt: string | null; lastError: ProductError | null;
};
export type Preview = { id: string; expiresAt: string; product: Product };
export type EditableTracker = { targetPrice: Money; enabled: boolean; alerts: Alerts };
export type CreateTracker = EditableTracker & { previewId: string };
export type TrackedItem = EditableTracker & { id: string; product: Product; createdAt: string; updatedAt: string };
export type Page = { limit: number; nextCursor: string | null };
export type TrackedItems = { items: TrackedItem[]; page: Page };
export type HistoryWindow = { from: string; to: string };
export type Observation = { id: string; price: Money; observedAt: string; providerChangedAt: string | null };
export type History = {
  trackedItemId: string; product: Product; window: HistoryWindow; retainedFrom: string; items: Observation[]; page: Page;
};
export type WebLogin = { user: User; sessionId: string; expiresAt: string };
export type Accepted = { message: 'If eligible, you will receive an email with next steps.' };
export type FieldError = { path: string; code: string; message: string };
export type ErrorDetail = {
  code: string; message: string; fields: FieldError[]; requestId: string;
  retryAfterSeconds: number | null; resourceId: string | null;
};

export function object(value: unknown, allowed: string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
      Object.keys(value).some((key) => !allowed.includes(key))) throw new Error('Unexpected object.');
  return value as Record<string, unknown>;
}
export function text(value: unknown, max = 2048, min = 1): string {
  if (typeof value !== 'string' || [...value].length < min || [...value].length > max) throw new Error('Unexpected text.');
  return value;
}
export function oneOf<const T extends readonly (string | boolean)[]>(value: unknown, values: T): T[number] {
  if (!values.includes(value as T[number])) throw new Error('Unexpected value.');
  return value as T[number];
}
export function integer(value: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new Error('Unexpected integer.');
  return value as number;
}
export function id(value: unknown): string {
  const result = text(value, 128);
  if (!/^[A-Za-z0-9_-]+$/.test(result)) throw new Error('Unexpected ID.');
  return result;
}
export function secret(value: unknown): string {
  const result = text(value, 512, 32);
  if (!/^[A-Za-z0-9_-]+$/.test(result)) throw new Error('Unexpected secret.');
  return result;
}
export function email(value: unknown): string {
  const result = text(value, 254);
  if (!/^[^\s@]+@[^\s@]+$/.test(result)) throw new Error('Unexpected email.');
  return result;
}
export function timestamp(value: unknown): string {
  const result = text(value, 64);
  const ms = Date.parse(result);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(result) ||
      !Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 19) !== result.slice(0, 19)) {
    throw new Error('Unexpected UTC timestamp.');
  }
  return result;
}
export function nullable<T>(value: unknown, parse: (value: unknown) => T): T | null {
  return value === null ? null : parse(value);
}
export function money(value: unknown): Money {
  const data = object(value, ['amountMinor', 'currency']);
  return { amountMinor: integer(data.amountMinor, 0, Number.MAX_SAFE_INTEGER), currency: oneOf(data.currency, ['USD']) };
}
export function alerts(value: unknown): Alerts {
  const data = object(value, ['email', 'push']);
  return { email: oneOf(data.email, [true, false]), push: oneOf(data.push, [true, false]) };
}
export function user(value: unknown): User {
  const data = object(value, ['id', 'email', 'name', 'emailVerified', 'role', 'createdAt']);
  return {
    id: id(data.id), email: email(data.email), name: nullable(data.name, (v) => text(v, 100)),
    emailVerified: oneOf(data.emailVerified, [true]), role: oneOf(data.role, ['user', 'admin']), createdAt: timestamp(data.createdAt),
  };
}
function https(value: unknown): string {
  const result = text(value);
  const url = new URL(result);
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new Error('Unsafe HTTPS URL.');
  return result;
}
function providerId(value: unknown): string {
  const result = text(value, 32);
  if (!/^[1-9][0-9]*$/.test(result)) throw new Error('Unexpected provider ID.');
  return result;
}
export const attribution = 'Prices supplied by CheapShark; Steam US/USD base-game offer, excluding taxes and checkout adjustments.';
export function product(value: unknown): Product {
  const data = object(value, [
    'id', 'identity', 'steamAppId', 'canonicalSteamUrl', 'title', 'storeName', 'imageUrl', 'source', 'currentPrice',
    'retailPrice', 'dealId', 'purchaseUrl', 'observedAt', 'providerChangedAt', 'freshness', 'staleAt', 'lastAttemptAt', 'nextCheckAt', 'lastError',
  ]);
  const identity = object(data.identity, ['provider', 'providerGameId', 'storeId', 'market', 'currency']);
  const source = object(data.source, ['name', 'url', 'attribution']);
  const steamAppId = providerId(data.steamAppId);
  const canonicalSteamUrl = text(data.canonicalSteamUrl, 200);
  if (canonicalSteamUrl !== `https://store.steampowered.com/app/${steamAppId}/`) throw new Error('Mismatched Steam URL.');
  const dealId = nullable(data.dealId, (v) => text(v, 1024));
  const purchaseUrl = nullable(data.purchaseUrl, (v) => text(v, 4096));
  // Deal IDs are raw wire strings. Encode exactly once, never fetch this human link.
  if (purchaseUrl !== (dealId === null ? null : `https://www.cheapshark.com/redirect?dealID=${encodeURIComponent(dealId)}`)) {
    throw new Error('Mismatched purchase redirect.');
  }
  const error = data.lastError === null ? null : object(data.lastError, ['code', 'message', 'occurredAt', 'retryAt']);
  const result: Product = {
    id: id(data.id), identity: {
      provider: oneOf(identity.provider, ['cheapshark']), providerGameId: providerId(identity.providerGameId),
      storeId: oneOf(identity.storeId, ['1']), market: oneOf(identity.market, ['US']), currency: oneOf(identity.currency, ['USD']),
    },
    steamAppId, canonicalSteamUrl, title: text(data.title, 300), storeName: oneOf(data.storeName, ['Steam']),
    imageUrl: nullable(data.imageUrl, https), source: {
      name: oneOf(source.name, ['CheapShark']), url: oneOf(source.url, ['https://www.cheapshark.com/']),
      attribution: oneOf(source.attribution, [attribution]),
    },
    currentPrice: nullable(data.currentPrice, money), retailPrice: nullable(data.retailPrice, money), dealId, purchaseUrl,
    observedAt: nullable(data.observedAt, timestamp), providerChangedAt: nullable(data.providerChangedAt, timestamp),
    freshness: oneOf(data.freshness, ['fresh', 'stale', 'unavailable']), staleAt: nullable(data.staleAt, timestamp),
    lastAttemptAt: nullable(data.lastAttemptAt, timestamp), nextCheckAt: nullable(data.nextCheckAt, timestamp),
    lastError: error === null ? null : {
      code: oneOf(error.code, ['PROVIDER_RATE_LIMITED', 'PROVIDER_UNAVAILABLE', 'STEAM_OFFER_UNAVAILABLE', 'INVALID_PROVIDER_DATA', 'UNSUPPORTED_PRODUCT']),
      message: text(error.message, 500), occurredAt: timestamp(error.occurredAt), retryAt: nullable(error.retryAt, timestamp),
    },
  };
  if (result.freshness === 'unavailable') {
    if ([result.currentPrice, result.retailPrice, result.observedAt, result.providerChangedAt, result.staleAt, dealId, purchaseUrl].some((v) => v !== null)) {
      throw new Error('Unavailable is not a retained price.');
    }
  } else if (result.currentPrice === null || result.observedAt === null || result.staleAt === null ||
      (result.freshness === 'fresh' && (result.lastError !== null || result.lastAttemptAt === null || dealId === null))) {
    throw new Error('Missing successful observation.');
  }
  return result;
}
export function preview(value: unknown): Preview {
  const data = object(value, ['id', 'expiresAt', 'product']);
  return { id: id(data.id), expiresAt: timestamp(data.expiresAt), product: product(data.product) };
}
export function trackedItem(value: unknown): TrackedItem {
  const data = object(value, ['id', 'product', 'targetPrice', 'enabled', 'alerts', 'createdAt', 'updatedAt']);
  return {
    id: id(data.id), product: product(data.product), targetPrice: money(data.targetPrice), enabled: oneOf(data.enabled, [true, false]),
    alerts: alerts(data.alerts), createdAt: timestamp(data.createdAt), updatedAt: timestamp(data.updatedAt),
  };
}
function page(value: unknown): Page {
  const data = object(value, ['limit', 'nextCursor']);
  return { limit: integer(data.limit, 1, 100), nextCursor: nullable(data.nextCursor, text) };
}
function items<T>(value: unknown, parse: (value: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error('Unexpected list.');
  return value.map(parse);
}
export function trackedItems(value: unknown): TrackedItems {
  const data = object(value, ['items', 'page']);
  return { items: items(data.items, trackedItem), page: page(data.page) };
}
export function historyWindow(value: unknown): HistoryWindow {
  const data = object(value, ['from', 'to']);
  const from = timestamp(data.from), to = timestamp(data.to);
  if (Date.parse(from) >= Date.parse(to) || Date.parse(to) - Date.parse(from) > 90 * 86_400_000) throw new Error('Invalid history window.');
  return { from, to };
}
export function history(value: unknown): History {
  const data = object(value, ['trackedItemId', 'product', 'window', 'retainedFrom', 'items', 'page']);
  return {
    trackedItemId: id(data.trackedItemId), product: product(data.product), window: historyWindow(data.window),
    retainedFrom: timestamp(data.retainedFrom), page: page(data.page),
    items: items(data.items, (value) => {
      const item = object(value, ['id', 'price', 'observedAt', 'providerChangedAt']);
      return { id: id(item.id), price: money(item.price), observedAt: timestamp(item.observedAt), providerChangedAt: nullable(item.providerChangedAt, timestamp) };
    }),
  };
}
export function webLogin(value: unknown): WebLogin {
  const data = object(value, ['user', 'sessionId', 'expiresAt']);
  return { user: user(data.user), sessionId: id(data.sessionId), expiresAt: timestamp(data.expiresAt) };
}
export function accepted(value: unknown): Accepted {
  const data = object(value, ['message']);
  return { message: oneOf(data.message, ['If eligible, you will receive an email with next steps.']) };
}
const statusCodes: Record<number, readonly string[]> = {
  400: ['MALFORMED_REQUEST', 'TOKEN_INVALID', 'AUTH_AMBIGUOUS'],
  401: ['AUTH_REQUIRED', 'INVALID_CREDENTIALS', 'SESSION_EXPIRED', 'SESSION_REVOKED'],
  403: ['EMAIL_UNVERIFIED', 'CSRF_INVALID', 'ORIGIN_DENIED', 'ADMIN_REQUIRED'],
  404: ['NOT_FOUND'], 409: ['DUPLICATE_TRACKED_ITEM', 'IDEMPOTENCY_CONFLICT', 'DEVICE_CONFLICT'],
  410: ['PREVIEW_EXPIRED'], 413: ['PAYLOAD_TOO_LARGE'], 415: ['UNSUPPORTED_MEDIA_TYPE'],
  422: ['VALIDATION_ERROR', 'INVALID_CURSOR', 'UNSUPPORTED_URL', 'UNSUPPORTED_PRODUCT', 'AMBIGUOUS_PRODUCT', 'STEAM_OFFER_UNAVAILABLE'],
  429: ['RATE_LIMITED', 'PROVIDER_RATE_LIMITED'], 500: ['INTERNAL_ERROR'], 503: ['SERVICE_UNAVAILABLE', 'PROVIDER_UNAVAILABLE'],
};
export function errorDetail(value: unknown, status: number): ErrorDetail {
  const data = object(object(value, ['error']).error, ['code', 'message', 'fields', 'requestId', 'retryAfterSeconds', 'resourceId']);
  if (!Array.isArray(data.fields) || data.fields.length > 50) throw new Error('Unexpected errors.');
  if (status === 429 && data.retryAfterSeconds === null) throw new Error('Missing rate-limit wait.');
  if (data.resourceId !== null && data.code !== 'DUPLICATE_TRACKED_ITEM') throw new Error('Unexpected private resource ID.');
  return {
    code: oneOf(data.code, statusCodes[status] ?? []), message: text(data.message, 500), requestId: id(data.requestId),
    retryAfterSeconds: nullable(data.retryAfterSeconds, (v) => integer(v, 1, Number.MAX_SAFE_INTEGER)), resourceId: nullable(data.resourceId, id),
    fields: data.fields.map((value) => {
      const field = object(value, ['path', 'code', 'message']);
      const path = text(field.path, 300);
      if (!path.startsWith('/')) throw new Error('Expected JSON pointer.');
      return { path, code: oneOf(field.code, ['required', 'unknown_field', 'invalid_type', 'out_of_range', 'invalid_format', 'unsupported', 'invalid_value']), message: text(field.message, 300) };
    }),
  };
}
