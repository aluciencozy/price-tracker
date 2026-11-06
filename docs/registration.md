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
  New indexes cover pre-login CSRF state and shared auth-rate buckets.
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
  explicit resend can recover after 60 seconds; no automatic retry job or
  late replay of uncertain delivery is implemented. No live send was used
  to validate this repair. Confirm sender/free-recipient permissions separately.

## Safety and concurrency

Passwords use salted scrypt (`N=32768,r=8,p=1`, 64-byte derived key). Tokens
contain 32 random bytes and only their SHA-256 hashes are stored. Links use
`/verify-email#token=...`; GET never consumes them. Tokens expire after 24 hours.

User creation plus token creation, resend cooldown plus token rotation, and
verification token consumption plus user update each commit in one transaction.
A failed write rolls back both sides. Resend invalidates the previous token.
The user write serializes resend against verification; concurrent verification
accepts a token once. Provider sends occur only after commit, never inside a
retryable transaction callback. A process crash after commit/before send can
leave an unsent token; explicit resend is the bounded recovery path.

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
The repair was run against a local MongoDB 8.0.16 single-node replica set with
fake email transport. This does not establish live email or remote MongoDB proof.
