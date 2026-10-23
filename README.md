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

The initial commit is a **starter**, not a finished tracker. Authentication, saved games, CheapShark integration, scheduled checks, and notifications are assigned in Issues. Do not use the starter with real user accounts or assume the health screen means these features are implemented.

## Repository layout

```text
apps/
  api/       Express + TypeScript API
  web/       React + TypeScript + Tailwind
  mobile/    Flutter Android app
docs/
  project.md             Scope, architecture, data, and alert rules
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

Open **http://127.0.0.1:5173**. Click **Check API** to test the connection to the API at **http://127.0.0.1:4000**. Vite proxies `/api` during development.

The starter works without environment files or a database account. For custom settings, copy the examples:

```sh
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env
```

| Setting | Where | Purpose |
| --- | --- | --- |
| `PORT`, `HOST` | API `.env` | Defaults to `4000`, `127.0.0.1`. |
| `WEB_ORIGINS` | API `.env` | Comma-separated allowed web origins; localhost/127.0.0.1 port 5173 by default. |
| `MONGODB_URI` | API `.env` | Optional for the starter health screen. Use the team's remote MongoDB URI once configured; never commit credentials. |
| `API_PROXY_TARGET` | Web `.env` | Local Vite proxy target, default `http://127.0.0.1:4000`. |
| `VITE_API_BASE_URL` | Web `.env` | Leave blank locally. For a separately hosted API, use its HTTPS **origin**, without `/api`. All `VITE_` values are public. |

`GET /api/health` checks API liveness and reports database state. `GET /api/ready` returns **503 until MongoDB is connected**. A working health screen does not mean authentication, persistence, or price tracking exists. Remote MongoDB is required for the finished course project, even though it is not required to run this starter.

For compiled API startup:

```sh
npm run build
npm run start --workspace @price-tracker/api
```

The React production output is in `apps/web/dist`; deploy it as static files with same-origin `/api` routing or set the public API origin at build time. This starter does not configure a cloud host, production scheduler, SMTP service, or Firebase project yet.

### Flutter / Android

Install **Flutter 3.47.7** (Dart 3.13.5), plus Android Studio's SDK and Java toolchain for Android builds. Start the API first, then run from `apps/mobile`:

```sh
flutter pub get
flutter run --dart-define=API_BASE_URL=http://10.0.2.2:4000
```

`10.0.2.2` points to the host machine from an Android emulator. The base URL is an origin, **without `/api`**. For a USB-connected device, use `adb reverse tcp:4000 tcp:4000` and set the origin to `http://127.0.0.1:4000` instead. Local HTTP is allowed only for local debug hosts; deployed builds must use HTTPS.

See [the mobile setup notes](apps/mobile/README.md) for checks and APK commands. Firebase/push, release signing, and app-store publishing are not configured in the scaffold. The generated release configuration still uses debug signing; it is not ready for distribution.

## Checks

From the repository root:

```sh
npm run check
```

This runs lint, TypeScript checks, tests, and API/web builds. Individual commands are `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build`.

From `apps/mobile`:

```sh
dart format --output=none --set-exit-if-changed lib test
flutter analyze
flutter test
```

**Initial validation, October 23, 2026:** lint/typecheck/build passed, **14 API tests + 4 React tests + 4 Flutter tests passed**, and Flutter analysis/format checks passed. These cover the starter and health behavior, not the planned features. GitHub Actions runs the Node and Flutter checks.

**Not verified locally:** Android APK compilation/device execution, live MongoDB, cloud deployment, or real email/push. Java and the Android SDK were not installed on the initialization machine. The feature issues include the required end-to-end evidence.

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

The plan includes a Gantt chart, ERD, PlantUML use-case and sequence/activity diagrams, a mobile class diagram, SwaggerHub API documentation, web/mobile wireframes, and recorded unit/integration test results. Figma is optional and is not part of our required toolchain. Hosting is not tied to Azure, AWS, or another vendor yet; domain setup is already handled.
