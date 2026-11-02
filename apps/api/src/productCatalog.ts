import { randomUUID } from 'node:crypto';
import { ProductModel } from './models/product.js';
import {
  lookupSteamOffer,
  parseSteamAppIdFromUrl,
} from './cheapshark.js';
import {
  ProviderDeferredError,
  ProviderRateLimitError,
} from './providerBudget.js';

const SUCCESS_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
const REFRESH_LEASE_MS = 35_000;
const FAILURE_BACKOFF_BASE_MS = 60_000;
const FAILURE_BACKOFF_MAX_MS = 6 * 60 * 60 * 1_000;

export type RefreshOptions = { force?: boolean };

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
  let product = await ProductModel.findById(productId).lean().exec();
  if (!product) throw new Error('The approved Steam product was not found.');

  if (!options.force) {
    deferFailedCheck(product);
    if (hasFreshPrice(product)) return product;
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
    { new: true },
  )
    .lean()
    .exec();

  if (!leased) {
    product = await ProductModel.findById(productId).lean().exec();
    if (product && !options.force) {
      deferFailedCheck(product);
      if (hasFreshPrice(product)) return product;
    }

    const retryAt = product?.refreshLeaseUntil ?? new Date(Date.now() + 1_000);
    throw new ProviderDeferredError(retryAt);
  }

  // A concurrent failure may have scheduled a retry before we got the lease.
  // Releasing this unused claim is not another failed provider attempt.
  try {
    if (!options.force) deferFailedCheck(leased);
  } catch (error) {
    await releaseProductLease(product._id, leaseToken);
    throw error;
  }

  try {
    // Another check may have refreshed the Product before this worker got its lease.
    if (!options.force && hasFreshPrice(leased)) {
      await releaseProductLease(product._id, leaseToken);
      return leased;
    }

    const offer = await lookupSteamOffer(leased.canonicalSteamUrl);

    if (
      offer.steamAppId !== leased.steamAppId ||
      offer.identity.providerGameId !== leased.providerGameId ||
      offer.identity.storeId !== leased.storeId
    ) {
      throw new Error('CheapShark returned a different approved offer.');
    }

    const observedAt = new Date(offer.observedAt);
    const updated = await ProductModel.findOneAndUpdate(
      {
        _id: leased._id,
        refreshLeaseToken: leaseToken,
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
      { new: true, runValidators: true },
    )
      .lean()
      .exec();

    if (!updated) {
      throw new Error('The approved product changed during its price check.');
    }

    return updated;
  } catch (error) {
    const failureCount = leased.consecutiveFailures + 1;
    const retryAt = retryTime(error, failureCount);

    // Only failure metadata changes; price, deal, and last-success fields remain intact.
    await ProductModel.updateOne(
      { _id: leased._id, refreshLeaseToken: leaseToken },
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
    ).exec();
    throw error;
  }
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
  ).exec();
}
