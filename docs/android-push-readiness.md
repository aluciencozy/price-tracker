# Android push readiness

This is an integration boundary, **not working FCM delivery**. Keep its PR separate
from Flutter design and other client/API wiring. It supports parts of
[#17](https://github.com/aluciencozy/price-tracker/issues/17),
[#22](https://github.com/aluciencozy/price-tracker/issues/22), and
[#25](https://github.com/aluciencozy/price-tracker/issues/25); it does not complete
those issues or [#18](https://github.com/aluciencozy/price-tracker/issues/18).

The push module, its tests, and this document are the feature. The final
integration adds small hooks in `main.dart` and `live_session_host.dart`, plus a
read-only `SessionController.activeSession` getter for native integrations. It adds
no dependency, health API change, Android configuration, Firebase project, plugin,
or cloud service. Nothing registers a device in sample mode or before a signed-in
API session exists. A previously granted permission/token may synchronize
automatically after sign-in; Android permission is requested only by the explicit
user action. Sample mode mounts no push controls and performs no push storage or
network work.

## Device integration

`PushRegistration` receives `readSession`, `DeviceEndpoint`, and an optional
`PushPermissionGateway`. Its default gateway always returns **unconfigured**, even
when asked for permission. Only an explicit user action should call
`synchronize(requestPermission: true)`.

Status distinguishes unconfigured, signed out, denied, missing token, offline
(including throttling/service unavailability), registered, and error. Registered
means the API accepted a token, **not that a notification was sent or received**.
Saving a tracker push preference does not register a device or establish delivery.

The wire boundary follows the actual contract in commit `47dc976`, not the earlier
draft containing `fcmToken`/POST 200 or an expanded `price_alert` event:

| Request | Body | Success |
| --- | --- | --- |
| `POST /api/devices` | `{installationId, platform:"android", pushToken}` | `201 Device` |
| `PUT /api/devices/:id` | Same complete body with the rotated token | `200 Device` |
| `DELETE /api/devices/:id` | None | `204`; 404 is already removed |

`Device` is exactly `{id, installationId, platform:"android", sessionId, createdAt,
updatedAt}`; it never contains the push token. Responses must match the captured
session and installation; rotation must keep the same device ID. Application IDs
are opaque 1–128 character ASCII letters/digits/underscore/hyphen strings. UTC
timestamps must be valid dates ending in `Z`; invalid normalized dates are rejected.

`HttpDeviceEndpoint` uses the installed `http.Client`, a five-second total deadline,
and no redirect following. HTTPS is required except local HTTP on localhost,
127.0.0.1, or 10.0.2.2. Its caller owns the client. `SecurePushStorage` generates
one random v4 installation UUID, persists it in platform-backed secure storage, and
reuses it for every request. It is never derived from a hardware ID or regenerated
per request.

The auth owner supplies `PushSession(id, bearerToken)` through `readSession`.
Session snapshots let cleanup use the old owner rather than the newly signed-in
account. The module never logs tokens, credentials, request bodies, response bodies,
or raw transport errors. Keep those out of UI and analytics too.

Call `synchronize()` immediately after session changes, on token rotation, and for
explicit retry. Calls are serialized. The same token does not re-register; rotation
uses PUT. A PUT 404 forgets only the missing binding; the next explicit retry uses
POST, without automatically replaying the write. Other failures retain the binding.
On logout, clear the callback's session first and await synchronization
**before revoking the old API session when possible**. Local registration context
clears immediately; a late successful registration cannot restore old-account UI.

`revocation == unconfirmed` means cleanup failed or a registration response may
have been lost/invalid. It remains sticky for this coordinator's lifetime: a later
unrelated successful removal cannot prove an earlier uncertain cleanup succeeded.
Permission denial or token loss also requests removal of an existing device.
The HTTP adapter honors positive delta-seconds `Retry-After` on 429/5xx by blocking
subsequent requests until the wait elapses; it never automatically retries a write.
`retryAfterSeconds` is a failure-time hint for UI, not a live countdown.

Only the installation UUID and bounded foreground alert keys are persisted. Device
bindings themselves are not; restart requires POST again. The backend contract must
atomically upsert token/installation, deactivate previous session eligibility on
rebind, and revoke bindings on logout/reset/expiry. Offline logout clears local
context but cannot claim server revocation. There is no cleanup outbox, scheduler,
fake backend, or automatic replay. Server ownership, rebind, and invalid-token
handling remain integration requirements.

## Safe event boundary

`PushEvent.parse` accepts exactly the contract's all-string data object:

```json
{"schemaVersion":"1","type":"price_target_reached","eventId":"episode_example","deliveryId":"delivery_push_example","recipientSessionId":"session_example","trackedItemId":"tracker_example","productId":"product_1","observedAt":"2026-10-26T16:34:42.829Z"}
```

Unknown/missing fields, nonstrings, invalid IDs/dates, other versions/types, URLs,
titles, price/target fields, and the old draft payload are rejected. This object is
a routing hint, not ownership or authoritative product information. There is no
purchase URL to navigate or fetch. Price/target safety (integer cents including
zero), exact Steam/US/USD context, CheapShark attribution and safe human-only
purchase routing belong to the authorized tracker/product API adapter. Do not
invent price details from the event or describe a target edit as a new sale.

`PushEvents.foreground` checks the recipient session before storage/UI, claims
`(recipientSessionId,eventId)`, then rechecks the session after awaiting storage.
`onForeground` receives only the validated routing hint. It can update/refetch
current state or show a generic notice; fetch authorized tracker details first if
displaying private game/price information. Accepted means the callback ran, not
verified Android notification presentation or delivery.

`SecurePushStorage` is the production `PushEventStore`. Its claim atomically inserts
a missing key in one serialized secure-storage transaction and evicts oldest keys to
retain at most the supplied capacity (default 512, max 1024) **in total**. It
persists only keys, not payloads or tokens. Reads and writes are serialized within
the foreground isolate; they are not atomic across isolates, so a future background
handler must route claims through the same owner. Corrupt or oversized data fails
closed. Test storage is explicitly in memory. Clear local keys using
`store.clear()` on logout; failure must not undo logout or allow old-session display.
Background/pending-event handling is not implemented.

Storage failure fails closed. Bounded eviction, clearing/reinstall, and process
failure can lose dedupe protection. A claim precedes the callback, so a crash/UI
failure can suppress a retry without display. This is **not exactly-once display
or delivery** and never replaces server episode/channel delivery records. Stable
delivery IDs remain stable across retries too; display dedupe uses the episode's
event ID even if a malformed sender varies the delivery ID.

`PushEvents.tap` deliberately does not suppress a tap just because foreground
handling already ran. It checks the session, calls
`readOwnedTracker(capturedSession, trackedItemId)`, and checks the session again
after awaiting the authenticated read, including error paths. A result from an old
session returns wrong-session, not an expiry/error for the newly signed-in account.
Map 404 to null and 401 to
`PushSessionExpired`; other errors return unavailable. Only a matching authorized
tracker/product reaches `openTracker`. Handle deleted/foreign, expired-session,
offline, and mismatched results with a safe current screen—not payload navigation.

## Application wiring

`PushSessionIntegration` mounts inside the API-mode session host. A signed-in
session creates a `PushIntegrationController`; sample mode and signed-out states do
not. Sign-out or account switch clears local registration context and alert keys
immediately, attempts removal with the captured old token, and never restores
old-account UI from a late response. Session changes are serialized with device
registration.

`PushAccountStatus` is added to the account screen beside the existing account
status. It distinguishes unconfigured, signed out, denied, missing token, offline,
registered, and error, and offers an explicit permission/retry action only when a
gateway could act. The default `UnconfiguredPushGateway` always reports that no
FCM provider or permission/token source is installed; the UI says so instead of
showing fake permission or delivery. A saved tracker push preference remains
separate from permission, device registration, and delivery.

`PushEventDispatcher` is the future FCM boundary. `foreground`, `tap`, and
`tokenChanged` delegate to the session-scoped controller and fail closed when no
controller is mounted. No listener, background isolate, or pending/cold-start queue
is installed. `PushTrackerNavigation` sits inside the session-keyed navigator and
opens only a tracker returned by the authorized read; deleted, foreign, expired,
offline, and mismatched results show a current-screen notice.

`SecurePushStorage` persists only the installation UUID and bounded
`(sessionId, eventId)` keys. Operations are serialized in this isolate, and corrupt
or oversized data fails closed. Logout and account changes clear the keys; a failed
clear blocks foreground display and stays retryable. Future background handlers must
coordinate with this owner rather than race independent secure-storage writes.

## Remaining hooks and proof

1. Separately approve and configure free FCM, then implement the real Android
   permission, token, notification-channel, and foreground gateway. Wire the
   gateway to `PushEventDispatcher`; no plugin or cloud project is installed here.
2. Implement background, cold-start, and tap lifecycle handling, including
   cross-isolate coordination for the persistent event store.
3. Verify device rebind/rotation and revocation against the real owned endpoints.
4. Record real Android foreground/background/tap, permission allowed/denied, token
   rotation, logout/account switch, duplicate-event, and restart evidence against
   actual owned endpoints. Use real Steam prices with target changes, not a
   fabricated discount. Leave #17/#18/#22/#25 open until their full criteria pass.

## Checks

From `apps/mobile`:

```sh
flutter pub get
dart format --output=none --set-exit-if-changed lib test
flutter analyze
flutter test
```

Offline tests cover exact device serialization, strict responses, safe origins,
timeouts/throttling, permission/status states, rotation, logout races and uncertain
cleanup; strict events, recipient isolation, dedupe/eviction/storage failure,
persisted installation UUID, authorized tap reads, application status, account
switches, and session-clearing navigation.

**October 28, 2026 — Linux, Flutter 3.47.7 / Dart 3.13.5:** dependency resolution
passed without lockfile changes; format check passed (10 files, no changes),
`flutter analyze` reported no issues, and `flutter test --reporter expanded`
passed **53 tests** (49 new push tests plus 4 existing starter tests).

**Review follow-up, same toolchain:** both stale-session error regressions and the
missing-device rotation regression failed before the fixes. Afterward,
`flutter test test/push --reporter expanded` passed **56 tests**, the full suite
passed **60 tests**, analysis reported no issues, and format/diff checks passed.

**Application integration, same toolchain:** after merging the finished Flutter
API/design work, formatting and analysis were clean and the full suite passed
**181 tests**, including the push integration and durable-storage tests.

**Unverified:** platform-backed secure storage on a real Android device, live
endpoint ownership/rebinding, Android builds/appearance, real permission/token
acquisition, foreground/background/tap FCM delivery, background/restart lifecycle,
and deployed cross-client delivery/security. No Android visual tests or browser
review are part of this initial build.
