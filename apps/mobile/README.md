# Price Tracker for Android

Generated with Flutter **3.47.7** / Dart **3.13.5** using `flutter create --platforms android`. Install Flutter plus Android Studio's SDK and Java toolchain before running Android builds. The Gradle wrapper is included; SDKs and `local.properties` are not.

From this directory:

```sh
flutter pub get
flutter analyze
flutter test
flutter run
flutter build apk --debug
```

The app opens a visibly labeled **in-memory sample watchlist**. No API is needed.
Changes reset when the process restarts. Covers and JetBrains Mono are bundled;
ordinary sample flows make no network requests. See
[the mobile design notes](../../docs/mobile-design.md) for the repository boundary,
sample scenarios, and remaining integration work.

Add game previews only Portal 2 (`https://store.steampowered.com/app/620/`) and
Half-Life 2 (`https://store.steampowered.com/app/220/`). Both start saved; remove one
first or choose **Account and settings → Sample developer scenarios → Empty
watchlist** to try adding. Preferences are local, and no alerts are sent.

Account screens use fixed read-only credential placeholders. Verification and
password reset explain the future browser handoff: finish in the browser, return
to Flutter, then sign in. No deep links, real sessions, or password storage.

Only **Account and settings → API diagnostic → Open API diagnostic → Check API**
calls `/api/health`. Start the API with `npm run dev:api` from the repository root
for that optional check. `10.0.2.2` is the Android emulator's host-machine alias.
For a USB-connected physical device, use `adb reverse tcp:4000 tcp:4000` then
`flutter run --dart-define=API_BASE_URL=http://127.0.0.1:4000`.

HTTP is permitted only for the three local debug hosts. Use an HTTPS API origin for deployed builds. `API_BASE_URL` is compiled into the app, so it must never contain secrets. Release signing and publishing are not configured; the generated release build still uses the debug key.

The diagnostic reports database readiness separately. It does not fetch prices or
save trackers. Live authentication/tracking, secure token storage, and Android
push integration are separate work. Push controls here only preview preferences
and an unavailable device, not permissions or delivery.

Android build/device/visual checks and real FCM delivery are not verified in this
design change. Run `dart format --output=none --set-exit-if-changed lib test`,
`flutter analyze`, and `flutter test` for the offline checks.
