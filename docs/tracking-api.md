# Tracking API integration notes

This document records the tracking and preview integration for #13/#14. These
routes and their verified-session middleware are mounted in the current API
source when tracking options are configured. The public schemas remain the
[shared OpenAPI contract](api/README.md); the notes below explain the resolver
boundary and its safety rules.

## Required auth and preview seams

`createTrackingRouter(requireVerifiedUser, cursorSigningSecret, options)` takes an
Express `RequestHandler`. It runs before every route and requires that middleware
to set `res.locals.principal` to:

```ts
{
  userId: string;       // server-derived Mongo ObjectId
  sessionId: string;    // active, revocable session
  transport: 'web' | 'mobile';
  role: 'user' | 'admin';
}
```

The middleware must reject invalid, revoked, expired, or unverified sessions and
ambiguous web/mobile credentials. On web mutations it must enforce the current
session's CSRF token and exact configured Origin. The router does not accept an
owner ID from a body, query, or header. If the middleware does not set a valid
principal, the router fails closed with `401 AUTH_REQUIRED`.

The preview resolver is also required, and is injected rather than silently
calling the check worker:

```ts
type ProductPreviewResolver = (approvedProductId: string, signal: AbortSignal) => Promise<ProductRecord & { _id: Types.ObjectId }>;
createProductPreviewService({ resolveProduct: previewResolver });
```

It is called after local Steam host/path parsing and exact app-ID extraction. A
new app is discovered on demand: Steam's undocumented `appdetails` response must
positively identify that exact app ID as type `game`, then CheapShark must return
one exact Steam app-ID match and a current US/USD Steam offer. The API does not
require a manually seeded two-game catalog. Steam's coarse `game` type does not
distinguish every special edition, so discovery is not proof that all editions
are excluded or every app is supported. The resolver must return the resolved
`ProductRecord` (including `_id`) and use the shared safe provider adapters,
cache, and request budget. It must honor cancellation, settle only after upstream
work has actually stopped, and must not create trackers, alert episodes, or
history observations. A successful scheduled/manual check owns the
`recordObservation` Product+history transaction; preview must not enter that
pipeline. Preview returns an honestly fresh/stale normalized Product snapshot.

The service persists successfully validated discoveries as shared `ProductModel`
rows. A missing local Product triggers bounded discovery rather than a seeded
catalog miss; unsafe or unsupported app/type/offer results are rejected. Startup
indexes are still required. Seed data is not an eligibility allowlist and its
historical examples do not prove support for other Steam apps.

## Mount point

`apps/api/src/app.ts` constructs the router when `options.tracking` is supplied,
after JSON parsing and device routes. A path gate sends only product-preview and
tracked-item paths to it and returns 503 while the database is unavailable. The
router owns the nested history route; do not mount a duplicate handler.

`trackingCursorSigningSecret` must be a deployment secret of at least 32 bytes,
shared across API instances. The router includes
`GET /tracked-items/:id/history` by reusing `createHistoryService`, so do not
also mount a second handler for that path. The existing `createHistoryRouter`
accepts a request-only async authenticator; it is not directly compatible with
the new `res.locals.principal` middleware without a small shared auth bridge.

`app.ts` owns the configured CORS/preflight policy, JSON parser and API error
envelope before mounting tracking routes. Keep those shared middleware boundaries
aligned with the contract; this router cannot intercept parser failures raised
earlier in the stack.

Mutations depend on the shared middleware's current-session CSRF/Origin checks.
The router sets `Cache-Control: no-store`, uses standard error envelopes, applies
database-backed preview request limits, and caps in-process per-user preview
concurrency at two. CheapShark's provider budget remains shared in MongoDB.

The preview service has a 10-second deadline and passes cancellation through
discovery/refresh to bounded provider requests. It holds the user's concurrency
slot until resolver work settles; abort alone is not evidence that upstream work
ended. Preserve that cancellation/settlement behavior when changing the resolver
or provider adapter. Normal tests do not call live providers.

## Data and tests

The router enforces 120 private requests per minute per verified session using
the shared MongoDB auth-limit collection. Preview limits are additional. The
same helper can run in authentication middleware without counting a request
twice. A blocked request returns matching `Retry-After` and error-envelope
seconds. Tests cover the threshold, different sessions and composed middleware.

Product previews are owner-bound, expire after 10 minutes, and are retained for
an additional day so an owned expired preview can return `410 PREVIEW_EXPIRED`
instead of being confused with a foreign/missing ID. Create responses and their
`Location` are stored atomically with the tracker for 24-hour UUID idempotency.
The unique `(userId, productId)` model index remains the final concurrent
duplicate guard. Deletion cancels pending/retryable deliveries, then removes
only the owner's tracker; shared products, history, and other owners are kept.

The integration test uses `TEST_MONGODB_URI` only with a random
`price_tracker_test_*` database name, checks that selected name before setup,
and drops only that database. It injects an offline Product fixture resolver;
it never calls CheapShark or sends messages.
