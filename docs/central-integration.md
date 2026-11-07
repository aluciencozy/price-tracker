# Central integration review — November 6, 2026

This integration is not a deployed release or permission to send.
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
| Web deal-ID boundary | 4f2f56daf786fd96a653a65776a21af5a0e8fb10 | 756b2bc |
| Purchase URL contract | a9117e844b6f7c449f5ee3e6ea4698dcf0a85519 | a91f96f |

Central changes were independently approved against `831dc4a` and committed
locally as `81bb2c0`. The approved web boundary and contract follow-ups were then
applied through `a91f96f`. The follow-up test-only browser harness and
documentation were independently reviewed and exercised in local browser QA.
The separately authored
`webClientHttp.integration.test.ts` is included in the approved central commit.
The only cherry-pick conflict was
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
Production also requires a stable `AUTH_JWT_SECRET` of at least 32 characters,
shared across replicas; the cursor secret must likewise remain stable across replicas.
Keep secrets in protected environment configuration, not in Git.
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
stop the shared test server. The combined run passed lint, both typechecks,
16 contract tests, 363 API tests and 274 web tests with zero skips, plus both
builds. API coverage includes real WebClient/repository HTTP against Express,
explicit fake verification delivery, real sessions/CSRF, private tracking,
ownership and logout, composed admin 202/Location/429, shared budget contention
between account/price queues, pending reset expiry, uncertainty preservation,
per-attempt deadlines and bounded shutdown work. Fixtures never contact
CheapShark, Resend or FCM. npm reports 15 moderate dependency advisories; no
unreviewed dependency upgrade was attempted.

The approved web purchase DTO and normative OpenAPI/README amendment are now
integrated, including canonical encoding and the 256-Unicode-codepoint deal-ID
boundary. SwaggerHub publication remains pending.

## Fixture browser acceptance

Local browser QA passed the core web flow against the composed API, guarded
disposable MongoDB and captured fixture mail: registration, explicit verification,
login/session reload, preview/save/edit/delete, logout, reset and new-password
login. It also checked two-account foreign versus missing resource responses,
authenticated CSRF rejection, invalid URL and offline fail-closed behavior, back
navigation, targeted keyboard interactions and no horizontal overflow at 320,
390, 768 and 1440 pixels. The real 429 retry wait was respected. This is targeted
functional coverage, not a complete accessibility audit. Fixture prices are not
live prices, and history was empty. Local evidence (not included in Git):
`/home/alex/.cache/price-tracker-web-browser-evidence/resumed-acceptance-report.md`
and `final-gap-run-report.md` in the same directory.

Flutter/device behavior, real offers, mailbox/push receipt, remote MongoDB and
deployed scheduling remain separate acceptance gates. No full-MVP completion or
live activation is claimed.

## Review fixes for PRs #54, #57, #59 and #60

The cumulative branch fixes the shared session throttle (120 private requests
per minute), recovery of unsent episode/channel alerts across newer qualifying
observations and failed checks, the email snapshot's 4096-character URL bound,
Flutter's strict one-decode canonical purchase URL validation and 256-codepoint
deal-ID bound, and the HTTP integration test's machine-specific database guard.
CI explicitly opts into the disposable email-budget database tests.

Proven-unsent alerts retain their delivery and episode IDs when choosing a new
recorded quote. Attempted email snapshots/keys and accepted push recipients stay
fixed. A freshness change before a provider call restores only that proven-unsent
attempt and schedules a retry. Tests cover concurrent claims, failed-check
recovery, checker-to-outbox handoff, partial-device recovery and long URLs.

Validation uses the existing commands and pinned Flutter 3.47.7 / Dart 3.13.5.
With a disposable MongoDB replica set and a CI-style `directConnection=true`
URI, `npm run check` passes 16 contract, 371 API and 274 web tests with zero
skips, lint, typechecks and builds. Flutter analysis, all 188 mobile tests and
the full formatting check pass. Tests use fixtures; no live provider or delivery
claim is added.

The integration branch records the original #53–#59 heads as merged ancestry
after comparing their changes with the included cherry-picked snapshots. This
preserves the composed implementation and review fixes while avoiding duplicate
merge conflicts in model registration and worker composition. Merge #60 as the
cumulative integration path; independently merging source branches into each
other can still conflict. This changes no protected branch.

The original PR branches now carry their own independently tested fixes:

| PR | Fix commit | Independent Node checks |
| --- | --- | --- |
| #54 | `3fbcc86` | 15 contract, 246 API and 241 web tests; lint, types and builds |
| #57 | `69d9931` | 15 contract, 254 API and 241 web tests; lint, types and builds |
| #59 | `4373d29` | 16 contract, 242 API and 241 web tests; lint, types and builds |

PR #59 also passes all 188 Flutter tests, analysis and formatting. PR #60 merges
these exact updated source heads. The tracking router and central authentication
use the same session-limit helper, so one request consumes one durable attempt.
Both injectable-router and real composed-session regressions cover this rule.
Scoped code approval does not close the live-provider, retention, delivery or
deployment acceptance gates recorded above.
