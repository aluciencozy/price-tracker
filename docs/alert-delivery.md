# Price-alert delivery outbox

`apps/api/src/alertDeliveryWorker.ts` drains the existing per-episode, per-channel
`NotificationDelivery` records. Constructing the worker is inert; application
integration must explicitly start it after MongoDB is connected and indexes are
ready, and stop it during graceful shutdown. This change does not start a worker,
enable a scheduler, or make provider calls during startup.

## Retry and uncertainty rules

- Email and push are independent channel records. Email success never completes
  push, and push failure never resends a confirmed email.
- Email snapshots its recipient, title, observed/target cents, and CheapShark
  redirect before the first send. The stable idempotency key is
  `price-alert-<deliveryId>`. Retries reuse that snapshot and key. `firstAttemptAt`
  is persisted before the adapter call.
- `emailUncertain` is persisted independently of `status: sending` before an
  external call can begin. A crash, unknown outcome, later local configuration
  failure, definite rejection, exhausted retry budget, or deleted/disabled
  tracker cannot turn an earlier uncertain acceptance into proven non-delivery.
  Only confirmed same-key success resolves earlier acceptance uncertainty. A
  definite rejection/local pre-send failure may clear the current attempt's
  conservative in-flight marker only when there was no earlier uncertainty.
  Ineligible uncertain work
  remains `unknown` without sending; it is not relabeled cancelled/failed.
- The Resend adapter can make up to three same-key attempts in one call. The
  worker allows at most five calls for one delivery and schedules bounded
  backoff. Unknown outcomes may be reconciled only with the same key and
  snapshot, and only before the 24-hour Resend window closes (with time reserved
  for the bounded adapter call). Past that safe cutoff, an unknown delivery
  remains `unknown`; it is never treated as proof of non-delivery. Keep the
  Resend sender/template configuration stable while an email is pending
  reconciliation.
- Push payloads use the shared version-1 `PushEvent`: `eventId` is the episode,
  `deliveryId` is the durable push record, and each persisted device recipient
  retains its original session ID. Price, target, email and purchase URL are not
  sent in push data. Per-device outcomes are stored; accepted devices are not
  resent when another device needs a retry. Only explicit FCM retryable
  rejections retry (up to five tries per device). An FCM `unknown` outcome or an
  expired in-flight lease is terminal for that device because FCM has no
  idempotency guarantee. Invalid-token outcomes invoke the existing
  session/token-fenced device cleanup.
- Claims use an atomic MongoDB update and a random fencing token. Expired email
  claims become unknown and can be reconciled within the Resend window; expired
  push attempts become unknown per device. The worker rechecks the tracker,
  channel preference, verified account and (for push) active owning session and
  device immediately before provider calls. MongoDB cannot make that check
  atomic with an external provider: an already-started external send cannot be
  recalled after a concurrent disable/delete/rebind.
- Before a delivery's first external attempt, its selected observation must be
  younger than 24 hours and not future-dated. The Product must still be the
  CheapShark Steam US/USD offer with no latest error, the same last-success time,
  price and deal, and the normalized human purchase redirect. Any newer history
  observation (including a later ObjectId at the same timestamp) supersedes it.
  Proven-unsent work selects the newest recorded observation while retaining
  its episode and channel delivery ID. A stale quote, failed check, or preview
  without recorded history defers that obligation for a minute; it does not
  cancel the only alert in an open episode. A later successful qualifying
  observation can resume delivery. Deleted/disabled trackers and channels still
  cancel eligible unsent work. Email purchase snapshots allow the same
  4096-character canonical URLs as the shared contract. A possible earlier email
  acceptance is different: within the safe Resend window, reconciliation uses
  the immutable original payload/key rather than substituting a newer quote.
  A later Product failure does not itself cancel or rewrite uncertain mail.
- `sent` means provider acceptance, not inbox receipt or device display. Exactly
  once delivery is not promised.

## Wiring contract

The integration owner can wire the worker without changing `app.ts`, `server.ts`,
or starting it in tests:

```ts
const priceAlertWorker = createPriceAlertDeliveryWorker({
  pushSender: createFirebaseFcmSender(firebaseProjectId),
  batchSize: 20,       // default 20, maximum 100 channel records per batch
  pollIntervalMs: 5000, // default 5 seconds; accepted range 250 ms–5 minutes
  leaseMs: 60_000,     // default 60 seconds; accepted range 45 seconds–5 minutes
  maxAttempts: 5,      // default and maximum 5
});

// After MongoDB connection and createDatabaseIndexes() succeed:
priceAlertWorker.start();
// During graceful shutdown, before disconnecting MongoDB:
await priceAlertWorker.stop();
```

`pushSender` is required and should be the result of the existing
`createFirebaseFcmSender(projectId)`. `emailSender` is optional; the default is
the existing `sendPriceAlert`. No new environment variable is introduced by the
worker. Central configuration must provide the existing Resend values
`RESEND_SEND_API_KEY`, `EMAIL_FROM`, and `TEMPLATE_PRICE_ALERT_ID` to enable email,
and Firebase Application Default Credentials plus `FIREBASE_PROJECT_ID` to
construct the push sender. The checked-in API example already names
`FIREBASE_PROJECT_ID` and `GOOGLE_APPLICATION_CREDENTIALS`; config validation
and runtime lifecycle wiring remain the integration owner's responsibility.

The one-shot `runBatch()` method is available to controlled callers/tests; it
claims no more than the configured batch size. The durable indexes are part of
`createDatabaseIndexes()`, including the existing unique
`(trackedItemId, episodeId, channel)` key and status/availability/lease scan.

## Verification limits

Worker integration tests use fixture MongoDB records and injected email/FCM
senders; they do not send real messages. MongoDB tests require an explicit
`TEST_MONGODB_URI` and select a unique `price_tracker_test_<random>` database,
never the demo database. Actual Resend mailbox delivery and Android presentation
still require the coordinated live demo and are not established by these tests.

Review-fix validation used the dedicated test replica on port 27060, with every
suite overriding the URI database using a random test-only `dbName`:

```sh
TEST_MONGODB_URI='mongodb://127.0.0.1:27060/?replicaSet=pt_test' npm run check
```

The Mongo-backed regressions cover per-device accepted/retryable/unknown state,
overlapping claims, restart without replaying accepted devices, fenced stale
completions, uncertainty surviving later local failure/rejection/retry limits,
same-key confirmation and the safe-window cutoff, stale/superseded first sends,
and already-encoded CheapShark deal IDs. No live provider calls are involved.
