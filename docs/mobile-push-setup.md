# Android push: setup and remaining work

**Not ready to deliver:** this checkout has no Firebase Flutter plugins, Firebase
initialization, Android notification presenter, or background/tap listener. Adding
project configuration alone will not enable push. The sample remains offline and
API mode reports the gateway as unconfigured. Do not send real alerts yet.

## Prepare later, after the integration is implemented

1. Create a team-owned Firebase project on the **Spark** plan. Firebase's
   [pricing](https://firebase.google.com/pricing) lists Cloud Messaging as no-cost
   and Spark as requiring no payment method. Do not enable billing, Blaze, free
   trials, Cloud Functions, Firebase Auth, or Firestore for this project.
2. Register an Android app with the exact current application ID
   **`dev.pricetracker.price_tracker`** (from `apps/mobile/android/app/build.gradle.kts`).
   If that ID changes, register the new ID and regenerate configuration.
3. The owner's Android app config (`google-services.json`, normally placed in
   `apps/mobile/android/app/`) or FlutterFire-generated `firebase_options.dart`
   contains public client identifiers, not the server's private credential.
   Keep project-specific generated files out of this repository; do not invent
   values. The eventual implementation must explicitly define which config input
   and opt-in flag it supports. **Neither file is read by the current app.**
   Firebase documents its [Flutter setup](https://firebase.google.com/docs/flutter/setup)
   and says FlutterFire generates `firebase_options.dart` with non-secret identifiers.
4. For the API, `apps/api/.env.example` documents `FIREBASE_PROJECT_ID` and
   `GOOGLE_APPLICATION_CREDENTIALS`. The latter points to a private service-account
   JSON file outside the repository, readable only by the API process; never put it
   in the app, a Dart define, a commit, or logs. Prefer deployment-managed
   Application Default Credentials where available. The sender is currently a
   building block: at this base commit the worker is not wired into server startup,
   and setting these variables alone does not start it. Confirm the integrated
   backend's enablement and device routes with its owner before testing.

## Work required before device testing

Implement an explicitly opt-in `firebase_core`/`firebase_messaging` gateway,
with no initialization in sample mode or when configuration is absent. Obtain
Android notification permission and FCM token, handle token refresh and the
existing authenticated device registration contract. Review logout/rebind behavior
against the mounted API, including offline and expired sessions.

The current server sends **data-only** messages. They do not automatically show a
notification. A native/local notification presenter is needed, including a channel,
permission handling and tap payload. Firebase's [receive guide](https://firebase.google.com/docs/cloud-messaging/flutter/receive-messages)
states that Android background handling runs in a separate isolate. The current
secure key store serializes only within one isolate; it cannot safely coordinate
background and foreground claims. Solve atomic cross-isolate session and episode
deduplication, logout races, and safe owned-tracker reads before presenting any
background alert. Provider acceptance is not phone display or exactly-once delivery.

## Later device evidence

Use Android 7+ with Google Play services, or a Google Play emulator image, and
record OS/device, app build, Flutter version, date and outcomes. Open the app at
least once; after Android force-stop it must be reopened before background messages
can resume. With a verified account and the real owned API, test permission allowed
and denied, registration, token rotation, foreground/background/terminated tap,
restart deduplication, logout and switching accounts, offline recovery, and deleted
or foreign tracker taps. Do not record tokens or personal details in evidence.

Use a supported real Steam game, check below target, then raise its target and run
the authorized admin check. Verify one alert per qualifying episode and repeat the
check. A changed target is not evidence of an actual price drop. Real receipt,
cross-client CRUD and delivery are unverified until these checks are performed.
