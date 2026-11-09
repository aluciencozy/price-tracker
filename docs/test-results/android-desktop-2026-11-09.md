# Android desktop acceptance — November 9, 2026

This records a local, controlled transport test, not production acceptance. The
API and disposable MongoDB used synthetic accounts and a tracker labeled
`[LOCAL TRANSPORT FIXTURE] Portal 2`. It had no current price, purchase link,
observations, or price history. Manual data-only FCM events used the normal
`price_target_reached` schema but were **not qualifying price episodes**. No real
mail or price provider was called during this transport test.

The client and server credentials were validated as belonging to the same Firebase
project; credentials were not committed. Eight controlled FCM sends were accepted
by the provider; device arrival was verified for seven. The final duplicate's
arrival was not verified. Provider acceptance alone is not receipt; the device
observations below are separate evidence. Project
Spark/billing status and production approval were not independently established.

## Environment and checks

- Android 16 / API 36 Google APIs emulator with Google Play services 252635038;
  the Google Play Store was not required for this test.
- Flutter 3.47.9 / Dart 3.13.7; the repository remains pinned to Flutter 3.47.7 /
  Dart 3.13.5. Node 24.22.1, npm 12.2.1, and local disposable MongoDB 8.0.16.
- At `ec59ddd`, the independently reviewed root check passed lint, both
  typechecks, both builds, and **700 tests**: 17 contract, 409 API, and 274 web;
  zero skips. The independent mobile review passed formatting, analysis, and
  **237 Flutter tests**.
- The permission-cleanup debug APK at `4a9a968` built with offline Gradle using a
  user-owned Android SDK overlay. Initial transport observations used the older
  build; the permission retest installed the fixed APK without clearing app data.

## Results

| Scenario | Result | Observation and limit |
| --- | --- | --- |
| Foreground | PASS | One FCM broadcast produced one SQLite claim and the in-app “Price alert received” notice. The initial observer missed the transient snackbar; zero OS notifications is expected in foreground. |
| Background and tap | PASS | A generic OS notification opened the owned local fixture, with target $0 and current price unavailable; no history was shown. |
| Duplicate | PASS | A second broadcast arrived but receipts remained at two and no new OS notification appeared. |
| Restart duplicate | PASS | After a background process kill without force-stop or data wipe, account A restored without login. A repeated event reached the new process; receipts stayed at two and no OS notification appeared. |
| Terminated and tap | PASS | After a background process kill, a new data event woke the process; its notification opened the correct owned fixture. |
| Account switch | PASS | A logged out with zero eligible bindings, B logged in with one, and a real push notification opened B's owned fixture. |
| Normal logout | PASS, limited | Both native logouts left zero eligible bindings; after B logout SQLite was empty and the signed-out screen appeared. No stale external message was sent because the harness correctly found no eligible device. |
| Initial signed-out relaunch | PASS, limited | Activity relaunch remained signed out. A fresh process restart was not confirmed in this initial phase because the attempted background process kill did not terminate it. The later fixed-build fresh-process test passed below. |
| Permission denial, initial build | FAIL | Revoking notification permission killed the app. B's session restored but the in-memory device ID was lost while one server binding remained. The explicit retry prompt was denied; OS permission remained denied and the binding remained. Permission was restored and normal logout removed the binding. |
| Permission denial, legacy upgrade | PASS | Against the upgraded local API, revoking permission on the old build killed the process and left A's binding. Installing the fixed APK over it without clearing data restored A without a new login, showed denied status, and removed both accounts' eligible bindings. The authenticated SQLite session remained present with zero receipts; display eligibility was suspended, not the session cleared. |
| Permission denial, fixed restart | PASS | Grant and explicit retry registered A; revocation killed the process. Normal fixed-build relaunch retained A's authentication, showed denial without a prompt, and left zero eligible bindings. Grant and retry registered A again. No request-level API log was captured, so the exact route sequence was not independently established on device. |
| Post-fix background and tap | PASS | A new accepted FCM event arrived in the background, added one SQLite receipt, and showed a generic OS notification. Its tap opened the owned local fixture with target $0 and current price unavailable. |
| Permission change and receipt retention | PASS | Revoking permission killed the process; normal relaunch restored A's session, showed denied status, and left A and B with zero eligible bindings. The same session's receipt remained present. Grant and explicit retry registered A again without losing the receipt. |
| Post-permission duplicate | UNVERIFIED | FCM accepted the duplicate while the same session had permission and an eligible A binding. The receipt count stayed at one and no OS notification appeared over 121 seconds, but usable broadcast logs were absent, so device arrival and full duplicate suppression were not verified. The eight-send cap was exhausted; no retry was made. |
| Final fresh-process logout | PASS | Normal native logout left A and B with zero eligible bindings, no SQLite session or receipts, and a signed-out screen. A confirmed fresh process also remained signed out with zero eligible bindings. No force-stop, data clear, or uninstall was used. |
| Offline queued FCM | NOT RUN | The emulator could not be shown reliably offline; no offline send was attempted. Radio settings were restored. |

## Shared web and mobile API

**PASS, local synthetic data only:** account B used a normal web cookie session
and mobile bearer session against the same local API. Web changed the target from
$0 to $0.01 and enabled email; mobile showed both. Mobile then saved target $0.02
with tracking on, email off, and push on; web refresh confirmed those values. An
accidental pause was corrected through the normal editor. A request for A's
tracker as B returned 404. Both clients logged out: web current-user returned
401, native showed blank sign-in fields, and A and B had zero eligible bindings.
This verifies neither deployed behavior nor real-time polling; the web check used
refresh. No provider lookup, email, or FCM send was made for this cross-client pass.

## Remaining acceptance

The permission-denial device-fix gate passed. The post-permission duplicate's
arrival remains unverified, separate from the earlier duplicate and restart
duplicate passes. Token rotation, revoked-session and deleted/foreign tracker tap
cases, and offline queued recovery were not tested. A real
qualifying episode with email and push through the durable outbox, repeated-check
deduplication, and real mailbox receipt were not tested. No new price drop is
claimed. The separately documented [live adapter lookup](live-adapter-2026-11-09.md)
is not part of this transport fixture. The permission cleanup retest itself made
no FCM, email, or provider sends; two subsequent controlled FCM sends brought the
total to eight accepted.

Live history collection is blocked pending team/source-owner retention review,
including for disposable tests; therefore the real qualifying-episode test must
not proceed yet. Neither the live adapter lookup nor these FCM transport tests
created history observations. Real email credentials and VM access were unavailable.

Remote MongoDB and VM/HTTPS deployment, independent daily-worker operation, $0
quotas, Firebase project approval, 90-day history retention approval, and
SwaggerHub publication remain owner/external gates. Wireframe work is cancelled;
UML and PowerPoint remain deferred to the final course-artifact pass.
