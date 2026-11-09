# Backend runtime

This is code wiring, not approval to send or proof of a deployed MVP. All live
flags below default to `false`. Credentials alone start no checks or delivery.
The operator must separately accept the free-service limits, recipients, sender,
Firebase setup, and deployment before enabling a flag. Passing configuration
validation does not establish any of those facts.

## One process for the MVP

Use Node 24 and the repository npm lockfile. From the repository root:

```sh
npm ci
npm run build --workspace @price-tracker/api
npm run start --workspace @price-tracker/api
```

Supply environment settings through the deployment's secret store. For local
development use `npm run dev:api` with the ignored `apps/api/.env`. Never commit
credentials or device tokens. This change adds no service, paid plan, queue,
database, or dependency.

The API process runs the background loops without a browser or app being open.
It must remain running: an HTTP-only/serverless host that suspends background
timers is not sufficient. Start with one process supervised by the approved
host. Extra accidental processes still share MongoDB claims and email budgets;
that is not permission to scale the workload or increase quotas.

MongoDB must support transactions (a replica set), with the intended indexes
created successfully. Startup installs indexes before marking `/api/ready`
ready or starting workers. Connection/index/adapter construction failure leaves
readiness unavailable. Workers skip new work while disconnected. Recovery polls
resume after reconnection; already active external requests can still finish.
`/api/health` reports liveness, not mailbox/device delivery or timely scheduling.

## Flags and cadence

| Setting | What enabling it does |
| --- | --- |
| `PRICE_TRACKING_ENABLED` | Mounts real previews, private tracking/history, and admin checks. Requires stable `TRACKING_CURSOR_SECRET` (at least 32 characters). |
| `PRICE_SCHEDULER_ENABLED` | Selects the current daily UTC slot at startup, then checks the slot every minute. Creates at most one durable `scheduled_<UTC-day-number>` run per day. Requires tracking and MongoDB. |
| `PRICE_RETRY_WORKER_ENABLED` | Recovers at most one existing due pending/partial/expired-claim price run per tick, including admin runs. Never creates a new daily run. Requires tracking and MongoDB. |
| `ACCOUNT_MAIL_ENABLED` | Recovers stale account-mail claims and dispatches at most one pending verification/reset message per tick. |
| `PRICE_EMAIL_ENABLED` | Enables only the price-email channel of the durable alert worker. Requires tracking. |
| `PRICE_PUSH_ENABLED` | Enables only the price-push channel. Requires tracking, `AUTH_JWT_SECRET`, Firebase project configuration, and deployment-managed Application Default Credentials. |

Enable daily checks **and** price recovery for normal operation. The delivery
worker is separate from the daily checker: pending notifications and retries do
not wait another day. Email and push may be enabled independently. A disabled
price channel is excluded from claims, stale-claim recovery, and retry expiry;
its records remain untouched until that channel is enabled again. Enabling a
channel later does not override existing episode/eligibility/freshness rules.

`WORKER_POLL_INTERVAL_MS` defaults to 5000 (allowed 1000–300000).
`PRICE_RETRY_INTERVAL_MS` defaults to 60000 (allowed 60000–3600000).
Each loop waits for its operation to finish before scheduling another tick;
there is no in-memory work queue. Daily and price-recovery ticks do not overlap
locally. Durable leases also protect against admin/scheduler/process overlap.
Alert batches claim at most five channel deliveries; existing attempt, timeout,
lease, and backoff limits still apply. A batch checks shutdown/readiness between
deliveries, not by cancelling a transport whose outcome might already be unknown.

The daily time is UTC midnight, observed on the first available minute poll;
startup catches up only the current slot, not every missed day. A busy operation,
provider backoff, suspension, downtime, or MongoDB failure can delay it. Persisted
run status and `nextRetryAt` are monitoring evidence, not a scheduling guarantee.
One recovery tick can finish an existing bounded run of up to 100 products; it
does not mean one network request. Keep the watched catalog small.

## Email acceptance and budget

Both account and price mail use the same Resend account budget. Enabling either
requires an explicit `RESEND_SEND_API_KEY` (Sending Access only) and `EMAIL_FROM`.
Account mail additionally requires an HTTPS first `WEB_ORIGINS` entry and
`TEMPLATE_PASSWORD_RESET_ID`. Price mail requires `TEMPLATE_PRICE_ALERT_ID`.
Verification deliberately uses plain text, not a remote verification template.
Reset and price template safety/rendering must be checked against the actually
published IDs. Links come from configured origins, never request headers.

Before enabling mail, the owner must verify the existing sender domain, approved
recipients/sandbox limits, published templates, and real team-mailbox receipt.
No new domain, paid subscription, billing-enabled trial, or overages are allowed.
The tested onboarding sender does not establish general recipient support.

The durable shared default budget reserves **three attempts per invocation**,
even if the first attempt succeeds. Limits are 90 reservations per rolling day
and 2700 per rolling 31 days: at most 30 fully reserved invocations/day and 900
per rolling 31 days, often fewer useful messages after retries/reconciliation.
No reservations are refunded. A database/budget failure defers before sending;
there is no local-memory fallback. Account messages and price alerts compete
for that same allocation; the MVP does not promise account-mail priority.

This is a conservative application gate, **not an absolute provider-arrival or
account-spend guarantee**. Other scripts/apps using the account, lost budget
state, machine pauses, a transport continuing after abort, and uncertain provider
outcomes remain operational risks. Do not reset the budget or use separate
databases to evade it. Keep live mail off unless the owner can independently
establish the operational bound and shared allocation described in
`central-integration.md`. Stop/reduce scope at a free limit, not enable billing.

## Android devices and push

`/api/devices` is mounted independently of the delivery flags. Registration,
PUT rotation, and removal require a real verified mobile bearer session; web
cookies (including prelogin cookies), ambiguous cookie/bearer combinations,
expired/revoked/version-invalid sessions, and foreign ownership are rejected.
Readiness and the common error/no-store policy apply. CORS includes PUT but
does not permit browser credential use on device routes. Device registration
does not prove Firebase exists or that a phone can receive a message.

When push is off, Firebase credentials are not discovered or initialized by the
runtime. When enabled, `FIREBASE_PROJECT_ID` and deployment-managed ADC are
required; never store service-account files in Git or public web configuration.
The owner must approve the free Firebase/Android project and verify receipt on
the actual Android device/emulator. No billing-enabled functions or paid fallback
are introduced. That acceptance remains blocked until project/device access is
available; code tests use fixture transports only.

## Shutdown, recovery, and uncertainty

SIGINT/SIGTERM stops new ticks and new managed checks. Shutdown waits for current
account dispatch, delivery batch, price/admin/recovery work, database startup,
and open HTTP requests before disconnecting MongoDB. After 60 seconds the process
exits unsuccessfully rather than hanging forever. A forced exit can interrupt
work: restart recovery relies on persisted leases and must retain uncertainty.
This is not a hard real-time drain guarantee.

Never change a sent delivery back to pending. Email retries retain the saved key
and payload within the existing bounded Resend idempotency window. An uncertain
FCM recipient is not blindly resent; stale attempted account mail becomes unknown
rather than silently replaying a token. Unknown outcomes can require operator
reconciliation and may mean a notification is missed. Database records cannot
guarantee exactly-once external delivery or mailbox/device receipt.

For a stalled deployment, inspect readiness and persisted price-run timestamps,
lease expiry, `nextRetryAt`, delivery states, and fixed error codes. Do not log
connection strings, tokens, URLs containing account secrets, or raw SDK errors.
Restore connectivity/configuration and let the bounded recovery loops reclaim
eligible expired work; do not clear claims just to force a send. For rollback,
disable live flags, drain/stop the process, and deploy the known reviewed build
with the same stable session/cursor secrets and database. Do not delete budget or
delivery state. Database backup/restore, HTTPS/CORS, host supervision and stale-run
monitoring still require the infrastructure owner's approved deployment plan.

## Offline checks and remaining acceptance

Use only a disposable replica set, never real accounts or a demo database:

```sh
TEST_MONGODB_URI='mongodb://127.0.0.1:27119/?replicaSet=pt_mvp_test' EMAIL_BUDGET_TEST_DISPOSABLE=1 npm test --workspace @price-tracker/api
npm run typecheck --workspace @price-tracker/api
npm run build --workspace @price-tracker/api
npm run lint
```

Tests use random isolated databases and fake pricing/email/push transports. They
cover real device-route JWTs, ownership, reset/logout invalidation, independent
channel controls, default-off runtime construction, polling/recovery cadence,
disconnection, nonoverlap, and stop/drain. They do not prove live CheapShark
support, sender/template acceptance, Firebase/Android delivery, deployed daily
runs, remote MongoDB, HTTPS, or a $0 host. Those remain owner acceptance gates for
issues #7, #15, #17, #18 and #26; account mailbox acceptance also remains for #8/#9.
