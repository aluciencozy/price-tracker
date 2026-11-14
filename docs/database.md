# MongoDB schema contract

Issue [#1](https://github.com/aluciencozy/price-tracker/issues/1). Review this with
James and Nick before closing the issue. This adds Mongoose models and additive
index creation to the existing `Staging` adapter; it does not implement account,
history, device, scheduler, or delivery endpoints. See the [ER diagram](diagrams/database.svg)
and its [editable source](diagrams/database.mmd). The [OpenAPI contract](api/README.md)
continues to define public responses. Never serialize a database document directly.

## Collections and ownership

Mongoose uses ObjectId primary keys and lower-case plural collection names.
Expose `_id.toString()` as the API's opaque `id` through explicit response mappers.
No client-supplied user ID, role, session, episode, or price history is authoritative.

| Model / collection | Stored fields and relationships |
| --- | --- |
| User / users | Normalized unique email, password hash, nullable name/verification date, role, timestamps. Only the auth service writes verification/role/hash. |
| Session / sessions | User, transport (`web`/`mobile`), nullable web-secret/CSRF hashes, fixed expiry, revocation date. Mobile JWT `sid` resolves to this row; informational session ID is never a credential. |
| AuthToken / authtokens | User, purpose, SHA-256 token hash, expiry and consumed date. One slot per user/purpose; reissue replaces it. Generate at least 256 random bits in the auth service. |
| Product / products | Existing shared adapter record: CheapShark game ID, distinct Steam app ID, store/market/currency, title/canonical URL, price/deal fields, success/attempt/change dates, retry metadata and refresh lease. No user target/preferences. |
| TrackedItem / trackeditems | User + Product, integer target cents, USD, enabled, channel flags, target revision, episode sequence/ID/open state, last evaluated observation/time. The owned refresh flow also stores its active private request ID and 60-second cooldown deadline here; this is the per-user/per-Product durable gate. This is the private watchlist. |
| PriceHistory / pricehistories | Immutable Product + check ID, successful price in cents, USD, local observation date, nullable provider change date, CheapShark attribution and observed deal ID. No user settings or raw provider payload. |
| NotificationDelivery / notificationdeliveries | Tracker/user/product/observation, stable episode ID and channel, status, attempts, availability, claim token/lease, sanitized error code and optional provider message ID. Independent email and push rows. |
| Device / devices | User + active Session, installation UUID, Android platform, private push token, active flag and timestamps. One binding per token and installation. |
| ProviderBudget / providerbudgets | Existing singleton CheapShark pacing/cooldown/lease state; shared by preview, scheduled, admin, and owned user checks. |
| PriceCheck / pricechecks | Durable run and Product-check rows, stable run/Product check IDs, status, retry time and leases. Internal `user` mode stores the request owner and tracker; each such run has one Product-check row seeded from that owned tracker. User status is mapped to `RefreshRequest`, never serialized as an admin `PriceCheck`. |
| CheckControl / checkcontrols | Existing active global run/cursor and durable operational counters. User refreshes share the run lock and provider budget; they must not receive another run's status when the lock is held. |

Device installation IDs use the shared `installationIdSchema` UUID validator,
including modern UUID versions such as v7. Store and compare lowercase UUIDs so
letter case cannot create a different installation binding. Request handlers must
use that same parser before lookups and equality checks.

`select:false` omits password/token/claim secrets in ordinary queries; it does not
redact newly created documents, explicit projections, raw driver queries or logs.
Services must map public fields and sanitize logs. A Mongoose `ref` is not a foreign
key or authorization check. Enforce existence/ownership in the service transaction.

## Identity and money

An offer is uniquely `(provider, providerGameId, storeId, market, currency)`.
The initial values are `cheapshark`, the exact game ID, `1`, `US`, `USD`.
Nick's second unique Product index also prevents two provider mappings for the same
Steam app/store/market. A changed deal ID updates purchase metadata, never identity.
The canonical URL is `https://store.steampowered.com/app/<steamAppId>/`; construct
the human purchase URL from the validated deal ID, never accept it from a client.
Keep CheapShark attribution in public product/history/alert responses.

Prices and targets use nonnegative safe integer cents, including zero. A missing
Product price remains null. A failed/missing/wrong-currency response never creates a
history row or changes the previous valid price to zero. Provider-change time is
not local fetch time. Product freshness is computed from the last successful
observation and latest failed attempt; timestamps do not imply a new sale.

Only the measured Portal 2 (`620` -> `36`) and Half-Life 2 (`220` -> `59`) mappings
start enabled. Their October 26 quotes are dated evidence, not seed prices.
Do not infer base-game type from an arbitrary Steam URL: reject unvalidated games,
DLC, bundles, subscriptions, unknown editions and ambiguous matches. Additional
stores remain disabled until separately proven. See [the source review](retailer-research.md).

## Indexes and expiry

| Collection | Unique constraint / supporting index |
| --- | --- |
| users | Unique normalized `email`. |
| sessions | Unique non-null web `secretHash`; user/revocation lookup; expiry TTL. |
| authtokens | Unique `(userId,purpose)` and `tokenHash`; expiry TTL. |
| products | Unique offer identity and unique Steam app mapping, preserved from adapter. |
| trackeditems | Unique `(userId,productId)`; product/enabled fan-out; user/creation/id pagination. |
| pricehistories | Unique `(productId,checkId)`; product/observation/id ascending history; 90-day TTL. |
| notificationdeliveries | Unique `(trackedItemId,episodeId,channel)`; status/availability/lease lookup. |
| devices | Unique installation and push token; user/session/active lookup. |
| pricechecks | Unique run ID; unique `(runId,productId)` for Product rows; status/retry/lease lookup. Owner status reads also require the linked tracker to remain owned. |

`createDatabaseIndexes()` builds indexes additively and can be repeated. It never
drops/replaces an existing index. Run before accepting traffic; duplicate legacy
records or incompatible index options require explicit migration rather than an
automatic destructive repair. `unique` is a database constraint, not a validator.
Catch error 11000 and return the agreed conflict only after checking ownership.

TTL deletion is asynchronous. Services must always check expiry/consumption/revocation
in the same atomic operation that authorizes use; a present expired row is invalid.
Verification lasts 24 hours, reset 30 minutes and sessions seven days per the API
contract. The schema stores absolute expiry; auth services enforce these lifetimes.

History retention is a rolling **90-day application cap**, matching the proposed
API contract, and only stores minimal local successful observations. This is not a
claim that CheapShark granted a retention license. The existing source review has
no explicit retention duration; Nick/team must confirm this policy before live
history collection. Do not archive/bulk export their catalog or full payloads.
API history must filter `observedAt >= now - 90 days` even before TTL removes rows;
return that boundary as `retainedFrom`. Requested ranges are `[from,to)`, default
30 days and max 90; pagination sorts `(observedAt,_id)` ascending.

## Durable writes required from services

Use MongoDB replica-set transactions for operations crossing documents. The
infrastructure choice must support them; a MongoDB-compatible API is insufficient
without checking transactions, unique indexes and TTL behavior. Production startup
must not silently fall back to an in-memory database.

1. **Auth:** consume `{tokenHash,purpose,consumedAt:null,expiresAt:{$gt:now}}`
   atomically. Verification updates the user in the same transaction. Reset updates
   the password, consumes the token and revokes all sessions/device bindings together.
   Check account verification and active session on every authenticated request.
2. **History:** insert one validated observation per Product/check ID. Replay of a
   check with conflicting data is an integrity error; never overwrite history.
   Stable IDs survive worker retry/restart. A new successful check may record the
   same price. Product success metadata and history must commit together.
3. **Owned refresh:** in one transaction, verify `(trackedItemId,userId)`, claim or
   coalesce the tracker's active request, persist the user run plus exactly one
   Product child row, and preserve its cooldown/status across restarts. Never accept
   client Product IDs or expose the internal run to the owner. The cooldown begins
   60 seconds after the request completes; active duplicate requests return the
   same private request, and a later request before the deadline gets 429 with the
   matching `Retry-After`. A cached success must point to a real existing
   PriceHistory row. Preview cache alone cannot be converted into an observation.
4. **Alerts:** evaluate only a fresh successful observation for an enabled, existing
   tracker. Serialize against target/preferences edits via transaction or revision
   compare-and-swap; stale observations cannot overwrite newer evaluation state.
   First at/below-target success opens a stable episode; a successful above-target
   observation rearms. Errors do neither. Increment target revision only when cents
   actually change; same-value replay and channel edits do not reset episodes.
5. Persist episode state and enabled-channel delivery rows in one transaction. If
   both channels are off, do not consume an unsent qualification: enablement may
   evaluate the next fresh observation. Once an episode creates any delivery,
   enabling a second channel does not replay it. Disabling a tracker cancels pending
   sends but preserves its episode; re-enabling alone never replays it. A genuine
   target change starts a new evaluation. Deal changes never reset an episode.
6. **Delivery:** claim atomically with a unique lease token, fence every completion
   by that token, and recheck current tracker/channel and recipient session eligibility.
   One channel succeeding never completes the other. A send accepted with a lost
   acknowledgment is `unknown`; do not blindly retry without provider idempotency
   or reconciliation. An expired `sending` lease may represent a real send.
7. **Devices:** authenticated bearer identity supplies user/session. Atomically
   rebind installation/token and revoke old-session eligibility without revealing
   the old account. Rotation keeps device ID; conflicts require a transaction and
   must not delete another binding based only on an untrusted request. Logout,
   reset, expiry and invalid-token responses deactivate eligibility. Dispatch must
   recheck session validity, even if a stale device row remains after session TTL.

Delivery dedup records have no automatic TTL in this first schema. Pruning requires
a documented replay horizon/tombstone policy; deleting sent rows must never reopen
episodes. Deleting a tracker cancels pending work before removing it, and dispatch
must skip missing trackers. PriceHistory TTL may remove a referenced observation;
services must not depend on its presence to remember a sent episode.

## Validation

Offline: `npm test --workspace @price-tracker/api -- test/models.test.ts`.
Real MongoDB: set `TEST_MONGODB_URI` to an explicitly disposable local test server,
then run `npm test --workspace @price-tracker/api -- test/models.integration.test.ts`.
The test chooses a random `price_tracker_test_...` database and drops only that
database afterwards. Never supply deployed credentials. Test results are recorded
in [the database validation report](database-validation.md).

Schemas/indexes are implemented here. Transactional auth, observation ingestion,
episode evaluation, delivery and device-rebind behavior above remain implementation
requirements of their linked issues, not guarantees supplied by model declarations.
