import { randomUUID } from 'node:crypto';
import { ProductModel } from './models/product.js';
import { PriceHistoryModel } from './models/tracking.js';
import {
  lookupSteamOffer,
  parseSteamAppIdFromUrl,
  type SteamOffer,
} from './cheapshark.js';
import {
  ProviderDeferredError,
  ProviderRateLimitError,
} from './providerBudget.js';

const SUCCESS_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
const REFRESH_LEASE_MS = 35_000;
const FAILURE_BACKOFF_BASE_MS = 60_000;
const FAILURE_BACKOFF_MAX_MS = 6 * 60 * 60 * 1_000;

export type ObservationWriter = (
  productId: string,
  stableCheckId: string,
  refreshLeaseToken: string,
  offer: SteamOffer,
) => Promise<unknown>;

/** Optional success hook for durable checks; legacy preview callers keep the same behavior. */
export type RefreshOptions = {
  force?: boolean;
  checkId?: string;
  observationWriter?: ObservationWriter;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Durable checks may only reuse a cache quote backed by genuine recorded history. */
  requireObservation?: boolean;
};

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : Object.assign(new Error('Price refresh was cancelled.'), { name: 'AbortError' });
}

/** Look up a previously verified/approved Steam game without contacting Steam or CheapShark. */
export async function findApprovedSteamProduct(inputUrl: string) {
  const steamAppId = parseSteamAppIdFromUrl(inputUrl);

  return ProductModel.findOne({
    steamAppId,
    provider: 'cheapshark',
    storeId: '1',
    market: 'US',
    currency: 'USD',
  })
    .select({
      providerGameId: 1,
      steamAppId: 1,
      storeId: 1,
      market: 1,
      currency: 1,
      canonicalSteamUrl: 1,
      title: 1,
      dealId: 1,
      purchaseUrl: 1,
      currentPriceMinor: 1,
      lastSuccessfulCheckAt: 1,
      nextCheckAt: 1,
      lastAttemptAt: 1,
      lastError: 1,
      consecutiveFailures: 1,
      refreshLeaseUntil: 1,
      refreshLeaseToken: 1,
    })
    .lean()
    .exec();
}

/**
 * Refresh a catalog product from CheapShark. Only a validated successful
 * offer updates price/deal fields; a failed lookup records an error while
 * leaving the last successful observation intact.
 */
export async function refreshApprovedSteamProduct(
  inputUrl: string,
  options: RefreshOptions = {},
) {
  const product = await findApprovedSteamProduct(inputUrl);
  if (!product) {
    throw new Error('This Steam game is not in the approved catalog.');
  }

  return refreshSteamProductById(String(product._id), options);
}

/** Shared entry point for scheduled/admin checks that already have a Product ID. */
export async function refreshSteamProductById(
  productId: string,
  options: RefreshOptions = {},
) {
  options.signal?.throwIfAborted();
  const dbOptions = options.signal ? { signal: options.signal, timeoutMS: options.timeoutMs ?? 10_000, maxTimeMS: 500 } : {};
  if (options.observationWriter && (!options.checkId || !/^[A-Za-z0-9_-]{1,128}$/.test(options.checkId))) {
    throw new Error('A stable check ID is required when recording an observation.');
  }

  let product = await ProductModel.findById(productId).setOptions(dbOptions).lean().exec();
  options.signal?.throwIfAborted();
  if (!product) throw new Error('The approved Steam product was not found.');

  if (!options.force) {
    deferFailedCheck(product);
    options.signal?.throwIfAborted();
    if (await canReusePrice(product, options)) return product;
  }

  const now = new Date();
  const leaseToken = randomUUID();
  const leaseUntil = new Date(now.getTime() + REFRESH_LEASE_MS);
  const leased = await ProductModel.findOneAndUpdate(
    {
      _id: product._id,
      $or: [
        { refreshLeaseUntil: null },
        { refreshLeaseUntil: { $lte: now } },
      ],
    },
    {
      $set: {
        refreshLeaseUntil: leaseUntil,
        refreshLeaseToken: leaseToken,
        lastAttemptAt: now,
      },
    },
    { returnDocument: 'after', ...dbOptions },
  )
    .lean()
    .exec();

  if (!leased) {
    product = await ProductModel.findById(productId).setOptions(dbOptions).lean().exec();
    options.signal?.throwIfAborted();
    if (product && !options.force) {
      deferFailedCheck(product);
      if (await canReusePrice(product, options)) return product;
    }

    const retryAt = product?.refreshLeaseUntil ?? new Date(Date.now() + 1_000);
    throw new ProviderDeferredError(retryAt);
  }

  // A concurrent failure may have scheduled a retry before we got the lease.
  // Releasing this unused claim is not another failed provider attempt.
  try {
    options.signal?.throwIfAborted();
    if (!options.force) deferFailedCheck(leased);
  } catch (error) {
    await releaseProductLease(product._id, leaseToken);
    throw error;
  }

  try {
    // Another check may have refreshed the Product before this worker got its lease.
    if (!options.force && await canReusePrice(leased, options)) {
      await releaseProductLease(product._id, leaseToken);
      return leased;
    }

    const offer = await lookupSteamOffer(leased.canonicalSteamUrl, {
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
    options.signal?.throwIfAborted();

    if (
      offer.steamAppId !== leased.steamAppId ||
      offer.identity.providerGameId !== leased.providerGameId ||
      offer.identity.storeId !== leased.storeId
    ) {
      throw new Error('CheapShark returned a different approved offer.');
    }

    const observedAt = new Date(offer.observedAt);
    let updated;
    if (options.observationWriter) {
      await options.observationWriter(String(leased._id), options.checkId!, leaseToken, offer);
      updated = await ProductModel.findById(leased._id).lean().exec();
    } else {
      updated = await ProductModel.findOneAndUpdate(
        {
          _id: leased._id,
          refreshLeaseToken: leaseToken,
          refreshLeaseUntil: { $gt: new Date() },
          provider: 'cheapshark',
          providerGameId: leased.providerGameId,
          storeId: leased.storeId,
          market: leased.market,
          currency: leased.currency,
        },
        {
          $set: {
            title: offer.title,
            canonicalSteamUrl: offer.canonicalSteamUrl,
            dealId: offer.dealId,
            purchaseUrl: offer.purchaseUrl,
            currentPriceMinor: offer.currentPrice.amountMinor,
            retailPriceMinor: offer.retailPrice?.amountMinor ?? null,
            lastSuccessfulCheckAt: observedAt,
            providerChangedAt: offer.providerChangedAt,
            nextCheckAt: new Date(observedAt.getTime() + SUCCESS_CACHE_TTL_MS),
            lastAttemptAt: observedAt,
            lastError: null,
            consecutiveFailures: 0,
            refreshLeaseUntil: null,
            refreshLeaseToken: null,
          },
        },
        { returnDocument: 'after', runValidators: true, ...dbOptions },
      )
        .lean()
        .exec();
    }

    if (!updated) {
      throw new Error('The approved product changed during its price check.');
    }

    return updated;
  } catch (error) {
    if (options.signal?.aborted) {
      await releaseProductLease(leased._id, leaseToken);
      throw abortError(options.signal);
    }
    const failureCount = leased.consecutiveFailures + 1;
    const retryAt = retryTime(error, failureCount);

    // Only failure metadata changes; price, deal, and last-success fields remain intact.
    await ProductModel.updateOne(
      { _id: leased._id, refreshLeaseToken: leaseToken, refreshLeaseUntil: { $gt: new Date() } },
      {
        $set: {
          lastError: failureMessage(error),
          lastAttemptAt: new Date(),
          nextCheckAt: retryAt,
          consecutiveFailures: failureCount,
          refreshLeaseUntil: null,
          refreshLeaseToken: null,
        },
      },
      { timeoutMS: 500, maxTimeMS: 500 },
    ).exec();
    throw error;
  }
}

async function canReusePrice(product: { _id: unknown; currentPriceMinor: number | null; lastSuccessfulCheckAt: Date | null; lastError: string | null }, options: RefreshOptions) {
  if (!hasFreshPrice(product)) return false;
  if (!options.requireObservation) return true;
  return Boolean(await PriceHistoryModel.exists({
    productId: String(product._id), observedAt: product.lastSuccessfulCheckAt,
    priceMinor: product.currentPriceMinor, currency: 'USD',
  }));
}

function hasFreshPrice(product: {
  currentPriceMinor: number | null;
  lastSuccessfulCheckAt: Date | null;
  lastError: string | null;
}): boolean {
  return product.lastError === null &&
    product.currentPriceMinor !== null &&
    Number.isSafeInteger(product.currentPriceMinor) &&
    product.currentPriceMinor >= 0 &&
    product.lastSuccessfulCheckAt !== null &&
    product.lastSuccessfulCheckAt.getTime() + SUCCESS_CACHE_TTL_MS > Date.now();
}

function deferFailedCheck(product: {
  lastError: string | null;
  nextCheckAt: Date | null;
}): void {
  // Retry scheduling applies even before the first successful observation.
  // It is separate from freshness: a retry time cannot renew an old price.
  if (product.lastError && product.nextCheckAt && product.nextCheckAt.getTime() > Date.now()) {
    throw new ProviderDeferredError(product.nextCheckAt);
  }
}

function retryTime(error: unknown, failureCount: number): Date {
  if (error instanceof ProviderRateLimitError && error.retryAt) return error.retryAt;
  if (error instanceof ProviderDeferredError) return error.retryAt;

  const backoff = Math.min(
    FAILURE_BACKOFF_BASE_MS * 2 ** Math.min(failureCount - 1, 10),
    FAILURE_BACKOFF_MAX_MS,
  );
  return new Date(Date.now() + backoff);
}

function failureMessage(error: unknown): string {
  if (error instanceof ProviderRateLimitError) {
    return 'CheapShark rate limited the request; retry has been deferred.';
  }
  if (error instanceof ProviderDeferredError) {
    return 'The shared CheapShark request budget deferred this check.';
  }
  return 'Price check failed; previous successful price retained.';
}

async function releaseProductLease(productId: unknown, leaseToken: string): Promise<void> {
  await ProductModel.updateOne(
    { _id: productId, refreshLeaseToken: leaseToken },
    { $set: { refreshLeaseUntil: null, refreshLeaseToken: null } },
    { timeoutMS: 500, maxTimeMS: 500 },
  ).exec();
}
