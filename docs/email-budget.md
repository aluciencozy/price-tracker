# Shared Resend budget: integration handoff

Issue [#7](https://github.com/aluciencozy/price-tracker/issues/7). This is an **unwired primitive**, not permission to send. Keep real email and its workers disabled by default until the integration, operator controls, and independent review are complete. No live acceptance or mailbox delivery is established by these tests.

## Interface and guarantees

`reserveEmailSend(limits?: EmailBudgetLimits): Promise<EmailBudgetDecision>` in `apps/api/src/emailBudget.ts` returns either `{ status: 'allowed', deadlineMonotonicMs }` or `{ status: 'deferred', reason, retryAfterMs }`. Reasons are `exhausted`, `unavailable`, `invalid_config`, and `config_mismatch`. `retryAfterMs` for exhaustion is the earliest time the snapshot has room for three attempts, measured from MongoDB's decision time (waiting that entire interval after receipt is conservative); competition may consume the released capacity first. For other reasons it is a 60-second minimum operational backoff, not a prediction of recovery. Alert an operator on repeated failures, rather than polling in a tight loop.

All account verification, reset, and price-alert calls use the same Mongo database and fixed `resend-account` singleton. One atomic, majority-acknowledged MongoDB update reserves **three outbound attempts per invocation**, matching `emails.ts`'s `MAX_SEND_ATTEMPTS = 3`. Every invocation, including one with the same Resend idempotency key, must reserve again. Never persist, replay, share, or reuse an allowed decision. A lost acknowledgement, crash, or early success wastes capacity; never refund it. An uncertain database write fails closed. The bounded array stores no recipient, token, delivery key, or message content; do not delete/reset it while reservations may still be in the rolling windows. Protect collection write access and backups as production state.

Defaults are 90 attempts per rolling 24 hours and 2700 per rolling 31 days; accepted integer allocations are 3–100 and 3–3000 respectively. These are conservative attempt allocations, not claims about Resend's reset schedule. A single invocation consumes three even when it sends fewer. Limits are pinned in the singleton: a process with different limits defers. To change an allocation, stop all senders and use a reviewed migration that preserves every reservation; do not remove the record. All deployments using this Resend account must share this database and configuration. Separate databases or direct/manual provider sends bypass the guard. Exclusivity or an explicitly approved allocation plus operational headroom is required; monitor account usage and keep billing/overages disabled. This primitive cannot account for external usage or promise the provider will accept a send.

MongoDB server time controls windows. Maintain a correctly synchronized MongoDB primary clock, majority writes and durable backups; clock jumps, lost state, writes bypassing this service, or restoring an old backup can defeat the limit. After lost/uncertain state, keep sending disabled for 31 days after the last possible external or app send, or obtain an independently verified safe operator procedure. Do not use TTL on this singleton.

Reservations are timestamped 60 seconds into the future. The absolute `deadlineMonotonicMs` is based on `performance.now()` **before** the database call plus 30 seconds, never on when the caller receives the result. It is meaningful only in the reserving process and must not be persisted or transferred. `emailAttemptMayStart(decision)` checks that deadline against the same monotonic clock. A pause of 24 hours plus padding between reservation and handoff therefore expires the grant; it must not create a fresh timer. Never reset the deadline for a retry.

Integration must check the helper immediately before **each** provider attempt, including retries after waits, and must bound the complete network attempt so no request reaches Resend more than 60 seconds after the MongoDB decision. A one-time check before `sendWithOutcome` is insufficient. The existing adapter does not enforce this and must be changed by its owner. For example, the intended structure is:

```ts
const decision = await reserveEmailSend(limits); // immediately before this invocation
if (decision.status === 'deferred') return deferWithoutSending(decision);
for (let attempt = 0; attempt < 3; attempt++) {
  if (!emailAttemptMayStart(decision)) return stopWithoutAnotherRequest();
  const outcome = await boundedProviderAttempt(); // no hidden retries; bounded abort
  if (!shouldRetry(outcome)) return outcome;
  await boundedRetryWait(); // recheck the same deadline on the next iteration
}
```

This is integration pseudocode, not an implemented transport. If expiry occurs before the first request, preserve the eligible pending job. If any request was already made, preserve its actual/possibly unknown outcome and provider idempotency rules; expiry cannot make that outcome unsent. Never refund the reservation. The helper alone cannot prevent a process pause *after* its check or a transport continuing after abort. The monotonic clock must also advance through any host suspend; some platforms do not guarantee this. The integration and deployment must prove the complete 60-second bound despite scheduling pauses, suspend, queueing, timeouts, and transport behavior, or keep real email disabled. No such guarantee is established here.

## Required owner integration (not implemented here)

1. Add an explicitly disabled-by-default real-email configuration and wire **both** paths through a shared pre-send hook immediately before `sendWithOutcome` makes its first provider request. Keep its maximum at three; if it changes, update the reservation and tests before deployment. Validation before the hook is fine, but nothing may contact Resend before an allowed reservation. Explicit operational test scripts and every other sender must also be disabled or budgeted; do not automatically query or send to Resend.
2. A deferred reservation means **no provider request was made**. Extend the internal delivery union/dispatcher handling explicitly; never map it to sent, unknown, permanent failure, or a consumed provider attempt. Use `retryAfterMs` in durable scheduling, with a sensible minimum/backoff. On budget/database failure leave eligible jobs pending and alert operators. Do not immediately reclaim them in a polling loop.
3. The account dispatcher currently claims `sending` and rotates the token before calling its sender, then maps non-success to failed. Arrange the reservation before that transition, or atomically restore a genuinely unsent claim to eligible pending without invalidating or extending token expiry. Recheck user/token eligibility and expiration on reschedule; expired tokens must expire normally, not generate stale mail. Avoid losing or revealing plaintext tokens. Handle crashes around any claim/reservation deliberately; reserved capacity can be wasted.
4. The price worker currently records `firstAttemptAt` and increments attempts before its sender. Place the hook before these marks, or explicitly undo only a proven unsent transition under its lease. Preserve a previously unknown outcome as unknown (never downgrade existing uncertainty), its idempotency cutoff, snapshot, and key. A fresh unsent deferred job remains eligible pending, with a future `availableAt`; never create a false provider attempt or success. Recheck ownership, eligibility, and lease after waiting.
5. Add integration tests covering both real dispatch paths, same-key retries, process overlap, crash recovery, expiry, configuration gating, no provider call on defer, and monotonic deadlines/aborts. Run them against a disposable replica-set database. Review rollout and sender-domain restrictions separately; no live acceptance is claimed.

## Checks

Run `npm run typecheck --workspace @price-tracker/api` from the root and `npx vitest run test/emailBudget.test.ts test/emailBudget.integration.test.ts` from `apps/api`. The database tests require both `EMAIL_BUDGET_TEST_DISPOSABLE=1` and an explicit `TEST_MONGODB_URI`, create a unique `price_tracker_test_email_*` database, and drop only that exact database. Check MongoDB availability and permissions first; never point a test at a shared demo database. Tests use no provider network.
