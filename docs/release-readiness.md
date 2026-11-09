# Release readiness — November 9, 2026

This is a handoff, not a release approval. It describes integration branch
`integration/mvp-completion` at `5ff08aa`, including the independently reviewed
backend runtime commit `6de4fb3` and dependency lockfile commit `b427837`. It does
not say this integration is deployed, that a chosen host costs $0, or that any
live email, push, or price check has worked. The November 5 VM record is still
evidence only for its older sample-mode build `b668d1e`; see
[the VM record](lab-vm-deployment.md).

## What is in the code

| Area | Current implementation | What the evidence does not prove |
| --- | --- | --- |
| Web sample and API boundary | Web sample data remains the default and stays in memory. API mode uses the shared Express API. | Sample success is not an account or saved-data result. A running health endpoint is not a live tracker. |
| Accounts and private data | Verified account/session routes are mounted. With `PRICE_TRACKING_ENABLED=true`, the API composes Steam preview, owned tracker CRUD/history, and admin-only check routes. Device endpoints require a verified mobile session. | Tracking is off by default. Remote MongoDB, actual HTTPS/CORS, mailbox links, two-user ownership, and deployed cross-client acceptance are pending. |
| Price checks | Scheduled and admin checks use the shared service. The process has an opt-in daily UTC schedule and a separate due-run recovery loop. | No cron or second checker is part of this design. Live application-adapter lookup, a deployed daily run, real current quote, and host uptime/cost acceptance are pending. |
| Alert state and delivery | Saved alert records remember each qualifying price episode and keep email and push delivery attempts separate. All live delivery flags default off. | Tests use fake email/push senders, so they do not prove sender approval, mailbox arrival, Firebase setup, Android receipt, or exactly-once delivery. An uncertain send may need owner review. |
| Mobile push | The integration base has server device-registration routes and a client boundary with an unconfigured default gateway. Separate mobile commit `d1a688c` adds opt-in Firebase/Android handling but is not merged. | Its independent critical review is pending, as are a team Firebase project, Android configuration approval, and actual device receipt. |

The README's `docs/mobile-push-setup.md` link refers to the handoff from mobile
commit `d1a688c`; that file is not present in this branch base. Reconcile it with
the independently reviewed mobile integration before merging the final docs
set. Its current client switches are `ANDROID_PUSH_ENABLED=true` and the public
Flutter defines `FIREBASE_API_KEY`, `FIREBASE_APP_ID`,
`FIREBASE_MESSAGING_SENDER_ID`, and `FIREBASE_PROJECT_ID`. These do not enable the
server worker: server push also requires `PRICE_TRACKING_ENABLED=true`,
`PRICE_PUSH_ENABLED=true`, `AUTH_JWT_SECRET`, `FIREBASE_PROJECT_ID`, and protected
Application Default Credentials. The setup requires a team-owned Spark project
and a real Android receipt, both still pending. The existing
[Android readiness notes](android-push-readiness.md) remain available meanwhile.

Runtime configuration, limits, recovery, and uncertain outcomes are described in
[backend runtime](backend-runtime.md). The operator steps for the existing API
service are in [VM scheduling](vm-scheduling.md). Neither document changes the
off-by-default settings or approves a live send.

## Recorded checks

The integration baseline recorded for November 9 is root `npm run check`: lint,
both TypeScript checks, API/web builds, **16 contract tests, 371 API tests, and
274 web tests with zero skips**. A separate backend review reports **392 API
tests with zero skips**, plus API typecheck, API build, and lint passing. These
are separate recorded runs, not counts to add together. They use fixtures and do
not contact CheapShark, Resend, or FCM. Issue [#23](https://github.com/aluciencozy/price-tracker/issues/23)
is closed for the tested backend results; that does not close deployed acceptance.

The current integration baseline lists 188 Flutter tests. Separate mobile commit
`d1a688c` preserves `9996b25` and reports **218 Flutter tests**, format and
analysis checks, and a debug APK build passing on Flutter 3.47.9 / Dart 3.13.7.
The mobile code is complete but still under independent critical review and is
not merged into this branch. The repository setup remains pinned to Flutter
3.47.7 / Dart 3.13.5. This is not a version upgrade decision; refresh the count
and toolchain after the final mobile branch is reviewed and integrated.

The independently reviewed dependency change `b427837` only updates the npm
lockfile. It uses a same-major compatible Google/Firebase transitive resolution
to remove the vulnerable production `rimraf`/`glob` path, without forced major
manifest changes. The recorded `npm audit --omit=dev` result is **0
vulnerabilities** (previously 6 moderate); full `npm audit` is **10 moderate,
development-only ESLint/TypeScript-ESLint `minimatch` warnings** (previously 15).
This removes the production findings; it does not make the full development
dependency audit clean.

Issue [#16](https://github.com/aluciencozy/price-tracker/issues/16) is closed on
fixture evidence for durable alert episodes. It does not prove real provider or
notification delivery. The October 26 CheapShark source proof in issue
[#3](https://github.com/aluciencozy/price-tracker/issues/3) proves two real
Steam-to-CheapShark lookups; it is not a live lookup through the current app
adapter or proof of a deployed daily price check. The command for an explicitly
approved adapter check is documented in the [README](../README.md); no live
lookup was made for this handoff.

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
| [#17](https://github.com/aluciencozy/price-tracker/issues/17), Ibrahim | Approve a free Firebase/Android project and server credentials, integrate the real mobile permission/token gateway, and record receipt on an Android device. Keep `PRICE_PUSH_ENABLED=false` until then. |
| [#18](https://github.com/aluciencozy/price-tracker/issues/18), Nick | Verify real email and Android delivery for one eligible episode, channel isolation, retries, and repeated-check deduplication. A target edit demonstrates qualification, not a new sale. |
| [#26](https://github.com/aluciencozy/price-tracker/issues/26), Ibrahim | Deploy an approved integration commit and verify HTTPS, production origins, database readiness/indexes, a daily run, recovery, email, push, and rollback. The November 5 `b668d1e` sample-mode record is not this deployment. |
| [#27](https://github.com/aluciencozy/price-tracker/issues/27), James | Record the deployed two-user security and end-to-end acceptance, including a real supported Steam offer, failures, and recovery. |
| [#30](https://github.com/aluciencozy/price-tracker/issues/30), Alex | Review release evidence and finish course handoff separately. Wireframe work is cancelled; UML diagrams and PowerPoint are deferred to the final course-artifact pass. This course work is not an application-release blocker and is not claimed complete here. |

Other remaining decisions are whether to keep our observed-price history for 90
days (source-owner/team approval is pending) and a live lookup through the
application's CheapShark adapter. Do not enable live history collection or say
that adapter check passed until the owners decide and record the result. The
source research issue #3 is closed; its completed research does not need to be
reopened for these separate decisions.

No issue state was changed for this documentation handoff. Real-price
demonstrations must use a supported game and change the user's target around the
actual reported price. Do not fabricate a sale, create a fictional live store, or
claim that a target edit was a price drop.
