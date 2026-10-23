# Project scope and design

Price Tracker is our COP 4331C large project for Fall 2026. Save a product URL, choose a target price, and get an email or Android push notification when the price reaches that target. The React web app and Flutter app use the same Express API and remote MongoDB database.

**Development deadline: November 10, 2026. Presentation prep: November 11–15. Course deadline: November 15.**

This file describes the intended app, not features already built. See the root [README](../README.md) for what the starter can run today and [the work plan](plan.md) for assignments and dates.

## Keep the first version small

- React and TypeScript with Tailwind for the web app.
- Express and TypeScript on Node.js for the API and price-check worker.
- Mongoose and remote MongoDB for shared data.
- Flutter for mobile, with Android as the first demo target.
- Email for verification, password resets, and price alerts.
- Android push notifications, using FCM or an equivalent service selected during setup.
- One working real retailer integration first. Add a second source only after the main flow works.
- A clearly labeled demo provider with controlled prices, so the presentation does not depend on a real sale.

No Python, browser extension, Kubernetes, or separate mobile backend. The hosting provider is still open. Domains already exist; buying domains is not part of this project.

## What users should be able to do

1. Register, verify their email, and log in. An unverified account cannot log in.
2. Reset a forgotten password through an expiring, single-use email link.
3. Paste a supported product URL and see the product name, price, currency, and retailer before saving it.
4. Save, list, edit, and remove their own tracked items.
5. Set a target price and turn email/push alerts on or off for each item.
6. See the latest successful check and price history, including a simple chart on the web.
7. Manage the same tracked items from Flutter.
8. Log out and stop that device from receiving another user's push alerts.

Unsupported URLs, unavailable products, and failed checks should have clear messages. Never replace a real price with zero when a request fails. A failed check must not generate a price alert or a fake history entry.

## Price checking

Start with one check every **24 hours**, configurable on the server. The worker runs without either client being open. An authenticated **admin-only Check Prices Now** action calls the same service for testing and demos. Ordinary users cannot trigger unrestricted retailer requests.

The shared check service should:

1. Claim due products so overlapping scheduled/manual runs do not check them twice.
2. Fetch each distinct product/variant once, not once per user.
3. Save a successful observation and update the current price and last-success timestamp.
4. Evaluate all users tracking that product.
5. Record pending notification deliveries and send eligible alerts.
6. Record failures, apply bounded retries/backoff, and continue with other products.

Use one worker process initially, plus a database-backed claim/lease to protect against restarts and accidental overlap. A separate queue service is not needed for the MVP. Set timeouts and per-provider request limits.

## Alert rules: do not send the same alert every day

Use **current price ≤ target price**, with both prices in the same currency. Money is stored as integer minor units: USD 49.99 is `4999`, not a floating-point dollar value.

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
| Products | Provider, canonical product identity, selected variant, currency, normalized URL, name, image URL, current price in minor units, last successful check, next check, last error, worker lease. Unique identity must include variant and currency/market where relevant. |
| TrackedItems | User ID, product ID, target price, per-channel preferences, alert episode state, timestamps. Unique `(userId, productId)` prevents accidental duplicate tracking. Every query/update/delete enforces user ownership. |
| PriceHistory | Product ID, price in minor units, currency, checked-at timestamp, check ID. Index product + time; deduplicate observations from the same check. |
| NotificationDeliveries | Tracked item, episode ID, channel, status, attempts, provider message ID, timestamps. Unique episode/channel key prevents repeated sends. Never log message secrets or device tokens. |

Products are shared across users, but watchlists and notification settings are private. A shoe in size 8 is not the same tracked variant as size 10. Do not silently change variants, mix currencies, or compare an installment payment to a full product price. State clearly whether a price excludes shipping and tax; the MVP compares the listed product price only.

## API boundaries

Use `/api` as the common prefix. Only health/readiness endpoints are implemented in the starter; business endpoints below are planned. The team should agree on an OpenAPI contract early, then keep it synced with SwaggerHub.

Planned groups:

- `/api/auth`: register, verify email, login, logout, forgot/reset password, current user.
- `/api/tracked-items`: authenticated list/create/update/delete.
- `/api/products/:id/history`: history available only through an authorized tracked item.
- `/api/devices`: register/remove the signed-in user's push device.
- `/api/admin/price-checks`: admin-only manual check and status.

Decide exact request/response schemas and token handling in the API-contract issue before both clients build against them. Return consistent validation and error responses. Never expose API keys, database credentials, password hashes, or verification/reset tokens in normal API responses.

Hash passwords with a maintained password-hashing library, rate-limit authentication endpoints, and give the same public response for password-reset requests whether an email exists or not. Expire and invalidate used verification/reset tokens. If the web app uses cookies, include CSRF protection and secure cookie settings; mobile tokens belong in platform-backed secure storage, not plain preferences. Document how logout and password resets revoke sessions.

## Retailer providers and URL safety

Each provider returns the same normalized product/price result. Clients and the scheduler should not know how a particular retailer is fetched. See [retailer research](retailer-research.md) for sources, demo candidates, access restrictions, and the recommended order of work.

Start with a permissioned real source (Shopify is the technical first choice), a small Books to Scrape adapter labeled as a fictional training store, and our controlled mock. Confirm real-source rights by **October 26** or escalate the blocker. Public product JSON is not approval for scheduled collection, history retention, or alerts; neither a sandbox nor a mock silently replaces the real-source requirement. Record source-specific retention/attribution limits before storing observations.

Only accept explicitly supported hosts and product URL patterns. Parse URLs server-side; reject credentials, unexpected ports, non-HTTPS URLs, loopback/private/link-local addresses, and unsupported schemes. Check DNS results and every redirect; ideally build a fixed provider API URL from a validated product ID rather than requesting the submitted URL. Apply the same checks to previews and manual checks. Do not bypass CAPTCHAs, paywalls, or retailer access controls.

Use fixtures for parser tests. Live retailer calls do not belong in normal CI. Demo prices must be visibly marked as simulated; never present them as live Amazon, Walmart, or Best Buy data.

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
| Nick (`@NickTheBrick04`) | Retailer research, provider adapters, safe scraping, scheduled price checks. |

Use small PRs linked to an issue. Alex reviews cross-app contracts and integration work. Do not leave every feature waiting for the final week: use the demo provider and agreed API examples to let web, mobile, and backend progress in parallel.

## Demo and finish line

By November 10, run the full flow on the deployed web app and an Android device/emulator: verify/login, add a supported URL, change the target, run an admin check, see a price observation, receive email and push, run the same check again without duplicate alerts, edit/delete the item, and confirm both clients show the same data.

Use a real provider to show a real lookup, then a clearly labeled controlled demo product to show a repeatable price drop. Keep test accounts and secrets out of the repository. November 11–15 is for rehearsals, final evidence, and small fixes—not unfinished core features.
