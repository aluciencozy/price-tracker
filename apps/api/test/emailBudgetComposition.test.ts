import { performance } from 'node:perf_hooks';
import { describe, expect, it, vi } from 'vitest';
import { EmailSendDeferred, sendWithOutcome, type EmailSender } from '../src/emails.js';
import type { EmailBudgetDecision } from '../src/emailBudget.js';

const payload = { from: 'fixture@example.invalid', to: 'recipient@example.invalid', subject: 'Fixture', text: 'Offline only' };
describe('budgeted email transport boundary', () => {
  it('makes no transport request on deferral or an expired initial grant', async () => {
    const send = vi.fn<EmailSender>();
    await expect(sendWithOutcome(payload, 'key', send, async () => ({ status: 'deferred', reason: 'exhausted', retryAfterMs: 1234 })))
      .rejects.toBeInstanceOf(EmailSendDeferred);
    await expect(sendWithOutcome(payload, 'key', send, async () => ({ status: 'allowed', deadlineMonotonicMs: 0 })))
      .rejects.toBeInstanceOf(EmailSendDeferred);
    expect(send).not.toHaveBeenCalled();
  });
  it('rechecks the original deadline after a request and never calls expiry unsent', async () => {
    const decision: EmailBudgetDecision = { status: 'allowed', deadlineMonotonicMs: performance.now() + 30_000 };
    const send = vi.fn<EmailSender>(async () => { decision.deadlineMonotonicMs = 0; throw new Error('uncertain'); });
    const outcome = await sendWithOutcome(payload, 'key', send, async () => decision);
    expect(outcome).toMatchObject({ status: 'unknown', attempts: 1, code: 'email_budget_deadline_expired' });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('reserves once per invocation even for the same key, with at most three actual attempts', async () => {
    const reserve = vi.fn(async (): Promise<EmailBudgetDecision> => ({ status: 'allowed', deadlineMonotonicMs: performance.now() + 30_000 }));
    const send = vi.fn<EmailSender>(async () => { throw new Error('uncertain'); });
    for (let i = 0; i < 2; i++) expect(await sendWithOutcome(payload, 'same-key', send, reserve)).toMatchObject({ status: 'unknown', attempts: 3 });
    expect(reserve).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(6);
    expect(send.mock.calls.every(([, options]) => options.idempotencyKey === 'same-key' && options.signal instanceof AbortSignal)).toBe(true);
  });
});
