# GitHub deployment to the existing Azure VM

Supports [#26](https://github.com/aluciencozy/price-tracker/issues/26) and
[#23](https://github.com/aluciencozy/price-tracker/issues/23). This uses the existing
VM and HTTPS origin; it creates no additional cloud resources or paid services.

## How deployment runs

After this workflow is merged into `main`, a successful **CI** run for a push to
`main` triggers **Deploy Azure VM**. The deploy job requires the latest push CI
run for that exact commit to pass, and checks that the commit is still `main`
before building and again before transfer. Pull requests never deploy. You can
also use **Actions → Deploy Azure VM → Run workflow**, selecting `main`; the same
CI requirement applies. A superseded run stops rather than deploying an old commit.

GitHub builds with Node 24 using `npm ci`, then transfers only package manifests,
the lockfile, compiled API/web assets, production dependencies and the read-only
verification script. Production dependencies are installed on the Linux runner
with lifecycle scripts disabled; the VM performs no npm install. This avoids
dependency-install CPU/memory pressure on the small live VM.
Source environment files, database dumps, `.git` and developer-machine dependencies
are not included. SSH requires the pinned VM host key; there is no permissive first-use
host check and the private key is removed from the runner after the job.

The VM extracts as the unprivileged `price-tracker` user. It validates production
configuration, atomically
switches `/srv/price-tracker/current`, and restarts the API. It checks MongoDB
readiness, HTTPS, frontend routes and an exact release marker. A failed switch
rolls back to the previous release and verifies readiness. GitHub performs another
external check and requests rollback if it fails. Both GitHub and the VM serialize
deployments. Old releases are retained for recovery; monitor disk space and prune
only reviewed, inactive releases after preserving a known-good build.

## Access and settings

Two repository Actions secrets are required:

| Name | Value / handling |
| --- | --- |
| `VM_DEPLOY_SSH_KEY` | Dedicated private SSH key, encrypted in GitHub. Never paste into code or logs. |
| `VM_DEPLOY_KNOWN_HOSTS` | VM Ed25519 public host-key line, independently checked through Azure. |

Host: `price-tracker-ibrahim.northcentralus.cloudapp.azure.com`; user: `azureuser`.
The dedicated key has `restrict` and a forced root-owned entry point. It accepts
only `deploy <sha>-<run>-<attempt>` or `rollback <sha>-<run>-<attempt>` and cannot
open an ordinary shell, allocate a terminal, or forward ports. Deploy permission
still allows replacing application code, so restrict repository write access.
The helper uses the existing VM sudo access; it does not add a general sudo grant.

The workflow builds the public website with `VITE_DATA_SOURCE=api`. It no longer
uses `VM_WEB_DATA_SOURCE` or publishes sample-mode releases. Release builds reject
an explicitly configured sample data source; local development can still use fixtures.
Before promotion, configure and validate account mail and the matching server flags.
Do not put credentials in public `VITE_` settings. This
workflow does not turn on tracking, scheduled provider calls, account mail or
push. These require separate operational acceptance and server configuration.

The database URI, `AUTH_JWT_SECRET`, `TRACKING_CURSOR_SECRET`, provider settings and
feature flags remain in `/etc/price-tracker/api.env`, root-managed, mode 640.
Signing secrets must stay stable across deploys. The deployment helper does not
change them or run destructive migrations, catalog seeds or database restores.
Startup owns additive indexes; incompatible schema changes need a separate review,
backup and migration plan before merging. File rollback does not undo database changes.

## One-time VM installation / key rotation

An authorized administrator installs these reviewed files as root-owned executable
files, outside application releases:

| Repository file | Installed destination |
| --- | --- |
| `deploy/vm/deploy-entry.sh` | `/usr/local/bin/price-tracker-deploy-entry` |
| `deploy/vm/deploy-release.sh` | `/usr/local/sbin/price-tracker-deploy` |

`/srv/price-tracker` and `releases/` stay root-owned. New release contents belong
to `price-tracker`.
Keep the existing systemd service and Apache TLS configuration. Helper changes in
later PRs require explicit administrator installation; application deployment
does not overwrite privileged helpers from an artifact.

Install the matching public key in `azureuser`'s `authorized_keys` as:

```text
restrict,command="/usr/local/bin/price-tracker-deploy-entry" ssh-ed25519 <public-key> price-tracker-github-deploy
```

For rotation, add a newly generated restricted public key, replace the encrypted
GitHub secret, verify a deployment, then remove only the retired public key. Never
disable host-key checking after host replacement: verify the new fingerprint via
Azure, then update `VM_DEPLOY_KNOWN_HOSTS`. To revoke deployment, remove this key's
authorization and delete `VM_DEPLOY_SSH_KEY`; existing application hosting continues.

## Recovery and checks

The Actions summary records the release ID, live origin and frontend mode. The
public `/deployment.json` contains only release identity and mode. Root-only
`/var/lib/price-tracker-deploy/<release>.previous` records its predecessor;
config-validation logs in that directory are private. API logs remain
in `journalctl -u price-tracker-api`. Raw logs and environment values do not belong
in GitHub issues.

An authorized operator can use the restricted key to send
`rollback <release-id>`. This is accepted only while that exact release is current,
so an old failed run cannot roll back a newer deployment. Re-running a previously
successful main workflow builds that commit with a new run attempt/release ID;
superseded commits require an explicit reviewed revert on `main` instead.

Local validation:

```sh
bash -n deploy/vm/deploy-entry.sh deploy/vm/deploy-release.sh
actionlint .github/workflows/deploy-vm.yml
npm run test:deployment
npm run lint
npm run build
```

These checks establish deployment behavior. They do not prove user ownership,
verified-email login, live price ingestion or external notification delivery.
See [the initial VM deployment](lab-vm-deployment.md) for the original release and
[database recovery](infrastructure.md#backup-reset-and-recovery) before migrations.

## November 9 validation record

- GitHub repository deployment secrets stored encrypted and verified by name only.
  Required stable signing secrets provisioned privately on the VM; existing values
  preserved. Tracking/scheduler flags remain disabled and frontend mode stays sample.
- Dedicated SSH identity rejected an arbitrary shell command as expected.
- `actionlint 1.7.12`, Bash syntax, lint, API/web builds, 16 contract tests and all
  six deployment-verifier tests passed locally with Node 24.22.1.
- Actual bundled Linux/x64 dependency release installed over the restricted SSH
  path using the original `b668d1e` sample build. Exact public release identity,
  frontend routes, API and MongoDB readiness passed.
- Explicit rollback restored the original release and readiness. A second test
  with a deliberately mismatched public release identity failed and automatically
  restored that original release. These test IDs were manual smoke identifiers,
  not GitHub workflow-run evidence.
- An earlier on-VM npm-install attempt caused the VM to stop responding; the
  original symlink stayed unchanged, and a VM restart recovered service. The final
  design installs dependencies on the runner instead; the bundled test passed.

The original `/srv/price-tracker/releases/b668d1e-20261105` is retained as the live
release after testing. This does not deploy the newer merged application or enable
its live features. The first actual Actions deployment still requires merging the
workflow into `main` and a successful CI run there.
