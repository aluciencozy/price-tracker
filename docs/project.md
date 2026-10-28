# Project scope and design

Price Tracker is our COP 4331C large project for Fall 2026. The **October 26 game-only MVP** lets users save a Steam base-game URL, choose a target price, and get email or Android push when its Steam price reaches that target. CheapShark supplies real pricing data through a free API. The React and Flutter apps share one Express API and remote MongoDB database.

**Development deadline: November 10, 2026. Presentation prep: November 11–15. Course deadline: November 15.**

This file describes the intended app, not features already built. See the root [README](../README.md) for what the starter can run today and [the work plan](plan.md) for assignments and dates.

## Keep the first version small

- React and TypeScript with Tailwind for the web app.
- Express and TypeScript on Node.js for the API and price-check worker.
- Mongoose and remote MongoDB for shared data.
- Flutter for mobile, with Android as the first demo target.
- Email for verification, password resets, and price alerts.
- Android push notifications, using FCM or an equivalent service selected during setup.
- One provider: CheapShark's free public API. One required store: Steam (`storeID=1`), US market, USD prices.
- Individual base games only, initially a small catalog with confirmed exact Steam-app-ID matches. No bundles, DLC, subscriptions, special-edition guesses, physical goods, or unrestricted URLs.
- GOG and Fanatical are optional only after exact game/store/edition matching is proven. They are not required for the November 10 release.
- A real-price demo that changes the user's target, not the provider's price. Fixtures are for tests, not a fictional storefront or a required live mock provider.

No Python, browser extension, Kubernetes, or separate mobile backend. The hosting provider is still open. Domains already exist; buying domains is not part of this project. The budget is **$0**: no paid plans, card-required/billing-enabled trials, automatic overages, or paid API fallback. Audit free database, hosting, scheduler, email, Firebase, and course-tool access in the infrastructure/email issues. If a required service cannot fit a free plan, escalate before spending or promising it.

## What users should be able to do

1. Register, verify their email, and log in. An unverified account cannot log in.
2. Reset a forgotten password through an expiring, single-use email link.
3. Paste a supported Steam `/app/<id>` URL and see the exact base game's title, Steam price, USD currency, source, and timestamps before saving it.
4. Save, list, edit, and remove their own tracked items.
5. Set a target price and turn email/push alerts on or off for each item.
6. See the latest successful check and price history, including a simple chart on the web.
7. Manage the same tracked items from Flutter.
8. Log out and stop that device from receiving another user's push alerts.

Unsupported URLs, unknown/DLC/edition matches, unavailable Steam offers, and failed checks should have clear messages. Never substitute another store's cheaper offer, a historical low, or zero when Steam data is missing. A failed check must not generate an alert or fake history entry. A genuine current price of zero, if reported and valid, is different from missing data.

## Price checking

Start with one check every **24 hours**, configurable on the server. The worker runs without either client being open. An authenticated **admin-only Check Prices Now** action calls the same service for testing and demos. Ordinary users cannot trigger unrestricted retailer requests.

The shared check service should:

1. Claim due products so overlapping scheduled/manual runs do not check them twice.
2. Fetch each distinct CheapShark game once per run/cache window, not once per user, and select the exact enabled store's offer.
3. Save a successful observation and update the current price and last-success timestamp.
4. Evaluate all users tracking that product.
5. Record pending notification deliveries and send eligible alerts.
6. Record failures, apply bounded retries/backoff, and continue with other products.

Use one worker process initially, plus a database-backed claim/lease to protect against restarts and accidental overlap. A separate queue service is not needed for the MVP. Set timeouts and per-provider request limits.

## Alert rules: do not send the same alert every day

Use **current price ≤ target price**, with both prices in the same currency. Money is stored as integer minor units: USD 49.99 is `4999`, not a floating-point dollar value.

A target of **$0** is valid for a game. Both current price and target must be nonnegative safe integer cents. Missing or failed price data is not a zero-price offer.

- Alert once when an item first qualifies, including the first successful observation if it is already at/below target.
- Do not alert again while it remains at/below target, even if its price changes again below that target.
- A successful price observation **above** the target rearms the item. A later drop can start a new alert episode.
- A failed check does not end an episode or rearm it.
- Saving a changed target starts a new evaluation only when the value actually changes. Replaying the same update must not send another alert.
- Turning a channel off and back on does not reset an already-alerted episode. If no alert has been created yet, an enabled channel can be evaluated on the next successful check; turning on a second channel does not replay an old episode.
- Email and push have separate delivery records. A push retry must not resend a successful email.

`lastNotifiedAt` alone is not enough. Save durable episode state and use a unique delivery key such as `(trackedItemId, episodeId, channel)`. Claim each delivery atomically before sending it. Store a provider message ID/idempotency key when supported. Deduplicate push handling on the client with the same event ID.

**Important limit:** a database cannot guarantee exactly-once delivery through an arbitrary email provider. If a provider accepts an email but the connection drops before confirmation, a blind retry can duplicate it. Prefer a provider with idempotency support; otherwise mark that outcome as uncertain and reconcile it instead of automatically resending. The integration tests must cover repeated runs, concurrent runs, restarts, recovery above target, target edits, and partial channel failures.

For example, [Resend documents a 24-hour idempotency window](https://resend.com/docs/dashboard/emails/idempotency-keys); that is an option to evaluate, not a selected dependency, and it does not replace our permanent delivery record. [FCM collapse keys only replace messages still waiting for delivery](https://firebase.google.com/docs/cloud-messaging/customize-messages/collapsible-message-types); they are not a permanent duplicate-alert guard. These sources were checked October 23, 2026.

## Proposed data model

These are implementation starting points, not finished schemas.

| Collection | Main fields and rules |
| --- | --- |
| Users | Normalized unique email, password hash, name, verification state, role, hashed expiring verification/reset tokens. Store push device tokens with user ownership, or use a small separate device collection. |
| Products | Keep this collection name if useful; each row represents a game at one store. Fields: provider (`cheapshark`), provider game ID, Steam app ID, store ID (`1` initially), market (`US`), currency (`USD`), canonical Steam URL, current deal ID/purchase redirect, title, optional image, price in minor units, last successful check, next check, last error, worker lease. Unique identity is `(provider, providerGameId, storeId, market, currency)`. Deal IDs are not stable game identity. |
| TrackedItems | User ID, product ID, target price, per-channel preferences, alert episode state, timestamps. Unique `(userId, productId)` prevents accidental duplicate tracking. Every query/update/delete enforces user ownership. |
| PriceHistory | Game/store Product ID, price in minor units, USD currency, successful local fetch/check timestamp, optional provider change timestamp, check ID. Record our observations from this point onward; do not invent past observations from a historical-low summary. Index product + time and deduplicate the same check. |
| NotificationDeliveries | Tracked item, episode ID, channel, status, attempts, provider message ID, timestamps. Unique episode/channel key prevents repeated sends. Never log message secrets or device tokens. |

Game/store offers are shared across users, but watchlists and notification settings are private. A Steam offer is not a GOG offer; a base game is not DLC or a deluxe edition. Preserve those distinctions, reject ambiguous matches, and do not use title similarity as proof of identity. Compare listed US/USD base-game prices as reported by CheapShark, excluding additional taxes/coupons/subscriptions. Explain that the source is CheapShark, not a direct Steam checkout quote. Keep the original validated Steam URL for identity and use the required CheapShark redirect for purchase actions.

## API boundaries

Use `/api` as the common prefix. Only health/readiness endpoints are implemented in the starter; business endpoints below are planned. The [proposed shared OpenAPI 3.1 contract](api/README.md) defines strict bodies, examples, cookie/bearer sessions, CSRF, pagination and errors. It awaits team review and actual SwaggerHub publication; it does not implement these routes.

Planned groups:

- `/api/auth/web` and `/api/auth/mobile`: register, verify/resend email, login, logout, forgot/reset password, current user; web adds CSRF bootstrap.
- `/api/product-previews`: owned, authenticated, bounded Steam URL preview.
- `/api/tracked-items`: authenticated list/create/update/delete.
- `/api/tracked-items/:id/history`: history available only through an owned tracked item; no public product-history route.
- `/api/devices`: register/remove the signed-in user's push device.
- `/api/admin/price-checks`: admin-only manual check and status.

Decide exact request/response schemas and token handling in the API-contract issue before both clients build against them. Return consistent validation and error responses. Never expose API keys, database credentials, password hashes, or verification/reset tokens in normal API responses.

Hash passwords with a maintained password-hashing library, rate-limit authentication endpoints, and give the same public response for password-reset requests whether an email exists or not. Expire and invalidate used verification/reset tokens. If the web app uses cookies, include CSRF protection and secure cookie settings; mobile tokens belong in platform-backed secure storage, not plain preferences. Document how logout and password resets revoke sessions.

## CheapShark integration and URL safety

Keep a small normalized provider interface so neither client nor the scheduler depends on CheapShark response details. See [the game-data research](retailer-research.md) for endpoint sequence, sources, and observed limitations. No HTML scraper or extra provider is required for the MVP.

Keep [the provider decision guide](provider-decisions.md) for future reference. It explains Best Buy's 72-hour cache limit, Amazon's scraping/affiliate restrictions, Target's scraping/storage restrictions, and other rejected or unresolved choices in plain English.

Accept exact Steam hosts and `/app/<numeric-id>` paths, validate locally, and never request the submitted URL. Resolve the app ID through CheapShark, verify an exact match, and select `storeID=1`. Use fixed HTTPS `www.cheapshark.com/api/1.0/` endpoints with validated query parameters. Do not choose an all-store cheapest field, `cheapestPriceEver`, a different edition, or another store when no current Steam offer exists.

Reject credential-bearing/non-HTTPS/wrong-host/unexpected-port URLs and unsupported path types, including Steam bundles and subscriptions. Validate all actual outbound destinations, rejecting private/loopback/link-local IPs and unsafe redirects. Use request/body limits and total deadlines. Do not execute fetched content or use arbitrary image proxies. Apply these rules to preview, scheduled, and manual checks alike.

Cache shared lookups, honor 429/Retry-After, and use bounded backoff. Send the descriptive application `User-Agent` required by the API docs. [The source proof](cheapshark-proof.json) passed October 26: two exact Steam URLs, matching game IDs, and Steam offers, with four HTTP 200 responses. Earlier 429 responses do not mean the native Node.js lookup is still unverified. Never rotate accounts/IPs or add a paid fallback. The docs prefer direct client calls and warn against bulk catalog caching; our scheduled checks are limited to the small watched list. If CheapShark blocks that use, escalate or reduce scope. The app adapter and its offline tests remain implementation work in #12; the research proof in #3 is complete.

Purchase redirects are not API endpoints. The provider explicitly blocks automated access to `/redirect`. An extra server-side probe returned 403, as the docs describe; no bypass was attempted. Generate the documented link for user navigation, but never request it in the worker or live verification script.

Use minimal offline fixtures for parsing, exact identity, money, missing-store, and throttle tests. Keep source attribution and required CheapShark deal purchase links in API responses, both clients, and notifications. The provider's `lastChange`, where available, is not our fetch time and does not prove a new discount today. The current API terms/history policy is recorded in #3; apply it to our observations without bulk-exporting or archiving third-party payloads.

## Course deliverables

The local assignment PDF is reference material only and is not committed. It requires:

- MERN, with React + TypeScript, and a Flutter mobile app.
- Remote MongoDB, email verification before login, password reset, and stronger authentication.
- Gantt chart and ERD.
- Use-case diagram, either a sequence or activity diagram, and a mobile class diagram. Use **PlantUML** for UML sources and keep the exported diagrams with the submission.
- API documentation on **SwaggerHub**.
- Unit and integration test results.
- Web and mobile prototypes/wireframes. Simple sketches or screenshots are fine for planning; **Figma is not required**.

Keep diagram and API documents consistent with the implemented system, not only this initial plan. Test reports should include actual commands, dates, results, and known failures; do not claim unrun tests passed.

## Team and review

| Person | Main work |
| --- | --- |
| Alex (`@aluciencozy`) | Project coordination, PR reviews, Flutter, Android push, presentation integration. |
| Martin (`@Martaino`) | React/TypeScript web app and Tailwind UI. |
| Ibrahim (`@IbrahimShaqqou`) | MongoDB, indexes, deployment infrastructure; then integration tests and backend support. |
| James (`@MageOfLight`) | Express/TypeScript API, authentication, shared app services. |
| Nick (`@NickTheBrick04`) | CheapShark lookup/matching, provider adapter, scheduled price checks. |

Use small PRs linked to an issue. Alex reviews cross-app contracts and integration work. Use offline fixtures and agreed API examples to let web, mobile, and backend progress in parallel; final acceptance still requires real Steam price data and real email/push.

## Demo and finish line

By November 10, run the full flow on the deployed web app and an Android device/emulator: verify/login, add a supported URL, change the target, run an admin check, see a price observation, receive email and push, run the same check again without duplicate alerts, edit/delete the item, and confirm both clients show the same data.

Use a real Steam base game with a valid current offer. Check once with a target below its reported price, then change the target above that real price and run an admin check. Show the qualifying email/push, repeat the check without another alert, and show the same item in both clients. This is a target-condition demonstration, not a claimed new sale. Do not fabricate a price or depend on an actual discount starting during the presentation. Keep test accounts and secrets out of Git. November 11–15 is for rehearsals, final evidence, and small fixes—not unfinished core features.
