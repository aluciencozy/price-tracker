# Database validation — November 4, 2026

Environment: macOS arm64, Node 24.22.1, npm 11.6.2, disposable local Docker
`mongo:8.0`. Base: `Staging` at `2e665ad` (Nick's CheapShark adapter).

Command from repository root:

```sh
TEST_MONGODB_URI=mongodb://127.0.0.1:27028 npm run check
```

| Check | Result |
| --- | --- |
| ESLint | Passed, zero warnings |
| API and web TypeScript | Passed |
| OpenAPI contract tests | 15 passed |
| API tests | 68 passed, including 14 new offline model cases and 6 new MongoDB integration cases |
| Web regression tests | 226 passed |
| API and web production builds | Passed |
| `git diff --check` | Passed |
| ER diagram | Generated from checked-in source and visually inspected as a PNG rendering |

The MongoDB tests create and drop only a randomly named isolated test database.
They verify repeated additive index creation, concurrent tracker uniqueness,
normalized email uniqueness, private field omission, duplicate history checks,
distinct successful same-price observations, per-channel delivery keys after a
disconnect/reconnect, device token/installation uniqueness and TTL index options.
Offline model tests cover zero, safe integer bounds, invalid/missing money,
currency, unknown fields, token hashes and immutable history fields.

An initial sandboxed API test run could not bind local ports (`listen EPERM`);
the final complete run above had local networking permission and passed.
The first full check also exposed the existing contract test's use of URL
`.pathname`, which left `%20` in filesystem paths. The test now uses Node's
`fileURLToPath`; the final run passed in this workspace containing spaces.

No real provider requests, messages, credentials or accounts were used. No deployed
MongoDB, replica-set transactions, authorization endpoints, history endpoint,
alert service, FCM delivery, or cloud deployment was verified. This report supports
schema issue #1 and contributes to #23; it does not complete the backend test matrix
or the live acceptance requirements of #2/#14/#16/#17/#23/#26.
