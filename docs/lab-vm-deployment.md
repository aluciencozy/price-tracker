# Lab VM deployment — November 5, 2026

Live URL: **https://price-tracker-ibrahim.northcentralus.cloudapp.azure.com/**

Deployed the current merged application, commit `b668d1e`, to the existing
`contact-manager-server` Azure VM (`20.221.200.159`). This supports
[#26](https://github.com/aluciencozy/price-tracker/issues/26) and the urgent lab
request. The retired site's files and original Apache configuration remain on
the VM for recovery. Separate course resources and MySQL were not changed.

## What is live

- Built React assets served by Apache, including direct SPA routes.
- Express API running as the isolated `price-tracker` system user under systemd.
- Apache proxies `/api/` to loopback port 4000; Node is not exposed publicly.
- Let's Encrypt HTTPS, HTTP redirect and automatic certificate-renewal timer.
- Real Atlas Free/M0 MongoDB connection using the application-scoped database
  user. The Atlas access list permits only this VM's single public IP.

**The deployed frontend is explicitly sample mode.** Its watchlist edits are local
and reset on refresh. Real registration/login, persisted watchlist routes, the
scheduled runner, email and Android delivery are not wired in the current merged
API. Health/readiness and an Atlas connection do not establish those features.
The auth and email work is still in separate team PRs. #26 remains open for that
full deployed end-to-end acceptance, scheduler/worker, and recovery evidence.

## Server layout

| Item | Location |
| --- | --- |
| Deployed release | `/srv/price-tracker/releases/b668d1e-20261105` |
| Current release symlink | `/srv/price-tracker/current` |
| API environment | `/etc/price-tracker/api.env`, root-managed, mode 640 |
| Node runtime | `/opt/node-v24.22.1-linux-x64` |
| API unit | `/etc/systemd/system/price-tracker-api.service` |
| HTTP/TLS vhosts | `/etc/apache2/sites-available/price-tracker*.conf` |
| Apache logs | `/var/log/apache2/price-tracker-{access,error}.log` |
| Application logs | `journalctl -u price-tracker-api` |

The [systemd unit](../deploy/vm/price-tracker-api.service) and
[HTTP bootstrap vhost](../deploy/vm/price-tracker.conf) are checked in without
credentials. TLS private keys and the database URI remain only in protected server
configuration. The temporary deployment SSH key is not committed.

After obtaining the certificate, the actual port-80 site uses the dedicated
[HTTPS redirect vhost](../deploy/vm/price-tracker-redirect.conf). Keep the frontend
and API proxy in the generated TLS vhost. A dedicated redirect prevents SPA
rewrite rules from short-circuiting the HTTP-to-HTTPS redirect.

## Build and redeploy

1. Select an approved commit and run `npm ci` and `npm run build` using Node 24.
   Build the web sample for the current health-only API. Enable API mode only when
   real authenticated business routes are mounted and verified.
2. Use `git archive` for tracked source, then add only `apps/api/dist` and
   `apps/web/dist`. Never archive the whole working tree, `.git`, `.env`, credentials
   or local database dumps. On macOS disable archive xattrs to avoid metadata noise.
3. Transfer the archive over authorized SSH and extract into a new release folder.
   Install locked production dependencies as `price-tracker`, with a writable
   `NPM_CONFIG_CACHE=/var/cache/price-tracker-npm`. Use `npm ci --omit=dev
   --ignore-scripts --no-audit --no-fund`; builds are already included.
4. Keep the root-managed API environment file outside the release. Its values are
   `NODE_ENV=production`, `HOST=127.0.0.1`, `PORT=4000`, exact HTTPS `WEB_ORIGINS`,
   and the secret `MONGODB_URI` with explicit `/price_tracker` database. Do not print
   settings in command output or paste them into PRs.
5. With the real URI supplied through `--env-file=/etc/price-tracker/api.env`, run
   compiled `dist/databaseSetupCli.js verify`, `indexes` and `seed` from `apps/api`.
   The seed inserts only approved game identities and preserves existing prices.
6. Point `current` at the new release, restart `price-tracker-api`, validate Apache
   configuration and reload Apache only if its configuration changed. Preserve the
   last known release until the new one passes external health/readiness and UI
   smoke tests.

For rollback, repoint `current` to the recorded prior application release and
restart the service. The first deployment has no prior Price Tracker release;
the original Apache vhost and `/var/www/html` remain for returning to the retired
site if explicitly desired. Do not restore old database snapshots without revoking
sessions and reconciling delivered notifications; see [database recovery](infrastructure.md).

## Measured checks

November 5, 2026, from the VM and an external client:

| Check | Observed result |
| --- | --- |
| Official Node runtime checksum | Passed, Node 24.22.1 |
| Local API/web production builds | Passed |
| Apache configuration | `Syntax OK` |
| API service | Enabled and active under systemd |
| TLS issuance | Valid certificate, automatic renewal configured |
| HTTPS homepage | HTTP 200 |
| Plain HTTP homepage | HTTP 301 to the HTTPS origin |
| Direct `/watchlist` route | HTTP 200, app renders |
| `/api/health` | HTTP 200, database `connected` |
| `/api/ready` | HTTP 200, `ready`, database `connected` |
| Atlas transaction probe | Actual rollback and commit passed from VM |
| Atlas additive indexes / seed | Both commands completed successfully |
| Browser sample smoke | Homepage, watchlist, search and game details render over HTTPS |

These checks made no live CheapShark calls, created no real user accounts and sent
no messages. Source review fixes for the UUID validator and purchase-link
normalization are already included in deployed commit `b668d1e`.

This reuses the existing authorized VM. It creates no additional paid VM, storage
plan, purchased domain or billing upgrade. It does not establish that the existing
student VM's compute/disk allocation is an always-free service; the approved
infrastructure budget and ongoing ownership still need team confirmation.
