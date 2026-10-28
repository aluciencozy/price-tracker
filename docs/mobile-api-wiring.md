# Flutter API wiring preparation

Related: #4, #11, #20, and the history/preferences portion of #22.

`apps/mobile/lib/client/` follows the shared OpenAPI prepared in contract commit
`47dc976` (`docs/api/openapi.json`, README and examples). That proposal still needs
team review; its business endpoints are not implemented. This branch does not
enable live mode or change existing main/screens/theme/health code. It does not
complete those issues.

## Integration interfaces

- `MobileApi(client: http.Client(), baseUrl: origin)` provides public registration,
  login, resend and forgot-password requests; authenticated `me`/`logout`; and
  preview/list/search/get/create/update/delete/history. `list(search:)` sends `q`.
  Logout, DELETE and GET requests have no body. No mobile cookie/CSRF handling.
- `SessionController(api: api, store: SecureSessionStore())` is a `ChangeNotifier`.
  Call `restore()` at startup, then use its `login`/`logout` for account actions.
  `user` and `sessionId` stay null until a complete verified login or stored-session
  `/me` succeeds. Account operations cannot overlap. An existing signed-in user
  is not re-bootstrapped by `restore()`.
- Listen to the controller: when `user` becomes null, discard every private
  watchlist/history/detail cache and private route. The controller owns no tracker
  cache. Keep sample state separate; never upload it on login.
- Wire DTOs represent nested `OfferIdentity`, separate Steam/provider/deal IDs,
  USD integer-cent `Money`, source attribution, nullable successful prices,
  provider errors/timestamps, trackers, pages, previews, and history. Nullable
  keys must still be present. Zero means free, not unknown. Failed observations
  cannot create zero prices or fictional history.
- Catch `ApiFailure`: `code`, `message`, `status`, `fields`, `requestId`,
  `retryAfterSeconds`, and `resourceId`. Server codes are preserved. Local codes
  include `OFFLINE`, `TIMEOUT`, `INVALID_RESPONSE`, `STORAGE`, `INVALID_SESSION`,
  `AUTH_REQUIRED`, `SESSION_EXPIRED`, `SESSION_CHANGED`, `BUSY`, and
  `ALREADY_SIGNED_IN`. `expiryFailure` reports automatic expiry/deletion errors.

The caller owns and closes the HTTP client and disposes the controller. Initialize
Flutter bindings before using secure storage. These classes do not import sample
data and never substitute sample success for a failed API operation.

## Session behavior

Only a validated, complete, verified seven-day Bearer session is persisted. There
is no refresh endpoint. `expiresAt` is authoritative; the client does not parse
JWT claims as proof of authentication. The server must validate/revoke sessions.

Startup reads encrypted storage and validates `/api/auth/mobile/me`. Expired or
corrupt records and 401s clear the secure record and private session state. A
startup network failure retains credentials for explicit retry, without allowing
private screens. Sign out before replacing a pending/restored account. Normal
private-request network failures leave the signed-in user intact.

An expiry timer clears idle sessions. Requests check expiry both before sending
and before accepting private responses; responses from an older session are
rejected. App-resume UI handling still needs to be connected after design merges.

Logout hides private state and deletes the secure record immediately while
attempting bodyless server revocation with the captured Bearer token, including
credentials retained after an offline startup. An offline logout reports failure:
local sign-out does not prove server revocation. A token may remain valid on the
server until expiry. A failed secure deletion is also explicit; do not claim the
persistent credential was removed. Retry clearing storage before changing users.

## HTTP behavior

Requests resolve fixed paths on the configured API origin, not submitted Steam
URLs or provider/purchase links. Redirects are disabled. A ten-second total
deadline covers headers and response body, with an abort trigger for supported
clients; responses are bounded to 1 MiB. Invalid JSON/types/shapes/UTF-8 and proxy
HTML fail safely, without showing raw response bodies or logging credentials.

Origin syntax matches `HealthApi`: HTTP(S), no credentials, query, fragment, or
path other than `/`. Credentials additionally require HTTPS except debug requests
to localhost, 127.0.0.1 or Android's 10.0.2.2 bridge. The existing Android network
security policy is an additional restriction. Live configuration is deliberately
not added to the old app entry point.

No operation automatically retries. Honor `retryAfterSeconds` before enabling a
retry; the transport preserves the larger valid delta-seconds header/body wait.
For an uncertain create outcome, reuse the same UUID `idempotencyKey` and identical
body; use a new key only for a new save intent. Reconcile/refetch before retrying
PATCH/DELETE. List/history pagination preserves opaque cursors. Repeat the returned
history window for later pages (or omit both bounds to reuse the cursor's window).
History is owned-tracker scoped, with successful observations only, not historical
lows. Target edits never prove a price change.

## Secure storage and platform follow-up

`flutter_secure_storage` is the only new direct dependency: a free plugin for
platform-backed encrypted storage, not an extra service or app framework. Android
uses Keystore-backed RSA-OAEP/AES-GCM defaults. Automatic reset on storage errors is
disabled so a failed read is explicit. Tests inject an in-memory `SessionStore`;
the adapter test uses the plugin's mock platform, not a hardware encryption test.

Before enabling live credentials, confirm Android minSdk >=23 and disable/exclude
secure preferences from Android backup per the plugin instructions. Manifests,
build settings, SDKs and signing keys are intentionally untouched in this pass.
Real device encryption/restart persistence, backup behavior, and APK compilation
remain unverified.

## Remaining after design and contract merge

Align with any final contract review corrections, then add explicit sample/live
configuration and connect native forms, loading/errors, protected navigation,
private-state clearing, pagination/history, stale metadata and source attribution.
Verification/reset complete through the emailed HTTPS browser links; show explicit
instructions to finish there, return to the app and sign in. Do not consume tokens
through app deep links or automatically sign in. Purchase redirects remain safe
human navigation only. Permission/device registration/event handling and Firebase
belong to the separate push-readiness PR; saving a push preference proves no delivery.

## Checks

From `apps/mobile`:

```sh
flutter pub get
dart format --output=none --set-exit-if-changed lib test
flutter analyze
flutter test
```

Offline fixture/MockClient tests cover serialization, headers, 204 responses,
money/null/invalid types, verification/expiry/revocation, encrypted-store adapter,
storage failures, offline behavior, logout races, request/body deadlines and errors.
They do not prove backend ownership, cross-client CRUD, real emails, deployed
integration, Android visuals, or push delivery. No browser/device QA was run.

Preparation validation (October 28): formatting and Flutter analysis passed;
49 Flutter tests passed, including the original health/widget tests. No Node code
changed, so the unrelated Node build/check was not run in this worktree.
