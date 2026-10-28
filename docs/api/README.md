# Shared API contract (proposed)

[`openapi.json`](openapi.json) is the proposed wire source of truth, **pending review with James, Martin and Alex** ([#4](https://github.com/aluciencozy/price-tracker/issues/4), model coordination [#1](https://github.com/aluciencozy/price-tracker/issues/1)). It is OpenAPI **3.1**, using JSON Schema 2020-12. Import this file into an OpenAPI 3.1 tool. Only the existing health/readiness endpoints work today; **none of these business endpoints are implemented by this PR**. Health responses are outside this business contract and remain unchanged.

**SwaggerHub: not published.** No explicit configured publication access was available. Import this exact file using approved free team access, record the real draft URL here, and review it before closing #4. Do not create a paid/billing-enabled service. A local valid source does not satisfy publication or team acceptance.

## Checks and examples

From the root, on Node 24 / npm 11:

```sh
npm ci
npm run test:contract
node docs/api/examples.mjs
```

The last command prints complete JSON HTTP exchanges: `method`, path template, headers, path/query values, request, status, response and response headers. [`examples.mjs`](examples.mjs) is the executable example source; omitted bodies mean **no body**, not JSON null. All credentials, application IDs, sessions, devices, observations and run results are illustrative offline fixtures. Only Portal 2 and Half-Life 2 identities/quotes come from the [October 26 source proof](../cheapshark-proof.json). USD 9.99 is a **dated recorded quote**, not a current/live price. Their examples are stale intentionally; the missing-offer example is illustrative, not a claim the game is unavailable. No multi-day history or provider-change time is invented. Never request the recorded purchase redirects from tests or the server.

Tests parse and validate the OpenAPI document, compile every schema with Ajv 2020-12, validate every route's successful request/response and representative errors, and reject unsafe/unknown fields, non-integer/unsafe money, missing/null confusion, invalid provider identities, purchase URLs and push payloads. These are contract checks, **not** HTTP/service, CSRF enforcement, authorization, durable delivery or upstream integration tests. `npm test` includes them. No live network calls occur in contract tests.

## Routes and bodies

All table paths below are relative to `/api`; OpenAPI contains the complete paths. JSON bodies must be objects of the documented shape; unknown body/query fields and duplicate query parameters are rejected. No coercion of JSON strings to numbers/booleans. Body limit 16 KiB; JSON content type required on body routes. Unknown fields may not be silently stripped. No owner IDs or provider/current-price/history writes from clients.

| Method/path | Request → success |
| --- | --- |
| `GET /auth/web/csrf` | no body → 200 `{csrfToken, expiresAt}` |
| `POST /auth/{web\|mobile}/register` | `{email,password,name?}` → generic 202 `{message}` |
| `POST /auth/{web\|mobile}/verify-email` | `{token}` → 204 |
| `POST /auth/{web\|mobile}/resend-verification` | `{email}` → generic 202 `{message}` |
| `POST /auth/{web\|mobile}/forgot-password` | `{email}` → generic 202 `{message}` |
| `POST /auth/{web\|mobile}/reset-password` | `{token,password}` → 204 |
| `POST /auth/web/login` | `{email,password}` → 200 `{user,sessionId,expiresAt}` + cookie; **no JWT** |
| `POST /auth/mobile/login` | `{email,password}` → 200 `{accessToken,tokenType:"Bearer",expiresIn:604800,expiresAt,sessionId,user}` |
| `GET /auth/{web\|mobile}/me` | no body → 200 `User` directly |
| `POST /auth/{web\|mobile}/logout` | no body → 204 |
| `POST /product-previews` | `{url}` → 201 `{id,expiresAt,product}` |
| `GET /tracked-items` | `q?`, `limit?`, `cursor?` → 200 `{items,page:{limit,nextCursor}}` |
| `POST /tracked-items` | `{previewId,targetPrice,enabled,alerts}` + UUID `Idempotency-Key` → 201 `TrackedItem` |
| `GET /tracked-items/{id}` | → 200 `TrackedItem` |
| `PATCH /tracked-items/{id}` | nonempty subset of `{targetPrice,enabled,alerts}` → 200 `TrackedItem` |
| `DELETE /tracked-items/{id}` | no body → 204 |
| `GET /tracked-items/{id}/history` | `from?`, `to?`, `limit?`, `cursor?` → 200 `History` |
| `POST /devices` | `{installationId,platform:"android",pushToken}` → 201 `Device` |
| `PUT /devices/{id}` | same full body (token rotation) → 200 `Device` |
| `DELETE /devices/{id}` | no body → 204 |
| `POST /admin/price-checks` | `{}` → 202 `PriceCheck` + `Location` |
| `GET /admin/price-checks/{id}` | → 200 `PriceCheck` |

Account operations share services between namespaces, not duplicated business logic. Account/profile editing and deletion, refresh tokens, browser push, global catalog search and ordinary-user check-now routes are deliberately absent. Alert preferences are `enabled` and complete `{email:boolean,push:boolean}` on each tracker, not a separate global settings resource.

## Authentication and browser safety (normative)

The October 28 interview confirms persistent web sign-in, superseding older JWT-only wording in #4/#9. The web receives an **opaque** cookie secret (not the informational `sessionId`); mobile receives a JWT. Both map to revocable server-side sessions. Fixed lifetime is **604800 seconds / seven days**, with no sliding expiry or refresh endpoint. `expiresAt` is authoritative. Validate JWT signature, explicit algorithm allowlist, issuer/audience, expiry and active session/account state on every request. Unverified users never receive a session; return `403 EMAIL_UNVERIFIED` only after verifying credentials. Invalid credentials get the same generic 401. Normalize/trim email consistently server-side; never trim passwords.

Production cookie: `__Host-price_tracker_session=<opaque>; Path=/; Max-Age=604800; Expires=<matching UTC expiry>; HttpOnly; Secure; SameSite=Lax`, **no Domain**. Never send its secret/JWT in JSON, URLs, logs, localStorage or sessionStorage. On reload/reopen, bootstrap with web `me`; a 401 returns to sign-in. GETs never extend expiry. Login rotates session identity, invalidates a previous session supplied on that request (and its devices), and invalidates pre-login CSRF state. Logout revokes the current session and its device bindings server-side before 204 and clears cookies with matching attributes. Password reset atomically revokes **all** account sessions/device bindings. Every later request with a revoked token fails, even before its nominal expiry. Client clears local state on 401; never falls back to sample success. An offline logout can clear local state but cannot claim server revocation until contact succeeds.

1. Before any browser mutation, call `GET /api/auth/web/csrf` with credentials. Without a session this sets `__Host-price_tracker_prelogin`, a random HttpOnly, Secure, host-only, SameSite=Lax, Path=/ cookie expiring after **30 minutes**, and returns its bound CSRF token. With a session it returns a session-bound token expiring no later than the session. Repeated bootstrap may return the same valid token; do not invalidate another tab unnecessarily.
2. Send `X-CSRF-Token` **and exact allowlisted `Origin`** on every browser mutation, including register, login, logout, verification/reset and preview. Reject missing/expired/unbound tokens with 403 `CSRF_INVALID`; missing/null/unapproved origins with 403 `ORIGIN_DENIED`. Do not rely on SameSite alone. Obtain a new bootstrap after login/logout; do not automatically replay an uncertain mutation just because a CSRF token changed.
3. Web auth routes reject Authorization headers. Mobile auth/device routes reject either named web cookie, including pre-login cookies. Shared business routes reject any combination of bearer and either web cookie with 400 `AUTH_AMBIGUOUS`, even if one credential is invalid; they never choose whichever works. Namespace misuse is also `AUTH_AMBIGUOUS`. Public native account routes do not issue or accept browser cookies; do not enable credentialed browser CORS for those routes. Bearer auth is a native transport, not a browser CSRF bypass.
4. Prefer same-origin `/api` routing. Approved cross-origin web deployments must be **same-site HTTPS** (SameSite=Lax is not a cross-site deployment solution), with `credentials: include`, exact configured origins, `Access-Control-Allow-Credentials: true`, and `Vary: Origin`; never `*`, reflected arbitrary origins or suffix matching. Preflight only approved origins/methods/headers (`Content-Type`, `X-CSRF-Token`, `Idempotency-Key`; native bearer uses `Authorization`). Expose `Retry-After`/`Location` as needed. OPTIONS has no business side effect or auth requirement. Reject unapproved actual requests, not just preflight. Do not expose CSRF bootstrap to unapproved origins.
5. **Explicit local debug exception only:** HTTP on `localhost` or `127.0.0.1`, using same-origin Vite proxy where possible. Use names `price_tracker_session_dev` / `price_tracker_prelogin_dev`, same HttpOnly/host-only/Path=/SameSite=Lax/expiry policy but without Secure; never weaken a `__Host-` cookie or depend on inconsistent browser exceptions. Recognize these names as cookie auth for ambiguity rejection too. Allow only exact configured loopback origins (for example `http://127.0.0.1:5173`), not LAN/public hosts. Production must refuse this mode and require HTTPS. Native emulator `10.0.2.2` is a debug transport only, not a web-origin/cookie exception. This is policy for future implementation, not newly added environment configuration.

All auth/account responses, CSRF bootstrap, previews, private resources and errors use `Cache-Control: no-store`. Never log password, CSRF/reset/verification token, JWT, cookie or push token. Use safe request IDs instead.

### Email link handoff

Use allowlisted HTTPS web links `/verify-email#token=<secret>` and `/reset-password#token=<secret>`. Read the fragment into memory and immediately remove it with `history.replaceState`; no token query parameters, analytics, third-party scripts or referrer leakage on these pages (`Referrer-Policy: no-referrer`). Show an explicit confirmation/form. **GET never consumes tokens**; POST only after CSRF bootstrap and user action. Neither verification nor reset auto-logs in. Verification expires after 24 hours; reset after 30 minutes. Store only token hashes, enforce single use/expiry atomically; reissuing invalidates previous token of the same purpose. Generic 202 body is always `{"message":"If eligible, you will receive an email with next steps."}` for register/resend/forgot, including existing/unknown/ineligible accounts. Flutter opens/explains browser completion, then asks users to return and sign in; no app deep-link token handling is required.

## Offers, history and alerts

- `Money` is required `{amountMinor,currency:"USD"}`; amount is integer **0..9007199254740991**. Zero is valid/free; missing prices are **null**. All model keys marked required remain present even when nullable. Application IDs are opaque strings. Steam app, CheapShark game, store and changing deal IDs are separate string fields, not interchangeable integers.
- `Product` is shared metadata for `(cheapshark,providerGameId,"1","US","USD")`; `TrackedItem` is private `{id,product,targetPrice,enabled,alerts,createdAt,updatedAt}`. The schema enumerates every Product field. Preserve attribution and select **only** the exact Steam base-game offer. Reject unknown/DLC/bundle/subscription/edition/ambiguous matches; title similarity is not identity. Only two games have recorded source proof, not blanket support for every app.
- Parse submitted URLs locally with the URL parser and an exact Steam host/path allowlist. Do not fetch them. Preview uses fixed CheapShark endpoints, DNS/private-address/redirect safety, honest application User-Agent, bounded timeout/body/concurrency and shared cache/provider budget. Never automatically fetch `/redirect`; purchase URLs are human navigation only. The API must ensure canonical app URL matches `steamAppId` and `purchaseUrl` exactly equals `https://www.cheapshark.com/redirect?dealID=` + `encodeURIComponent(dealId)` (a cross-field invariant, not expressible by ordinary JSON Schema). Only vetted HTTPS image origins; never turn API images into an arbitrary fetch proxy.
- `observedAt` is the last successful **local** observation; `providerChangedAt` is nullable upstream change time, never inferred from fetch time. `lastAttemptAt`/`lastError` describe the latest attempt. `staleAt = observedAt + 24 hours`. `fresh` means a valid success younger than staleAt and no later failed attempt; `stale` preserves the last valid price after age/failure. `unavailable` means **no retained successful observation**, so prices, observedAt, providerChangedAt, staleAt and deal/purchase are null. A later missing offer keeps last-success metadata as stale; explain that any retained link is dated/unconfirmed. Failed fetches create neither zero prices nor history rows. Never evaluate alerts against stale failures. `nextCheckAt` is an estimate, not a delivery promise.
- Previews last 10 minutes and belong to the authenticated user. They may use a retained cached stale observation if identified honestly, but cannot fabricate an offer without a previously validated Steam success. Missing/unsupported matches get 422. Saving an owned unexpired preview does not trigger a new upstream request; worker checks refresh later. Foreign preview/item/device IDs always get 404. Never leak another user's `resourceId`.
- Lists have default limit 20, max 100, opaque `nextCursor` (null means done). Literal, case-insensitive title substring search is private watchlist-only. Cursors bind owner/filter/sort/window; malformed or changed-filter cursors return 422 `INVALID_CURSOR`. History is available **only** at an owned tracker path, ordered ascending `(observedAt,id)`; range is `[from,to)`, defaults previous 30 days, maximum 90 days, `from < to`, UTC. Subsequent cursor requests repeat returned window; cursor embeds the first page's normalized window, so omitted bounds reuse it rather than advancing "now". Proposed retention is rolling **90 days of minimal local observations**, no provider payload archive/bulk export; model/provider owners must confirm retention under #1/#14 before implementation. `retainedFrom` exposes the actual retention boundary even with no rows; older requested windows may be empty or truncated, never filled with guesses.
- Create requires a UUID Idempotency-Key. Scope user/method/route; retain success for 24 hours; compare normalized validated JSON, not key order. Concurrent same-key requests must serialize/replay original 201 + body/Location, including before preview-expiry validation; changed body returns 409 `IDEMPOTENCY_CONFLICT`. No mutation on that conflict. Validation/auth/provider failures are not cached successes. Different keys cannot bypass unique `(user,product)`; return 409 `DUPLICATE_TRACKED_ITEM` with the **owned** tracker ID. After retention, uniqueness still prevents duplicates. There is no guarantee about retrying a removed item after the key expires.
- PATCH changes only supplied target/enabled/preferences; supplied alerts contains both booleans. Last accepted write wins. Identical target updates do not start another episode; actual target changes allow new evaluation on a successful check, not a claimed new sale. Channel toggling/enabling does not replay old episodes; disabling/deleting cancels unsent deliveries but cannot recall externally accepted messages. Follow [the exact episode/channel rules](../project.md#alert-rules-do-not-send-the-same-alert-every-day), including uncertain-email reconciliation. A target edit never creates history or proves a discount.

## Devices, push and admin status

Device operations require native bearer auth and current-session ownership. `installationId` is a random local UUID, never an owner credential. Register/rebind atomically on login/account switch; rotation keeps device ID. Binding uniqueness on token/installation removes previous session delivery eligibility, without exposing the previous account. DELETE only affects current-session devices. Logout/reset/expiry deactivate bindings; permission denial/removal should unregister while authenticated. Clean up invalid FCM tokens. Checking token possession/FCM validity remains backend integration work; token registration does not prove delivery.

`PushEvent` is a versioned **FCM data object with only string values**:

```json
{"schemaVersion":"1","type":"price_target_reached","eventId":"episode_example","deliveryId":"delivery_push_example","recipientSessionId":"session_example","trackedItemId":"tracker_example","productId":"product_1","observedAt":"2026-10-26T16:34:42.829Z"}
```

No arbitrary URLs, credentials, price/target or personal data. Stable `eventId` identifies the qualifying episode across channels/retries; stable `deliveryId` identifies the durable push delivery, never a fresh retry ID. Server delivery fan-out uses a per-recipient-session payload with the same event/delivery IDs; retries must not retarget a newly signed-in session. Client validates schema/type and active `recipientSessionId`, ignores unknown versions and old sessions, deduplicates durably by **recipientSessionId + eventId**, and opens only the owned tracker after an authenticated API fetch. A foreign/deleted tracker or expired session shows a safe unavailable/sign-in state. No blind URL navigation or automatic account switch. Data-only handling should avoid automatic OS presentation of sensitive stale-account content; foreground/background/tap behavior and actual delivery still need separate Android proof.

Admin enqueue accepts only `{}` and calls the same daily worker service. Ordinary users get 403. Coalesce overlapping active runs; enforce shared cache/backoff/claims. Status exposes aggregate counts only. `queued` has null started/finished timestamps; `running` has startedAt and null finishedAt; terminal states have both. `succeeded` means no failed products, `partial` means both success and failure, `failed` means no success or fatal run failure. At termination succeeded + failed + skipped = total; while active this sum may be smaller. Zero products may succeed with zero counts. Failed runs do not imply all product prices became unavailable. Poll active runs no faster than 5 seconds/Retry-After. No worker, scheduler, delivery service or fake outbox is included here.

## Errors, limits and retries

Every application error uses only:

```json
{"error":{"code":"VALIDATION_ERROR","message":"Check the highlighted fields.","fields":[{"path":"/targetPrice/amountMinor","code":"out_of_range","message":"Use nonnegative integer USD cents."}],"requestId":"request_example","retryAfterSeconds":null,"resourceId":null}}
```

See each OpenAPI operation for statuses. 400 is malformed JSON/token/auth ambiguity, 401 authentication/session loss, 403 CSRF/origin/verification/admin denial, 404 missing/foreign, 409 duplicate/idempotency/device conflict, 410 expired owned preview, 422 strict validation/unsupported/missing offer/cursor, 429 local/provider limit, 503 source/service outage. Common infrastructure failures **on every operation** also use this envelope: 413 `PAYLOAD_TOO_LARGE`, 415 `UNSUPPORTED_MEDIA_TYPE`, 500 `INTERNAL_ERROR` (no stack traces). Bodyless routes reject submitted bodies with 400. `fields` is always present, usually empty; paths are JSON pointers (`/query/limit` or `/headers/Idempotency-Key` outside body). `resourceId` is null except an owned duplicate tracker; request IDs contain no secrets. Error messages are human-facing; branch on code, not English text. Reverse proxies must be configured to preserve this error format; an HTML/network response is a transport failure, not a valid API response.

Proposed initial limits (implementation must enforce and tune only through documented policy): auth/register/resend/forgot/reset/verify **5 attempts per 15 minutes per IP + normalized email/token hash**, login additionally per account; CSRF bootstrap 60/minute/IP; ordinary authenticated API 120/minute/session; preview 5/minute/user and 20/minute/IP, maximum 2 concurrent/user, 10-second total deadline; manual admin enqueue 1/minute/admin; status polling max 12/minute/admin. Provider-wide limits are shared across all entry points and may be stricter; honor upstream Retry-After rather than probing around a block. Generic account responses do not reveal which account-specific limiter fired. No paid fallback/IP rotation.

429 always includes positive integer delta-seconds `Retry-After` matching `error.retryAfterSeconds`; 503 includes both when retry is known, otherwise null/no header. Clients honor the larger local/provider wait, use bounded jittered retries, and do not busy-loop. Automatically retry safe GETs only (max two retries); retry create only with identical body + original Idempotency-Key after uncertain outcome. Do not automatically retry login/email/token consumption, PATCH, DELETE or enqueue; let the user reconcile/refetch first. Repeated explicit PATCH of identical values is semantically safe, but must not replay an alert. A failed fetch never masquerades as a sample/live success.
