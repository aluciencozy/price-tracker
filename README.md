# Price Tracker — PC Games MVP

Save a Steam game link, set the price you want, and get notified when its Steam price reaches that target. Price Tracker is our COP 4331C large project at UCF for Fall 2026.

**Scope updated October 26:** the MVP tracks real PC games through CheapShark's free API. It is not a general shopping scraper. Start with Steam URLs, US prices, and USD; GOG and Fanatical are optional only after exact game/store matching is verified. The budget is **$0**, with no paid plans, billing-enabled trials, or fictional stores in the demo.

The web app uses **React, TypeScript, and Tailwind**. The mobile app uses **Flutter**. Both share one **Express/TypeScript API** and **MongoDB** database.

**Finish development by November 10. Present by November 15.**

## What we are building

- Registration, email verification before login, and password reset.
- A private watchlist: add a supported Steam `/app/<id>` URL, set a target, edit preferences, and remove items.
- Game title, selected store, current USD price, target price, source, and last successful check.
- Daily background price checks, plus an admin-only manual check for testing.
- Email and Android push alerts when a price reaches or drops below the target.
- No repeated alerts while the game stays below the target. Email and push retries are tracked separately.
- Shared game/store offers and our own observed price history, with the same watchlist on web and mobile.
- Individual base games only. No bundles, DLC, subscriptions, guessed editions, regional switching, or arbitrary URLs in the MVP.

See [the project details](docs/project.md) for the data model, alert rules, security boundaries, and course checklist. See [the work plan](docs/plan.md) for owners, dates, dependencies, and the Gantt chart.

The web and mobile apps still open in local sample mode by default. The API now contains verified account flows, private tracking/history and admin routes, and verified mobile-device routes. Tracking is mounted only when `PRICE_TRACKING_ENABLED=true`; daily checks, recovery, account email, and price email/push each have separate opt-in flags. With those flags off, the API is not a live tracker. Do not confuse fixture coverage, a healthy API, or device registration with live price checks or delivered notifications. See [release readiness](docs/release-readiness.md) and the [VM schedule handoff](docs/vm-scheduling.md) for what is and is not accepted.

## Repository layout

```text
apps/
  api/       Express + TypeScript API
  web/       React + TypeScript + Tailwind
  mobile/    Flutter Android app
docs/
  project.md             Scope, architecture, data, and alert rules
  release-readiness.md   Implemented code versus owner acceptance still pending
  vm-scheduling.md       The existing API service's internal daily schedule
  lab-vm-deployment.md   Historical November 5 deployment evidence
  plan.md                Weekly plan and issue links
  retailer-research.md   CheapShark endpoints, store matching, and free-access rules
  provider-decisions.md Why other stores/APIs were not selected, with limits and sources
AGENTS.md                Guidance for coding agents
```

## Run locally

### Web and API

Install **Node.js 24** and **npm 11 or newer**. With nvm, run `nvm install` and `nvm use` from the repository root.

```sh
npm ci
```

Start these in separate terminals, both from the repository root:

```sh
npm run dev:api
```

```sh
npm run dev:web
```

Open **http://127.0.0.1:5173** and choose **Try sample**. The light-only web app works without the API. Its fonts and small game thumbnails are bundled locally; no backend, provider, remote font, or remote image request happens by default.

The sample starts with Portal 2 and Half-Life 2. Search your saved games, open details, edit targets and independent email/Android-push preferences, or confirm removal. **Add game** uses Steam URL → offer preview → target/preferences → save; remove a seeded game first to add it again. Targets use integer USD cents and allow $0.00. Changes live in memory and reset on refresh, never upload automatically, and survive navigation/back. Routes and saved-game search are URL-addressable; static hosting must rewrite app routes to `index.html` while keeping `/api` routing separate.

Preview reports an already-saved game before asking for a target and links to its existing tracker. In API mode, it checks the owned watchlist after validating the offer; a failed duplicate lookup requires Retry before continuing. API search waits 300 ms after typing and labels retained results while searching or after a failure. Corrected target errors clear when the value becomes valid. Reduced motion disables preview and confirmation entry animations.

Prices and human purchase redirects are stale snapshots from [the October 26 source proof](docs/cheapshark-proof.json), not live quotes. Only these two identities were validated. The multi-day chart is **explicitly labeled illustrative**, with a data table; its invented values are not recorded Steam history. Purchase links can expire and are never fetched automatically. No other store or historical low substitutes for a missing Steam offer.

In sample mode, registration, verification/resend, login/logout, forgot/reset, and account pages are honest local previews. Use made-up sample credentials only. They do not store/transmit credentials, create sessions, send email, register devices, or deliver alerts. Android push is a per-game preference, not browser push.

Expand **Development tools** in the footer for loading, empty, offline, expired-session, save-error, failed-check, missing-offer, free-price, unsupported-content and history scenarios. These are local fixtures, not provider-support claims. Account forms have their own expandable scenario controls. Choose **Normal** to leave a scenario; refresh to reset everything.

Inside Development tools, expand **API connection (manual diagnostic)** and click **Check API** to test `http://127.0.0.1:4000` health. This is the only optional backend request in sample mode; it never fetches prices. Vite proxies `/api` locally.

#### Opt-in API mode

Set `VITE_DATA_SOURCE=api` in `apps/web/.env` and restart Vite (or rebuild for deployment) to connect account forms and the private watchlist to the [shared API contract](https://github.com/aluciencozy/price-tracker/pull/36). The default is `sample`; invalid values show a configuration error without starting either source. API mode never uploads sample records or falls back to sample success. It uses persistent browser-managed HttpOnly cookies and CSRF protection, not JavaScript-stored JWTs.

The API mounts registration, verification/resend, login/logout, forgot/reset, web CSRF, and verified mobile-device routes. Web sessions use a persistent HttpOnly cookie; mobile receives a seven-day JWT when `AUTH_JWT_SECRET` is configured. Tracking, owned history, and admin-check routes are mounted only when `PRICE_TRACKING_ENABLED=true` and MongoDB/indexes are ready; that flag also requires a stable `TRACKING_CURSOR_SECRET`. See [account setup and transaction tests](docs/registration.md). Generic account responses and fixture mail tests do not prove mailbox delivery. Android push starts only with explicit mobile settings. [Controlled desktop testing](docs/test-results/android-desktop-2026-11-09.md) observed real FCM receipt on an emulator, local cross-client behavior, and a successful permission-denial fix retest; operational acceptance remains pending. See [mobile push setup](docs/mobile-push-setup.md).

Leave `VITE_API_BASE_URL` blank for same-origin `/api` routing. A separate API must use an approved **same-site HTTPS origin**, without `/api`, and exact credentialed CORS configuration; HTTPS alone does not make cross-site cookies work. HTTP is development-only on exact `localhost`/`127.0.0.1`. No credentials belong in public `VITE_` values.

Static hosting must serve the app shell on direct `/watchlist/:id`, `/verify-email` and `/reset-password` routes. Email links hand off `#token` to memory and immediately remove it from the address bar; verification/reset require explicit POST actions and never auto-login. The app sets a no-referrer meta policy; deployed hosting should also send `Referrer-Policy: no-referrer`. See [web API wiring](docs/web-api-wiring.md) for interfaces, bounds, tests and remaining real integration work.

See [the web design and repository handoff](docs/web-design.md). The existing [SVG wireframes](docs/wireframes/README.md) are historical planning files; wireframe work is cancelled and is not an application-release blocker. `npm test --workspace @price-tracker/web` runs offline interaction/repository/purchase safety tests; it does not verify live accounts, ownership, delivery, or upstream purchase links.

The web sample works without environment files or a database account. The API can start without MongoDB for health/liveness only; real account and tracking flows require a database, with tracking additionally gated by the opt-in flags below. For local settings, copy the examples:

```sh
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env
```

| Setting | Where | Purpose |
| --- | --- | --- |
| `VITE_DATA_SOURCE` | Web `.env` | `sample` (default, local-only) or `api` (real HTTP/session boundary, no sample fallback). Restart/rebuild after changing. |
| `PORT`, `HOST` | API `.env` | Defaults to `4000`, `127.0.0.1`. |
| `WEB_ORIGINS` | API `.env` | Comma-separated allowed web origins; localhost/127.0.0.1 port 5173 by default. |
| `MONGODB_URI` | API `.env` and deployment secret | Optional only for health/liveness. Real account persistence, tracking, and workers require the approved MongoDB URI; never commit credentials. |
| `AUTH_JWT_SECRET` | API `.env` and deployment secret | Stable random signing key of at least 32 characters; required in production. Keep server-side, use the same value across replicas, and do not rotate without invalidating sessions. |
| `TRACKING_CURSOR_SECRET` | API `.env` and deployment secret | Stable random signing key of at least 32 characters; required with `PRICE_TRACKING_ENABLED=true`. Keep it unchanged across restarts and replicas. |
| `PRICE_TRACKING_ENABLED` | API `.env` | Defaults to `false`; mounts real preview, private tracking/history, and admin-check routes. Requires MongoDB and `TRACKING_CURSOR_SECRET`. |
| `PRICE_SCHEDULER_ENABLED`, `PRICE_RETRY_WORKER_ENABLED` | API `.env` | Both default to `false`. Opt in to the API process's daily UTC check and due-run recovery; do not add cron or a second scheduler. |
| `ACCOUNT_MAIL_ENABLED` | API `.env` | Defaults to `false`; enables verification/reset mail recovery. Requires the approved sender settings, HTTPS first `WEB_ORIGINS` entry, and `TEMPLATE_PASSWORD_RESET_ID`. Runtime verification mail is plain text and needs no template. |
| `PRICE_EMAIL_ENABLED`, `PRICE_PUSH_ENABLED` | API `.env` | Defaults to `false`; independently enable each alert channel after its owner acceptance. Enabling a flag is not proof of delivery. |
| `RESEND_SEND_API_KEY` | API `.env` and deployment secret | Resend Sending Access key used by the API to send email. Keep it server-side. |
| `EMAIL_FROM` | API `.env` and deployment secret | Sender address on a verified domain, for example `Price Tracker <alerts@mail.example.com>`. |
| `TEMPLATE_VERIFICATION_EMAIL_ID` | Optional API `.env` setting | Used only by the separate `sendVerificationEmail` helper. The runtime verification worker sends plain text and does not need this ID. |
| `TEMPLATE_PASSWORD_RESET_ID` | API `.env` and deployment secret | ID of the published password-reset template in Resend. |
| `TEMPLATE_PRICE_ALERT_ID` | API `.env` and deployment secret | ID of the published price-alert template in Resend. |
| `RESEND_FULL_ACCESS_API_KEY` | Local API `.env` only, during template setup | Temporary Full Access key for creating/publishing templates. Never deploy it; revoke it after setup. |
| `API_PROXY_TARGET` | Web `.env` | Local Vite proxy target, default `http://127.0.0.1:4000`. |
| `VITE_API_BASE_URL` | Web `.env` | Leave blank locally. For a separately hosted API, use its HTTPS **origin**, without `/api`. All `VITE_` values are public. |
| `FIREBASE_PROJECT_ID`, `GOOGLE_APPLICATION_CREDENTIALS` | API deployment only | Approved Firebase project and protected server-side Application Default Credentials; never put credentials in Git or web/mobile build settings. |

### Resend email setup

Issue [#7](https://github.com/aluciencozy/price-tracker/issues/7) uses Resend for account and price-alert email. The confirmed Free plan limit is **100 emails per day and 3,000 per month**. Keep the account on the free plan, leave billing/overages disabled, and stop or reduce sending at the limit.

The initial test used Resend's `onboarding@resend.dev` sender and delivered to the account owner's mailbox. That confirms the test send only; it does not prove delivery to other users. To send to other recipients, configure and verify a sender domain the team already owns. Add the DNS records Resend provides, wait until the dashboard marks the domain verified, set `EMAIL_FROM` to an address on that domain, and send a real test to a team-controlled mailbox. Record the verified sender and any account-specific recipient restrictions before promising delivery for the demo. Do not buy a new domain or enable paid overages.

Use a **Sending Access** API key for the running API. For template setup only, the scripts need a **Full Access** key as well as the sending key. Put both in the local `apps/api/.env`; never commit them. Do not put the Full Access key in deployment secrets, and revoke it after setup. Keep the sending key in the deployment secret store.

Create and publish each template once, then copy its returned ID into `apps/api/.env` and deployment secrets:

```powershell
cd apps/api
npx tsx .\scripts\create-email-templates.ts
npx tsx .\scripts\create-password-reset-template.ts
npx tsx .\scripts\create-price-alert-template.ts
```

These scripts create and publish new templates; do not rerun them if the corresponding template already exists. They use Resend's documented triple-brace variables. HTML values are passed separately after escaping, while plain-text values remain readable. Creating templates in this checkout does not update any already-published remote template: publish corrected templates and set the matching IDs before enabling their channel. Runtime verification mail is plain text and does not use a Resend template. Account mail requires `TEMPLATE_PASSWORD_RESET_ID`; price email requires `TEMPLATE_PRICE_ALERT_ID`. `TEMPLATE_VERIFICATION_EMAIL_ID` is optional and used only by the separate `sendVerificationEmail` helper, not by the runtime account-mail worker. Preview any templates you will use before activation; offline tests do not verify provider rendering. The setup scripts do not send an email. The `test-resend.ts` script sends a real test price-alert email to `RESEND_TEST_RECIPIENT` in the local environment; it uses sample values and does not require MongoDB. Never log verification/reset URLs or their tokens.

The email adapter confirms success only with a nonblank SDK message ID and no SDK error. Resend 6.37 exposes HTTP headers but drops the actual HTTP status for JSON errors; body `statusCode` and `name` are not transport evidence. All unconfirmed sends therefore return `unknown`, including apparent 400/429 responses. Only validation/configuration failures before sending return `permanent_failure`; `retryable_failure` is reserved for a future transport with verified rejection evidence. The API's separate durable worker owns claims and recovery; an unknown result is not blindly resent. See [backend runtime limits](docs/backend-runtime.md).

Each call makes at most three attempts, each with a five-second timeout, always using the same caller-supplied idempotency key and payload. Real `Retry-After` seconds or HTTP dates pace retries; delays over one second stop the call and are returned as `retryAfterMs` on the unknown outcome, not slept through or ignored. Later errors cannot erase uncertainty; a confirmed same-key success can resolve it. The durable worker records delivery state and recovery, but neither it nor the adapter can prove mailbox receipt or guarantee exactly-once delivery. It must reconcile unknown outcomes rather than blindly retry beyond [Resend's 24-hour idempotency window](https://resend.com/docs/dashboard/emails/idempotency-keys).

`GET /api/health` checks API liveness and reports database state. `GET /api/ready` returns **503 until MongoDB and startup indexes are ready**. Neither endpoint proves a current price, scheduled run, verified sender, or device delivery. Remote MongoDB is required for the finished course project.

For compiled API startup:

```sh
npm run build
npm run start --workspace @price-tracker/api
```

The React production output is in `apps/web/dist`; deploy it as static files with same-origin `/api` routing or set the public API origin at build time. The November 5 [lab VM record](docs/lab-vm-deployment.md) is a historical sample-mode deployment of commit `b668d1e`; it does not show that this integration is deployed. Host cost/uptime, sender approval, Firebase access, and live end-to-end acceptance remain open; see [release readiness](docs/release-readiness.md).

### Flutter / Android

Install the pinned **Flutter 3.47.7** (Dart 3.13.5), plus Android Studio's SDK and Java toolchain for Android builds. Start the API first, then run from `apps/mobile`:

```sh
flutter pub get
flutter run --dart-define=API_BASE_URL=http://10.0.2.2:4000
```

`10.0.2.2` points to the host machine from an Android emulator. The base URL is an origin, **without `/api`**. For a USB-connected device, use `adb reverse tcp:4000 tcp:4000` and set the origin to `http://127.0.0.1:4000` instead. Local HTTP is allowed only for local debug hosts; deployed builds must use HTTPS.

See [the mobile setup notes](apps/mobile/README.md) for checks and APK commands. Firebase initialization, permission requests, token registration, foreground/background presentation, and tap handling remain off by default; enable them only with `ANDROID_PUSH_ENABLED=true` and the public Firebase build settings in the [push setup handoff](docs/mobile-push-setup.md). Emulator transport receipt, permission cleanup and fresh-process logout passed; post-permission duplicate arrival and production approval remain unverified. Release signing and app-store publishing are not configured; the generated release configuration still uses debug signing and is not ready for distribution.

## Checks

From the repository root:

```sh
npm run check
```

This runs lint, TypeScript checks, tests, and API/web builds. Individual commands are `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build`.

**Recorded Node check at `ec59ddd`:** `npm run check` passed lint, both typechecks, both builds, and **700 tests** (17 contract, 409 API, 274 web; zero skips). API tests used the two-worker limit. The earlier `49d423d` audit reported 0 production vulnerabilities and 10 moderate development-only warnings, with zero high or critical findings. These checks do not prove deployment, delivery, or $0 operation.

**Mobile push checks:** independent review passed formatting, analysis, and **237 Flutter tests** on Flutter 3.47.9 / Dart 3.13.7; the permission-cleanup debug APK built offline. The repository remains pinned to Flutter 3.47.7 / Dart 3.13.5. Controlled emulator receipt and permission-denial retesting passed; the final duplicate's arrival was unverified. See the [desktop report](docs/test-results/android-desktop-2026-11-09.md).

**Fixture-based browser QA:** authentication, tracker flows, synthetic history, ownership, offline behavior, responsive layouts, and targeted keyboard checks passed after the test-only disclosure fix. See the [November 9 report](docs/test-results/web-acceptance-2026-11-09.md). This was not live-provider or delivery testing. axe found zero confirmed violations in audited views, with chart contrast checks still incomplete; this is not a full accessibility or WCAG conformance audit.

**Historical design validation, October 28, 2026:** an earlier `npm run check` passed lint, both typechecks, **80 web tests + 14 API regression tests**, and both builds. It is not the current implementation baseline.

From `apps/mobile`:

```sh
dart format --output=none --set-exit-if-changed lib test
flutter analyze
flutter test
```

**Initial validation, October 23, 2026:** lint/typecheck/build passed, **14 API tests + 4 React tests + 4 Flutter tests passed**, and Flutter analysis/format checks passed. This is historical starter evidence, not the current feature baseline. GitHub Actions runs the Node and Flutter checks.

**Owner acceptance still pending:** remote MongoDB/host configuration, deployed current integration, verified team sender and general recipient delivery, Firebase project and billing approval, and a real qualifying email/push episode. Controlled Android emulator receipt does not prove production delivery. A test Resend message to the account owner's mailbox does not prove delivery to other recipients. See [release readiness](docs/release-readiness.md).

## Game stores and price data

For a short explanation of why Best Buy, Amazon, Target, and other options are excluded, read [the provider decision guide](docs/provider-decisions.md). It separates confirmed restrictions from information we could not verify.

The planned provider is **[CheapShark](https://apidocs.cheapshark.com/)**. Its public API is free and does not require an API key. It supplies real store prices; we still build our own accounts, watchlists, daily checks, history, email, push, and deduplication.

| Store | MVP status |
| --- | --- |
| Steam | First required store. Accept validated base-game Steam URLs and compare only the matching Steam offer. |
| GOG, Fanatical | Optional later. Verify exact game/edition/store matching before enabling; no title-only guesses or promised URL support yet. |
| Other CheapShark stores | Not supported automatically just because the upstream API lists them. |

Extract the Steam app ID locally, resolve its exact CheapShark game ID, and select `storeID=1` (Steam). **Do not substitute the cheapest price across all stores or the historical low.** Reject ambiguous matches and games without a qualifying Steam offer. Begin with a small validated base-game catalog because a Steam app URL can also identify DLC or other unsupported content.

All outbound pricing requests go to fixed CheapShark API endpoints, not the submitted Steam URL. Cache shared lookups, honor `429`/`Retry-After`, and use CheapShark's required deal redirect links for purchase buttons. See [the integration research](docs/retailer-research.md) for the endpoint sequence and safety rules.

**Source proof passed, October 26:** Portal 2 (`620` → CheapShark `36`) and Half-Life 2 (`220` → `59`) both resolved to current Steam offers at USD 9.99. All four API requests returned HTTP 200 using Node.js and the provider-required descriptive `User-Agent`. See [the measured results](docs/cheapshark-proof.json). Only these two games are validated so far; this is not support for every Steam app. Earlier automated attempts were rate-limited (429); they are not the current result. This proves the source lookup, not the unfinished Express/watchlist/notification features.

To reproduce the live check explicitly, run `node scripts/verify-cheapshark.mjs`. It paces four requests, stops on 429, and is **not part of CI**. Do not fetch purchase redirects from the server: the provider documents that `/redirect` blocks automated access and is for human clicks only.

One bounded live application-adapter lookup completed on November 9 for Portal 2 (Steam app `620` → CheapShark game `36`, Steam `1`, US/USD; API-reported USD 9.99). See the [dated adapter report](docs/test-results/live-adapter-2026-11-09.md). It is separate from the October 26 source proof, creates no price-history observation, and does not prove a checkout quote, a new price drop, deployed checks, or support for other games. To repeat it, use an approved disposable local replica-set URI and preserve its shared provider-budget/cooldown state:

```sh
MONGODB_URI="$APPROVED_LOCAL_MONGODB_URI" npm run verify:cheapshark-adapter --workspace @price-tracker/api
```

This explicit live command is not part of CI and never requests the purchase redirect.

### Real-price presentation

Use a real supported game. First check with a target below its reported price, then raise the target above that same real price and run an admin check. Show email and Android push, repeat the check, and show that no duplicate alert is sent. This demonstrates qualification and deduplication—not a claimed new sale. No training store, fabricated price, or live mock provider is required; test fixtures remain for automated tests only.

### $0 budget

Use free access only, cache requests, and keep the watchlist small. Issue [#2](https://github.com/aluciencozy/price-tracker/issues/2) must also verify free remote MongoDB, hosting, independent scheduling, and service quotas; issue [#7](https://github.com/aluciencozy/price-tracker/issues/7) covers free real email delivery. Stop or reduce scope at a free-tier limit rather than enabling billing. Existing domains can be used, but there is no new domain purchase. Required course services without a usable free option must be raised with the instructor, not purchased silently.

## Working together

| Person | Main area |
| --- | --- |
| Alex / `@aluciencozy` | Project lead, PR reviews, Flutter |
| Martin / `@Martaino` | React/TypeScript web app |
| Ibrahim / `@IbrahimShaqqou` | MongoDB and deployment, then backend/testing help |
| James / `@MageOfLight` | Express/TypeScript API |
| Nick / `@NickTheBrick04` | CheapShark integration and price checks |

Use [GitHub Issues](https://github.com/aluciencozy/price-tracker/issues) as the task list. Each issue has an owner, planned dates, dependencies, and a checklist. If GitHub cannot assign someone while their invite is pending, the owner is still written in the issue.

Work from the current [milestone](https://github.com/aluciencozy/price-tracker/milestones), close issues after the linked PR is merged, and update the Gantt when dates change. The chart is a checked-in plan, not an automatically synced GitHub Projects view.

Keep PRs small and link the issue they address. Never commit `.env` files, tokens, database credentials, device tokens, or signing keys. The assignment PDF stays local and is ignored by Git.

## Course documents

The course requires a Gantt chart, ERD, PlantUML use-case and sequence/activity diagrams, a mobile class diagram, SwaggerHub API documentation, prototypes/wireframes, and recorded unit/integration test results. Wireframe work is cancelled; UML diagrams and PowerPoint are deferred until app and test work is finished, at the very end of the course-artifact pass. These artifacts are not represented as complete and are not application-release blockers. Figma is optional. Hosting/vendor and $0 service acceptance remain open; domain setup is already handled.
