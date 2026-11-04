# Observed Steam history

Supports [#14](https://github.com/aluciencozy/price-tracker/issues/14), based on
schema PR #42. This implements transactional observation ingestion, owned history
reads, and an injectable Express router. It does not install an authentication
shortcut or mount a public history endpoint in the health-only starter.

## Integrating a successful check

Nick's shared scheduler/refresh service should call:

```ts
await recordObservation(productId, stableCheckId, refreshLeaseToken, offer);
```

Use the validated `SteamOffer` from the provider adapter and the active Product
refresh lease. A check ID must survive retry/restart and identify the successful
observation, not each attempt. Replace the existing Product-only success update
with this call; do not call both sequentially, since the old update releases the
lease before history can commit. Nick's adapter still uses its original success
path in this PR: integration into #15 must explicitly make this replacement.

The function requires exact matching Product identity, Steam app/store/US/USD,
valid nonnegative safe integer cents, canonical Steam URL, correctly encoded
CheapShark purchase redirect and a local success younger than 24 hours. It accepts
real zero, rejects future/stale/missing/invalid prices, and never substitutes a
historical low or other store. No outbound request is made by this service.

It updates the shared cache and inserts history in one replica-set transaction,
fenced by the refresh token and expiry. A lost lease or newer stored observation
rejects the write. Exact replay returns the existing row; conflicting data under
the same Product/check identity is rejected. A changed deal ID is metadata for a
later check, not a new Product. Separate successful checks may record equal prices.
Failures must use the adapter's existing failure path and must not call this writer.

The current adapter has no source-change time and supplies null. Keep that field
distinct from the local observation date if upstream support is added later.
The 90-day minimal-observation retention policy still needs source-owner/team
confirmation as recorded in [database.md](database.md); do not enable live history
collection until that review is complete.

## Integrating the authenticated read

After the API owner implements the verified, revocable web/mobile session boundary,
mount the router before the API's 404 handler:

```ts
app.use('/api', createHistoryRouter(authenticateVerifiedSession, cursorSigningSecret));
```

`authenticateVerifiedSession(request)` must validate the cookie/CSRF-origin policy
where applicable or mobile JWT, enforce ambiguity rules, check verification and
active session, and return the server-derived `{ userId }`. It must throw a
`HistoryError` with the agreed auth code/status (or translate the shared auth error)
on rejection. GET has no mutation/CSRF-token requirement; credentialed web CORS
still belongs to the shared API boundary. Never pass an HTTP body/header/query
user ID directly into the history service. There is no default authenticator.

The cursor key must be a deployment secret of at least 32 bytes, shared across API
instances. Generate it cryptographically and keep it outside git. Rotation makes
existing cursors invalid; clients restart pagination. No key is committed or
invented for production. The router sends `Cache-Control: no-store`, strict
contract success responses, and sanitized error envelopes.

`GET /api/tracked-items/:id/history` verifies ownership before accessing shared
history. Foreign and missing trackers return the same 404. Query fields are only
`from`, `to`, `limit` and `cursor`; dates are UTC, range `[from,to)`, default previous
30 days, maximum 90 days, limit 20 by default/100 maximum. Rows outside rolling
retention are excluded even if the asynchronous TTL monitor has not removed them.
An empty/truncated window remains empty; no invented chart points or older price
summary is returned.

HMAC-signed cursors bind owner, tracker, normalized time window, and ascending
`(observedAt,_id)` position. Equal timestamps paginate without duplicates. Omitted
bounds on later pages reuse the original window; changing bounds or tampering
returns `422 INVALID_CURSOR`. Limit may change within its documented bounds.
The response includes only the shared product, normalized observations and paging
metadata; no owner's targets, private preferences, leases or device details.
Product failure metadata preserves the prior valid price with stale status and a
sanitized generic source-failure code. Reads never refresh upstream prices.

## Verification and remaining acceptance

Local MongoDB 8.0 replica-set tests cover zero/invalid/stale/future/wrong-store
prices, lease loss, exact/conflicting replay, deal changes, private ownership,
equal-time pagination/window reuse, tampering/changed bounds, range boundaries,
empty history, stale cache and the required router auth boundary. Use
`TEST_MONGODB_URI` pointing only to a disposable local replica set and run:

```sh
npm test --workspace @price-tracker/api
```

November 4, 2026, macOS arm64 / Node 24.22.1: all **81 API tests passed**, including
13 history integration cases. API typecheck/build and repository lint passed.
Tests include overlapping transaction writes and validation of the returned History
object against the actual shared OpenAPI schema.

The tests isolate/drop only random test databases and never contact CheapShark.
The scheduler write hook, real authentication mounting, remote MongoDB transaction
proof, retention approval and deployed client history evidence remain before #14
can be closed. The factory is ready for those integrations; the starter's running
health routes alone do not prove a deployed history API.
