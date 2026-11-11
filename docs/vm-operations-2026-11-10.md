# VM operations checklist — November 10, 2026 (Eastern)

Supports [#2](https://github.com/aluciencozy/price-tracker/issues/2),
[#17](https://github.com/aluciencozy/price-tracker/issues/17),
[#23](https://github.com/aluciencozy/price-tracker/issues/23), and
[#26](https://github.com/aluciencozy/price-tracker/issues/26).

## Access and deployed release

- [x] Confirmed the original key supplied by the team signs in as `azureuser`
  at `20.221.200.159`, using an independently pinned VM host identity. Its RSA
  fingerprint matches the original authorized key. No new shared private key or
  general-access key was created. The temporary local key copy is removed after
  the checks; do not commit or redistribute private keys.
- [x] Confirmed PR #62 merged and actual Actions deployments succeeded. The latest
  measured release is `22f589e`, run
  [42739043577](https://github.com/aluciencozy/price-tracker/actions/runs/42739043577).
  Its public marker says `dataSource: api`; it is no longer the original sample build.
- [x] Scanned locally reachable Git history and GitHub PR descriptions, issue
  comments and review comments for a password-bearing URI for the actual Atlas
  cluster. No such value was found. This does not audit private Discord messages,
  screenshots, external forks or unknown copies. No password was rotated without
  evidence of an exposed value. Never paste a real URI in a PR or Discord.

Team SSH command, with Alex's existing key saved privately on the user's machine:

```sh
chmod 600 contact-manager-server_key.pem
ssh -i contact-manager-server_key.pem azureuser@20.221.200.159
```

Verify a first-use server fingerprint with the VM owner rather than accepting an
unexpected changed host key. An alternative hostname is
`price-tracker-ibrahim.northcentralus.cloudapp.azure.com`. The GitHub deployment key
remains restricted to deploy/rollback; it is not the key for interactive team access.
If an individual cannot connect, collect that person's public key and authorize
it separately. Do not send the new GitHub private key.

## Custom domain

- [x] DNS for `largeproject.cop4331cfall26jo.com` resolves to `20.221.200.159`.
- [x] Expanded the existing free Let's Encrypt certificate to cover the new domain
  and the Azure hostname. Certificate expiry is February 9, 2027; certbot renewal
  remains enabled. No domain purchase or paid resource was created.
- [x] Apache serves the new domain over HTTPS and redirects HTTP to it. The Azure
  HTTPS hostname remains available for existing links, SSH identity and deployment
  checks. Both hostnames use the same application release.
- [x] `WEB_ORIGINS` lists the custom HTTPS origin first and the Azure HTTPS origin
  second. Account verification/reset links use the first configured origin.
  Measured custom-domain preflight returns 204 with the exact allowed origin;
  API readiness is 200 with MongoDB connected. Homepage/reset routes return 200.

Root-only backup copies of the previous vhosts and environment are in
`/var/backups/price-tracker/domain-*`. They contain secrets and must stay private.
TLS configuration uses the existing `/etc/letsencrypt/live/price-tracker-ibrahim.northcentralus.cloudapp.azure.com/`
certificate files; the directory name need not match the new primary hostname.

The workflow in this PR additionally checks the exact public release on the new
domain before success. A failed domain check uses the existing guarded application
rollback. A file rollback cannot undo DNS, certificates or database changes.

## Hourly checks

- [x] Installed root-owned `hourly-price-check.mjs` at
  `/usr/local/lib/price-tracker/hourly-price-check.mjs` and the checked-in
  `price-tracker-hourly.service` / `.timer` under `/etc/systemd/system/`.
- [x] Enabled the persistent hourly systemd timer. It runs at the top of each UTC
  hour with up to 45 seconds jitter. It does not require an open browser, mobile
  application, or a functioning API listener.
- [x] Disabled `PRICE_SCHEDULER_ENABLED` to avoid a duplicate daily scheduler.
  `PRICE_TRACKING_ENABLED` and `PRICE_RETRY_WORKER_ENABLED` remain true. The API
  continues its existing frequent recovery loop; account and price delivery
  workers retain their separate opt-in controls.
- [x] Started the real service and observed bounded retry followed by success for
  `scheduled_hourly_498435`. Both selected product records were skipped according
  to the shared service's eligibility/freshness rules. This is execution evidence,
  not proof that new live prices were fetched or notifications were delivered.
  The first attempt failed and the automatic retry completed; no raw driver or
  provider errors were logged.

The wrapper imports the current release's shared `runPriceChecks` and
`resumeDuePriceChecks`, which are also used by admin/API checks. It resolves the
release path once, uses one stable UTC-hour run ID, recovers at most one existing
run per attempt, and caps new selection at 100 products. MongoDB global/run/item
leases and the shared provider budget remain authoritative. Systemd prevents
overlap of this unit; contention or partial work retries with the same hour's ID,
at most three starts in ten minutes. Interrupted work retains its persisted state.

The job is a lower-priority unprivileged process with CPU/memory limits. It performs
no npm install. Operators explicitly approved an hourly cadence for this VM;
this replaces the previous daily cadence rather than adding a second schedule.
Keep the catalog small and honor provider backoff. It does not bypass limits,
claim hourly fresh quotes are guaranteed, or request human purchase redirects.

Useful non-secret operations:

```sh
sudo systemctl list-timers price-tracker-hourly.timer
sudo systemctl show price-tracker-hourly.service -p Result -p ExecMainStatus
sudo journalctl -u price-tracker-hourly.service --since today
sudo systemctl start price-tracker-hourly.service
```

Install/reinstall these operator-managed files as root-owned files, verify with
`systemd-analyze verify`, run `systemctl daemon-reload`, then enable the timer.
Application deployment does not replace privileged system files. To stop new
hourly checks, disable the timer and stop its service; preserve MongoDB lease,
history, budget and delivery records. Do not enable the old daily schedule at the
same time. Keep the Node runtime and environment paths aligned with the API unit.

## Still blocked on team configuration and real delivery

- [ ] Nick must privately configure `RESEND_SEND_API_KEY` (Sending Access),
  `EMAIL_FROM` (an accepted sender), `TEMPLATE_PASSWORD_RESET_ID`, and
  `TEMPLATE_PRICE_ALERT_ID` in `/etc/price-tracker/api.env`. No Resend settings
  were present during this audit. Use `sudoedit`; never paste values in Discord,
  GitHub or public `VITE_` configuration. Omit unused values rather than leaving
  empty entries that fail validation.
- [ ] Confirm the Resend sender/recipient restrictions, published template safety
  and shared free-account budget. Then enable `ACCOUNT_MAIL_ENABLED=true` and,
  separately, `PRICE_EMAIL_ENABLED=true`, restart the API, and verify readiness
  plus actual verification/reset/price-message receipt at an approved mailbox.
  Inspect pending/expired/unknown records first; do not force uncertain messages
  back to pending or erase the shared budget. A successful provider response is
  not proof of inbox delivery.
- [ ] Alex must provide approved Firebase/Android project configuration and a
  working device/emulator. Configure `FIREBASE_PROJECT_ID` and protected ADC,
  then independently enable `PRICE_PUSH_ENABLED` and prove real Android receipt.
  Credentials do not activate sending by themselves.
- [ ] Full deployed acceptance, including authenticated admin checks, ownership,
  actual mailbox/device receipt and recovery must pass before closing the affected
  deployment/push issues. Do not close them on health checks alone. Existing
  closed #23 records fixture/replica-set test evidence, not live delivery.

No changes to teammates' authentication, frontend or notification implementation
were needed for this infrastructure work. Missing credentials and device access
are not substituted with fake successful delivery.
