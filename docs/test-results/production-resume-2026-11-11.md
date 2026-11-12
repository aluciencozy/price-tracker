# Production readiness resume — November 11, 2026

This records the combined pending fixes and VM checks after the usage-limit pause.
It is not a full release approval. Real email remains the final deferred test at
the project lead's request while sender-domain setup is pending.

## Combined Node validation

The resumed branch combines the production account-mail guard, Mongoose security
patch, signed-out page headings, trusted-loopback proxy handling, and the
teammate's custom-domain/hourly-runner changes from PR #65.

```sh
TEST_MONGODB_URI='mongodb://127.0.0.1:27065/?replicaSet=pt_resume_test' \
EMAIL_BUDGET_TEST_DISPOSABLE=1 npm run check
```

Passed lint, API/web typechecks, both builds and **735 tests with zero skips**:
17 contract, 11 deployment/runner, 421 API and 286 web. Tests used an isolated
local MongoDB 8.0.16 replica set, not the production database. No live provider or
message sends were made by the suite. The disposable MongoDB process was stopped
afterward. Mongoose emitted existing deprecated `new`-option warnings; these were
not test failures.

Mongoose is locked to 9.12.1. The production dependency audit reports zero
vulnerabilities; ten moderate development-tool findings remain.

## Android validation

The mobile agent passed formatting, analysis and **239 Flutter tests** with
Flutter 3.47.9 / Dart 3.13.7. The repository CI remains pinned to Flutter 3.47.7.
Release builds now default to the live team-domain API and reject explicit sample
mode; debug fixtures retain their existing local defaults. Foreground and
background push share the build-mode policy and fail closed before initializing
Firebase for invalid/sample configurations. Tracker details no longer falsely
report every device as disconnected.

A push-disabled API-mode debug APK built successfully using a user-owned SDK
overlay and an isolated Flutter home. This is a debug-signed acceptance artifact,
not a signed public release. No emulator, real account, Firebase delivery or
provider request was used by those tests.

## VM reconciliation

- Both the team domain and Azure hostname pass HTTPS readiness with a connected
  database. The teammate's custom domain, certificate, allowed origins and
  independent hourly timer are preserved.
- The active hourly timer replaces the earlier in-process daily scheduler; the
  API recovery loop remains enabled. Inspected recent hourly runs completed with
  two skipped products and no observations. This is not price or alert acceptance.
- The live Apache TLS virtual host now removes incoming forwarding identity
  headers early, before its loopback proxy adds trustworthy values. Configuration
  syntax passed before a graceful reload. Existing TLS, hostnames and response
  security policies were preserved, with a protected rollback copy retained.
- Source tests verify per-client auth rate limits through the trusted loopback
  proxy, ignored spoofed prefixes, untrusted-peer rejection and disabled proxy
  trust in development/wildcard-bind configurations. A deployed forwarding check
  is still required after the code update.
- The hourly wrapper selects its current UTC-hour ID on each invocation. Retries
  crossing an hour boundary can select a new ID after recovering due work; the
  operation notes were corrected rather than claiming all retries share a slot.
- VM resource headroom is limited: roughly 81 MiB available RAM was reported by
  the independent audit on the 891 MiB host, without swap. Dependency installs
  and test suites were kept off the VM. Resource limits alone do not establish
  production capacity or a completed infrastructure cost/security audit.

## Outstanding acceptance

The domain being usable for the application does not prove Resend sender-domain
verification. Actual mailbox verification/reset, authenticated two-user web and
Android flows, qualifying durable email/push alerts, recovery/overlap, Firebase
approval, release signing, SwaggerHub demonstration and team submission tasks
remain separate gates. No account was manually verified to bypass email and no
acceptance issue was closed merely because the code or anonymous pages passed.
