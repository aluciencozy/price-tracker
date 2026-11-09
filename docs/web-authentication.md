# Web authentication — Issue #10

The React account screens use the existing shared Express API. No endpoint,
authentication strategy, or mail service was replaced. Registration,
verification/resend, login/logout, forgot/reset-password and session restoration
use `/api/auth/web`. Web sessions use browser-managed HttpOnly cookies and CSRF;
the mobile JWT is not stored or sent by the website.

Registration success and an unverified login offer a verification/resend link
with the entered email prefilled through router state. Passwords and link tokens
are never passed in router state. Verification/reset tokens stay in memory after
their fragment is removed from the address bar. Submission is explicit, and
neither operation automatically logs in.

Account forms show the API error summary and associate field errors with their
inputs when supplied by the API. Current account endpoints generally return an
empty field-error list and a generic summary; the UI preserves that response
rather than guessing individual errors. Pending requests block duplicate
submissions, verification and resend share one guard, and rate-limit waits block
explicit retries. Navigation aborts requests and discards late results.

Confirmed logout, successful reset and current-session 401 responses clear
private views. An offline logout reports failure and retains the known session:
it cannot promise server revocation. Successful logout remains effective even
if the following CSRF bootstrap fails. Reload restores the cookie session through
`/me`; an unavailable session check shows Retry without displaying private data.

## Local setup

Use Node 24, npm 11 or newer, and a local MongoDB replica set (transactions are
required). Install repository dependencies with `npm ci`. Keep configuration in
ignored environment files and use only synthetic accounts for local acceptance.

For the normal API, set `MONGODB_URI` in `apps/api/.env` to your local replica set
database. Keep the existing local `WEB_ORIGINS` defaults, and use the same hostname
throughout the browser flow. In `apps/web/.env`, set:

```dotenv
VITE_DATA_SOURCE=api
VITE_API_BASE_URL=
API_PROXY_TARGET=http://127.0.0.1:4000
```

Run `npm run dev:api` and `npm run dev:web` in separate terminals. Restart Vite
after changing configuration. Sample mode remains the repository default. No
tracking/scheduler opt-in or live provider call is needed to test account screens.

**Account mail defaults to disabled.** The integrated server can start the
existing dispatcher when `ACCOUNT_MAIL_ENABLED=true`, but only after the
[backend runtime](backend-runtime.md) configuration and operational requirements
are met. These include an approved HTTPS first web origin, verified sender,
Sending Access key and password-reset template. Credentials alone do not enable
sending. A 202 response can queue a message without delivering it.

For full local link acceptance without external mail, use the existing
[disposable browser harness](browser-fixture-acceptance.md). It runs the real
Express routes, MongoDB and account dispatchers with a captured-message transport.
Its inspection endpoint exists only in that standalone test harness. It is not
part of the production API, and captured messages are not mailbox delivery.

## Validation — November 9, 2026

Environment: Ubuntu 26.04 x86_64, Node 24.22.1, npm 12.2.1, disposable MongoDB
8.2.6 replica set, Chromium 158 through a temporary Playwright installation.
Test tools, binaries and browser profiles were kept outside the repository.

```sh
TEST_MONGODB_URI='mongodb://127.0.0.1:27060/?replicaSet=pt_test' EMAIL_BUDGET_TEST_DISPOSABLE=1 npm run check
```

Passed lint, both typechecks, 16 contract tests, 371 API tests, 282 web tests and
both production builds, with no skipped tests. Existing Mongoose deprecation
warnings appeared. Eight new screen regressions cover verification navigation,
field errors/corrected retry, duplicate verification/resend/logout submissions,
rate-limit blocking, navigation cancellation and invalid-link recovery.

Two separate Chromium scenarios used fresh harness databases and real API limits:

- Register, reject unverified login, preserve email for resend, explicitly verify
  a captured link, sign in, restore after reload, sign out, and protect Back and
  refresh afterward. Checked HttpOnly/SameSite=Lax session cookies, no JavaScript
  access to the session cookie, empty local/session storage and no horizontal
  overflow on the account page at 320, 390, 768 and 1440 pixels.
- Missing reset link, register/verify, request reset, open captured reset link,
  scrub the fragment, reject mismatched confirmation, complete reset without
  auto-login, then sign in using the new password. A sixth account POST exercised
  the actual 429 response, visible countdown and disabled submit control.

Both scenarios reported zero browser runtime errors and zero external requests.
They did not fetch Steam/CheapShark, send external mail, or weaken rate limits.
The existing API/session tests cover revoked sessions, expired/reused tokens,
old passwords, CSRF and ownership; screen tests cover offline failure and stale
session responses. These results are not a full accessibility or deployment audit.

## Integration refresh — November 9, 2026

Merged PR #61's `integration/mvp-completion` at `cda1096` into
`connect-web-authentication`. That snapshot already contains `Staging` at
`01d4d4e`. Conflicts were limited to README, web API wiring and browser fixture
instructions. The resolution preserves PR #61's guarded test-only Vite config
and synthetic-data disclosure, and updates the account-mail instructions to use
its existing opt-in dispatcher. Backend and mobile code match that PR snapshot.

The combined `npm run check` passed lint, both typechecks, 17 contract tests,
409 API tests, 282 web tests and both builds: **708 tests, zero skipped**.
The account and password-reset Chromium scenarios above were rerun successfully
against the combined API using PR #61's fixture Vite config and its required
disposable `pt_mvp_test` replica set on port 27119. Each scenario used a fresh
database, with no external requests or browser runtime errors. Full Node checks
used the separate disposable `pt_test` replica set on port 27060.

Review found stale setup wording but no new blocking authentication defect.
Flutter/device checks were not rerun for this merge; mobile code was preserved
from PR #61. Captured-message acceptance still does not establish real mailbox
delivery.

## Deferred real mailbox acceptance

Issue [#10](https://github.com/aluciencozy/price-tracker/issues/10) still needs real
mailbox-to-browser evidence. This was explicitly deferred; do not close the issue
on the strength of captured test messages alone.

1. Finish the verified $0 sender configuration and the operational shared email
   budget requirements described in [registration](registration.md),
   [email budget](email-budget.md) and [central integration](central-integration.md).
   The dispatcher is now wired into normal startup behind `ACCOUNT_MAIL_ENABLED`;
   enable it only after those requirements are met. Live flags default to off.
2. Use an approved HTTPS web origin and a team-controlled inbox. Configure SPA
   rewrites for `/verify-email` and `/reset-password`, no-referrer headers and
   production cookie/CORS policy. Keep all sender credentials server-side.
3. Register and receive the actual message. Open its link in the browser, confirm
   explicit verification and separate login; exercise resend and expired/used
   links without bypassing cooldowns.
4. Request a password reset and complete it from the inbox link. Confirm the old
   password and existing sessions are rejected, then sign in with the new one.
5. Record date, environment, sanitized outcomes and any sender restrictions.
   Never save tokens, passwords, cookie values or reusable links in evidence.
