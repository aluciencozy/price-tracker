# Flutter API wiring

Related: #4, #11, #20, and the history/preferences portion of #22.

The Flutter adapter and screens follow shared contract `829b37a`,
[PR #36](https://github.com/aluciencozy/price-tracker/pull/36), without importing
sibling worktree files at runtime. The contract still needs API-owner acceptance
and actual backend implementation. This branch is based on Flutter design PR #35;
it preserves that design and does not complete live-backend/course acceptance.

## Select the data source

Default `flutter run` uses `DATA_SOURCE=sample`: labeled in-memory data, no automatic
HTTP, no credential-store access, no upload. The existing health diagnostic is
still an explicitly requested action only. To use the real API boundary:

```sh
flutter run --dart-define=DATA_SOURCE=api --dart-define=API_BASE_URL=http://10.0.2.2:4000
```

Use an HTTPS origin (without `/api`) for deployed builds. Invalid `DATA_SOURCE`
values or API origins fail closed with a configuration error; they never start
sample fallback. Changing mode requires restarting with new build configuration.
`API_BASE_URL` alone does not enable API mode. No secrets belong in Dart defines.

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
- `LiveSessionHost` performs startup restoration, protects a session-keyed nested
  navigator, and disposes the HTTP repository/cache on session loss. Dialogs also
  belong to that nested navigator, so private detail/removal/purchase routes do
  not survive logout or expiry. Old asynchronous responses cannot restore them.
- `HttpTrackerRepository` implements the design's `TrackerRepository`,
  `PagedTrackerRepository` and `HistoryMetadataRepository`. It maps wire DTOs to
  UI values, stores create-intent UUIDs across uncertain retries, passes private
  title search as `q` (omitted for a blank/cleared filter, including later pages),
  and exposes `hasMore`/`loadMore` for watchlist pages. History
  repeats the returned window across pages, exposes the retention boundary, and
  never imports illustrative sample observations. Its bounded loop reports an
  error rather than silently truncating unexpectedly large history.
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
  The adapter preserves field messages, owned duplicate IDs and retry waits in
  `RepositoryException`; screens retain drafts and explain failures.

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
rejected. App resume calls `checkSession()` against `/me`; a network error retains
the signed-in session and shows an error, while 401/expiry clears private state.
That read-only check never holds the account-action lock: sign-out clears private
routes/credentials immediately even while `/me` is pending. Late checks from the
old session cannot restore data or overwrite the next account.

Logout hides private state and deletes the secure record immediately while
attempting bodyless server revocation with the captured Bearer token, including
credentials retained after an offline startup. An offline logout reports failure:
local sign-out does not prove server revocation. A token may remain valid on the
server until expiry. A failed secure deletion is also explicit; do not claim the
persistent credential was removed. Retry clearing storage before changing users.
`cleanupRequired` blocks new credentials until the local deletion retry succeeds.
When no credentials remain in memory, retrying logout performs local cleanup only,
without a false `AUTH_REQUIRED` failure. `revocationUnconfirmed` remains honest
about a previous offline revocation. Disposed controllers check immediately after
awaited login/storage reads before writing credentials or activating a token.

Real auth fields include email/password, optional registration name, resend and
forgot-password. Unverified login explains the block. Verification/reset screens
instruct users to finish via their emailed browser links, return and sign in.
Neither screen consumes a token or automatically logs in. No browser cookies,
CSRF bootstrap, app deep links, or additional launcher dependency are involved.

## HTTP behavior

Requests resolve fixed paths on the configured API origin, not submitted Steam
URLs or provider/purchase links. Redirects are disabled. A ten-second total
deadline covers headers and response body, with an abort trigger for supported
clients; responses are bounded to 1 MiB. Invalid JSON/types/shapes/UTF-8 and proxy
HTML fail safely, without showing raw response bodies or logging credentials.

Origin syntax matches `HealthApi`: HTTP(S), no credentials, query, fragment, or
path other than `/`. Credentials additionally require HTTPS except debug requests
to localhost, 127.0.0.1 or Android's 10.0.2.2 bridge. The existing Android network
security policy is an additional restriction.

No operation automatically retries. Honor `retryAfterSeconds` before enabling a
retry; the transport preserves the larger valid delta-seconds header/body wait.
Auth/editor/load buttons show a countdown, and the HTTP repository prevents new
requests during the same server-requested wait. No busy-loop or automatic replay.
For an uncertain create outcome, reuse the same UUID `idempotencyKey` and identical
body; use a new key only for a new save intent. Reconcile/refetch before retrying
PATCH/DELETE. List/history pagination preserves opaque cursors. Repeat the returned
history window for later pages (or omit both bounds to reuse the cursor's window).
History is owned-tracker scoped, with successful observations only, not historical
lows. Target edits never prove a price change.

## Secure storage and platform setup

`flutter_secure_storage` is the only new direct dependency: a free plugin for
platform-backed encrypted storage, not an extra service or app framework. Android
uses Keystore-backed RSA-OAEP/AES-GCM defaults. Automatic reset on storage errors is
disabled so a failed read is explicit. Tests inject an in-memory `SessionStore`;
the adapter test uses the plugin's mock platform, not a hardware encryption test.

The locked plugin's Android Gradle file requires minSdk 23 and Java 17. The app
uses `maxOf(flutter.minSdkVersion, 23)` and retains its Java/Kotlin 17 configuration.
Its manifest disables auto-backup and references backup rules excluding all shared
preferences for legacy backup and Android 12+ cloud/device transfer. This prevents
credential preferences being restored without their Keystore key. SDKs/signing
keys were not changed. Actual merged-manifest behavior, encryption/restart
persistence, backup transfer behavior and APK compilation remain unverified.

## Extension points for the separate push PR

`PriceTrackerApp.sessionIntegrationBuilder(context, session, child)` can wrap the
live session host with a separate lifecycle coordinator. It is never invoked in
sample mode. Listen to `SessionController.user`/`sessionId` for account changes;
do not use a device/installation ID as an owner credential. The app owns and
disposes this controller. `accountStatusBuilder(context, session)` inserts a
device-status widget into live account settings. No push provider, permissions,
device APIs or event handling are implemented here. Saved push preferences do not
prove registration or delivery. Keep purchase redirects human-only and never
probe them during integration.

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

The focused session review regressions pass, including disposed delayed login A
versus newer account B sharing storage, disposed delayed restore, and a successful
local cleanup retry after server logout 204/storage deletion failure. Full-check
results: `dart format --output=none --set-exit-if-changed lib test` passed,
`flutter analyze` found no issues, and all **103 Flutter tests passed**, including
the preserved sample/design tests. No Node files changed; Node checks were not
run for this Flutter-only change. No live API/provider requests were used.
