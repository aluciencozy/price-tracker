import { createHash, randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { evaluateTrackerObservation } from './alertEpisodes.js';
import { ProviderDeferredError, ProviderRateLimitError } from './providerBudget.js';
import { refreshSteamProductById } from './productCatalog.js';
import { recordObservation } from './history.js';
import { PriceHistoryModel, TrackedItemModel } from './models/tracking.js';
import { ProductModel } from './models/product.js';
import { PriceCheckModel, type PriceCheckMode, type PriceCheckRecord } from './models/priceCheck.js';
import { CheckControlModel } from './models/checkControl.js';
import { SteamGameUnsupportedError } from './cheapshark.js';

const MAX_PRODUCTS_PER_RUN = 100;
const RUN_LEASE_MS = 120_000;
const ITEM_LEASE_MS = 60_000;
const FAILURE_BACKOFF_BASE_MS = 60_000;
const FAILURE_BACKOFF_MAX_MS = 6 * 60 * 60_000;
const idPattern = /^[A-Za-z0-9_-]{8,64}$/;

export type PriceCheckRunSummary = {
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  runId: string;
  mode: PriceCheckMode;
  status: 'pending' | 'running' | 'complete' | 'partial';
  total: number;
  counts: Record<'pending' | 'running' | 'succeeded' | 'failed' | 'skipped', number>;
  truncated: boolean;
  nextRetryAt: string | null;
  checks: Array<{
    productId: string;
    checkId: string;
    status: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';
    attempts: number;
    result: 'refreshed' | 'cached' | null;
    observationId: string | null;
    errorCode: string | null;
    nextRetryAt: string | null;
  }>;
};

export type RunPriceChecksOptions = {
  runId: string;
  mode: PriceCheckMode;
  /** Lower limits are useful for controlled CLI runs; higher limits are clamped to the hard cap. */
  maxProducts?: number;
  /** Called after durable run/check rows are ready but before provider work begins. */
  onQueued?: (summary: PriceCheckRunSummary) => void | Promise<void>;
};

export function checkIdFor(runId: string, productId: string): string {
  return `pc_${createHash('sha256').update(`${runId}:${productId}`).digest('hex')}`;
}

function isDuplicateKey(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;
}

function safeRetryAt(error: unknown, attempt: number, productRetryAt?: Date | null): Date {
  const providerRetry = error instanceof ProviderRateLimitError || error instanceof ProviderDeferredError
    ? error.retryAt
    : null;
  if (providerRetry && Number.isFinite(providerRetry.getTime())) return providerRetry;
  if (productRetryAt && Number.isFinite(productRetryAt.getTime())) return productRetryAt;
  const backoff = Math.min(
    FAILURE_BACKOFF_BASE_MS * 2 ** Math.min(Math.max(attempt - 1, 0), 10),
    FAILURE_BACKOFF_MAX_MS,
  );
  return new Date(Date.now() + backoff);
}

function errorCode(error: unknown, persistedObservation: boolean): string {
  if (error instanceof ProviderRateLimitError) return 'PROVIDER_RATE_LIMITED';
  if (error instanceof ProviderDeferredError) return 'PROVIDER_DEFERRED';
  if (error instanceof SteamGameUnsupportedError) return 'UNSUPPORTED_PRODUCT';
  if (persistedObservation) return 'OBSERVATION_EVALUATION_FAILED';
  return 'PROVIDER_UNAVAILABLE';
}

function toSummary(run: PriceCheckRecord, items: PriceCheckRecord[]): PriceCheckRunSummary {
  const counts = { pending: 0, running: 0, succeeded: 0, failed: 0, skipped: 0 };
  for (const item of items) {
    if (item.entryType === 'product' && item.status in counts) {
      counts[item.status as keyof typeof counts] += 1;
    }
  }
  return {
    createdAt: (run.createdAt ?? run.availableAt).toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.completedAt?.toISOString() ?? null,
    runId: run.runId,
    mode: run.mode,
    status: run.status as PriceCheckRunSummary['status'],
    total: items.length,
    counts,
    truncated: run.truncated,
    nextRetryAt: run.nextRetryAt?.toISOString() ?? null,
    checks: items.flatMap(item => item.productId && item.checkId ? [{
      productId: String(item.productId),
      checkId: item.checkId,
      status: item.status as PriceCheckRunSummary['checks'][number]['status'],
      attempts: item.attempts,
      result: item.result,
      observationId: item.observationId ? String(item.observationId) : null,
      errorCode: item.errorCode,
      nextRetryAt: item.status === 'failed' ? item.availableAt.toISOString() : null,
    }] : []),
  };
}

export async function getPriceCheckRun(runId: string): Promise<PriceCheckRunSummary | null> {
  if (!idPattern.test(runId)) return null;
  const [run, items] = await Promise.all([
    PriceCheckModel.findOne({ entryType: 'run', runId }).lean().exec(),
    PriceCheckModel.find({ entryType: 'product', runId }).sort({ productId: 1 }).lean().exec(),
  ]);
  return run ? toSummary(run, items) : null;
}

/**
 * Run one bounded batch. `runId` identifies the durable run; each Product gets
 * one stable history check ID. Recalling the same run resumes failed/expired
 * claims and replays alert evaluation from persisted history without refetching.
 */
export async function runPriceChecks(options: RunPriceChecksOptions): Promise<PriceCheckRunSummary> {
  const { runId, mode } = options;
  if (!idPattern.test(runId)) throw new Error('Invalid price-check run ID.');
  if (!['scheduled', 'admin', 'cli', 'user'].includes(mode)) throw new Error('Invalid price-check mode.');
  if (mode === 'user') {
    const run = await PriceCheckModel.findOne({ entryType: 'run', runId, mode, selectionComplete: true }).lean();
    const items = await PriceCheckModel.find({ entryType: 'product', runId }).limit(2).lean();
    const tracker = run?.ownerUserId && run.trackedItemId && await TrackedItemModel.findOne({ _id: run.trackedItemId, userId: run.ownerUserId }).lean();
    const item = items[0];
    if (!run || !tracker || items.length !== 1 || !item || item.mode !== 'user' ||
        String(item.productId) !== String(tracker.productId) || !item.checkId) {
      throw new Error('User price-check run must be seeded with exactly one owned product before execution.');
    }
  }
  const requestedLimit = options.maxProducts ?? MAX_PRODUCTS_PER_RUN;
  if (!Number.isFinite(requestedLimit) || requestedLimit < 1) throw new Error('Invalid product limit.');
  const maxProducts = Math.max(1, Math.min(MAX_PRODUCTS_PER_RUN, Math.floor(requestedLimit)));
  const now = new Date();
  const globalToken = randomUUID();
  await CheckControlModel.updateOne({ _id: 'active' }, { $setOnInsert: { leaseUntil: new Date(0) } }, { upsert: true }).catch(error => { if (!isDuplicateKey(error)) throw error; });
  const globalClaim = await mongoose.connection.transaction(async session => {
    const claim = await CheckControlModel.findOneAndUpdate({ _id: 'active', leaseUntil: { $lte: now } },
      { $set: { runId, leaseToken: globalToken, leaseUntil: new Date(Date.now() + RUN_LEASE_MS) } },
      { returnDocument: 'after', session }).exec();
    if (!claim) return null;
    // Publish the queue identity and active claim atomically. An overlapping
    // enqueue can always return a real queued row, never an initialization gap.
    await PriceCheckModel.updateOne({ entryType: 'run', runId }, { $setOnInsert: {
      entryType: 'run', runId, mode, status: 'pending', availableAt: now,
    } }, { upsert: true, session }).exec();
    return claim;
  });
  if (!globalClaim) {
    if (mode === 'user') {
      const own = await getPriceCheckRun(runId);
      if (own) return own;
      throw new Error('User price-check run is missing.');
    }
    const current = await CheckControlModel.findById('active').lean().exec();
    const summary = current?.runId ? await getPriceCheckRun(current.runId) : null;
    if (summary && summary.mode !== 'user') return summary;
    if (summary?.mode === 'user') {
      await PriceCheckModel.updateOne({ entryType: 'run', runId }, { $setOnInsert: {
        entryType: 'run', runId, mode, status: 'pending', availableAt: now,
      } }, { upsert: true });
      return (await getPriceCheckRun(runId))!;
    }
    throw new ProviderDeferredError(new Date(Date.now() + 1_000));
  }
  try {
    return await executePriceCheckRun(options, maxProducts, globalToken);
  } finally {
    await CheckControlModel.updateOne({ _id: 'active', leaseToken: globalToken }, {
      $set: { leaseUntil: new Date(0), leaseToken: null },
    });
  }
}

async function executePriceCheckRun(options: RunPriceChecksOptions, maxProducts: number, globalToken: string): Promise<PriceCheckRunSummary> {
  const { runId, mode } = options;
  const now = new Date();
  const existingRun = await PriceCheckModel.findOne({ entryType: 'run', runId }).lean().exec();
  if (!existingRun || existingRun.mode !== mode) throw new Error('Price-check run ID is already in use.');
  if (existingRun.status === 'complete' || (existingRun.nextRetryAt && existingRun.nextRetryAt > now)) {
    return (await getPriceCheckRun(runId))!;
  }

  const runLeaseToken = randomUUID();
  const claimedRun = await PriceCheckModel.findOneAndUpdate(
    {
      _id: existingRun._id,
      status: { $ne: 'complete' },
      $or: [{ leaseUntil: null }, { leaseUntil: { $lte: now } }],
    },
    { $set: { status: 'running', leaseToken: runLeaseToken, leaseUntil: new Date(now.getTime() + RUN_LEASE_MS), nextRetryAt: null, completedAt: null, startedAt: existingRun.startedAt ?? now } },
    { returnDocument: 'after' },
  ).lean().exec();
  if (!claimedRun) return (await getPriceCheckRun(runId))!;

  try {
    if (!claimedRun.selectionComplete) {
      await mongoose.connection.transaction(async session => {
        const owned = await PriceCheckModel.findOne({
          _id: claimedRun._id, leaseToken: runLeaseToken, leaseUntil: { $gt: new Date() }, selectionComplete: false,
        }).session(session).exec();
        if (!owned) throw new Error('Price-check selection lease was lost.');
        const control = await CheckControlModel.findById('selection').session(session).lean().exec();
        let products = await ProductModel.find(control?.cursor ? { _id: { $gt: control.cursor } } : {})
          .select({ _id: 1 }).sort({ _id: 1 }).limit(maxProducts + 1).session(session).lean().exec();
        if (!products.length && control?.cursor) {
          products = await ProductModel.find({}).select({ _id: 1 }).sort({ _id: 1 }).limit(maxProducts + 1).session(session).lean().exec();
        }
        const truncated = products.length > maxProducts;
        const selectedProducts = products.slice(0, maxProducts);
        const last = selectedProducts.at(-1);
        await CheckControlModel.updateOne({ _id: 'selection' }, { $set: { cursor: last?._id ?? null } }, { upsert: true, session });
        for (const product of selectedProducts) {
          const productId = String(product._id);
          await PriceCheckModel.updateOne(
            { entryType: 'product', runId, productId: product._id },
            { $setOnInsert: {
              entryType: 'product', runId, mode, productId: product._id,
              checkId: checkIdFor(runId, productId), status: 'pending', attempts: 0,
              availableAt: now, nextRetryAt: null, leaseToken: null, leaseUntil: null,
              observationId: null, result: null, errorCode: null, startedAt: null,
              completedAt: null, truncated: false,
            } },
            { upsert: true, session },
          ).exec();
        }
        const selected = await PriceCheckModel.updateOne(
          { _id: claimedRun._id, leaseToken: runLeaseToken, leaseUntil: { $gt: new Date() } },
          { $set: { truncated, selectionComplete: true } },
          { session },
        ).exec();
        const selectionOwner = await CheckControlModel.updateOne({
          _id: 'active', leaseToken: globalToken, leaseUntil: { $gt: new Date() },
        }, { $set: { leaseUntil: new Date(Date.now() + RUN_LEASE_MS) } }, { session });
        if (selected.matchedCount !== 1 || selectionOwner.matchedCount !== 1) throw new Error('Price-check selection lease was lost.');
      });
    }

    const items = await PriceCheckModel.find({ entryType: 'product', runId }).sort({ productId: 1 }).lean().exec();
    if (options.onQueued) await options.onQueued((await getPriceCheckRun(runId))!);
    for (const item of items) {
      const live = await PriceCheckModel.updateOne(
        { _id: claimedRun._id, leaseToken: runLeaseToken, leaseUntil: { $gt: new Date() } },
        { $set: { leaseUntil: new Date(Date.now() + RUN_LEASE_MS) } },
      ).exec();
      if (live.matchedCount !== 1) break;
      const globalLive = await CheckControlModel.updateOne({ _id: 'active', leaseToken: globalToken, leaseUntil: { $gt: new Date() } }, { $set: { leaseUntil: new Date(Date.now() + RUN_LEASE_MS) } });
      if (globalLive.matchedCount !== 1) break;
      await processCheckItem(item);
    }

    const finalItems = await PriceCheckModel.find({ entryType: 'product', runId }).sort({ productId: 1 }).lean().exec();
    const unresolved = finalItems.filter(item => item.status === 'pending' || item.status === 'running' ||
      (item.status === 'failed' && (mode !== 'user' || ['PROVIDER_DEFERRED', 'PROVIDER_RATE_LIMITED'].includes(item.errorCode ?? ''))));
    const nextRetryAt = unresolved.length
      ? unresolved.map(item => item.status === 'running' ? item.leaseUntil : item.availableAt)
        .filter((date): date is Date => Boolean(date))
        .sort((left, right) => left.getTime() - right.getTime())[0] ?? new Date(Date.now() + 1_000)
      : null;
    await mongoose.connection.transaction(async session => {
      const completedAt = new Date();
      const updated = await PriceCheckModel.updateOne(
        { _id: claimedRun._id, leaseToken: runLeaseToken, leaseUntil: { $gt: completedAt } },
        { $set: {
          status: unresolved.length ? 'partial' : 'complete', nextRetryAt,
          completedAt, leaseToken: null, leaseUntil: null,
        } }, { session },
      ).exec();
      if (updated.matchedCount && mode === 'user' && !unresolved.length && claimedRun.trackedItemId) {
        const retry = finalItems[0]?.status === 'failed' ? finalItems[0].availableAt.getTime() : 0;
        await TrackedItemModel.updateOne({ _id: claimedRun.trackedItemId, userId: claimedRun.ownerUserId, refreshRunId: runId }, {
          $set: { refreshRunId: null, refreshCooldownUntil: new Date(Math.max(completedAt.getTime() + 60_000, retry)) },
        }, { session }).exec();
      }
    });
    return (await getPriceCheckRun(runId))!;
  } catch (error) {
    await PriceCheckModel.updateOne(
      { _id: claimedRun._id, leaseToken: runLeaseToken, leaseUntil: { $gt: new Date() } },
      { $set: {
        status: 'partial', nextRetryAt: new Date(Date.now() + 1_000), completedAt: new Date(),
        leaseToken: null, leaseUntil: null,
      } },
    ).exec();
    throw error;
  }
}

async function processCheckItem(item: PriceCheckRecord): Promise<void> {
  if (!item.productId || !item.checkId || item.status === 'succeeded' || item.status === 'skipped') return;
  const now = new Date();
  if ((item.status === 'failed' && item.availableAt > now) ||
      (item.status === 'running' && item.leaseUntil && item.leaseUntil > now)) return;

  const itemLeaseToken = randomUUID();
  const claimed = await PriceCheckModel.findOneAndUpdate(
    {
      _id: item._id,
      $or: [
        { status: 'pending' },
        { status: 'failed', availableAt: { $lte: now } },
        { status: 'running', leaseUntil: { $lte: now } },
      ],
    },
    { $set: { status: 'running', leaseToken: itemLeaseToken, leaseUntil: new Date(now.getTime() + ITEM_LEASE_MS), startedAt: item.startedAt ?? now, errorCode: null }, $inc: { attempts: 1 } },
    { returnDocument: 'after' },
  ).lean().exec();
  if (!claimed) return;

  let persistedObservation = false;
  try {
    const watchers = await TrackedItemModel.find({ productId: claimed.productId, enabled: true })
      .select({ _id: 1 }).sort({ _id: 1 }).lean().exec();
    if (!watchers.length && claimed.mode !== 'user') {
      await finishItem(claimed._id, itemLeaseToken, { status: 'skipped', completedAt: new Date(), leaseToken: null, leaseUntil: null, errorCode: null, nextRetryAt: null });
      return;
    }

    let observation = await PriceHistoryModel.findOne({ productId: claimed.productId, checkId: claimed.checkId }).exec();
    let result: 'refreshed' | 'cached' = 'refreshed';
    if (!observation) {
      const product = await refreshSteamProductById(String(claimed.productId), {
        checkId: claimed.checkId!,
        observationWriter: recordObservation,
        requireObservation: true,
      });
      observation = await PriceHistoryModel.findOne({ productId: claimed.productId, checkId: claimed.checkId }).exec();
      if (!observation && product.lastSuccessfulCheckAt && product.lastError === null) {
        observation = await PriceHistoryModel.findOne({
          productId: claimed.productId,
          observedAt: product.lastSuccessfulCheckAt,
        }).sort({ _id: -1 }).exec();
        result = 'cached';
      }
    }

    if (!observation) {
      await finishItem(claimed._id, itemLeaseToken, {
        status: 'skipped', result: 'cached', completedAt: new Date(),
        leaseToken: null, leaseUntil: null, errorCode: 'NO_RECORDED_OBSERVATION', nextRetryAt: null,
      });
      return;
    }

    persistedObservation = true;
    for (const watcher of watchers) {
      await evaluateTrackerObservation(String(watcher._id), String(observation._id));
    }
    await finishItem(claimed._id, itemLeaseToken, {
      status: 'succeeded', result, observationId: observation._id,
      completedAt: new Date(), leaseToken: null, leaseUntil: null,
      errorCode: null, nextRetryAt: null,
    });
  } catch (error) {
    const product = persistedObservation
      ? null
      : await ProductModel.findById(claimed.productId).select({ nextCheckAt: 1 }).lean().exec().catch(() => null);
    const retryAt = safeRetryAt(error, claimed.attempts, product?.nextCheckAt);
    await finishItem(claimed._id, itemLeaseToken, {
      status: 'failed', availableAt: retryAt, nextRetryAt: retryAt,
      leaseToken: null, leaseUntil: null, completedAt: null, errorCode: errorCode(error, persistedObservation),
    });
  }
}

async function finishItem(
  itemId: mongoose.Types.ObjectId,
  leaseToken: string,
  update: Partial<PriceCheckRecord>,
): Promise<void> {
  await PriceCheckModel.updateOne(
    { _id: itemId, leaseToken, leaseUntil: { $gt: new Date() } },
    { $set: update },
  ).exec();
}

/** Resume a bounded number of due runs (including accepted admin work) after restart. */
export async function resumeDuePriceChecks(limit = 10): Promise<PriceCheckRunSummary[]> {
  const now = new Date();
  const runs = await PriceCheckModel.find({
    entryType: 'run',
    $or: [
      { status: 'pending' },
      { status: 'partial', $or: [{ nextRetryAt: null }, { nextRetryAt: { $lte: now } }] },
      { status: 'running', leaseUntil: { $lte: now } },
    ],
  }).sort({ createdAt: 1 }).limit(Math.max(1, Math.min(10, Math.floor(limit)))).lean().exec();
  const summaries: PriceCheckRunSummary[] = [];
  for (const run of runs) {
    if (run.mode === 'user' && (!run.trackedItemId || !run.ownerUserId || !await TrackedItemModel.exists({ _id: run.trackedItemId, userId: run.ownerUserId }))) {
      // A deleted tracker must not leave a permanently un-runnable row at the head of recovery.
      await PriceCheckModel.updateOne({ _id: run._id, status: run.status, $or: [{ leaseUntil: null }, { leaseUntil: { $lte: now } }] }, {
        $set: { status: 'complete', completedAt: now, nextRetryAt: null, leaseToken: null, leaseUntil: null },
      });
      continue;
    }
    summaries.push(await runPriceChecks({ runId: run.runId, mode: run.mode }));
  }
  return summaries;
}

export const resumeDueScheduledPriceChecks = resumeDuePriceChecks;

export const priceCheckConstants = { MAX_PRODUCTS_PER_RUN, RUN_LEASE_MS, ITEM_LEASE_MS } as const;
