# Flutter design and sample interactions

Related work: #6, #11, #20, #22, #25. This design does not complete their API,
UML, device, or notification acceptance criteria.

## Design

Native Material 3, light only, with an explicit centralized `ColorScheme` in
`apps/mobile/lib/theme.dart`. Teal `#00bba7` uses dark `#031a1e` foreground;
background is `#f9fdff`, cards are white. Secondary `#e4f2f2`, muted `#ebf4f4`,
accent `#c3ecdf`, accent foreground `#006363`, and border `#dae3e4` are sRGB
conversions of the shared OKLCH palette. Focus, control outlines, text buttons,
and errors use stronger contrast than decorative borders.

Bundled JetBrains Mono, 8px corners, subtle cool elevation, small covers, and
roomy left-aligned rows carry the shared design without a marketing screen.
Android day/night launch and window styles also stay light, including Android
12+ launch backgrounds. Local artwork sources and the font license are under
`apps/mobile/assets`. The supplied reference PNG was read only, never copied.

## Try the sample

- Search saved games; open details; review dated source/timestamps and explicitly
  **illustrative sample history** with readable daily USD values.
- Edit targets (including zero), enabled state, independent email/Android push
  preferences. Remove with confirmation, or cancel without changing anything.
- Add: local Steam URL parsing → supported preview → target/preferences → save.
  Only source-proof Portal 2 and Half-Life 2 identities are accepted. Unknown
  apps/DLC/editions, bundles/subscriptions, unsafe URLs, duplicates, missing
  Steam offers, and expired previews explain why they cannot be saved.
- Account previews cover register, sign in, unverified accounts, verification/
  resend, forgot/reset, expired links, and sign out. Read-only placeholders do
  not collect passwords. No real account, secure session, or email is claimed.
- Verification/reset finish in a browser, then users return and sign in. No
  deep-link token handling or automatic login is promised.
- Expand **Account and settings → Sample developer scenarios** for empty,
  offline, expired, failed-check/stale, and missing-offer examples. Normal/reset
  restores both fixtures; offline failures preserve existing data and drafts.
- API diagnostic is secondary and explicitly invoked. No automatic polling or
  ordinary-user price-check action exists.

Changes stay in memory and reset on process restart. Prices/purchase links are
dated October 26, 2026 source proof, not live quotes. Multi-day history values
are invented for layout and labeled where shown, not presented as real Steam
observations. Target edits never change price/history or prove a new sale.
The safe, dated CheapShark redirect can be copied into a browser for human
navigation; the app never requests redirects. A missing price is unavailable,
not free. Failed checks preserve the last successful price and timestamp. The
missing-offer scenario instead illustrates having no retained observations.

## Later API adapter boundary

`TrackerRepository` in `apps/mobile/lib/tracker_repository.dart` is injected
through `PriceTrackerApp(repository: ...)`. Widgets use async list/search, get,
preview, create, update, delete, and tracker-owned history. The default
`SampleTrackerRepository` owns all fixtures/state; widgets do not read provider
payloads or fixture arrays. No database, storage, scheduler, or new framework.

- Money holds safe integer `amountMinor` and fixed `currency: USD`. Nullable
  product price distinguishes unknown from zero. Parsing never uses floating
  point dollars.
- Tracker has id, product, targetPrice, enabled, alerts, createdAt, updatedAt.
  Product ID, provider game ID, Steam app ID, and deal purchase URL stay distinct.
  Stable offer identity is CheapShark + provider game ID + store `1` + US + USD.
- Observation time, nullable provider-change time, failed-attempt/error,
  freshness, attribution, and purchase URL are separate values. History uses
  an owned tracker ID, not a direct unowned-product lookup.
- Preview returns `{id, expiresAt, product}`; create takes `previewId`, target,
  enabled, and alerts. Ten-minute sample expiry is enforced. No owner/current
  price/history writes. Update only changes target/preferences.
- `RepositoryException` has a useful message and a distinct expired flag. An
  HTTP adapter must map structured contract errors here and never fall back
  to sample success when live requests fail.

These are UI domain values, not complete JSON DTOs. Exact routes, strict Product
JSON fields, pagination, error codes, bearer session storage, request replay/
idempotency keys, and serialization belong to the separately reviewed shared
contract and wiring PR. The current preview/create shape follows that proposal.
The account UI is intentionally a preview, not an auth service. Before enabling
an HTTP repository, add explicit live-mode configuration, live labels, secure
storage, and session guards. Never upload sample records.

Android push readiness is a **separate PR**. This change only has preference
controls/unavailable-device copy: no Firebase, permission/device APIs, plugins,
tokens, event/tap handling, or delivery claims. Signing, real ownership checks,
cross-client persistence, and actual email/push remain integration work.

## Validation

With Flutter 3.47.7 / Dart 3.13.5, from `apps/mobile`:

```sh
dart format --output=none --set-exit-if-changed lib test
flutter analyze
flutter test
```

Passed: format (10 files unchanged), analyze (no issues), **21 tests**. Coverage
includes money/free/unknown, identity/URL/purchase safety, CRUD/search/preferences/
duplicates, preview expiry, preserved success on failures, loading/errors,
session/account previews, cancel/confirmed deletion, forced light under dark OS,
320px layout at 200% text, and retained health parsing/readiness/offline behavior.
The health test also proves it runs only after the explicit diagnostic action.
Tests use fixtures, not Steam/CheapShark calls. Artwork was downloaded once during
implementation, not at runtime or in CI.

No Android visual/build/device tests or browser review were requested here.
Actual appearance, upstream listing availability, deployed ownership/security,
real verification/reset sessions, and FCM behavior remain unverified.
