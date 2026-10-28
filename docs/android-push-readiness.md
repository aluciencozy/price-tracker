# Android push readiness

This is an integration boundary, **not working FCM delivery**. Keep its PR separate
from Flutter design and other client/API wiring. It supports parts of
[#17](https://github.com/aluciencozy/price-tracker/issues/17),
[#22](https://github.com/aluciencozy/price-tracker/issues/22), and
[#25](https://github.com/aluciencozy/price-tracker/issues/25); it does not complete
those issues or [#18](https://github.com/aluciencozy/price-tracker/issues/18).

Only `apps/mobile/lib/push/`, offline tests, and this document are added. No
existing screens, main, health API, dependencies, Android configuration, Firebase
project, plugins, or cloud services change. Nothing starts automatically.

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
127.0.0.1, or 10.0.2.2. Its caller owns the client. Inject one stable, locally stored
random installation UUID; do not generate one per request or use a hardware ID.
No UUID generator or persistence dependency is added here.

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

Device bindings are not persisted in this module. Restart requires POST again;
the backend contract must atomically upsert token/installation, deactivate previous
session eligibility on rebind, and revoke bindings on logout/reset/expiry. Offline
logout clears local context but cannot claim server revocation. There is no cleanup
outbox, scheduler, fake backend, or automatic replay. Server ownership, rebind, and
invalid-token handling remain integration requirements.

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

Supply a real `PushEventStore` before wiring events. Its claim must atomically
insert a missing key and evict oldest keys to retain at most the supplied capacity
(default 512, max 1024) **in total**. Persist only keys, not payloads or tokens, in
the API branch's platform-backed secure storage. A read/write pair is not atomic
across isolates; serialize operations and test the eventual implementation. There
is deliberately no pretend-durable default. Test storage is explicitly in memory.
Clear local keys using `store.clear()` on logout; failure must not undo logout or
allow old-session display. Background/pending-event handling is not implemented.

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

## Remaining hooks and proof

1. Parent merges completed Flutter API/design work before adding UI hooks here.
   Connect status/revocation and explicit permission/retry actions to settings;
   sample mode stays unconfigured and never registers sample devices.
2. Adapt secure auth sessions, stable persisted installation UUID, token changes,
   logout/account switching, authorized tracker reads, and safe native navigation.
3. Implement/test the bounded persistent event store using the API branch's secure
   storage. Keep old-session filtering even when clearing storage fails.
4. Separately approve/configure free FCM and implement the real Android permission,
   token, notification-channel and foreground gateway. Background, cold-start/tap,
   and cross-isolate lifecycle handling still need implementation; no plugin is
   installed or configured here.
5. Record real Android foreground/background/tap, permission allowed/denied, token
   rotation, logout/account switch, duplicate-event and restart evidence against
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
cleanup; strict events, recipient isolation, dedupe/eviction/storage failure, and
authorized tap reads.

**October 28, 2026 — Linux, Flutter 3.47.7 / Dart 3.13.5:** dependency resolution
passed without lockfile changes; format check passed (10 files, no changes),
`flutter analyze` reported no issues, and `flutter test --reporter expanded`
passed **53 tests** (49 new push tests plus 4 existing starter tests).

**Review follow-up, same toolchain:** both stale-session error regressions and the
missing-device rotation regression failed before the fixes. Afterward,
`flutter test test/push --reporter expanded` passed **56 tests**, the full suite
passed **60 tests**, analysis reported no issues, and format/diff checks passed.

**Unverified:** secure-store persistence, live endpoint ownership/rebinding,
Android builds/appearance, real permission/token acquisition, foreground/background/
tap FCM delivery, and deployed cross-client delivery/security. No Android visual
tests or browser review are part of this initial build.
