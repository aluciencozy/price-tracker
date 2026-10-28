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

Sample account screens use fixed read-only credential placeholders. Verification and
password reset explain the future browser handoff: finish in the browser, return
to Flutter, then sign in. No deep links, real sessions, or password storage.

Only **Account and settings → API diagnostic → Open API diagnostic → Check API**
calls `/api/health`. Start the API with `npm run dev:api` from the repository root
for that optional check. `10.0.2.2` is the Android emulator's host-machine alias.
For a USB-connected physical device, use `adb reverse tcp:4000 tcp:4000` then
`flutter run --dart-define=API_BASE_URL=http://127.0.0.1:4000`.

HTTP is permitted only for the three local debug hosts. Use an HTTPS API origin for deployed builds. `API_BASE_URL` is compiled into the app, so it must never contain secrets. Release signing and publishing are not configured; the generated release build still uses the debug key.

The diagnostic reports database readiness separately. It does not fetch prices or
save trackers. Push controls only save preferences; Android permission/device/event
handling is a separate PR, not evidence of delivery.

## Explicit API mode

`DATA_SOURCE=sample` is the default. It initializes neither the live client nor
credential storage. `API_BASE_URL` alone does not enable live mode. Unknown
`DATA_SOURCE` values show a configuration error, never sample success.

```sh
flutter run --dart-define=DATA_SOURCE=api --dart-define=API_BASE_URL=http://10.0.2.2:4000
```

For a deployed API, use its HTTPS origin without `/api`. The shared contract is
[PR #36](https://github.com/aluciencozy/price-tracker/pull/36); business routes must
actually be implemented before real accounts/trackers work. The health-only API
scaffold is not sufficient.

API mode uses editable auth forms, platform-backed Bearer-session storage, owned
tracker CRUD/search/pagination and recorded history. Verification/password reset
finish through the emailed browser links; return to the app and sign in. No token
deep links or automatic sign-in. Startup network errors offer a session retry,
not sample fallback. Logout clears local data; an offline result cannot prove
server revocation. See [API wiring notes](../../docs/mobile-api-wiring.md) for
interfaces, storage failures, test coverage and remaining backend verification.

Android minSdk is at least 23. Credential preferences are excluded from legacy
backup and Android 12+ cloud/device transfer, with auto-backup disabled. These
settings and plugin requirements were inspected, not verified by an APK/device run.

Android build/device/visual checks and real FCM delivery are not verified in this
design change. Run `dart format --output=none --set-exit-if-changed lib test`,
`flutter analyze`, and `flutter test` for the offline checks.
