# Daily checks on the existing VM

This is the handoff for the API's built-in schedule. It is not evidence that the
new integration is deployed or approval to start price checks or send messages.
The November 5 deployment record is an older sample-mode build; see
[the historical VM record](lab-vm-deployment.md), [backend runtime details](backend-runtime.md),
and [release readiness](release-readiness.md).

In plain terms: when the owners approve and enable it, the VM checks prices each
day, resumes price checks that were left waiting, and sends enabled notifications
that are waiting. The website and phone app do not need to stay open. The checker
runs inside the existing API service.

## Use one long-running API service

The existing `price-tracker-api` systemd service starts `apps/api/dist/server.js`
as the `price-tracker` service account. When opted in, that API process runs the
daily checker and recovery loops itself. Keep the API process up even when nobody
has the website or mobile app open. If the VM or API service is stopped, no check
or notification can run; a restart resumes eligible saved work after MongoDB and
indexes are ready.

Do **not** add cron, a systemd timer, or a second scheduled checker. The API has
its own daily clock and durable claims. Another timer would add a competing
trigger and complicate monitoring, not make the existing schedule safer. Do not
run the API as root or change the service account from the checked-in systemd
unit. Keep its environment file protected and readable only by the existing
service account/group arrangement.

## What the clock does

| Work | API setting | Timing in the current code |
| --- | --- | --- |
| Check prices each day | `PRICE_SCHEDULER_ENABLED=true` | Checks the daily UTC slot every minute. It runs once for each UTC day. After restart, it resumes that day's saved run instead of starting a duplicate. A continuously running service normally starts the new day's check at or just after UTC midnight. |
| Finish a waiting or interrupted price check | `PRICE_RETRY_WORKER_ENABLED=true` | Looks for saved work that is due every 60 seconds by default. It does not create another daily check. |
| Deliver pending email or push alerts | `PRICE_EMAIL_ENABLED=true` and/or `PRICE_PUSH_ENABLED=true` | The enabled channel worker polls every 5 seconds by default, in small batches. |
| Verification and password-reset email | `ACCOUNT_MAIL_ENABLED=true` | Recovers and sends account mail every 5 seconds by default. |

The schedule catches the current UTC-day slot after startup; it does not replay one
new scheduled run for every day the VM was off. Provider limits, a busy run,
MongoDB downtime, and host suspension can delay work. This is not an exact-time
or delivery guarantee. Keep the watched-game list small and within the approved
free-use limits.

## Owner setup before any live flag changes

Keep all live flags `false` until the named owner has completed and recorded the
checks below. Adding a secret does not turn a worker on.

1. **Database and host — Ibrahim, issues [#2](https://github.com/aluciencozy/price-tracker/issues/2) and [#26](https://github.com/aluciencozy/price-tracker/issues/26).** Confirm the approved host can keep this service running and still meets the strict $0 rule; the old VM's existence is not proof of free ongoing compute. Set up remote MongoDB that supports the app's transaction tests. Give the app a database account limited to `price_tracker`, not an administrator account, and restrict which machines can connect. Use the existing `verify`, `indexes`, and `seed` steps in [infrastructure setup](infrastructure.md) and the [VM deployment record](lab-vm-deployment.md). Check that transaction commit/rollback and additive index setup both succeed before enabling tracking. Do not use a standalone database or `0.0.0.0/0` as a shortcut.
2. **Persistent server secrets — deployment owner.** Set `AUTH_JWT_SECRET` and `TRACKING_CURSOR_SECRET` to separate random values of at least 32 characters in the protected service environment. Keep both values stable across restarts and replicas. `MONGODB_URI` must name the application database. Never print or commit these values, and do not rotate them during a normal restart.
3. **Web origin and links — web/deployment owner.** Set `WEB_ORIGINS` to exact HTTPS origins only, with no path; the first entry is used to build verification and reset links. Set the web build's public `VITE_API_BASE_URL` to the HTTPS API origin without `/api` when it is not same-origin. The configured origin and deployed link must match. Do not put credentials in `VITE_` values.
4. **Email — Nick, issue [#7](https://github.com/aluciencozy/price-tracker/issues/7), with the account-flow owner for issues [#8](https://github.com/aluciencozy/price-tracker/issues/8) and [#9](https://github.com/aluciencozy/price-tracker/issues/9).** Confirm the existing sender domain is verified, real recipient restrictions, the actual free allocation, and receipt in a team-controlled mailbox. Runtime verification mail is plain text and does not need a Resend template. Publish and review the password-reset and price-alert templates; set `TEMPLATE_PASSWORD_RESET_ID` for account mail and `TEMPLATE_PRICE_ALERT_ID` for price email. `TEMPLATE_VERIFICATION_EMAIL_ID` is optional and used only by the separate `sendVerificationEmail` helper, not the runtime account-mail worker. Use only `RESEND_SEND_API_KEY` (Sending Access), `EMAIL_FROM`, and the template IDs for channels being enabled. Never deploy `RESEND_FULL_ACCESS_API_KEY`. Account and price messages share a conservative database-backed budget; it is not an absolute provider-spend guarantee.
5. **Android push — Ibrahim, issue [#17](https://github.com/aluciencozy/price-tracker/issues/17), with the app owner.** Approve a team-owned Spark Firebase project and Android app, then configure the mobile app with `ANDROID_PUSH_ENABLED=true` and the public Firebase build settings in [mobile push setup](mobile-push-setup.md). The mobile implementation is merged and tested, but it stays off without these explicit settings. Separately set server `FIREBASE_PROJECT_ID` and protected Google credentials with Application Default Credentials (for example, `GOOGLE_APPLICATION_CREDENTIALS` pointing to a private file readable by `price-tracker`). Do not enable paid Cloud Functions or put the private file in Git. Code and fixture tests do not prove that a real Android device receives a message.
6. **Confirm the API release and owner approval.** Build/deploy only through the existing [VM deployment procedure](lab-vm-deployment.md); preserve the last known release. Confirm the selected web/API origins, database, sender, Firebase access, quotas, and recovery owner before changing any flag.

## Enable only the accepted work

For daily price checks, the owner must deliberately set all three of these in the
protected API environment:

```dotenv
PRICE_TRACKING_ENABLED=true
PRICE_SCHEDULER_ENABLED=true
PRICE_RETRY_WORKER_ENABLED=true
```

Keep them `false` until the database transaction/index checks and release review
are complete. `PRICE_TRACKING_ENABLED` mounts preview, private watchlist/history,
and admin-check routes; it requires `TRACKING_CURSOR_SECRET` and MongoDB. The two
other flags enable the daily UTC run and recovery of due work. They do not enable
email or push.

Account email is separately controlled by `ACCOUNT_MAIL_ENABLED`. Price email and
push are separately controlled by `PRICE_EMAIL_ENABLED` and
`PRICE_PUSH_ENABLED`. Enable either channel only after its owner has verified the
service, access limits, recipients/templates or Android device, and real receipt.
The mobile app now has an opt-in Firebase gateway, but it does not initialize
Firebase by default. `ANDROID_PUSH_ENABLED=true` and the public client keys only
enable the app side; they do not start server delivery. Keep `PRICE_PUSH_ENABLED`
off until the approved Firebase project, protected server credentials, and real
Android receipt have been accepted. The server also requires
`PRICE_TRACKING_ENABLED=true`, `AUTH_JWT_SECRET`, `FIREBASE_PROJECT_ID`, and
Application Default Credentials.

Do not copy values into a repository file or make changes from this documentation
branch. The [backend runtime guide](backend-runtime.md) lists every dependency,
default, and limit for these flags.

## Check health, work, and recovery

- Check `GET /api/health` for API liveness and database status. Check
  `GET /api/ready` for connected MongoDB and completed startup indexes. A ready
  response does not mean a check or message has happened.
- On the VM, use the existing service's `systemctl status price-tracker-api` and
  sanitized `journalctl -u price-tracker-api` output. Worker errors are reported
  with fixed codes; do not expose environment values, database URIs, tokens,
  recipient addresses, or raw provider errors in a ticket or log.
- An authorized admin can inspect a manual check at its returned status URL.
  Scheduled checks and waiting notifications are saved in MongoDB. Use the
  deployment owner's approved monitoring process to review saved run times,
  lock expiry, `nextRetryAt` (when a retry is due), and notification status. Do
  not manually reset a notification or retry an uncertain send; that can create
  a duplicate message.
- If MongoDB disconnects, the workers pause. Once it reconnects, the running
  process checks again; the price-recovery worker resumes due price checks, and
  the delivery workers pick up notifications still waiting or whose worker
  stopped before finishing. An unknown external send stays unknown if retrying
  could send a duplicate.
- Restart only through the existing systemd service after an approved release or
  environment update. Keep the VM running between scheduled checks. If service or
  VM downtime spans the daily slot, restart recovery can finish eligible saved
  work, but it does not manufacture a separate run for each missed calendar day.

## Roll back safely

Before deploying, record the approved stable release and commit for rollback. If
the new release is unhealthy, use the existing VM runbook to point back to that
recorded release and restart `price-tracker-api`. If no stable API integration
release exists yet, ask the deployment owner to choose one; do not treat the old
sample-mode build as a working tracker rollback. Keep the same database and stable
auth/cursor secrets. Do not drop delivery, email-budget, run, or history records:
they protect against duplicate messages and lost observations. If live flags were
enabled, the owner should disable them in the protected environment before or
during rollback, then confirm readiness and inspect saved recovery state before
re-enabling anything. The November 5 build does not contain the current API
integration.
