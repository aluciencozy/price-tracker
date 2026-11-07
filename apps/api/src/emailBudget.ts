import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { mongo } from 'mongoose';
import { EmailBudgetModel, type EmailBudgetRecord } from './models/emailBudget.js';

export const EMAIL_ATTEMPTS_PER_INVOCATION = 3;
export const EMAIL_BUDGET_DAILY_MS = 24 * 60 * 60 * 1000;
export const EMAIL_BUDGET_MONTHLY_MS = 31 * EMAIL_BUDGET_DAILY_MS;
// The integrator must enforce the monotonic invocation deadline below.
const RESERVATION_PADDING_MS = 60_000;
const INVOCATION_DEADLINE_MS = 30_000;
const FAILURE_BACKOFF_MS = 60_000;
const ACCOUNT = 'resend-account' as const;

export type EmailBudgetLimits = { dailyLimit: number; monthlyLimit: number };
export const DEFAULT_EMAIL_BUDGET_LIMITS: Readonly<EmailBudgetLimits> = {
  dailyLimit: 90, monthlyLimit: 2700,
};

export type EmailBudgetDecision =
  | { status: 'allowed'; deadlineMonotonicMs: number }
  | { status: 'deferred'; reason: 'exhausted'; retryAfterMs: number }
  | { status: 'deferred'; reason: 'unavailable' | 'invalid_config' | 'config_mismatch'; retryAfterMs: number };

function validLimits(limits: EmailBudgetLimits): boolean {
  return Number.isSafeInteger(limits?.dailyLimit) && limits.dailyLimit >= 3 && limits.dailyLimit <= 100 &&
    Number.isSafeInteger(limits?.monthlyLimit) && limits.monthlyLimit >= 3 && limits.monthlyLimit <= 3000;
}

/** Check immediately before every network attempt, in the reserving process only. */
export function emailAttemptMayStart(decision: EmailBudgetDecision): boolean {
  return decision.status === 'allowed' && performance.now() < decision.deadlineMonotonicMs;
}

/** Reserve three attempts for exactly one invocation. Never cache or replay an allowed decision. */
export async function reserveEmailSend(
  limits: EmailBudgetLimits = DEFAULT_EMAIL_BUDGET_LIMITS,
): Promise<EmailBudgetDecision> {
  if (!validLimits(limits)) return { status: 'deferred', reason: 'invalid_config', retryAfterMs: FAILURE_BACKOFF_MS };
  const started = performance.now();
  const decisionId = randomUUID();
  try {
    // One atomic update, using MongoDB's clock for every comparison and reservation.
    // No automatic application retry: an ambiguous write has already consumed capacity.
    const collection = EmailBudgetModel.collection as unknown as mongo.Collection<EmailBudgetRecord>;
    const record = await collection.findOneAndUpdate(
      { _id: ACCOUNT },
      [
        { $set: {
          dailyLimit: { $ifNull: ['$dailyLimit', limits.dailyLimit] },
          monthlyLimit: { $ifNull: ['$monthlyLimit', limits.monthlyLimit] },
          reservations: { $filter: {
            input: { $ifNull: ['$reservations', []] }, as: 'r',
            cond: { $gt: ['$$r', { $subtract: ['$$NOW', EMAIL_BUDGET_MONTHLY_MS] }] },
          } },
          decisionAt: '$$NOW',
        } },
        { $set: {
          allowed: { $and: [
            { $eq: ['$dailyLimit', limits.dailyLimit] },
            { $eq: ['$monthlyLimit', limits.monthlyLimit] },
            { $lte: [{ $add: [{ $size: { $filter: {
              input: '$reservations', as: 'r',
              cond: { $gt: ['$$r', { $subtract: ['$$NOW', EMAIL_BUDGET_DAILY_MS] }] },
            } } }, EMAIL_ATTEMPTS_PER_INVOCATION] }, limits.dailyLimit] },
            { $lte: [{ $add: [{ $size: '$reservations' }, EMAIL_ATTEMPTS_PER_INVOCATION] }, limits.monthlyLimit] },
          ] },
          decisionId,
        } },
        { $set: { reservations: { $cond: ['$allowed', { $concatArrays: [
          '$reservations', Array.from({ length: EMAIL_ATTEMPTS_PER_INVOCATION }, () => ({ $add: ['$$NOW', RESERVATION_PADDING_MS] })),
        ] }, '$reservations'] } } },
      ],
      { upsert: true, returnDocument: 'after', writeConcern: { w: 'majority', wtimeoutMS: 5000 } },
    );
    if (!record || record.decisionId !== decisionId || !(record.decisionAt instanceof Date) ||
      !Array.isArray(record.reservations) || !record.reservations.every(r => r instanceof Date && Number.isFinite(r.getTime()))) {
      return { status: 'deferred', reason: 'unavailable', retryAfterMs: FAILURE_BACKOFF_MS };
    }
    if (record.dailyLimit !== limits.dailyLimit || record.monthlyLimit !== limits.monthlyLimit) {
      return { status: 'deferred', reason: 'config_mismatch', retryAfterMs: FAILURE_BACKOFF_MS };
    }
    if (record.allowed === true) {
      const deadlineMonotonicMs = started + INVOCATION_DEADLINE_MS;
      return performance.now() < deadlineMonotonicMs ? { status: 'allowed', deadlineMonotonicMs } :
        { status: 'deferred', reason: 'unavailable', retryAfterMs: FAILURE_BACKOFF_MS };
    }
    if (record.allowed !== false) return { status: 'deferred', reason: 'unavailable', retryAfterMs: FAILURE_BACKOFF_MS };
    const now = record.decisionAt.getTime();
    const retryFor = (windowMs: number, limit: number) => {
      const times = record.reservations.map(r => r.getTime()).filter(t => t > now - windowMs).sort((a, b) => a - b);
      const required = times.length + EMAIL_ATTEMPTS_PER_INVOCATION - limit;
      return required > 0 ? times[required - 1]! + windowMs - now : 0;
    };
    return { status: 'deferred', reason: 'exhausted', retryAfterMs: Math.max(
      retryFor(EMAIL_BUDGET_DAILY_MS, limits.dailyLimit), retryFor(EMAIL_BUDGET_MONTHLY_MS, limits.monthlyLimit),
    ) };
  } catch {
    return { status: 'deferred', reason: 'unavailable', retryAfterMs: FAILURE_BACKOFF_MS };
  }
}
