# Registration, sessions and password reset (#8, #9)

The API mounts `register`, `verify-email`, `resend-verification`, `login`, `me`,
`logout`, `forgot-password` and `reset-password` under both `/api/auth/web` and
`/api/auth/mobile`. Registration and verification never create sessions.
Account operations follow the request, response and error shapes in [the shared
contract](api/README.md).

## Setup

- Use a MongoDB replica set supporting transactions (including a local replica
  set for tests). Standalone MongoDB fails closed, not a non-atomic fallback.
- Run `npm run db:indexes --workspace @price-tracker/api` and
  `npm run db:verify --workspace @price-tracker/api` before accepting traffic.
  New indexes cover pre-login CSRF state, shared auth-rate buckets and the
  per-account account-mail outbox.
  Startup also waits for additive indexes before marking persistence ready or
  accepting account operations; a failed index build keeps them unavailable.
- `WEB_ORIGINS` is an exact allowlist. The first entry is the verification-link
  origin; it must be HTTPS to send mail. Production rejects HTTP origins.
  Development HTTP cookies are limited to localhost/127.0.0.1.
- Production requires a stable `AUTH_JWT_SECRET` of at least 32 characters.
  Generate it once with `openssl rand -base64 48`, keep it in the deployment
  secret store, and use the same value on every replica. Never generate a new
  key at startup; key changes invalidate native JWTs.
- Mail uses #7's `sendWithOutcome`, `RESEND_SEND_API_KEY` and `EMAIL_FROM`.
  **Registration sends plain text**, not a published remote template. No
  `TEMPLATE_VERIFICATION_EMAIL_ID` is needed for these routes. The separate
  template helpers remain subject to published-template/rendering validation
  before activation; checked-in template HTML is not a remote-template update.
- Password reset mail uses `TEMPLATE_PASSWORD_RESET_ID`; publish and verify the
  matching remote template before enabling delivery.
- In production, when `ACCOUNT_MAIL_ENABLED=false`, register, resend and forgot
  return a generic 503 without creating accounts or mail jobs. Existing token
  verification and password reset remain available. When mail is enabled,
  generic 202 responses do not promise provider acceptance or mailbox delivery.
  Failed/uncertain delivery keeps the account and token intact. An
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
registration, verification/resend, login and reset actions. IP exhaustion
returns 429 with `Retry-After`; email buckets for register/resend/forgot stay
generic 202. CSRF bootstrap uses 60/min/IP.
Resend also has an atomic 60-second account cooldown, including the initial
registration send. Buckets survive API restarts and enforce time independently
  of delayed TTL deletion. In production only, when `HOST` is exactly
  `127.0.0.1` or `::1`, Express trusts loopback proxies for client IPs. Keep the
  API port private and allow only trusted local processes to reach it. Apache
  must remove incoming `X-Forwarded-For`, `X-Forwarded-Host` and
  `X-Forwarded-Proto` headers before proxying, then append the actual remote IP
  with `ProxyAddHeaders On`; do not place another proxy ahead of Apache without
  separately reviewing its trusted client-IP handling. Verify the Apache header
  directives execute before `ProxyPass` forwards requests. Other bind addresses
  and nonproduction environments do not automatically trust forwarded headers.
  For the direct-client Apache vhost, with `mod_headers` and `mod_proxy` enabled:

  ```apache
  RequestHeader unset X-Forwarded-For
  RequestHeader unset X-Forwarded-Host
  RequestHeader unset X-Forwarded-Proto
  ProxyPreserveHost On
  ProxyAddHeaders On
  ProxyPass /api/ http://127.0.0.1:4000/api/
  ProxyPassReverse /api/ http://127.0.0.1:4000/api/
  ```

  Test the actual vhost configuration and client-IP behavior before relying on
  this setup; do not add a duplicate `ProxyPass` to an existing vhost.

Web mutations require exact Origin plus a cookie-bound CSRF token. GET
`/api/auth/web/csrf` creates a 30-minute HttpOnly pre-login cookie; repeated
bootstrap preserves its valid token across tabs. Account forms also accept an
active verified web session's stable CSRF binding. Bootstrap with a verified
session does not extend its expiry. Web rejects bearer headers; mobile rejects
web cookies. All account responses use `no-store`.

## Sessions and password reset (#9)

- Login checks the existing salted `scrypt$32768$8$3` hashes. Unknown and
  wrong-password accounts receive the same 401; `EMAIL_UNVERIFIED` is returned
  only after the correct password has been checked. Passwords are not trimmed.
- Web login creates a random opaque secret, stores only its SHA-256 hash, and
  returns no JWT. Production uses the host-only, HttpOnly, Secure, SameSite=Lax
  `__Host-price_tracker_session` cookie for exactly seven days. Local HTTP on
  configured loopback origins uses the corresponding `*_dev` cookie names
  without Secure. There is no sliding expiry or refresh endpoint.
- Mobile login signs a seven-day HS256 JWT with `jose`. The JWT carries a
  session ID and account session version; MongoDB stores a hash of the complete
  token. Signature, algorithm, issuer, audience, expiry, active session, current
  user and verified-email state are checked on every request.
- Both session transports persist the account `sessionVersion` and compare it
  with the current account on use; missing legacy versions mean zero. Login
  writes the account's `sessionFence` inside the issuance transaction, so a
  concurrent password reset cannot leave an old-password session active.
  Other account writers must preserve these fields and keep password changes,
  version increments and session/device revocation transactional.
- A successful web login consumes the supplied pre-login record in the issuance
  transaction. Failed login leaves it usable until expiry; concurrent use of the
  same pre-login CSRF binding can create at most one session.
- Private web mutations require the current-session CSRF binding. Registration,
  login, verification/resend and forgot/reset accept either pre-login-bound or
  current-session-bound CSRF. Shared middleware rejects bearer/cookie mixing.
- Logout revokes the current session and its device bindings. Password reset
  consumes a hashed 30-minute token once, changes the password and increments
  the account session version while revoking every session and device in one
  transaction. Reset does not log the user in.
- When account mail is enabled, forgot-password returns the same 202 message
  for eligible and ineligible accounts. Eligible requests queue
  one account-mail generation with an atomic 60-second account cooldown. A raw
  reset token is minted only when the dispatcher claims the job; the outbox
  stores only hashes and never replays an interrupted or uncertain send.
- API startup must use `startAccountMailDispatcher(verificationSender,
  passwordResetSender, connected)` so verification and reset messages share one
  serial dispatcher. `startVerificationDispatcher` alone does not send reset
  mail. Until startup is switched to the shared dispatcher, reset jobs remain
  queued. Route tests use fake senders; no real reset email is sent by tests.

The reusable API middleware is in `apps/api/src/authMiddleware.ts`:
`requireVerifiedUser(config, expectedTransport?)` sets
`res.locals.principal = { userId, sessionId, transport, role }` after checking
the current MongoDB session and verified user. `requireAdmin` follows it for
role-protected handlers.

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
Session tests also cover verified-only p=3 login, generic bad credentials,
fixed cookie/JWT expiry, current-session CSRF, mixed-transport rejection,
logout/reset revocation, device deactivation, concurrent reset consumption and
transaction rollback across token/password/session/device writes.
Blocked fake-sender gates prove eligible/ineligible HTTP responses complete
without releasing the sender, not merely that their JSON bodies match. Outbox
tests cover restart recovery, interrupted sends, accepted-send status-write
failure, terminal unknown/failure, expired pending jobs, rollback and managed
single-active-send/shutdown behavior.
The repair was run against a local MongoDB 8.0.16 single-node replica set with
fake email transport. This does not establish live email or remote MongoDB proof.
