# Web API client preparation

This branch adds an **unused, separately tested HTTP/session boundary** for #4, #10, #19 and #21. It does not connect the screens, implement backend endpoints, or complete those issues. The existing prototype and explicitly invoked health diagnostic are unchanged.

The wire source is `docs/api/openapi.json` from the shared-contract work (source baseline: `47dc976`). Its accompanying README and examples were read directly, not inferred from the earlier chat draft. Contract review/publication and real backend integration remain separate work. Reconcile later contract corrections when the parent merges it; do not import files from a sibling worktree at runtime.

## Entry points

Import `WebClient` from `apps/web/src/client/webClient.ts`. Import wire types from `dto.ts` and `ClientError` from `http.ts`.

| Operation | Client method |
| --- | --- |
| Restore cookie session | `restoreSession(options?)` → `User` or null on 401 |
| Account | `register`, `resendVerification`, `forgotPassword`, `verifyEmail`, `resetPassword`, `login`, `logout` |
| Preview | `preview(url, options?)` |
| Watchlist | `listTrackedItems({q?, limit?, cursor?}, options?)` |
| Tracker | `getTrackedItem`, `createTrackedItem`, `updateTrackedItem`, `deleteTrackedItem` |
| History | `getHistory(id, {from?, to?, limit?, cursor?}, options?)` |

Every operation accepts an optional `{signal: AbortSignal}`. For methods with a query/input, pass options after that argument. Create takes `(values, idempotencyKey, options?)`; generate one UUID per intended save and retain the **same values and key** if reconciling/retrying an uncertain save. The client never generates a new key behind the caller's back. PATCH accepts only target price, enabled state and complete email/push preferences. Unknown input fields are rejected, not silently stripped.

IDs are opaque, contract-bounded application strings. Never use a Steam app ID, provider game ID, or deal ID as a tracker ID. Money stays integer USD cents; zero is valid and null means unavailable. DTO guards reject unsafe/fractional money, wrong offer identity, mismatched Steam/purchase URLs, malformed UTC timestamps, missing required nullable fields, unexpected fields, and inconsistent unavailable/fresh states. Failed observations retain the last successful price and its distinct timestamps/error metadata. No client method fetches Steam, CheapShark, artwork, attribution, or purchase links.

History is an owned tracker request, not an all-store historical low. On continuation, pass the returned `window.from` and `window.to` with `page.nextCursor`; stop at null. Preserve `retainedFrom`, empty results and failures. Do not fill gaps with illustrative sample history.

## Session and CSRF behavior

- Construction makes no requests. In API mode, call `restoreSession` at startup before showing private data. A new client can restore after refresh/reopening because the browser owns the persistent cookie.
- `getSession()` returns a stable snapshot until a transition; `subscribe(listener)` returns an unsubscribe function. These can support a later React hook. Initial status is `unknown`, not signed out. `/me` returns only User, so restored `sessionId` and `expiresAt` are null; never invent them.
- A network/timeout/invalid response leaves the last known session intact. A current-context 401 clears it, including if the 401 body is malformed. Late private successes are rejected after a session change; an old request's 401 cannot clear a newer login.
- All fetches use `credentials: include`, `cache: no-store`, and reject redirects. There is no Authorization header, JavaScript-written Origin/Cookie header, JWT storage, or browser credential storage. Browser-generated Origin and backend cookie/CORS enforcement still require integration testing.
- Before mutations, bootstrap `/api/auth/web/csrf`; share concurrent bootstrap requests, cache only the unexpired in-memory token, and send `X-CSRF-Token`. Cancelling one waiting caller does not abort the shared bootstrap for another. Login discards pre-login CSRF and bootstraps the session binding. Successful logout clears private context and bootstraps a new pre-login binding.
- `CSRF_INVALID` clears the cached token for the **next explicit attempt**, without replaying the failed mutation. Verification/reset return 204 and never log in. Reset clears the current private context after success.
- Confirmed login/logout changes remain visible even if their subsequent CSRF bootstrap fails. Inspect the session snapshot rather than assuming every rejected login/logout promise means the transition failed. An offline logout before confirmation keeps the known session and reports failure; it does not claim server revocation.
- Cookie secrets and seven-day Secure/HttpOnly/host-only cookie policy are backend responsibilities. The browser cannot read the cookie or infer whether it contains a JWT. There is no refresh-token endpoint or unlimited-session promise.

## Configuration and failures

The existing public `VITE_API_BASE_URL` is the API **origin**, without `/api`. Blank uses same-origin `/api` (the existing Vite proxy locally). Deployed API origins require HTTPS. Only development permits HTTP on exact `localhost` or `127.0.0.1`; native emulator/LAN hosts are not browser exceptions. Separate deployments must meet the contract's approved **same-site** HTTPS/CORS policy. An HTTPS URL alone does not prove that deployment is allowed.

Constructor options can override `baseUrl`, `development`, `timeoutMs` and `fetch` for tests/integration. Each HTTP attempt has a 10-second default deadline (configurable 1–30000 ms), covering body reads, and a 1 MiB JSON response limit. Mutations are never automatically retried. Transient GET failures (network, timeout, valid 429/503 envelopes) get at most two retries with bounded jitter. The larger valid Retry-After header/body wait wins; waits of 30 seconds or longer return immediately as an error rather than being shortened. The UI must honor that wait before another explicit attempt. Caller abort also cancels retry waits. A mutation waiting on bootstrap can take the bounded bootstrap attempts plus its own deadline.

`ClientError.kind` distinguishes `http`, `network`, `timeout`, `aborted`, `invalid-response` and `invalid-input`. `details` carries validated API code, JSON-pointer field errors, request ID, retry seconds and owned duplicate resource ID when available. Branch on code/status, not English messages. HTML/proxy pages and malformed envelopes are invalid transport responses, never sample success. Do not log credentials, tokens, request bodies, or CSRF headers.

## Parent integration still required

After merging the finished design and latest contract:

1. Add explicit sample/API configuration, defaulting to sample. Do not construct/restore the HTTP client in sample mode, migrate sample records automatically, or fall back to samples after an API error. Test actual sample screens with fetch observed to remain untouched (other than a deliberately invoked health diagnostic).
2. Adapt the final design's sample boundary to these DTO operations; connect async loading/error/validation/duplicate states and per-item settings. Preserve existing USD target validation, accessible controls, health behavior and safe human purchase navigation. Returned image URLs are data only; do not automatically load arbitrary remote images. Review vetted image origins/local artwork separately.
3. Bind session snapshots to route protection and clear all UI-held private lists/details/previews on logout/401/account change. Cancel screen requests on navigation and ignore `aborted` results. Do not turn an offline startup into a signed-out success.
4. At `/verify-email` and `/reset-password`, read `#token` into memory and immediately remove the fragment with `history.replaceState`. Never use query tokens, analytics or automatic token-consuming GETs. POST only after explicit confirmation; apply `Referrer-Policy: no-referrer`. This client deliberately does not touch location/history or consume tokens automatically.
5. Exercise screens against real implemented API ownership/CSRF/cookie behavior, then run the deferred independent browser review. No browser QA was run for this transport-only phase. Android push/device/admin behavior is outside this client.

## Checks

Run `npm run check` on Node 24/npm 11. Client tests execute mocked HTTP requests and responses, including methods, encoded URLs, exact bodies, credentials/headers, pagination, 204, malformed/oversized JSON, money/identity validation, 401 races, deadline/body cancellation, bounded GET retries, account flows, and CSRF concurrency/expiration/rotation. They make no live provider/backend calls and do not prove real email, persistent cookies, ownership enforcement or delivery.

October 28, 2026: `npm run check` passed lint, both TypeScript checks, 14 API tests, 116 web tests (93 added client tests), and API/web builds on Node 24.22.1. Browser QA, Flutter checks and real backend/provider integration were not run for this web-only preparation.
