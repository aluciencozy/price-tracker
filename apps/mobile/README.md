# Android starter

Generated with Flutter **3.47.7** / Dart **3.13.5** using `flutter create --platforms android`. Install Flutter plus Android Studio's SDK and Java toolchain before running Android builds. The Gradle wrapper is included; SDKs and `local.properties` are not.

From this directory:

```sh
flutter pub get
flutter analyze
flutter test
flutter run --dart-define=API_BASE_URL=http://10.0.2.2:4000
flutter build apk --debug
```

Start the API with `npm run dev:api` from the repository root. `10.0.2.2` is the Android emulator's host-machine alias. For a USB-connected physical device, use `adb reverse tcp:4000 tcp:4000` then `flutter run --dart-define=API_BASE_URL=http://127.0.0.1:4000`.

HTTP is permitted only for the three local debug hosts. Use an HTTPS API origin for deployed builds. `API_BASE_URL` is compiled into the app, so it must never contain secrets. Release signing and publishing are not configured; the generated release build still uses the debug key.

Tap **Check API** to call `/api/health`. Database connectivity is shown separately; a healthy API does not mean persistence is ready. No accounts, product tracking, or notifications exist yet.
