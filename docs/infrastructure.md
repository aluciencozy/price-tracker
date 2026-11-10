# Free infrastructure and database setup

Tracks [#2](https://github.com/aluciencozy/price-tracker/issues/2) and deployment
[#26](https://github.com/aluciencozy/price-tracker/issues/26). This branch builds on
schema PR #42. The owner has an authenticated Azure for Students subscription with
its spending limit **On**, verified November 4, 2026. No new cloud resources,
payment method, paid tier or billing upgrade has been created by this work.

## Proposed services, pending team approval and live verification

| Component | Candidate | Free limits / unresolved acceptance |
| --- | --- | --- |
| Remote database | MongoDB Atlas Free/M0 | 512 MB including indexes, 100 operations/second, 10 GB in and out per rolling seven days. Provision and run our connection/index/transaction checks before acceptance. |
| API and web | Azure App Service Linux F1 | Shared CPU, 60 CPU minutes/day, 1 GB memory and storage. Provider HTTPS hostname; cold starts and quota shutdown possible, no SLA. Intended for learning/demo rather than supported production use. |
| Daily price scheduler | In-process timer in the API service on the documented Azure VM | No separate runner or service is added. The API process must stay running; checks begin 24 hours after scheduler startup and repeat 24 hours after each tick completes. Verify host uptime/cost approval, both opt-in flags, restricted Atlas access, and real persisted run evidence before acceptance. |
| Email / Android push | Existing team email adapter / Firebase FCM | Coordinate #7/#17/#18. Configuration and real delivery proof remain required. Never enable billing to unlock cloud functions. |

Sources checked November 4: [Atlas Free limits](https://www.mongodb.com/docs/atlas/reference/free-shared-limitations/),
[Atlas cluster storage](https://www.mongodb.com/docs/atlas/manage-clusters/),
[App Service Linux pricing](https://azure.microsoft.com/en-us/pricing/details/app-service/linux/),
[GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions).
Recheck actual signup/deployment screens and account quotas before provisioning.
Stop/reduce scope at a free limit; never auto-upgrade. Student credit is not proof
that a normally paid SKU satisfies the repository's strict free-service policy.

The old contact-manager VM is running Linux on `Standard_B2ats_v2`, with a premium
OS disk and public IP. A read-only inventory found a local MySQL listener, no
MongoDB executable and no Node executable on the command path. It is not an
established MongoDB deployment or an audited free hosting choice. The owner says
the old project is retired, but this audit has not stopped, deleted or modified it.
Other course resources are outside this project's scope.

Do not rely on scheduled WebJobs in F1: reliable schedules require Always On,
which Microsoft limits to paid Basic/Standard/Premium tiers. A browser keepalive
is not an independent scheduler. See [Microsoft's WebJobs guidance](https://learn.microsoft.com/en-us/azure/app-service/web-sites-create-web-jobs).
Do not substitute Azure DocumentDB/Cosmos compatibility for the required MongoDB
without course/team acceptance and verified transaction/index/TTL compatibility.

## Database creation and access

1. Create a separate Atlas project and select **Free/M0**, no payment method or
   trial. Prefer an available region near the approved Azure app region. Disable
   sample-data import and optional paid features.
2. Create an application database user restricted to `readWrite` on
   `price_tracker`; do not use Atlas account credentials or an admin role in the API.
   Store its generated password in the owner's password manager and deployment
   secret settings. Use a separate database/user for tests.
3. Restrict the Atlas access list to current developer IPs and all actual outbound
   app IPs. Do not use `0.0.0.0/0`. Review access after app moves or scales. TLS
   remains enabled. For an independent hosted runner, establish a narrow temporary
   egress rule or a reviewed runner with known egress; unrestricted network access
   is not a deployment shortcut. This is unresolved until tested.
4. Put a properly escaped connection URI with explicit `/price_tracker` database
   in ignored `apps/api/.env` for local use and Azure environment settings for
   deployment. Do not paste it in issue/PR text or logs. Atlas login and database
   login are separate identities. Never put credentials in `VITE_` settings.

## Repeatable operational commands

Run from the repository root with Node 24 and the API environment configured:

```sh
npm ci
npm run db:verify --workspace @price-tracker/api
npm run db:indexes --workspace @price-tracker/api
npm run db:seed --workspace @price-tracker/api
```

The npm workspace runs from `apps/api`, so dotenv loads its ignored `.env`.
An explicitly supplied `MONGODB_URI` takes precedence. Commands reject missing or
implicit application databases and `admin/config/local/test`. Logs contain only
success/failure summaries, not connection details. They disconnect on completion.
For a compiled deployment, run `node dist/databaseSetupCli.js verify` (or `indexes`
or `seed`) with production environment settings; it does not require `tsx`.

`verify` pings the database and proves both transaction rollback and commit using
a random marker in `infrastructureprobes`, then deletes only its own marker.
It leaves an empty probe collection. A standalone server fails this acceptance
check. The operation requires database write access; it is not a read-only ping.

`indexes` creates additive indexes without dropping/replacing existing indexes.
An incompatible existing index or duplicate data fails instead of silently being
destroyed. `seed` first builds indexes, then inserts only the two validated game
identities using `$setOnInsert`. Repetition preserves existing prices and leases;
it fabricates no current quote, past history, user, target or notification.
Create demo accounts through the real registration/verification flow when #8/#9
are implemented; do not prepopulate a shared password or pretend an account verified.

## Backup, reset and recovery

M0 lacks managed backups; do not promise automatic cloud restore. Use the official
[MongoDB Database Tools](https://www.mongodb.com/docs/database-tools/) from a trusted
machine to make a manual `mongodump` before migrations and release. Pass credentials
through its protected configuration/password prompt rather than shell arguments.
Keep dumps encrypted outside the repository with owner-restricted access; they
contain private accounts and tokens. Record capture date and restore procedure
without secrets. Do not upload dumps or raw provider payloads to GitHub.

Test `mongorestore` into a separate explicitly named staging database, then run
indexes and smoke checks there before switching an approved deployment. Restore
must not blindly overwrite the live database. Revoke restored sessions, device
eligibility and short-lived auth tokens; reconcile delivery records before starting
workers because messages sent after the backup cannot be inferred from that backup.

No destructive reset command is supplied. For a demo reset, remove only designated
demo accounts/trackers using reviewed owned operations, cancel pending deliveries,
and preserve deduplication state needed to avoid replay. `db:seed` can safely restore
missing catalog metadata. Full collection/database drops require a separate reviewed
recovery action and a verified backup.

## Verification record and remaining work

Local validation uses a disposable MongoDB 8.0 single-node replica set. The seed is
tested for idempotency and preservation of prices; the probe checks commit/rollback
and cleanup. This proves the local commands, not the remote service or least-privilege
configuration. #2 remains open until remote API-environment connection, team-approved
vendors/access, secrets, backup recovery and independent scheduling are demonstrated.
#26 remains open until the actual deployed account/watchlist/check/email/Android path
works without either client remaining open.
