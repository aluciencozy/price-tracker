# Central integration review — November 6, 2026

This is local integration work, not a deployed release or permission to send.
The branch is `feature/web-flow-integration` in the durable
`/home/alex/.cache/price-tracker-web-flow-integration` worktree. No feature PR was
merged. The reviewed inputs below were cherry-picked from immutable snapshots.

| Input | Original reviewed commit | Local commit |
| --- | --- | --- |
| Staging base | c6d3735c7566f64feeb7ebf62c9ca7433fa22d5e | same |
| Web save retry | 0b0df96cc14fa69d69f8207e7de2c330e20433ef | bd44ccb |
| Tracking API | ab6c0c9914a48c1b6956280f23a4acdd2719fce5 | 611ea65 |
| Authentication | bcc855135ec576fe84c97d292f6515d16ed2caae | 15ab6e9 |
| Shared budget | 6cb592d8d68e810788c9b17895f2dec9430a9fec | d837987 |
| Alert delivery | eabeacf1715fe760e5fbde987a62f33ef13eb4c5 | d9d5ef4 |
| Web purchase DTO | f12e92744714604d399d5e44d65a8f5664f8d759 | 573f5b8 |
| Checks and preview resolver | 7608566371716f02e93da9f099ccb8f005c74e29 | 831dc4a |

Local HEAD before central review is `831dc4a`. Central changes are uncommitted;
review `git diff` plus untracked source/test files, including the separately
authored `webClientHttp.integration.test.ts`. The only cherry-pick conflict was
additive model registration: both tracking models and both check models remain.

## Composition and activation

`createApp` accepts an optional tracking object containing an explicit resolver
and stable cursor secret. There is no fixture or successful resolver default.
It composes the actual verified-session middleware, preview/CRUD/owned-history
router and administrator checks, scoped so router-wide authentication cannot
intercept unrelated health/account paths. Private routes gate database/index
readiness. API parser failures use the common error envelope and no-store;
non-API legacy errors and health responses are preserved. CORS enables required
web methods and headers, rejects unapproved actual/preflight origins, and omits
credential permission for native account/device paths.

Server defaults are `PRICE_TRACKING_ENABLED=false` and
`PRICE_SCHEDULER_ENABLED=false`. Enabling tracking requires a stable
`TRACKING_CURSOR_SECRET` of at least 32 characters; scheduling requires tracking.
These proposed central configuration additions need review with the auth owner.
The real reviewed preview resolver is supplied only on explicit tracking opt-in.
Mongo selection/connect/socket limits are 1000ms, pool wait 500ms, buffering off.
Index failure never falls back to memory. These bounds do not promise hard
real-time behavior during event-loop stalls or server interrupt delays.

The scheduler is created only after connection/index readiness. Its daily tick
resumes due runs before the current UTC slot; nextRetryAt is not an independent
wakeup guarantee. Managed admin work is drained during shutdown; the scheduler
stops before Mongo disconnect. No operational schedule or host is selected here.

**Account-mail and price email/push loops remain disabled in server startup.**
The old unrestricted verification dispatcher was removed. Tests explicitly call
the reviewed dispatchers/workers with fake transports. Real activation still
requires sender-domain/recipient approval, Resend account allocation, Firebase
setup, source-retention approval, deployment and a separate acceptance action.

## Shared email budget composition

Every real `sendWithOutcome` invocation reserves three attempts from the same
durable budget, including same-key reconciliation. The existing three-attempt
loop checks the original monotonic deadline before every actual transport call,
including after retry waits. It does not acquire a replacement grant inside a
retry loop. Injected fake transports can supply a fake or actual budget; existing
SDK response-shape tests explicitly mock the budget and HTTP, not production.

`EmailSendDeferred` is a typed exception meaning this invocation made **zero**
provider requests. Account dispatch atomically restores only its still-current
generation's hashed issuance placeholder and pending state, with future
availableAt. Expiry is never extended; newer resends cannot be overwritten.
Price dispatch restores only its fenced claim's original attempts, first-attempt
time, snapshot, key and uncertainty, then schedules availability. Previously
unknown sends remain unknown. Deadline expiry after a request returns unknown,
never deferred/unsent. Reservations are never refunded.

This tests observable application deadlines, not an absolute provider cap.
Process pauses after the last check, host suspend clocks, external account usage,
lost budget state and a transport continuing after abort can defeat the required
provider-arrival bound. The 60-second reservation padding does not solve those
operational conditions. Keep live mail OFF unless the complete bound and shared
allocation can be established; do not promise unrestricted or exactly-once mail.

## Reproduce the offline checks

```sh
TEST_MONGODB_URI='mongodb://127.0.0.1:27060/?replicaSet=pt_test' EMAIL_BUDGET_TEST_DISPOSABLE=1 npm run check
```

Tests use fresh random test databases and drop only their own databases. Do not
stop the shared test server. The final measured run passed lint, both typechecks,
15 contract tests, 348 API tests and 270 web tests with zero skips, plus both
builds. API coverage includes real WebClient/repository HTTP against Express,
explicit fake verification delivery, real sessions/CSRF, private tracking,
ownership and logout, composed admin 202/Location/429, shared budget contention
between account/price queues, pending reset expiry, uncertainty preservation,
per-attempt deadlines and bounded shutdown work. Fixtures never contact
CheapShark, Resend or FCM. npm reports 15 moderate dependency advisories; no
unreviewed dependency upgrade was attempted.

The web purchase DTO now matches the backend's actual canonical builder, but the
separately owned normative OpenAPI/README amendment is pending an approved
immutable snapshot. Do not edit those files concurrently or call the contract
alignment finished. Browser behavior, Flutter/device behavior, real offers,
mailbox/push receipt, remote MongoDB and deployed scheduling remain separate
acceptance gates. This report is not full-MVP completion or independent approval
of the central diff.
