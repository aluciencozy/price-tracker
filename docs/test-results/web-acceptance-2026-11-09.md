# Web acceptance report — November 9, 2026

## Scope and setup

- Tested reviewed snapshot `e120fd64a567b94266f6650cef0401afb5438af4` on `verification/web-stress`.
- Browser QA used local sample mode (`127.0.0.1:5173`) and the API fixture (`127.0.0.1:4016`, Vite `127.0.0.1:5176`) against the existing local test replica set (`127.0.0.1:27119`). The fixture mailbox marker returned `fixture: true`; its captured messages were inspected only as local test data.
- The regular fixture used a random disposable database. A second fresh fixture was started with `BROWSER_TEST_HISTORY=1` for history and reset coverage. Both exact database names were confirmed absent after graceful fixture shutdown. The shared MongoDB process was left running.
- No real credentials or user data were used. No external provider, mail, FCM, emulator, or purchase-redirect request was made. Screenshots remain outside the repository at `/home/alex/.cache/price-tracker-mvp-browser-qa/resume-e120fd64/screenshots/` and are not committed.

## Results

| Area | Result | Evidence |
| --- | --- | --- |
| Sample mode and request boundary | **PASS** | Home, seeded watchlist, detail, and add/edit flows worked. Sample actions produced no `/api` requests. |
| Sample CRUD and search | **PASS** | Add/preview/save, duplicate handling, zero target, edits, independent email/push preferences, search/no-results, refresh reset, and delete confirmation were exercised. The confirmation was cancelled with Escape and accepted with keyboard focus/Enter. |
| Sample lifecycle and failure states | **PASS** | Loading, empty, offline/retry, expired-session preview, save error, failed check preserving the last successful price, missing offer, genuine free price, unsupported DLC/bundle/edition, empty/error history, and illustrative-history states were inspected. Missing/failed prices were not shown as zero. |
| API account and session flows | **PASS** | Registration returned a generic response; verification required an explicit action and did not sign in. Login, session restore on reload, logout, and signed-out private-route protection worked. A separate fresh fixture exercised register `202`, verify `204`, login `200`, forgot-password `202`, and reset-password `204`—five account POSTs, with no rate-limit response. Reset required the explicit form action, did not auto-login, and the subsequent `/me` check returned `401`; private data was cleared. |
| API tracker operations and authorization | **PASS** | Portal 2 and Half-Life 2 preview/save, duplicate preview, zero target, edit, independent alert preferences, search/no-results, empty history, invalid URL/DLC validation, and delete confirmation were exercised. A saved deletion remained absent after refresh. Missing tracker returned `404`; a request without CSRF returned `403 CSRF_INVALID`; an ordinary-user admin check returned `403 ADMIN_REQUIRED`. |
| Cross-account isolation | **PASS** | A second verified account had an empty watchlist. Requests for account A’s Portal 2 tracker and its history as account B both returned `404`, without exposing the item. |
| API offline behavior | **PASS** | Aborting the local watchlist API request showed an API connection error and Retry; it did not fall back to sample data. Retry restored the saved API watchlist. |
| Synthetic history table and chart | **FAIL — disclosure** | With the history-enabled fixture, both games rendered a chart and three table rows: Portal 2 `$14.99`, `$11.99`, `$9.99`; Half-Life 2 `$7.99`, `$12.99`, `$9.99`. The rows were synthetic QA fixtures. The UI labeled them “Successful observations” / “Successful Steam observations” and did not say synthetic, illustrative, or not real. It also labeled the fixture’s current `$9.99` offer “fresh” via CheapShark. “Not a live checkout quote” does not explain that these fixture values are invented history. See Bug 1 below. |
| Responsive layout | **PASS** | Sample detail screenshots at 320, 390, 768, and 1440 px showed no horizontal overflow. API detail measurements at the same widths reported document/body width equal to viewport width, with no horizontal overflow. |
| Accessibility and keyboard | **PASS with manual review** | axe-core 4.12.1 found zero confirmed WCAG 2 A/AA violations on audited sample/API views. The sample confirmation-dialog audit had two incomplete checks (`aria-hidden-focus` and SVG chart color contrast), which require manual review and are not confirmed violations. Keyboard Escape/Tab/Enter behavior was exercised on sample removal. |
| Runtime and console | **PASS** | No application runtime errors were observed. Console output contained expected React development notices, reduced-motion notices, and Vite reconnect messages during intentional mode/server changes. |

## Bug 1 — synthetic API history is presented as real observations

**Severity: medium; acceptance failure for fixture-backed history.** In the documented `BROWSER_TEST_HISTORY=1` harness, both game detail pages render invented historical values using the same wording and visual treatment as real recorded observations. The page does not identify the history (or the fixture’s current offer) as synthetic. This can mislead a tester or presentation audience into treating invented rows as recorded Steam prices. Do not use these history screens as real-price evidence until the fixture data is visibly disclosed. No application changes were made in this QA-only task.

## Checks and limits

- Preserved pre-QA integration result: `npm run check` **PASS**, 687 tests passed, zero skipped (API test workers capped at 2). This check was not rerun during this browser-only acceptance pass.
- No mobile/Flutter checks were run as part of web QA.
- Live CheapShark lookup, production deployment, real mailbox delivery, Android/FCM receipt, and automated purchase redirects were not tested. These remain outside local fixture evidence.
- Only this documentation report is in scope for the acceptance commit; no application code, issues, or pull requests were changed.

## Cleanup

The browser session and the owned API/sample/API-mode Vite processes were closed. Both random fixture databases were verified absent after graceful shutdown. The shared MongoDB test replica set was not stopped. Screenshot evidence remains outside Git.
