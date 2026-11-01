import { setTimeout as delay } from 'node:timers/promises';
import { ProviderBudgetModel } from './models/providerBudget.js';

const PROVIDER_KEY = 'cheapshark' as const;
// Conservative application pacing; this is not a published CheapShark quota.
const MIN_REQUEST_INTERVAL_MS = 5_000;
const REQUEST_LEASE_MS = 15_000;
const RATE_LIMIT_BASE_BACKOFF_MS = 60_000;
const RATE_LIMIT_MAX_BACKOFF_MS = 30 * 60_000;
const EPOCH = new Date(0);

export class ProviderRateLimitError extends Error {
  constructor(
    readonly retryAt: Date | null,
    readonly retryAfterHeader: string | null = null,
    options?: ErrorOptions,
  ) {
    super('CheapShark rate limited the request.', options);
    this.name = 'ProviderRateLimitError';
  }
}

export class ProviderDeferredError extends Error {
  constructor(readonly retryAt: Date) {
    super('The shared CheapShark request budget is temporarily unavailable.');
    this.name = 'ProviderDeferredError';
  }
}

function parseRetryAfter(value: string | null, now: number): Date | null {
  if (!value) return null;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return new Date(now + seconds * 1_000);
  }

  const date = Date.parse(value);
  return Number.isFinite(date) ? new Date(date) : null;
}

async function ensureBudgetRecord(): Promise<void> {
  try {
    await ProviderBudgetModel.updateOne(
      { _id: PROVIDER_KEY },
      {
        $setOnInsert: {
          leaseUntil: EPOCH,
          nextRequestAt: EPOCH,
          cooldownUntil: EPOCH,
          rateLimitCount: 0,
        },
      },
      { upsert: true },
    ).exec();
  } catch (error) {
    // Another process may win the singleton upsert. Its document is sufficient.
    if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 11000)) {
      throw error;
    }
  }
}

async function acquireRequestSlot(deadline: number): Promise<void> {
  await ensureBudgetRecord();

  while (Date.now() < deadline) {
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + REQUEST_LEASE_MS);
    const lease = await ProviderBudgetModel.findOneAndUpdate(
      {
        _id: PROVIDER_KEY,
        leaseUntil: { $lte: now },
        nextRequestAt: { $lte: now },
        cooldownUntil: { $lte: now },
      },
      { $set: { leaseUntil } },
      { new: true },
    )
      .lean()
      .exec();

    if (lease) return;

    const budget = await ProviderBudgetModel.findById(PROVIDER_KEY).lean().exec();
    if (!budget) {
      throw new ProviderDeferredError(new Date(Date.now() + 1_000));
    }

    const availableAt = Math.max(
      budget.leaseUntil.getTime(),
      budget.nextRequestAt.getTime(),
      budget.cooldownUntil.getTime(),
    );
    const remaining = deadline - Date.now();
    if (availableAt - Date.now() > remaining) {
      throw new ProviderDeferredError(new Date(availableAt));
    }

    await delay(Math.max(10, Math.min(availableAt - Date.now(), remaining)));
  }

  throw new ProviderDeferredError(new Date(Date.now() + 1_000));
}

async function releaseRequestSlot(success: boolean): Promise<void> {
  const now = new Date();
  await ProviderBudgetModel.updateOne(
    { _id: PROVIDER_KEY },
    {
      $set: {
        leaseUntil: EPOCH,
        nextRequestAt: new Date(now.getTime() + MIN_REQUEST_INTERVAL_MS),
        ...(success ? { rateLimitCount: 0 } : {}),
      },
    },
  ).exec();
}

async function recordRateLimit(retryAfter: string | null): Promise<Date> {
  const now = Date.now();
  const state = await ProviderBudgetModel.findOneAndUpdate(
    { _id: PROVIDER_KEY },
    { $inc: { rateLimitCount: 1 } },
    { new: true },
  )
    .lean()
    .exec();

  const count = Math.max(0, (state?.rateLimitCount ?? 1) - 1);
  const fallbackMs = Math.min(
    RATE_LIMIT_BASE_BACKOFF_MS * 2 ** Math.min(count, 10),
    RATE_LIMIT_MAX_BACKOFF_MS,
  );
  const headerTime = parseRetryAfter(retryAfter, now)?.getTime();
  // Never retry sooner than Retry-After; use bounded exponential backoff if absent/invalid.
  const retryAt = new Date(
    headerTime === undefined
      ? now + fallbackMs
      : Math.max(headerTime, now + MIN_REQUEST_INTERVAL_MS),
  );

  await ProviderBudgetModel.updateOne(
    { _id: PROVIDER_KEY },
    {
      $max: { cooldownUntil: retryAt, nextRequestAt: retryAt },
      $set: { leaseUntil: EPOCH },
    },
  ).exec();

  return retryAt;
}

/** Run one outbound CheapShark request under the shared MongoDB budget. */
export async function withCheapSharkRequestBudget<T>(
  deadline: number,
  request: () => Promise<T>,
): Promise<T> {
  await acquireRequestSlot(deadline);

  try {
    const result = await request();
    await releaseRequestSlot(true);
    return result;
  } catch (error) {
    if (error instanceof ProviderRateLimitError) {
      const retryAt = await recordRateLimit(error.retryAfterHeader);
      throw new ProviderRateLimitError(retryAt, error.retryAfterHeader, { cause: error });
    }

    await releaseRequestSlot(false);
    throw error;
  }
}
