import mongoose from 'mongoose';
import { z } from 'zod';
import { cheapSharkPurchaseUrl, parseSteamUrl, SteamGameUnsupportedError } from './cheapshark.js';
import { ProductModel, type ProductRecord } from './models/product.js';
import { ProductPreviewModel } from './models/trackingApi.js';
import { discoverSteamProduct, type DiscoveryLookup } from './productDiscovery.js';
import { ProviderDeferredError, ProviderRateLimitError } from './providerBudget.js';
import { publicProduct } from './history.js';
import { TrackingError, validationError } from './trackingErrors.js';

const PREVIEW_LIFETIME_MS = 10 * 60_000;
const PREVIEW_PURGE_DELAY_MS = 24 * 60 * 60_000;
const PREVIEW_DEADLINE_MS = 10_000;

const bodySchema = z.strictObject({ url: z.string().min(1).max(2048) });
const objectIdPattern = /^[a-f0-9]{24}$/;

type Clock = () => Date;

/** Must reuse the safe shared provider cache/budget and honor cancellation. */
export type ProductPreviewProduct = ProductRecord & { _id: mongoose.Types.ObjectId };
export type ProductPreviewResolver = (approvedProductId: string, signal: AbortSignal) => Promise<ProductPreviewProduct>;

function unsupportedUrl(message = 'Use a supported HTTPS Steam /app/<id> URL.') {
  return new TrackingError(422, 'UNSUPPORTED_URL', message, [{ path: '/url', code: 'unsupported', message }]);
}

function productUnavailable(message = 'The supported Steam offer is unavailable.') {
  return new TrackingError(422, 'STEAM_OFFER_UNAVAILABLE', message, [{ path: '/url', code: 'unsupported', message }]);
}

function providerFailure(error: unknown): TrackingError {
  if (error instanceof ProviderRateLimitError || error instanceof ProviderDeferredError) {
    const retryAt = error.retryAt;
    const seconds = retryAt ? Math.max(1, Math.ceil((retryAt.getTime() - Date.now()) / 1000)) : 60;
    return new TrackingError(429, error instanceof ProviderRateLimitError ? 'PROVIDER_RATE_LIMITED' : 'RATE_LIMITED',
      'The shared price source is temporarily rate limited.', [], seconds);
  }
  if (error instanceof Error && error.message.includes('No unambiguous current Steam offer')) return productUnavailable();
  if (error instanceof SteamGameUnsupportedError) {
    return new TrackingError(422, 'UNSUPPORTED_PRODUCT', 'This Steam app is not a supported game.');
  }
  if (error instanceof Error && error.message.includes('did not return one exact match')) {
    return new TrackingError(422, 'AMBIGUOUS_PRODUCT', 'CheapShark did not confirm one exact Steam app ID match.',
      [{ path: '/url', code: 'unsupported', message: 'The submitted Steam app ID could not be matched exactly.' }]);
  }
  return new TrackingError(503, 'PROVIDER_UNAVAILABLE', 'The Steam price source is temporarily unavailable.');
}

async function withPreviewDeadline<T>(work: (signal: AbortSignal) => Promise<T>, deadlineMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const controller = new AbortController();
  const operation = Promise.resolve().then(() => work(controller.signal));
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(new TrackingError(503, 'SERVICE_UNAVAILABLE', 'The price preview exceeded its time limit.'));
        }, deadlineMs);
        timer.unref();
      }),
    ]);
  } catch (error) {
    if (timedOut) {
      // Keep the caller's concurrency slot until provider work has actually settled.
      // Abort is a request to stop, not proof that the resolver released its resources.
      await operation.then(() => undefined, () => undefined);
    }
    throw error;
  } finally {
    controller.abort();
    if (timer) clearTimeout(timer);
  }
}

function toProductRecord(value: unknown): ProductRecord & { _id: mongoose.Types.ObjectId } {
  if (!value || typeof value !== 'object' || !('_id' in value) || !(value._id instanceof mongoose.Types.ObjectId)) {
    throw new TrackingError(503, 'SERVICE_UNAVAILABLE', 'The product catalog is temporarily unavailable.');
  }
  return value as ProductRecord & { _id: mongoose.Types.ObjectId };
}

/**
 * Resolves or discovers shared Products through the bounded provider cache.
 * The resolver must not write history or alerts.
 */
export function createProductPreviewService(options: { resolveProduct: ProductPreviewResolver; discover?: DiscoveryLookup; now?: Clock; deadlineMs?: number }) {
  const resolveProduct = options.resolveProduct;
  const now = options.now ?? (() => new Date());
  const deadlineMs = options.deadlineMs ?? PREVIEW_DEADLINE_MS;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1) throw new Error('Preview deadline must be a positive safe integer.');

  return async function createOwnedProductPreview(userId: string, rawBody: unknown) {
    if (!objectIdPattern.test(userId)) throw new TrackingError(401, 'AUTH_REQUIRED', 'Sign in to preview a product.');
    const parsedBody = bodySchema.safeParse(rawBody);
    if (!parsedBody.success) throw validationError(parsedBody.error, rawBody);

    let game: ReturnType<typeof parseSteamUrl>;
    try {
      game = parseSteamUrl(parsedBody.data.url);
    } catch {
      throw unsupportedUrl();
    }

    return withPreviewDeadline(async signal => {
    const dbOptions = { signal, timeoutMS: deadlineMs, maxTimeMS: 500 };
    const filter = {
      steamAppId: game.steamAppId,
      provider: 'cheapshark' as const,
      storeId: '1' as const,
      market: 'US' as const,
      currency: 'USD' as const,
    };
    let cached = await ProductModel.findOne(filter).setOptions(dbOptions).lean().exec();
    signal.throwIfAborted();
    if (!cached) {
      try { cached = await discoverSteamProduct(game.canonicalSteamUrl, signal, options.discover); }
      catch (error) { signal.throwIfAborted(); throw providerFailure(error); }
    }

    let resolved: unknown;
    let refreshFailure: unknown;
    try {
      resolved = await resolveProduct(String(cached._id), signal);
      signal.throwIfAborted();
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof SteamGameUnsupportedError) throw providerFailure(error);
      refreshFailure = error;
      // A prior successful quote may be returned honestly as stale when a bounded refresh fails.
      const retained = await ProductModel.findOne(filter).setOptions(dbOptions).lean().exec();
      if (!retained || !retained.steamTypeValidatedAt || retained.steamTypeRejected || retained.currentPriceMinor === null || !retained.lastSuccessfulCheckAt || !retained.dealId || !retained.purchaseUrl) {
        throw providerFailure(error);
      }
      resolved = retained;
    }

    const product = toProductRecord(resolved);
    if (String(product._id) !== String(cached._id) || product.steamAppId !== game.steamAppId ||
        !product.steamTypeValidatedAt || product.steamTypeRejected || product.provider !== 'cheapshark' || product.providerGameId !== cached.providerGameId || product.storeId !== '1' || product.market !== 'US' ||
        product.currency !== 'USD' || product.canonicalSteamUrl !== game.canonicalSteamUrl) {
      throw new TrackingError(503, 'SERVICE_UNAVAILABLE', 'The confirmed product identity changed during preview.');
    }
    const validPrice = product.currentPriceMinor === null ||
      (Number.isSafeInteger(product.currentPriceMinor) && product.currentPriceMinor >= 0);
    const validRetail = product.retailPriceMinor === null ||
      (Number.isSafeInteger(product.retailPriceMinor) && product.retailPriceMinor >= 0);
    let validPurchaseLink = product.dealId === null && product.purchaseUrl === null;
    if (product.dealId) {
      try { validPurchaseLink = product.purchaseUrl === cheapSharkPurchaseUrl(product.dealId); }
      catch { validPurchaseLink = false; }
    }
    if (!validPrice || !validRetail || !validPurchaseLink) {
      throw new TrackingError(503, 'SERVICE_UNAVAILABLE', 'The cached Steam offer failed integrity checks.');
    }
    const publicView = publicProduct(product, now());
    if (!publicView.currentPrice || publicView.freshness === 'unavailable' || !publicView.dealId || !publicView.purchaseUrl) {
      throw productUnavailable();
    }
    if (refreshFailure) {
      const failedAt = now();
      const retryDate = refreshFailure instanceof ProviderRateLimitError || refreshFailure instanceof ProviderDeferredError
        ? refreshFailure.retryAt
        : null;
      publicView.freshness = 'stale';
      publicView.lastAttemptAt = failedAt.toISOString();
      publicView.lastError = {
        code: 'PROVIDER_UNAVAILABLE',
        message: 'The latest preview refresh failed; the previous successful price is retained.',
        occurredAt: failedAt.toISOString(),
        retryAt: retryDate?.toISOString() ?? null,
      };
    }

    const createdAt = now();
    const expiresAt = new Date(createdAt.getTime() + PREVIEW_LIFETIME_MS);
    signal.throwIfAborted();
    const preview = new ProductPreviewModel({
      _id: new mongoose.Types.ObjectId(),
      userId,
      productId: product._id,
      product: publicView,
      expiresAt,
      purgeAt: new Date(expiresAt.getTime() + PREVIEW_PURGE_DELAY_MS),
    });
    await preview.validate();
    signal.throwIfAborted();
    await ProductPreviewModel.collection.insertOne(preview.toObject(), dbOptions);
    signal.throwIfAborted();
    return { id: String(preview._id), expiresAt: expiresAt.toISOString(), product: publicView };
    }, deadlineMs);
  };
}

export type ProductPreviewService = ReturnType<typeof createProductPreviewService>;
