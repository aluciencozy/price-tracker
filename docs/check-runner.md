# Bounded price checks (#12, #14, #15)

## Current API integration

- `runPriceChecks({runId, mode, maxProducts?})` in `src/priceChecks.ts` runs/resumes
  one durable run. Modes are `scheduled`, `admin`, explicit `cli`, and internal-only
  `user`; the user mode is never exposed as an admin `PriceCheck` trigger.
- `getPriceCheckRun(runId)` returns internal operational details. Do not serialize
  this object to clients. `publicPriceCheck` maps it to the existing strict OpenAPI
  aggregate DTO, without individual checks, users, leases or provider payloads.
- `server.ts` mounts tracking and the admin price-check routes only when
  `PRICE_TRACKING_ENABLED=true`. `createAdminPriceCheckRouter` receives
  `requireVerifiedUser(config)`, which enforces verified/revocable sessions, transport
  ambiguity, Origin and mutation CSRF before setting
  `res.locals.principal={userId,sessionId,transport,role}`. The router additionally
  requires the server-derived admin role. Do not add an admin bootstrap.
- `resolveApprovedProductPreview` from `src/productPreviewResolver.ts` implements
  the tracking owner's `(approvedProductId, signal) => Promise<ProductRecord &
  {_id: Types.ObjectId}>`. Pass it to
  `createProductPreviewService({resolveProduct: resolveApprovedProductPreview})`.
  Mount history only through the tracking router, not again separately.
- Price-check models are included in additive startup index creation. Keep them
  registered alongside other model indexes.

## Admin contract and coordination

POST accepts only JSON `{}` and returns **202**, `Location` pointing to the run,
and the exact OpenAPI `PriceCheck`, not a `{data:...}` wrapper. GET returns the same
aggregate DTO; active polls include `Retry-After: 5`. Only verified administrators
can inspect any run, including scheduled runs. These are shared operational
resources, not owned trackers; ordinary users receive no run information.

MongoDB fixed-window counters enforce one enqueue/minute/admin and twelve
polls/minute/admin across processes/restarts. Expiry is checked by the window key,
not asynchronous TTL deletion. The shared active-run coordination row coalesces
scheduled/manual overlap. Its claim and initial queued run row publish in one
transaction, so an overlapping enqueue can return the same durable queue identity.
An unavailable database returns 503/Retry-After, never fabricated queue acceptance.

## Owned per-game refresh (#69)

The tracking router accepts `POST /api/tracked-items/:id/refresh` (`{}` only) and
`GET /api/tracked-item-refreshes/:requestId`. The first operation authorizes the
verified owner before creating work; status reads require both the persisted
request owner and continued ownership of its tracker. Foreign, missing, and
deleted trackers/requests all return the same 404. These routes map internal run
rows to the strict `RefreshRequest` DTO; never serialize `getPriceCheckRun()` or
`publicPriceCheck()` as a user response. The DTO has no global run state, other
Product selections, leases, or watcher data.

An owner request is durably seeded with exactly one Product-check child row from
the owned tracker, rather than accepting a general `productIds` selector or using
the global catalog cursor. It still runs through the shared Product refresh lease,
provider-wide cache/budget/backoff, `recordObservation`, and
`evaluateTrackerObservation` for enabled watchers. A cache result is `cached` only
when backed by a real history row; preview-only cache causes a genuine bounded
lookup before success and never becomes history by relabeling. A target edit does
not fetch, observe, or alert by itself; the next successful check may evaluate the
existing real observation for the changed target without appending history.

`TrackedItem` stores the active private refresh ID and 60-second cooldown deadline.
Concurrent POSTs while active coalesce to that owner's request; after completion,
a second POST during cooldown gets 429/`Retry-After`. The cooldown begins at
completion, so time waiting behind the batch lock cannot consume it. A rate-limited
provider/shared budget result is `deferred`, retains its actual retry time, and
keeps the request resumable; status has `finishedAt: null` while deferred. The
existing due-run recovery resumes the same user run/check ID after contention or
restart. Enable `PRICE_RETRY_WORKER_ENABLED=true` where this restart recovery is
required. If the existing global active-run lock is held, a user request must
return its own queued status—not the unrelated admin/scheduled run. Existing admin
and scheduled coalescing and the hourly timer remain unchanged.

`PriceCheck` rows contain one run and one stable run/Product check identity.
Run/item leases and Product refresh leases fence completion. A scheduled/admin run
processes at most 100 catalog Product candidates sequentially and checks enabled
watchers before requesting a price. A user run instead checks its one explicitly
owned Product, even if that tracker is paused, then evaluates only enabled
watchers. Selection uses an indexed ObjectId continuation stored in
`CheckControl`, not an unbounded distinct/group scan. Later new runs continue past
the last selected candidate and wrap at the end, so Products after 100 are not
starved. Selection rows and cursor commit in one transaction fenced by global/run
tokens; a crash rolls both back. Retries do not append another page. `truncated`
is internal operational information, not a public DTO
field. Validated products can be added by on-demand preview; the two-game sample and
dated source proof are not a fixed API catalog. The 100-product run bound limits
each batch, not the Steam app IDs users may submit, and discovery does not promise
availability for every Steam app.

The existing provider-wide request budget/cache/backoff applies everywhere.
Failures preserve the last successful quote and do not create history or rearm an
episode. 429/Retry-After is not shortened. Each product failure allows later
products to progress. Successful durable checks call authoritative
`recordObservation(productId, stableCheckId, leaseToken, offer)` instead of the old
Product-only success write, then replay `evaluateTrackerObservation` per enabled
watcher by persisted observation ID. No email/push is sent here.

Preview deliberately writes only the shared quote cache, never history or alerts.
Recorded successes follow the existing 24-hour reuse window.
If a durable check encounters a fresh preview-only cache with no matching history,
it makes a new bounded genuine provider lookup under the normal shared budget and
records that actual success/time. It does not relabel a preview as a new fetch or
fabricate an observation. Later runs reuse a fresh recorded success. Replay after
history commits but evaluation fails reuses that same row, without fetching again.

## Cancellation and database connection requirements

`lookupSteamOffer(url, {signal?,timeoutMs?})` keeps the existing 30-second default;
preview uses a smaller total bound. One absolute lookup deadline covers both
fixed requests and budget waits. Abort cancels the per-request DNS `Resolver`
(A/AAAA), destroys the HTTP request/response, cancels timer-based budget sleeps,
and prevents the second request. It is not a promise race leaving network work
running. The provider budget remains claimed until the request settles.

The preview resolver starts its timer before the first database read and passes
the combined AbortSignal, driver `timeoutMS`, and server `maxTimeMS` through
catalog/budget operations. Product/provider models disable Mongoose buffering.
Normal work is cancelled at 8.5 seconds, reserving 1.5 seconds inside the public
ten-second bound for bounded cooldown persistence and fenced lease cleanup.
Cleanup operations have 250ms (provider) or 500ms (Product) driver/server limits;
normal preview database commands also have a 500ms server execution limit.
No provider request begins after cancellation.
If cleanup cannot reach MongoDB, existing finite leases expire; do not clear a
new owner's token or start a replacement request outside the budget.

The integration owner must connect before exposing preview and bound connection
selection/pool waits: `serverSelectionTimeoutMS <= 1000`,
`waitQueueTimeoutMS <= 500`, `connectTimeoutMS <= 1000`, and `bufferCommands:false`.
MongoDB must support transactions for history/episodes. These are connection
requirements, not silently applied edits to the auth owner's config/server.
Abort terminates driver/socket work but cannot roll back an already accepted
server-side write, nor instantly interrupt MongoDB code between its interrupt
points. `maxTimeMS` is enforced at those server interrupt points, not a hard
real-time CPU kill. Lease fencing and unchanged source times handle write
uncertainty. No client/provider work is intentionally left racing in the background.
Event-loop stalls cannot have a hard real-time guarantee.
The tracking service's own timeout is a final HTTP boundary, not a substitute for
using this resolver.

## Scheduler / explicit executable

After MongoDB connects and startup indexes finish, `server.ts` starts
`startBackgroundWorkers`. The price schedule runs in the API process and requires
both `PRICE_TRACKING_ENABLED=true` and `PRICE_SCHEDULER_ENABLED=true`; the host
must keep that process alive. The worker checks the current UTC-day slot at
startup and then polls once per minute. It uses the durable run ID
`scheduled_<UTC-day-number>` so the same day does not create duplicate runs. This
is a UTC calendar-day schedule, not a 24-hour delay after startup.

Due or interrupted work is handled by a separate recovery loop when
`PRICE_RETRY_WORKER_ENABLED=true`. It checks for resumable work every minute by
default, including admin runs. A restart can resume the same durable run; downtime
does not create a separate run for every missed UTC day. Stop the workers before
disconnecting MongoDB. Worker errors use fixed codes and do not include provider
or database details; successful run summaries are persisted, not written to the
service journal. Monitor the API service and inspect
`GET /api/admin/price-checks/{id}` as a verified administrator. A `partial` run
has failed work or retryable items; keep the same run identity when resuming.

On the documented VM, configure the existing root-managed API environment file
with `PRICE_TRACKING_ENABLED=true`, `PRICE_SCHEDULER_ENABLED=true`,
`PRICE_RETRY_WORKER_ENABLED=true`, and the already-required stable
`TRACKING_CURSOR_SECRET`. Preserve the existing Atlas URI and authentication
secrets. Never copy values into this repository or enable the switches on a host
that is not approved to make live provider requests.
After updating settings, rebuild/redeploy the API, restart its systemd service,
and verify `/api/ready`, the scheduler startup conditions, and the persisted run
through the admin status route. Do not infer a successful scheduled run from
health/readiness or service logs alone.

The deployed VM notes currently identify release `b668d1e`; that commit's
`server.ts` does not contain the current background-worker wiring. A redeploy of
a commit with the current `server.ts` and approved environment settings is
required before Issue #15 can claim deployed scheduler evidence. Host uptime and
cost approval remain infrastructure acceptance items.

```sh
npm run check:prices --workspace @price-tracker/api -- --run-id demo-check-20261106 --mode cli --max-products 20
```

This is an explicit real-provider command: do not use in routine tests. It requires
an application `MONGODB_URI`, builds additive indexes and prints internal sanitized
progress. Retry with the same run ID; never change it just to evade a cooldown.
It refuses the protected local demo database. Monitor partial runs, nextRetryAt,
expired running leases and truncated batches; resume the same ID for recovery.

## Offline verification

Use `TEST_MONGODB_URI=mongodb://127.0.0.1:27060/?replicaSet=pt_test` for the provided
test-only replica set. Tests select/drop only random `price_tracker_test_*`
databases. They never use the demo database or contact CheapShark/email/push.

```sh
TEST_MONGODB_URI='mongodb://127.0.0.1:27060/?replicaSet=pt_test' npm run check
```

Tests cover exact DTO schema validation, 202/Location, admin denial, durable
counter contention from independent Node processes, >100-product continuation,
transactional selection rollback, preview-only cache handoff,
two-user shared fetch, overlap/replay, post-history evaluation recovery, valid
zero, failure/rearm, partial progression and cancellation of DNS/HTTP/budget work.
A real MongoDB stalled-read test verifies driver cancellation before provider work;
a resolver deadline test verifies self-abort and no later provider/budget requests.
These tests do not establish production hosting or live provider support.

November 6 verification in this worktree: the full command above passed lint,
both TypeScript checks, **15 contract + 256 API + 241 web tests, zero skips**, and
both production builds. The API tests include 13 price-check database cases.
The shared test server was not stopped; only each suite's unique database was
dropped. No live provider or delivery was contacted. No commit/push/PR was made.
