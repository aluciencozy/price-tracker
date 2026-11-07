# Tracking API integration notes

This adds injectable preview, tracker, and owned-history routes for #13/#14. It
does not mount them in `app.ts` or configure authentication. The public schemas
remain the existing [shared OpenAPI contract](api/README.md); this document only
describes implementation wiring.

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

It is called only after local Steam host/path parsing, confirmed-catalog lookup,
and an exact seeded Product identity check. It must return the resolved
`ProductRecord` (including `_id`) and must use the shared safe CheapShark adapter,
cache, and provider budget. It must honor the abort signal, settle only after its
upstream work has actually stopped, and must not create trackers, alert episodes, or
history observations. A successful scheduled/manual check owns the
`recordObservation` Product+history transaction; preview must not enter that
pipeline. The preview route returns only an honestly fresh/stale normalized Product snapshot.

The service uses the current `ProductModel` row as the shared identity and
returns `503 SERVICE_UNAVAILABLE` if the confirmed metadata catalog has not been
seeded. Run the existing `npm run db:indexes --workspace @price-tracker/api`
and `npm run db:seed --workspace @price-tracker/api` setup commands before
enabling tracking routes. The seed contains metadata only, never a quote.

## Mount point

The central integration owner can mount one router after JSON parsing and the
shared auth/session middleware is available, but before the API 404 handler:

```ts
app.use('/api', createTrackingRouter(
  requireVerifiedUser,
  trackingCursorSigningSecret,
  { createPreview: createProductPreviewService({ resolveProduct: previewResolver }) },
));
```

`trackingCursorSigningSecret` must be a deployment secret of at least 32 bytes,
shared across API instances. The router includes
`GET /tracked-items/:id/history` by reusing `createHistoryService`, so do not
also mount a second handler for that path. The existing `createHistoryRouter`
accepts a request-only async authenticator; it is not directly compatible with
the new `res.locals.principal` middleware without a small shared auth bridge.

The current starter's global CORS policy does not yet allow tracking `PATCH` /
`DELETE` or the complete web cookie/CSRF header policy. Its JSON parser and final
error handler also run before this router and currently return legacy string
errors for malformed JSON/oversized bodies. The central app integration must
apply the contract's exact credentialed same-site web CORS/preflight policy and
translate parser errors into the common error envelope with `no-store`; this
router cannot intercept parser errors raised earlier in the stack.

Mutations depend on the shared middleware's current-session CSRF/Origin checks.
The router sets `Cache-Control: no-store`, uses standard error envelopes, applies
database-backed preview request limits, and caps in-process per-user preview
concurrency at two. CheapShark's provider budget remains shared in MongoDB.

The preview service requests cancellation at 10 seconds, but holds the user's
concurrency slot and waits until the resolver actually settles. A resolver that
ignores cancellation can therefore delay the response indefinitely; abort alone
is not evidence that upstream work ended. The current adapter's internal total
lookup deadline is 30 seconds and does not expose cancellation. The price-check
worker must supply a resolver that stops all provider work and settles within the
contract's 10-second total deadline before this route is enabled. No live
provider calls are made by normal tests.

## Data and tests

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
