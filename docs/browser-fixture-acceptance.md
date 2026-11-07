# Local browser acceptance (fixtures only)

The reviewed harness has passed targeted local browser QA. This is a
separate test-only server, not a deployment or real price/mail demonstration.
Never enter real credentials or user data. No provider, Resend, FCM, scheduler,
browser or emulator is started automatically by the harness.

From `/home/alex/.cache/price-tracker-web-flow-integration`, use separate terminals:

```sh
BROWSER_TEST_DISPOSABLE=1 TEST_MONGODB_URI='mongodb://127.0.0.1:27060/?replicaSet=pt_test' npx tsx apps/api/test/fixtures/browserAcceptance.ts
```

```sh
cd /home/alex/.cache/price-tracker-web-flow-integration/apps/web
VITE_DATA_SOURCE=api VITE_API_BASE_URL='' API_PROXY_TARGET=http://127.0.0.1:4016 node ../../node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5176 --strictPort
```

Open **http://127.0.0.1:5176**. The API binds only 127.0.0.1:4016; Vite proxies
`/api` so browser cookies remain same-origin. Do not use localhost interchangeably
with 127.0.0.1. A busy port is an error; never stop another owner's service or
silently switch ports. The shared MongoDB test primary on 27060 stays running.
This invokes the repository-pinned Vite executable directly (not through nested
npm option forwarding). These shell values must be set on the Vite process even
if a local `.env` exists; the explicit empty `VITE_API_BASE_URL` forces same-origin
requests, `VITE_DATA_SOURCE=api` selects the API client, and `API_PROXY_TARGET`
pins the dev proxy to the fixture API. Do not use another command, mode, or API
origin. Before entering any fixture data,
inspect browser DevTools Network: every application request must target
`http://127.0.0.1:5176`, with `/api` proxied to `127.0.0.1:4016`. Verify the
harness terminal's local-only startup message and that `/api/__fixture/mailbox`
returns `fixture: true`. Stop immediately if a request targets another origin,
the proxy or fixture marker is missing, or an unexpected redirect occurs.

The harness creates a new guarded `price_tracker_test_browser_<random>` database,
with two clearly test-only price fixtures (999 cents), and supplies an offline
resolver to the actual composed app. History starts empty. No fixture is uploaded
to a real application database and no ordinary application mode falls back to it.
The real account dispatcher captures fake transport acceptance in memory after
the real shared Mongo budget permits it. It sends nothing externally. Inspect
**http://127.0.0.1:5176/api/__fixture/mailbox** to copy explicit verification/reset
links; do not record token values in evidence or console output. This endpoint
exists only in this standalone harness and does not constitute mailbox delivery.

## Browser QA checklist

1. Confirm API mode and an initially signed-out/private guard. Register a fresh
   synthetic `player@example.invalid` account with a 12+ character fixture password.
2. Wait for its fake verification entry. Open the captured link; confirm fragment
   removal, explicit verification POST, no automatic login, then sign in.
3. Refresh and navigate directly to the watchlist; verify cookie session restore.
4. Preview `https://store.steampowered.com/app/620/`, save a target (also test zero),
   search, open details, edit target/preferences, and inspect honestly empty history.
   Never click the fixture purchase link: it is not a validated live offer.
5. Exercise invalid URLs, duplicate add, and delete confirmation. Confirm edits and
   delete persist across refresh and no sample records appear in the real watchlist.
6. Log out, navigate back and refresh; no private records remain visible. Use a
   second browser profile for cross-account private-route checks if needed.
7. Record functional UI/cookie/keyboard/validation results, not a visual redesign.
   Keep synthetic accounts and tokens out of screenshots intended for publication.

Real authentication limits still apply (five account POSTs/IP/15 minutes). Do not
weaken them or rotate IPs to bypass them. For a separate reset scenario, stop and
restart this fixture harness to get a new disposable database, register/verify/
login/forgot/reset (five POSTs), confirm explicit reset and revocation, and record
that this is a separate fixture scenario. A 429 must show honest Retry-After.

On completion Ctrl-C the harness and Vite terminals. Harness shutdown closes its
HTTP server, drains its fake account dispatcher, and drops only its own exact
database before disconnecting. Do not stop MongoDB. Abrupt process termination
or a bounded cleanup failure may leave an isolated test database; the harness
prints its generated database name before connecting, including on startup failure.
Record that name for guarded cleanup,
never bulk-drop test or application databases. These results cannot establish
real pricing, mailbox/push receipt, Flutter, deployment, free-tier capacity, or
independent daily scheduling.
