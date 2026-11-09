# Release readiness — November 9, 2026

This is a handoff, not a release approval. It summarizes reviewed changes in
backend runtime `6de4fb3`, dependency lockfile `b427837`, mobile push `d1a688c`
with contention fix `d6d4b9e`, and portable browser-history fixtures
`2e85fcb`/`8f167c5`. It does not say the app is deployed, that a chosen host costs
$0, or that deployed email, push, or daily price checks have worked. The November 5 VM
record is still evidence only for its older sample-mode build `b668d1e`; see
[the VM record](lab-vm-deployment.md).

## What is in the code

| Area | Current implementation | What the evidence does not prove |
| --- | --- | --- |
| Web sample and API boundary | Web sample data remains the default and stays in memory. API mode uses the shared Express API. | Sample success is not an account or saved-data result. A running health endpoint is not a live tracker. |
| Accounts and private data | Verified account/session routes are mounted. With `PRICE_TRACKING_ENABLED=true`, the API composes Steam preview, owned tracker CRUD/history, and admin-only check routes. Device endpoints require a verified mobile session. | Tracking is off by default. Remote MongoDB, actual HTTPS/CORS, mailbox links, two-user ownership, and deployed cross-client acceptance are pending. |
| Price checks | Scheduled and admin checks use the shared service. One bounded live application-adapter lookup for Portal 2 completed on November 9; see the [adapter report](test-results/live-adapter-2026-11-09.md). | No cron or second checker is part of this design. One dated lookup does not prove a deployed daily run, a checkout quote, or host uptime/cost acceptance. |
| Alert state and delivery | Saved alert records remember each qualifying price episode and keep email and push delivery attempts separate. All live delivery flags default off. | Fixture tests and manual transport events do not prove sender approval, mailbox arrival, a qualifying outbox episode, or exactly-once delivery. An uncertain send may need owner review. |
| Mobile push | The merged client has an opt-in Firebase gateway (`ANDROID_PUSH_ENABLED=true` plus explicit public Firebase build values). Controlled real FCM transport reached an Android emulator; see the [desktop report](test-results/android-desktop-2026-11-09.md). | It stays off by default. Permission-denial cleanup failed on the initial build; the integrated fix awaits a device retest. Project/billing and operational acceptance remain open. |

The [mobile push setup](mobile-push-setup.md) lists the public Flutter defines:
`ANDROID_PUSH_ENABLED=true`, `FIREBASE_API_KEY`, `FIREBASE_APP_ID`,
`FIREBASE_MESSAGING_SENDER_ID`, and `FIREBASE_PROJECT_ID`. These only configure the
client; they do not enable server sending. The server separately requires
`PRICE_TRACKING_ENABLED=true`, `PRICE_PUSH_ENABLED=true`, `AUTH_JWT_SECRET`,
`FIREBASE_PROJECT_ID`, and protected Application Default Credentials. Neither
side initializes/sends by default. Controlled emulator receipt is recorded, but
Spark/billing status and production approval remain pending. See the [Android readiness notes](android-push-readiness.md)
for lifecycle boundaries.

Runtime configuration, limits, recovery, and uncertain outcomes are described in
[backend runtime](backend-runtime.md). The operator steps for the existing API
service are in [VM scheduling](vm-scheduling.md). Neither document changes the
off-by-default settings or approves a live send.

## Recorded checks

The independently reviewed root `npm run check` at integration snapshot `ec59ddd`
passed lint, both TypeScript checks, both builds, and **700 tests**: 17 contract,
409 API, and 274 web tests, with zero skips. The API test script uses
`--maxWorkers=2`. At the earlier `49d423d` snapshot, `npm audit --omit=dev` reported zero vulnerabilities; the full
audit reported 10 moderate development-only findings and zero high or critical
findings. Issue [#23](https://github.com/aluciencozy/price-tracker/issues/23) is
closed for fixture-tested backend results; that does not close deployed
acceptance. Earlier browser-only QA retains its historical 687-test result.

The independent mobile review passed **237 Flutter tests** on Flutter 3.47.9 /
Dart 3.13.7. The permission-cleanup debug APK at `4a9a968` built offline; its
device retest remains pending. The repository remains pinned to Flutter 3.47.7 /
Dart 3.13.5. Controlled real FCM receipt and local cross-client checks are recorded
separately in the [desktop report](test-results/android-desktop-2026-11-09.md);
they do not prove a qualifying outbox episode or deployed delivery.

The independently reviewed dependency change `b427837` only updates the npm
lockfile. It uses a same-major compatible Google/Firebase transitive resolution
to remove the vulnerable production `rimraf`/`glob` path, without forced major
manifest changes. The recorded `npm audit --omit=dev` result is **0
vulnerabilities** (previously 6 moderate); full `npm audit` is **10 moderate,
development-only ESLint/TypeScript-ESLint `minimatch` warnings** (previously 15).
This removes the production findings; it does not make the full development
dependency audit clean. The production audit was recorded with zero findings;
these audit results are separate from the `npm run check` test count.

Issue [#16](https://github.com/aluciencozy/price-tracker/issues/16) is closed on
fixture evidence for durable alert episodes. It does not prove real provider or
notification delivery. The October 26 CheapShark source proof in issue
[#3](https://github.com/aluciencozy/price-tracker/issues/3) records two source
lookups; it is separate from the one bounded November 9 lookup through the current
application adapter, documented in the [adapter report](test-results/live-adapter-2026-11-09.md).
That report records one exact Portal 2 identity and a dated provider response; it
does not prove a checkout quote, broader catalog support, or a deployed daily
check. The lookup created no price-history observation. The online adapter check
for issue [#12](https://github.com/aluciencozy/price-tracker/issues/12) is ready
for closure after this reviewed evidence is merged; the issue remains open until
then.

Portable browser-history fixtures are merged in `2e85fcb` and `8f167c5`; the
test-only persistent fixture-disclosure setup in `c90eb0d` adds three targeted
tests. Together, eight targeted fixture tests passed. The disclosure banner is
present in the local fixture server and absent from the production build. The
optional synthetic-history scenario and exact local-only commands are in
[browser fixture acceptance](browser-fixture-acceptance.md). Synthetic rows are
not real recorded Steam prices. The [November 9 browser acceptance report](test-results/web-acceptance-2026-11-09.md)
records the fixture-only flows and focused disclosure retest after fix
`c90eb0d` (retest snapshot `4237043`). Account verification/login/reset/logout,
tracker operations/search/preferences/history, cross-account ownership, offline
behavior, responsive layouts, and targeted keyboard interactions passed in the
documented scenarios. No live provider, email, FCM, emulator, or purchase redirect
was used. axe found zero confirmed violations on audited views, but chart-axis
contrast checks remain incomplete; this is not a full accessibility audit or
WCAG conformance claim. The QA report's earlier disclosure failure is retained
as historical evidence and was resolved for the fixture retest.

## Owner acceptance still needed

The following issues were open when checked for this handoff. Keep each open
until its own full checklist and evidence are complete; a code merge or green
fixture suite is not enough.

| Issue / owner in issue | Short action before sign-off |
| --- | --- |
| [#2](https://github.com/aluciencozy/price-tracker/issues/2), Ibrahim | Approve the remote database and host; prove transaction commit/rollback, indexes, restricted access, backup/recovery, independent uptime, and the strict $0 limit. A VM or free-tier listing alone is not proof. |
| [#7](https://github.com/aluciencozy/price-tracker/issues/7), Nick | Confirm Resend sender-domain verification, recipient limits, shared account/alert allocation, published templates, and receipt at a team mailbox without paid billing or overages. |
| [#8](https://github.com/aluciencozy/price-tracker/issues/8), [#9](https://github.com/aluciencozy/price-tracker/issues/9), [#10](https://github.com/aluciencozy/price-tracker/issues/10), James / Martin | Run the real verify, login, reset, logout/revocation, and browser-link flow against the approved service and mailbox; retain the two-user security and ownership checks. |
| [#15](https://github.com/aluciencozy/price-tracker/issues/15), Nick | Observe the built-in daily UTC job and shared admin check on the approved always-running host; inspect run/retry recovery and sanitized logs. Do not add cron beside the API scheduler. |
| [#17](https://github.com/aluciencozy/price-tracker/issues/17), Ibrahim | Approve the Firebase project, Spark/billing status and server credentials; retest permission-denial cleanup on the integrated Android build. Controlled real emulator receipt is recorded, but keep `PRICE_PUSH_ENABLED=false` until operational acceptance. |
| [#18](https://github.com/aluciencozy/price-tracker/issues/18), Nick | Verify real email and Android delivery for one eligible episode, channel isolation, retries, and repeated-check deduplication. A target edit demonstrates qualification, not a new sale. |
| [#26](https://github.com/aluciencozy/price-tracker/issues/26), Ibrahim | Deploy an approved integration commit and verify HTTPS, production origins, database readiness/indexes, a daily run, recovery, email, push, and rollback. The November 5 `b668d1e` sample-mode record is not this deployment. |
| [#27](https://github.com/aluciencozy/price-tracker/issues/27), James | Record the deployed two-user security and end-to-end acceptance, including a real supported Steam offer, failures, and recovery. |
| [#30](https://github.com/aluciencozy/price-tracker/issues/30), Alex | Review release evidence and finish course handoff separately. Wireframe work is cancelled; defer UML diagrams and PowerPoint until app and test work is finished, at the very end. This course work is not an application-release blocker and is not claimed complete here. |

The remaining data-retention decision is whether to keep observed-price history
for 90 days; source-owner/team approval is pending. The one-off adapter lookup
created no history and does not resolve that decision. Do not enable live history
collection until owners approve it. The source research issue #3 is closed; its
completed research does not need to be reopened for this separate decision.

No issue state was changed for this documentation handoff. Real-price
demonstrations must use a supported game and change the user's target around the
actual reported price. Do not fabricate a sale, create a fictional live store, or
claim that a target edit was a price drop.
