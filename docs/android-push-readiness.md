# Android push readiness

**Native implementation exists; live delivery is not proven.** This supports
[#17](https://github.com/aluciencozy/price-tracker/issues/17),
[#22](https://github.com/aluciencozy/price-tracker/issues/22) and
[#25](https://github.com/aluciencozy/price-tracker/issues/25). Leave real receipt and
[#18](https://github.com/aluciencozy/price-tracker/issues/18) acceptance open until
configured device tests pass. See [exact setup flags](mobile-push-setup.md).

## Implemented lifecycle

- `main.dart` creates the official Firebase gateway only for explicitly configured
  Android API mode; initialization is lazy, after a verified API session exists.
  Sample/default/missing config initializes no Firebase and makes
  no push requests. Manifest auto-initialization is disabled/removed.
- Permission is read after sign-in/resume, requested only by a user action.
  `getToken` and `onTokenRefresh` feed the existing serialized `PushRegistration`.
  POST registers, PUT rotates, DELETE removes using captured owner credentials.
  HTTP calls have a five-second deadline, no redirects and bounded retry hints.
- Status distinguishes unconfigured, signed out, denied, missing token, offline,
  registration failure and API-confirmed registration. None proves delivery.
- Foreground data-only messages use the shared durable claim and a **generic
  in-app notice**. Background/terminated messages run a top-level entry-point
  callback in the Firebase isolate, initialize with the same public options and
  use the same SQLite store plus an Android local notification channel.
- Background notifications show only `Price Tracker` and `An alert is available.
  Sign in to check your saved games.` They never display payload game/title/price,
  target, account details or claimed sale. One stable native notification ID and
  `onlyAlertOnce` reduce repeated native alerts, but are not delivery transactions.
- Local notification launch details/warm responses and FCM initial/opened events
  queue at most one routing hint until the session navigator exists. Taps never
  use the display-dedup guard: opening an already-seen alert is legitimate.
- Tap checks the recipient, fetches the owned tracker through the current Bearer
  API, rechecks session after the await, and verifies tracker/product identity.
  Deleted/foreign (404), expired (401), offline and mismatched responses stay on a
  safe current screen. No event URL is accepted or followed. Prices, attribution
  and purchase links come only from the owned API; the existing purchase
  normalization patch is retained.

## Shared contract (unchanged)

| Request | Body | Success |
| --- | --- | --- |
| `POST /api/devices` | `{installationId, platform:"android", pushToken}` | `201 Device` |
| `PUT /api/devices/:id` | Same full body with rotated token | `200 Device` |
| `DELETE /api/devices/:id` | None | `204`; 404 already removed |

Device is exactly `{id, installationId, platform:"android", sessionId, createdAt,
updatedAt}`, never the token. IDs, UTC dates, installation and captured session
must match. The random installation UUID is in platform secure storage, not a
hardware identifier. Bindings are rebuilt with POST after restart; server upsert
and rebind must be atomic. Unknown write results remain uncertain; writes are not
blindly replayed. Removal failure remains explicit rather than claiming revocation.

Strict PushEvent example:

```json
{"schemaVersion":"1","type":"price_target_reached","eventId":"episode_example","deliveryId":"delivery_push_example","recipientSessionId":"session_example","trackedItemId":"tracker_example","productId":"product_1","observedAt":"2026-10-26T16:34:42.829Z"}
```

Only these eight string fields are accepted. Unsupported types/versions, malformed
IDs/dates, extra URLs, titles or prices fail closed. Server messages **must be
data-only**. An FCM `notification` block can auto-display outside Dart's checks and
is not a supported/private-safe sender contract.

## Cross-isolate session and episode safety

`AtomicPushStorage` uses a small local SQLite database shared by both Flutter
engines. It stores only the authorized session ID/expiry and unique
`(sessionId,eventId)` receipts. JWTs remain exclusively in platform secure storage;
there is no SQLite/preference credential copy or background authenticated fetch.
`SecurePushStorage` still supplies the installation UUID and is the legacy
foreground-only fallback for unconfigured/test integrations, never the FCM receipt
store. Its isolate-local serialization is not used for background claims.
Each isolate caches one separate connection (`singleInstance:false`); reusing a
native handle across engines could trigger sqflite's hot-restart rollback of the
other engine's active transaction. SQLite itself coordinates the writer locks.
Every new connection runs `PRAGMA busy_timeout = 0` in `onConfigure`. Android's
single native worker must not wait inside a competing BEGIN while the lock owner's
COMMIT is queued behind it. Fail-fast BUSY/LOCKED returns to Dart, whose existing
bounded delay yields the worker to that COMMIT. No native busy wait or longer
retry budget is used; transaction bodies and uncertain side effects are not replayed.

Each SQLite writer transaction checks the persisted session/expiry and atomically
inserts a unique receipt. Session rebind/logout uses that same writer boundary.
Receipts survive same-session restarts. Up to 512 native episode keys are retained;
at capacity new displays fail closed, **without evicting and replaying old keys**.
Lock acquisition retries SQLITE_BUSY/LOCKED for up to two seconds; a transaction
body, failed commit or uncertain notification is never retried. Storage failure
means no fallback display.

The receipt commits **before** display. A second writer transaction rechecks the
session and holds the writer lock while awaiting the generic presenter. Logout
therefore either wins and prevents display, or follows the completed display and
cancels notifications. Memory/private routes drop synchronously; logout also awaits
durable deactivation through `beforeLocalSessionClear`. Secure credential deletion
runs even if native cleanup fails, and cleanup failure blocks another login until
retry succeeds. A failed cancellation cannot roll back session deactivation.
Remote device cleanup remains best effort; offline sign-out cannot prove server
revocation. Server-side revocation while the app is offline is not knowable from a
message alone: a still-bound, unexpired session can produce **generic text only**.
Foreground/resume/401 checks clear revoked sessions before private navigation.

Startup does not erase native state while the secure read or authenticated `/me`
check is pending: a valid same-session restore must keep its episode receipts.
If the secure read instead confirms **no saved credentials**, restoration awaits
the existing local-cleanup barrier, just as rejected, expired or malformed records
do. This removes an orphaned SQLite binding left by process death after secure
credential deletion but before native cleanup. Restoration cannot complete or
permit another login before that cleanup settles; failure remains explicit and
requires retry. Disposed pending restores cannot clear a replacement binding.

This favors **at-most-once handling safety within retained session state**, not
guaranteed or exactly-once display. Process death between claim and display can
lose the notification; death after native display but before completion does not
replay its committed receipt. Clearing local keys explicitly, reinstalling or data
loss removes dedup protection. FCM/Android may delay/drop data, especially offline,
under battery restrictions or after force-stop. The app must be reopened after
force-stop. Server episode/channel delivery records are still required.

## Offline validation and remaining gates

Run from `apps/mobile`:

```sh
flutter pub get
dart format --output=none --set-exit-if-changed lib test
flutter analyze
flutter test --reporter expanded
flutter build apk --debug
```

Tests inject gateway, messaging, presenter, session store and database boundaries.
Real SQLite FFI tests use independent connections and separate Dart isolates; they
cover duplicate foreground/background arrivals, same-session restart, account
switch, expiry, capacity, failed presentation, failed cancellation and logout
overlap. Other tests cover permission/refresh streams, cold/warm taps, API headers,
rotation/throttling, old-session responses, owned reads and native privacy barriers.
No routine test contacts Firebase, CheapShark or a real API.

Debug APK compilation passes with Flutter 3.47.9/Dart 3.13.7 and the locked
compatible plugins. **November 9, 2026:** formatting and analysis passed and all
**229 Flutter tests passed** (offline, including the preserved purchase-safety tests).
The critical-review follow-up adds a real-SQLite test behind one shared FIFO
worker, modeling Android's default 2.5-second native busy wait. Without fail-fast
configuration it reproduced failed logout; with the fix it verifies COMMIT,
notification cancellation and durable old-session rejection after reopen. A
separate test reads `PRAGMA busy_timeout` on every test connection and confirms
zero. These are scheduling/SQLite regressions, not Android-device evidence.
The startup follow-up adds nine real-SQLite integration regressions for the crash
gap, same-session receipt retention without early clear, failed restoration,
awaited cleanup/account-switch exclusion and disposed old-owner callbacks.
The default debug APK builds at `apps/mobile/build/app/outputs/flutter-apk/app-debug.apk`;
it contains no Firebase project configuration and is not enabled for delivery.
Firebase Core emits an upstream legacy-Kotlin-plugin warning;
it does not prevent this build. Device rendering, platform secure storage/backup,
real permission/token acquisition, FCM receipt, force-stop recovery, actual mounted
API ownership/rebind, server worker startup and cross-client flow remain unverified.
No browser, emulator or live Firebase session was used. Record actual device
evidence using the checklist in the setup guide before claiming readiness.
