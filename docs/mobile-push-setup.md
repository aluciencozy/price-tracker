# Android push setup

The native client is implemented and builds without a Firebase project. **Real
receipt is unverified.** Default/sample/unconfigured builds do not initialize
Firebase, request permission/tokens, or register devices. Android auto-initialization
is removed and messaging auto-init is disabled in the manifest.

## Public client configuration

1. Use a team-owned Firebase project on **Spark**, without billing/payment method,
   Blaze, trials, Cloud Functions, Firebase Auth, Firestore or Analytics.
   [FCM is no-cost](https://firebase.google.com/pricing). Our Express API owns accounts,
   tracking and sending; no Firebase account/database SDK is added.
2. Register Android application **`dev.pricetracker.price_tracker`**. Copy its
   public API key, Android app ID, project number (sender ID), and project ID.
   These are public client identifiers, not service-account credentials.
3. From `apps/mobile`, build with the actual values in place of the placeholders:

```sh
flutter pub get
flutter build apk --debug \
  --dart-define=DATA_SOURCE=api \
  --dart-define=API_BASE_URL=http://10.0.2.2:4000 \
  --dart-define=ANDROID_PUSH_ENABLED=true \
  --dart-define=FIREBASE_API_KEY=YOUR_ANDROID_PUBLIC_API_KEY \
  --dart-define=FIREBASE_APP_ID=1:YOUR_PROJECT_NUMBER:android:YOUR_APP_HEX_ID \
  --dart-define=FIREBASE_MESSAGING_SENDER_ID=YOUR_PROJECT_NUMBER \
  --dart-define=FIREBASE_PROJECT_ID=your-project-id
```

Use the same defines with `flutter run` once a device is available. Android 7+
with Google Play services, or a Google Play emulator image, is required by FCM.
For USB use `adb reverse tcp:4000 tcp:4000` and origin `http://127.0.0.1:4000`.
Deployed builds require an HTTPS API origin, **without `/api`**. Values are compiled
into the APK; rebuild when changing them. A local ignored JSON file can instead
provide these same public keys through `--dart-define-from-file=/path/to/file.json`.

No `google-services.json`, Google Services Gradle plugin, generated
`firebase_options.dart`, or missing optional import is needed: initialization uses
explicit `FirebaseOptions`. Do not commit project-specific generated configuration.
The gateway validates normal Android app-ID/sender/API-key/project-ID shapes; absent,
disabled or malformed configuration reports **unconfigured**, not delivery enabled.
Wrong but plausible project values can still fail initialization/registration and
show a retryable error. Sign in with a verified account and use **Account and
settings → Check permission / retry device** to request permission explicitly.
Previously granted permission is read without prompting after sign-in/resume.

## Locked SDK compatibility

`firebase_core 4.15.2`, `firebase_messaging 16.7.1`,
`flutter_local_notifications 22.0.0` and `sqflite 2.4.5` are locked in
`apps/mobile/pubspec.lock`. Messaging 16 uses `getToken`/`onTokenRefresh` registration
tokens, matching the existing `firebase-admin send({token})` backend. Messaging 17
introduces FID-based `register`/`onRegistered`; do not substitute those IDs into the
token contract or blindly upgrade it. Notifications 22 works with this project's
SDK 36/AGP 9.1.0; version 23 needs SDK 37. Desugaring is enabled for the presenter.
See the [pinned Messaging API](https://pub.dev/documentation/firebase_messaging/16.7.1/)
and [Notifications 22 setup](https://pub.dev/packages/flutter_local_notifications/versions/22.0.0),
alongside Firebase's [Flutter receive guide](https://firebase.google.com/docs/cloud-messaging/flutter/receive-messages).
No SDK source or signing keys are changed. Release configuration still uses debug
signing and is not ready for distribution.

## Backend integration gate

The configured API must mount authenticated, verified, owned `/api/devices`
POST/PUT/DELETE and tracker reads. Registration uses `{installationId,
platform:"android", pushToken}` with Bearer authorization; the session owner comes
from the API session, never a client user ID. The API must atomically rebind the
installation/token and revoke devices on logout/reset/expiry.

Server credentials stay server-side. `PRICE_TRACKING_ENABLED` defaults to `false`;
tracking requires `MONGODB_URI` and a stable `TRACKING_CURSOR_SECRET` of at least
32 characters. Server push also defaults to off and requires explicit
`PRICE_PUSH_ENABLED=true`, tracking enabled, a stable `AUTH_JWT_SECRET` (at
least 32 characters, required in production), `FIREBASE_PROJECT_ID`, and
deployment-managed Application Default Credentials (ADC).
`GOOGLE_APPLICATION_CREDENTIALS` may point to a private
credential file outside Git, readable by the API service account. Never put a
private key in a Dart define, APK, or mobile config. Credentials alone do not
start a worker; enable sending only after owner approval of the Firebase project,
quotas, and Android receipt. See [backend runtime settings](backend-runtime.md)
for all flags and recovery behavior.

Send the existing strict all-string, **data-only** PushEvent schema (see
[readiness](android-push-readiness.md)). Do not add an FCM `notification` block:
Android can auto-display it before Dart session/privacy checks. High-priority data
delivery may still be throttled by Android/FCM; force-stop requires reopening.

## Real-device proof still required

Record device/Android/Google Play versions, build, date and pass/fail results,
without tokens or user details. Test permission allowed/denied, token rotation,
foreground generic notice, background generic notification, warm/terminated tap,
restart duplicate suppression, logout/account switching during receipt, revoked
session, deleted/foreign tracker taps and offline recovery. Tap navigation must
fetch the owned tracker through the current authenticated API, never a payload URL.

Use a supported real Steam base game, check below target, raise the target and run
the admin check. Show one episode alert and repeat the check without a new alert.
This is target qualification, not proof of a new price drop. No emulator, live
Firebase, real device, cross-client CRUD or server-send test was run for this change.
