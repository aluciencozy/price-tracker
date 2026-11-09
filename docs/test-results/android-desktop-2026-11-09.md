# Android desktop acceptance — November 9, 2026

This records a local, controlled transport test, not production acceptance. The
API and disposable MongoDB used synthetic accounts and a tracker labeled
`[LOCAL TRANSPORT FIXTURE] Portal 2`. It had no current price, purchase link,
observations, or price history. Manual data-only FCM events used the normal
`price_target_reached` schema but were **not qualifying price episodes**. No real
mail or price provider was called during this transport test.

The client and server credentials were validated as belonging to the same Firebase
project; credentials were not committed. Six controlled FCM sends were accepted
by the provider and all six device broadcasts were observed. Provider acceptance
alone is not receipt; the device observations below are separate evidence. Project
Spark/billing status and production approval were not independently established.

## Environment and checks

- Android 16 / API 36 Google APIs emulator with Google Play services 252635038;
  the Google Play Store was not required for this test.
- Flutter 3.47.9 / Dart 3.13.7; the repository remains pinned to Flutter 3.47.7 /
  Dart 3.13.5. Node 24.22.1, npm 12.2.1, and local disposable MongoDB 8.0.16.
- At `ec59ddd`, the independently reviewed root check passed lint, both
  typechecks, both builds, and **700 tests**: 17 contract, 409 API, and 274 web;
  zero skips. The independent mobile review passed **237 Flutter tests**.
- The permission-cleanup debug APK at `4a9a968` built with offline Gradle using a
  user-owned Android SDK overlay. It was not installed for the observations below.

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
| Signed-out relaunch | PASS, limited | Activity relaunch remained signed out. A fresh process restart after final logout was **not confirmed** because the attempted background process kill did not terminate it. Offline startup regression tests are not device proof. |
| Permission denial, initial build | FAIL | Revoking notification permission killed the app. B's session restored but the in-memory device ID was lost while one server binding remained. The explicit retry prompt was denied; OS permission remained denied and the binding remained. Permission was restored and normal logout removed the binding. |
| Permission denial, integrated fix | NOT RUN | The reviewed API owned-installation deletion and mobile durable cleanup/display-suspension fixes are integrated (`5a1b448` and `4a9a968`). Their device retest is pending; do not infer device success from the 237 offline tests or APK build. |
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

Retest permission denial on the integrated build. Token rotation, revoked-session
and deleted/foreign tracker tap cases, reliable offline recovery, and final-logout
fresh-process restoration are not established by this desktop run. A real
qualifying episode with email and push through the durable outbox, repeated-check
deduplication, and real mailbox receipt were not tested. No new price drop is
claimed. The separately documented [live adapter lookup](live-adapter-2026-11-09.md)
is not part of this transport fixture.

Remote MongoDB and VM/HTTPS deployment, independent daily-worker operation, $0
quotas, Firebase project approval, 90-day history retention approval, and
SwaggerHub publication remain owner/external gates. Wireframe work is cancelled;
UML and PowerPoint remain deferred to the final course-artifact pass.
