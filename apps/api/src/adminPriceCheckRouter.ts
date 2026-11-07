import { randomUUID } from 'node:crypto';
import express, { type RequestHandler } from 'express';
import { z } from 'zod';
import { accountError } from './accountError.js';
import { CheckControlModel } from './models/checkControl.js';
import { getPriceCheckRun, runPriceChecks, type PriceCheckRunSummary } from './priceChecks.js';

export async function consumeAdminLimit(userId: string, action: 'enqueue' | 'poll', now = Date.now()) {
  const start = Math.floor(now / 60_000) * 60_000;
  const id = `admin_${action}_${userId}_${start}`;
  let row;
  try {
    row = await CheckControlModel.findOneAndUpdate({ _id: id }, {
      $inc: { attempts: 1 }, $setOnInsert: { expiresAt: new Date(start + 60_000) },
    }, { upsert: true, returnDocument: 'after' }).exec();
  } catch (error) {
    if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 11000)) throw error;
    row = await CheckControlModel.findOneAndUpdate({ _id: id }, { $inc: { attempts: 1 } }, { returnDocument: 'after' }).exec();
  }
  return row!.attempts > (action === 'enqueue' ? 1 : 12) ? Math.max(1, Math.ceil((start + 60_000 - now) / 1000)) : null;
}

export function publicPriceCheck(summary: PriceCheckRunSummary) {
  const active = summary.status === 'pending' || summary.status === 'running';
  const failed = summary.counts.failed + (active ? 0 : summary.counts.pending + summary.counts.running);
  return {
    id: summary.runId,
    status: active ? (summary.status === 'pending' ? 'queued' : 'running')
      : summary.status === 'partial' ? (summary.counts.succeeded && failed ? 'partial' : 'failed') : 'succeeded',
    trigger: summary.mode === 'scheduled' ? 'scheduled' : 'manual',
    createdAt: summary.createdAt,
    startedAt: summary.startedAt,
    finishedAt: active ? null : summary.finishedAt,
    counts: { total: summary.total, succeeded: summary.counts.succeeded, failed, skipped: summary.counts.skipped },
    lastError: failed || summary.status === 'partial' ? {
      code: 'PROVIDER_UNAVAILABLE', message: 'One or more price checks failed; successful prices are retained.',
      occurredAt: summary.finishedAt ?? summary.createdAt, retryAt: summary.nextRetryAt,
    } : null,
  };
}

type Options = {
  run?: typeof runPriceChecks;
  get?: typeof getPriceCheckRun;
  limit?: typeof consumeAdminLimit;
};

/** Inject requireVerifiedUser(config); it owns session, verification, Origin and CSRF validation. */
export function createAdminPriceCheckRouter(authenticateVerifiedSession: RequestHandler, options: Options = {}) {
  const router = express.Router();
  const run = options.run ?? runPriceChecks;
  const get = options.get ?? getPriceCheckRun;
  const limit = options.limit ?? consumeAdminLimit;
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.use(authenticateVerifiedSession);
  router.use((_req, res, next) => {
    const principal = res.locals.principal;
    if (!principal?.userId || !principal.sessionId || !['web', 'mobile'].includes(principal.transport)) {
      accountError(res, 401, 'AUTH_REQUIRED', 'Sign in with a verified session.'); return;
    }
    if (principal.role !== 'admin') { accountError(res, 403, 'ADMIN_REQUIRED', 'Administrator access is required.'); return; }
    next();
  });
  const rate: RequestHandler = async (req, res, next) => {
    try {
      const retry = await limit(res.locals.principal.userId, req.method === 'POST' ? 'enqueue' : 'poll');
      if (retry !== null) { res.set('Retry-After', String(retry)); accountError(res, 429, 'RATE_LIMITED', 'The admin request limit was reached.'); return; }
      next();
    } catch { accountError(res, 503, 'SERVICE_UNAVAILABLE', 'The price-check service is unavailable.'); }
  };
  router.post('/admin/price-checks', rate, async (req, res) => {
    if (!req.is('application/json')) { accountError(res, 415, 'UNSUPPORTED_MEDIA_TYPE', 'Use application/json.'); return; }
    if (!z.strictObject({}).safeParse(req.body).success || Object.keys(req.query).length) {
      accountError(res, 422, 'VALIDATION_ERROR', 'Submit an empty JSON object.'); return;
    }
    try {
      const active = await CheckControlModel.findById('active').lean().exec();
      const prior = active?.runId ? await get(active.runId) : null;
      const runId = prior && prior.status !== 'complete' ? prior.runId : `admin_${randomUUID()}`;
      let queued!: (summary: PriceCheckRunSummary) => void;
      const ready = new Promise<PriceCheckRunSummary>(resolve => { queued = resolve; });
      const work = run({ runId, mode: prior?.runId === runId ? prior.mode : 'admin', onQueued: queued });
      const summary = await Promise.race([ready, work]);
      void work.catch(() => console.error('Admin check failed; inspect persisted run status.'));
      res.set('Location', `/api/admin/price-checks/${summary.runId}`).set('Retry-After', '5').status(202).json(publicPriceCheck(summary));
    } catch { res.set('Retry-After', '5'); accountError(res, 503, 'SERVICE_UNAVAILABLE', 'The price-check service is unavailable.'); }
  });
  router.get('/admin/price-checks/:id', rate, async (req, res) => {
    try {
      if (Object.keys(req.query).length || req.body !== undefined) { accountError(res, 400, 'MALFORMED_REQUEST', 'No body or query is accepted.'); return; }
      const summary = await get(String(req.params.id));
      if (!summary) { accountError(res, 404, 'NOT_FOUND', 'Price check not found.'); return; }
      if (summary.status === 'running' || summary.status === 'pending') res.set('Retry-After', '5');
      res.json(publicPriceCheck(summary));
    } catch { accountError(res, 503, 'SERVICE_UNAVAILABLE', 'The price-check service is unavailable.'); }
  });
  return router;
}
