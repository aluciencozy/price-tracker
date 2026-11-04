# Backend integration validation — November 4, 2026

Supports [#23](https://github.com/aluciencozy/price-tracker/issues/23). The
`codex/backend-validation` branch combines PRs #42, #43, #44, #45 and #46 to check
that their models, scripts and services work together. It does not implement
James's authentication/watchlist endpoints, Nick's scheduler/delivery worker,
real Firebase setup or the deployed end-to-end flow.

## Actual local results

Environment: macOS arm64, Node 24.22.1, npm 11.6.2, Docker MongoDB 8.0 single-node
replica set, loopback-only port 27028. Test processes choose random isolated test
databases and drop only those databases. No remote credentials/provider messages
are used by these tests.

```sh
TEST_MONGODB_URI='mongodb://127.0.0.1:27028/?directConnection=true' npm run check
```

| Check | Result |
| --- | --- |
| Repository lint | Passed, zero warnings |
| API and web typechecks | Passed |
| Shared OpenAPI tests | 15 passed |
| API unit and integration tests | 124 passed across 11 files; no skipped integration cases |
| Web regression tests | 226 passed across 8 files |
| API/web production builds | Passed |

The 124 API tests include 48 existing health/provider/cache/budget cases, 14
schema validation cases, 8 MongoDB model/setup cases, 13 setup-target cases,
13 history cases, 11 alert-state cases, 8 device cases and 9 offline FCM cases.
They cover actual index conflicts and transaction rollback/commit; concurrent
tracker/observation/episode writes; immutable/deduplicated history; current Steam
versus invalid/wrong-store prices; ownership, paging and signed cursor checks;
target edits/channel toggles; restart/replay; session eligibility and token rotation;
and explicit delivery rejection/uncertainty outcomes.

## CI changes

The existing Node CI job now starts an official MongoDB 8.0 container, initializes
a single-node replica set and waits for a writable primary before running the
existing `npm run check`. It supplies only a loopback `TEST_MONGODB_URI` and removes
the container in an always-run cleanup step. No Atlas URI, Firebase credential,
provider request or additional cloud service is needed. The Flutter job is unchanged.

The local combined suite passed against the same replica-set topology. A GitHub
CI run must still confirm the workflow in its actual Linux runner environment;
do not label it passed merely because the local run passed.

The first GitHub run (41894577067) used `ubuntu-latest`, which resolved to Ubuntu
26.04, and failed because the MongoDB container exited before tests started.
Flutter passed. The initial workflow did not preserve the container's logs, so
the exact server crash was not established by that run. Adding container logs and
trying Ubuntu 24.04 exposed fatal MongoDB ID 12257600: its kernel-version guard
rejects the hosted runner's newer kernel before tests can start.

The Node job now pins **Ubuntu 22.04**, the temporary workaround recommended in
[GitHub runner-images #15005](https://github.com/actions/runner-images/issues/15005).
That upstream report reproduces the same issue on 24.04 and 26.04 and links the
MongoDB kernel-detection fix. We do not bypass the MongoDB guard or change Atlas.
The workflow always captures container state/logs before cleanup. The new run
must verify this correction; the previous local results remain local evidence only.

## Acceptance still outstanding

- Verified-before-login, reset, JWT/cookie revocation, CSRF/auth ambiguity and full
  tracker CRUD/search route tests require the shared API implementation.
- History ingestion and episode evaluation must be invoked by the shared scheduled/
  admin check service. Its overlapping run/lease/restart behavior needs integration
  evidence, beyond the service-level concurrency cases tested here.
- The actual delivery worker needs fenced claim/lease recovery, partial channel
  failures, unknown send reconciliation and provider-failure isolation tests.
- Live Atlas access with least-privilege credentials, deployed API environment,
  real email/Android delivery, Firebase lifecycle and complete security smoke
  tests remain. Local fixture tests are not that evidence.

#23 remains open until the full issue matrix is implemented and measured. These
results are a reproducible foundation and explicitly separate verified code from
remaining integration work. See individual database/history/alert/push reports for
their fixtures and limitations.
