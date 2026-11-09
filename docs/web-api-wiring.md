# Web API wiring

This document describes the web app's HTTP/session boundary for #4, #10, #19 and #21. The integrated API now contains account/session routes and verified-user tracking/history/admin routes; tracking routes are mounted only when `PRICE_TRACKING_ENABLED=true` and the database/indexes are ready. Sample mode remains the default, and the health diagnostic is still manual-only. Fixture-based browser acceptance against the composed API is recorded in [central integration](central-integration.md); it is not live provider, mailbox, push, or deployment acceptance. No live backend/provider calls were made for this documentation update.

The wire source is the committed `docs/api/openapi.json`, originally introduced in [contract PR #36](https://github.com/aluciencozy/price-tracker/pull/36) and updated by subsequent integration work. The web client has no sibling-worktree runtime dependency. Backend route implementations are integrated; deployed behavior and owner acceptance remain separate work. See [Issue #10 setup and acceptance](web-authentication.md) for verification/resend navigation, field errors, submission guards and the remaining real mailbox checks.

## Mode and UI boundary

`VITE_DATA_SOURCE=sample` (default) creates only a fresh sample repository. `api` creates only `WebClient`; invalid values/configuration fail closed. There is no runtime sample upload or error-to-sample fallback. Bundled local fonts/artwork are used in both modes; API image URLs are never loaded. API mode retains the labeled landing **example**, not fictional records in a real account.

`main.tsx` chooses the runtime before rendering. `<App runtime={runtime} emailLink={handoff} />` permits offline screen tests with an injected client. The original `<App repository={repository} />` injection still works in sample mode. `createApiRepository(client)` adapts strict DTOs to `TrackerRepository`; each private route owns its instance and cancels requests/discards save keys on unmount. UI lists, details and drafts are unmounted on logout, current-context 401 or account/session change. Superseded searches are cancelled without replacing the search field or losing focus. There is no private record cache.

List/search and history follow every cursor, repeating search filters/history bounds. Pages are bounded at 100 requests of up to 100 rows, with repeated-cursor/window guards; exceeding the bound reports an error, never a silently truncated success. This is sufficient for the small student watchlist; use explicit page controls if the actual data approaches that limit. History preserves window/retention metadata and always uses `illustrative: false`. Only successful observations are charted; failures/empty history are explicit.

An intended save gets a random UUID held in its route-scoped repository by validated preview/preferences. Explicit retry with unchanged values reuses that key/body. Changed preferences get a new key. Keys never enter browser storage and are discarded on route exit; after leaving an uncertain save, refetch the watchlist to reconcile before creating another. Mutations are never automatically replayed. API field errors/owned duplicates, stale metadata, missing/free prices and Retry-After are shown separately from sample copy. Saved preferences never claim alert delivery or a new price drop.

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
- `getSession()` returns a stable snapshot until a transition; `subscribe(listener)` returns an unsubscribe function. `ApiSession` binds them through React's external-store hook. Initial status is `unknown`, not signed out. `/me` returns only User, so restored `sessionId` and `expiresAt` are null; never invent them.
- A network/timeout/invalid response leaves the last known session intact. Unknown startup shows a retry state, not a signed-out success. A current-context 401 clears it, including if the 401 body is malformed. Late private successes **and errors** are rejected after a session change; an old request's 401 cannot clear a newer login. Login reserves its new context after input validation, before bootstrap/POST, so an earlier restore cannot invalidate it mid-flight. The prior snapshot remains until an actual outcome.
- All fetches use `credentials: include`, `cache: no-store`, and reject redirects. There is no Authorization header, JavaScript-written Origin/Cookie header, JWT storage, or browser credential storage. Browser-generated Origin and backend cookie/CORS enforcement still require integration testing.
- Before mutations, bootstrap `/api/auth/web/csrf`; share concurrent bootstrap requests, cache only the unexpired in-memory token, and send `X-CSRF-Token`. Cancelling one waiting caller does not abort the shared bootstrap for another. Login discards pre-login CSRF and bootstraps the session binding. Successful logout clears private context and bootstraps a new pre-login binding.
- `CSRF_INVALID` clears the cached token for the **next explicit attempt**, without replaying the failed mutation. Verification/reset return 204 and never log in. Reset clears the current private context after success.
- Confirmed login/logout changes remain visible even if their subsequent CSRF bootstrap fails. Inspect the session snapshot rather than assuming every rejected login/logout promise means the transition failed. An offline logout before confirmation keeps the known session and reports failure; it does not claim server revocation.
- Cookie secrets and seven-day Secure/HttpOnly/host-only cookie policy are backend responsibilities. The browser cannot read the cookie or infer whether it contains a JWT. There is no refresh-token endpoint or unlimited-session promise.

## Configuration and failures

The existing public `VITE_API_BASE_URL` is the API **origin**, without `/api`. Blank uses same-origin `/api` (the existing Vite proxy locally). Deployed API origins require HTTPS. Only development permits HTTP on exact `localhost` or `127.0.0.1`; native emulator/LAN hosts are not browser exceptions. Separate deployments must meet the contract's approved **same-site** HTTPS/CORS policy. An HTTPS URL alone does not prove that deployment is allowed.

Constructor options can override `baseUrl`, `development`, `timeoutMs` and `fetch` for tests/integration. Each HTTP attempt has a 10-second default deadline (configurable 1–30000 ms), covering body reads, and a 1 MiB JSON response limit. Mutations are never automatically retried. Transient GET failures (network, timeout, valid 429/503 envelopes) get at most two retries with bounded jitter. The larger valid Retry-After header/body wait wins; waits of 30 seconds or longer return immediately as an error rather than being shortened. Buttons show/block the wait; the client's shared in-memory cooldown also prevents navigation from immediately bypassing it. That cooldown retains only a deadline, not another route/account's error details. Caller abort also cancels retry waits. A mutation waiting on bootstrap can take the bounded bootstrap attempts plus its own deadline.

`ClientError.kind` distinguishes `http`, `network`, `timeout`, `aborted`, `invalid-response` and `invalid-input`. `details` carries validated API code, JSON-pointer field errors, request ID, retry seconds and owned duplicate resource ID when available. Branch on code/status, not English messages. HTML/proxy pages and malformed envelopes are invalid transport responses, never sample success. Do not log credentials, tokens, request bodies, or CSRF headers.

## Email links

Before React/router initialization, `captureEmailLink()` reads the fragment for `/verify-email` and `/reset-password` (also `/verify` and `/reset` aliases), then immediately uses `history.replaceState` to remove the fragment **and query**, without storing a token in history state. Only a single fragment token is accepted; query tokens are ignored. No GET consumes a token. The real form requires explicit confirmation/password submission after CSRF bootstrap. It clears consumed tokens/passwords, and navigation away clears the pending token. Verification/reset do not auto-login; Flutter users are told to return and sign in.

The document sets a `no-referrer` meta policy; production hosting should send the matching HTTP header and serve the SPA shell on direct email/detail routes. No analytics or remote scripts are introduced. Capture happens even in sample mode to scrub a mistaken real link, but sample mode never sends or consumes its token. A scrubbed link cannot survive refresh: reopen the original email link if needed.

## Still requires owner acceptance

The API account/session/CSRF, ownership, preview, tracker, history, device and admin routes are present in the integrated code; tracker/admin routes require `PRICE_TRACKING_ENABLED=true`. Confirm them against the approved deployment, including cookies across refresh/reopening, exact allowed Origin/CORS behavior, real mailbox links, revocation and cross-client ownership. All background flags default to `false`; a database connection alone does not start daily checks or send mail/push. Provider matching and limits have offline coverage, but live application-adapter lookup, recorded deployed history, sender acceptance, Android gateway/device receipt, due-run recovery, and deployed scheduling are not proved by fixtures. The server's device endpoint is not an Android FCM provider. See [release readiness](release-readiness.md) and [VM scheduling](vm-scheduling.md).

Account and alert workers now have explicit opt-in startup wiring; all flags default to off. See [backend runtime](backend-runtime.md) before enabling mail. The website has no device/push/admin UI or ordinary-user check-now action. Local web authentication tests use captured messages rather than external mailbox delivery.

## Checks

Run `npm run check` on Node 24/npm 11. Client tests execute mocked HTTP requests and responses, including methods, encoded URLs, exact bodies, credentials/headers, pagination, 204, malformed/oversized JSON, money/identity validation, 401 races, deadline/body cancellation, bounded GET retries, account flows, and CSRF concurrency/expiration/rotation. They make no live provider/backend calls and do not prove real email, persistent cookies, ownership enforcement or delivery.

Screen tests inject a real WebClient with an observed offline fetch function. They cover sample zero-network/storage behavior, fail-closed mode selection, real form bodies/headers, session guards/401/account-switch cancellation, email handoff/explicit consumption, CRUD, zero/missing prices, paginated search/history, duplicate/validation errors, uncertain save-key reuse and Retry-After. The five design-review regressions from `8430080` remain included. The October check below is historical. Later fixture-based browser acceptance against the composed API is recorded in [central integration](central-integration.md); Flutter, live provider/mail/push, and deployed integration checks remain separate acceptance work.

**Historical web-wiring check, October 28, 2026, Node 24.22.1:** `npm run check` passed lint, both TypeScript checks, **14 API tests + 225 web tests**, and both builds. The web total includes all 85 design/purchase/repository tests, 106 client boundary tests, 5 adapter tests and 29 API screen tests. No live provider/backend calls were made. Current integrated check counts are recorded in [release readiness](release-readiness.md); this older run is not the current baseline.

Issue #10 adds tests for verification navigation with prefilled email, accessible field errors and corrected retry, overlapping verification/resend/logout submissions, rate-limit blocking, navigation cancellation and invalid-link recovery. These screen tests use mocked HTTP; the separate browser acceptance uses real Express routes and disposable MongoDB. See [web authentication](web-authentication.md) for dated results and limits.
