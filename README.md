# Price Tracker

Save a product link, set the price you want, and get notified when it reaches that price. Price Tracker is our COP 4331C large project at UCF for Fall 2026.

The web app uses **React, TypeScript, and Tailwind**. The mobile app uses **Flutter**. Both share one **Express/TypeScript API** and **MongoDB** database.

**Finish development by November 10. Present by November 15.**

## What we are building

- Registration, email verification before login, and password reset.
- A private watchlist: add a product URL, set a target, edit preferences, and remove items.
- Product name, current price, target price, retailer, and last successful check.
- Daily background price checks, plus an admin-only manual check for testing.
- Email and Android push alerts when a price reaches or drops below the target.
- No repeated alerts while the product stays below the target. Email and push retries are tracked separately.
- Shared products and price history, with the same watchlist on web and mobile.
- A small set of supported retailers, not an unrestricted scraper for every URL.

See [the project details](docs/project.md) for the data model, alert rules, security boundaries, and course checklist. See [the work plan](docs/plan.md) for owners, dates, dependencies, and the Gantt chart.

The initial commit is a **starter**, not a finished tracker. Authentication, saved products, live retailer lookups, scheduled checks, and notifications are assigned in Issues. Do not use the starter with real user accounts or assume the health screen means these features are implemented.

## Repository layout

```text
apps/
  api/       Express + TypeScript API
  web/       React + TypeScript + Tailwind
  mobile/    Flutter Android app
docs/
  project.md             Scope, architecture, data, and alert rules
  plan.md                Weekly plan and issue links
  retailer-research.md   API/scraping options and demo sources
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

## Retailer support

Retailer adapters are planned work, not features included in the initial scaffold. Recommended order:

1. **One permissioned real retailer**, preferably a Shopify store with an approved product feed. Keychron's public product JSON was verified technically, but is **not cleared for scheduled collection/history/alerts**. Shopify's current terms also need clearance; public access is not permission.
2. **Books to Scrape**, a scraping sandbox with fictional prices, for a small HTML adapter. Web Scraper's training shop is a backup.
3. **Our own mock provider**, for repeatable price changes through the same check/alert pipeline.

Do not put Amazon, Walmart, or Best Buy on the deadline's critical path. Amazon has a Creators API, but standard terms restrict tracking/alerts; Best Buy's default API storage limit conflicts with long-term history; Walmart access and retention need confirmation. See [the detailed research](docs/retailer-research.md) for official sources, concrete URLs, variant/currency handling, and alternatives. **An approved real source is still an open project dependency**, with an early permission checkpoint rather than a last-week surprise.

Only fetch approved hosts and honor source-specific storage rules. A sandbox or mock price must never be presented as live retailer data.

## Working together

| Person | Main area |
| --- | --- |
| Alex / `@aluciencozy` | Project lead, PR reviews, Flutter |
| Martin / `@Martaino` | React/TypeScript web app |
| Ibrahim / `@IbrahimShaqqou` | MongoDB and deployment, then backend/testing help |
| James / `@MageOfLight` | Express/TypeScript API |
| Nick / `@NickTheBrick04` | Retailer integrations and price checks |

Use [GitHub Issues](https://github.com/aluciencozy/price-tracker/issues) as the task list. Each issue has an owner, planned dates, dependencies, and a checklist. If GitHub cannot assign someone while their invite is pending, the owner is still written in the issue.

Work from the current [milestone](https://github.com/aluciencozy/price-tracker/milestones), close issues after the linked PR is merged, and update the Gantt when dates change. The chart is a checked-in plan, not an automatically synced GitHub Projects view.

Keep PRs small and link the issue they address. Never commit `.env` files, tokens, database credentials, device tokens, or signing keys. The assignment PDF stays local and is ignored by Git.

## Course documents

The plan includes a Gantt chart, ERD, PlantUML use-case and sequence/activity diagrams, a mobile class diagram, SwaggerHub API documentation, web/mobile wireframes, and recorded unit/integration test results. Figma is optional and is not part of our required toolchain. Hosting is not tied to Azure, AWS, or another vendor yet; domain setup is already handled.
