import { afterEach, describe, expect, it, vi } from 'vitest';
import { EMAIL_BUDGET_DAILY_MS, EMAIL_BUDGET_MONTHLY_MS, emailAttemptMayStart, reserveEmailSend } from '../src/emailBudget.js';
import { EmailBudgetModel } from '../src/models/emailBudget.js';

const clock = vi.hoisted(() => ({ now: 1000 }));
vi.mock('node:perf_hooks', async importOriginal => {
  const original = await importOriginal<typeof import('node:perf_hooks')>();
  return { ...original, performance: { now: () => clock.now } };
});
afterEach(() => vi.restoreAllMocks());

describe('email budget fail-closed behavior', () => {
  it.each([
    { dailyLimit: 101, monthlyLimit: 2700 }, { dailyLimit: 90, monthlyLimit: 3001 },
    { dailyLimit: 2, monthlyLimit: 3 }, { dailyLimit: NaN, monthlyLimit: 3 },
    { dailyLimit: 3.5, monthlyLimit: 3 },
  ])('rejects malformed limits without touching the database: %o', async limits => {
    const call = vi.spyOn(EmailBudgetModel.collection, 'findOneAndUpdate');
    expect(await reserveEmailSend(limits)).toMatchObject({ status: 'deferred', reason: 'invalid_config' });
    expect(call).not.toHaveBeenCalled();
  });

  it('does not allow a send after an ambiguous driver failure', async () => {
    vi.spyOn(EmailBudgetModel.collection, 'findOneAndUpdate').mockRejectedValue(new Error('write acknowledgement lost'));
    expect(await reserveEmailSend()).toMatchObject({ status: 'deferred', reason: 'unavailable' });
  });

  it('does not allow a malformed driver response', async () => {
    vi.spyOn(EmailBudgetModel.collection, 'findOneAndUpdate').mockResolvedValue(null);
    expect(await reserveEmailSend()).toMatchObject({ status: 'deferred', reason: 'unavailable' });
  });

  it('calculates the later of the daily and 31-day release boundaries', async () => {
    const now = new Date('2026-11-06T12:00:00Z');
    vi.spyOn(EmailBudgetModel.collection, 'findOneAndUpdate').mockImplementation(async (_filter, update) => {
      const stages = update as unknown as Array<{ $set: { decisionId?: string } }>;
      return { _id: 'resend-account', dailyLimit: 3, monthlyLimit: 3,
        decisionId: stages[1]!.$set.decisionId, decisionAt: now, allowed: false,
        reservations: Array(3).fill(new Date(now.getTime() - EMAIL_BUDGET_DAILY_MS + 1000)) } as never;
    });
    expect(await reserveEmailSend({ dailyLimit: 3, monthlyLimit: 3 })).toEqual({
      status: 'deferred', reason: 'exhausted', retryAfterMs: EMAIL_BUDGET_MONTHLY_MS - EMAIL_BUDGET_DAILY_MS + 1000,
    });
  });

  it('expires an allowed grant across a 24-hour handoff pause and checks every retry', async () => {
    clock.now = 1000;
    vi.spyOn(EmailBudgetModel.collection, 'findOneAndUpdate').mockImplementation(async (_filter, update) => {
      const stages = update as unknown as Array<{ $set: { decisionId?: string } }>;
      return { _id: 'resend-account', dailyLimit: 90, monthlyLimit: 2700,
        decisionId: stages[1]!.$set.decisionId, decisionAt: new Date(), allowed: true,
        reservations: [new Date()] } as never;
    });
    const decision = await reserveEmailSend();
    expect(decision).toMatchObject({ status: 'allowed', deadlineMonotonicMs: 31_000 });
    const send = vi.fn();
    clock.now += EMAIL_BUDGET_DAILY_MS + 60_000;
    if (emailAttemptMayStart(decision)) send();
    expect(send).not.toHaveBeenCalled();
    clock.now = 30_999;
    if (emailAttemptMayStart(decision)) send();
    clock.now = 31_000;
    if (emailAttemptMayStart(decision)) send();
    expect(send).toHaveBeenCalledTimes(1);
  });
});
