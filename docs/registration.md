# Registration and email verification (#8)

The API mounts `register`, `verify-email` and `resend-verification` under both
`/api/auth/web` and `/api/auth/mobile`. These share one service and the request,
response and error shapes in [the shared contract](api/README.md). They never
create sessions. Login/password reset remain separate work (#9); a 404 from
the unimplemented login route is not proof of credential-checked login refusal.

## Setup

- Use a MongoDB replica set supporting transactions (including a local replica
  set for tests). Standalone MongoDB fails closed, not a non-atomic fallback.
- Run `npm run db:indexes --workspace @price-tracker/api` and
  `npm run db:verify --workspace @price-tracker/api` before accepting traffic.
  New indexes cover pre-login CSRF state, shared auth-rate buckets and the
  per-account verification-mail outbox.
  Startup also waits for additive indexes before marking persistence ready or
  accepting account operations; a failed index build keeps them unavailable.
- `WEB_ORIGINS` is an exact allowlist. The first entry is the verification-link
  origin; it must be HTTPS to send mail. Production rejects HTTP origins.
  Development HTTP cookies are limited to localhost/127.0.0.1.
- Mail uses #7's `sendWithOutcome`, `RESEND_SEND_API_KEY` and `EMAIL_FROM`.
  **Registration sends plain text**, not a published remote template. No
  `TEMPLATE_VERIFICATION_EMAIL_ID` is needed for these routes. The separate
  template helpers remain subject to published-template/rendering validation
  before activation; checked-in template HTML is not a remote-template update.
- Missing email configuration or failed/uncertain delivery keeps the account
  and token intact. The generic 202 does not promise mailbox delivery. An
  explicit resend can recover after 60 seconds; no automatic replay of an
  attempted/uncertain delivery is implemented. No live send was used
  to validate this repair. Confirm sender/free-recipient permissions separately.

## Safety and concurrency

Passwords use salted scrypt (`N=32768,r=8,p=3`, 64-byte derived key). Tokens
contain 32 random bytes and only their SHA-256 hashes are stored. Links use
`/verify-email#token=...`; GET never consumes them. Tokens expire after 24 hours.

User/token/outbox creation, resend cooldown/token/outbox rotation, and verification
token consumption/user update each commit in one transaction. A failed write
rolls back every related change. Resend invalidates the previous token. The user
write serializes resend against verification; concurrent verification accepts a
token once.

### Delivery does not delay the public response

Both eligible and ineligible requests return without invoking or waiting on an
email provider. This closes the provider/network/retry-latency eligibility
oracle; it does **not** claim to equalize database or password-hashing timings.
No artificial sleep or request-triggered fire-and-forget send is used.

The API process owns one managed polling dispatcher. It claims at most one job
per tick (one second after the previous job completes) and allows only one active
provider call per process. It never accumulates an in-memory work queue. Outbox
metadata is bounded to one fixed-size row/account, replaced by explicit resend,
with seven-day TTL cleanup; pending jobs expire after the original 24 hours even
if TTL deletion is delayed. Provider calls retain #7's bounded same-key retries
and deadlines. If a sender ignores its deadline, this worker remains occupied
instead of spawning more sends. Shutdown stops scheduling, waits for the active
job, and retains the server's existing ten-second forced-exit bound.

The request stores only a hashed random issuance-generation placeholder. On
claim the dispatcher generates the actual secret in memory and atomically marks
the job `sending` while replacing that generation's token hash. Raw secrets and
recipients are not stored in the outbox. Token expiry is not extended by queueing.
The current generation's idempotency key and confirmed provider message ID are
recorded for diagnostics; provider acceptance is not mailbox-delivery proof.
Sends occur only after claim commit, never in a retried transaction callback.

Unclaimed `pending` jobs survive restarts and may be safely dispatched. Claimed
jobs are **never reclaimed or resent**: after 60 seconds, stale `sending` becomes
`unknown`, even if the process crashed before actually calling the provider.
Thrown provider errors are also `unknown`. Unknown and failed outcomes are
terminal for that generation (including any returned Retry-After; no late retry
is scheduled). A crash or failed status write after provider acceptance therefore
cannot trigger a blind replay. Explicit resend after the cooldown creates a new
generation and is the recovery path. An older in-flight completion cannot
overwrite the new generation's outbox state. A late old email may arrive, but its
link is invalid after explicit rotation; this is not a delivery guarantee.

The initial rate policy uses shared MongoDB **fixed 15-minute buckets**, five
attempts per IP and per normalized email/token hash across both transports and
all three actions. IP exhaustion returns 429 with `Retry-After`; email bucket
exhaustion stays generic 202 for register/resend. CSRF bootstrap uses 60/min/IP.
Resend also has an atomic 60-second account cooldown, including the initial
registration send. Buckets survive API restarts and enforce time independently
of delayed TTL deletion. Leave Express proxy trust disabled unless exact trusted
proxy configuration is separately reviewed; do not trust arbitrary forwarded IPs.

Web mutations require exact Origin plus a cookie-bound CSRF token. GET
`/api/auth/web/csrf` creates a 30-minute HttpOnly pre-login cookie; repeated
bootstrap preserves its valid token across tabs. Account forms also accept an
active verified web session's stored CSRF hash. Bootstrap with an active verified
session returns a stable session-bound token without extending that session.
Login/logout issuance and revocation remain #9. Mobile rejects web
cookies; web rejects Authorization. All account responses use `no-store`.

## Tests

`npm run check` includes offline fixtures and skips DB suites unless explicitly
enabled. To exercise the real transactions against an isolated test database:

```sh
TEST_MONGODB_URI='mongodb://127.0.0.1:27050/?replicaSet=pr50' npm test --workspace @price-tracker/api
```

Each integration suite chooses a random database and removes only its own data.
Tests cover rollback after failed user/token writes, cooldown rollback,
concurrent registration/resend/verification, expiry/reuse, mail failure,
generic responses, durable limits, transport separation and both CSRF bindings.
Blocked fake-sender gates prove eligible/ineligible HTTP responses complete
without releasing the sender, not merely that their JSON bodies match. Outbox
tests cover restart recovery, interrupted sends, accepted-send status-write
failure, terminal unknown/failure, expired pending jobs, rollback and managed
single-active-send/shutdown behavior.
The repair was run against a local MongoDB 8.0.16 single-node replica set with
fake email transport. This does not establish live email or remote MongoDB proof.
