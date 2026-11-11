# Live VM operations — November 10, 2026

Checks used the deployed HTTPS domain and authorized SSH access. The deployed application was `22f589e`. This report contains no account records, credentials, tokens, or reusable email links.

## Verified

- The public domain resolves to the authorized VM. HTTP redirects to the HTTPS domain.
- The API runs as its dedicated unprivileged account, listens on loopback, and is active with no recorded restarts after scheduler activation. Its environment file is root-managed and group-readable only by the service account.
- Public TLS validation succeeded with TLS 1.3. The certificate expires February 3, 2027; the existing certificate-renewal timer is enabled and active. No renewal request was forced.
- SSH password and keyboard-interactive authentication are disabled; public-key authentication is enabled. Inspected listeners expose SSH and web ports, while the API and existing database listeners bind to loopback. UFW is inactive; Azure network-security rules were not audited, so restricted infrastructure access is not signed off.
- MongoDB reports a writable replica-set primary with transaction support. This was a read-only capability check, not a new commit/rollback test. Inspected user, session, tracker, product, and history indexes include the expected ownership/identity uniqueness and expiry indexes.
- The deployed web release marker says `api`. Public app routes and direct verification/reset routes return HTML successfully. Readiness reports a connected database.
- Anonymous web/mobile session reads return `401 AUTH_REQUIRED`. Invalid-origin and missing-CSRF registration requests return `403` before account creation.
- After activation, anonymous tracker and admin-check requests return `401`, rather than the earlier `404` for unmounted routes. This does not establish authenticated business-flow acceptance.

## Scheduler activation

The project lead approved the team's 90-day history-retention decision during this session. CheapShark usage restrictions still apply; this is not a claim of separate approval from Steam or CheapShark.

Only tracking, the built-in daily scheduler, and its recovery worker were enabled. The previous protected configuration was backed up privately. Stable secrets and other settings were preserved. No cron job, systemd timer, second scheduler, or new cloud resource was added.

The API service is enabled at boot, uses `Restart=on-failure`, and runs on a UTC-synchronized host. Its startup scheduled run `scheduled_20768` completed at **2026-11-11 01:05:14 UTC** (November 10 in the team's local evening). Both catalog products were skipped because there were no tracked items. No provider request, price-history observation, or notification delivery was demonstrated by this run.

## HTTPS response hardening

Before this pass, static HTML lacked HSTS/CSP and API replies contained duplicate security headers. The existing Apache TLS virtual host now normalizes both header tables and provides one value for HSTS, CSP, frame protection, content-type protection, and referrer policy. Configuration syntax passed before a graceful Apache reload; the API was not restarted for this change. A root-only backup was retained.

Public checks of the homepage, registration, verification route, readiness, and tracker route confirmed the headers. HSTS initially uses one day without `includeSubDomains` or preload. CSP limits scripts, fonts, and connections to the same origin; images to the same origin/data; frames and objects are blocked. Inline styles remain allowed for the existing UI framework. Browser compatibility is recorded separately in the web audit.

## Email blocker confirmed

The running service had account mail disabled and no sending key, explicit sender, reset template, price-email template, Firebase project, or server push credentials configured. Two verification-mail rows were pending. Only aggregate counts were inspected; no recipient addresses or tokens were extracted.

The separate email audit found a restricted local sandbox sender and could not validate the local key through management requests. No key was copied to the VM, no pending mail was dispatched, and no external email was sent during this audit. Account mail, price email, and push remain disabled until valid approved configuration and bounded real acceptance are available.

The project lead requested that real email delivery be the final acceptance step, after the sender domain becomes available. This is a deferred test, not a delivery failure attributed to a configured sender and not a completed account acceptance result.

## Not established

Real verification/reset mailbox arrival, authenticated two-user CRUD/search/history, web/Android shared updates, a genuine qualifying alert episode, repeat-check deduplication, authenticated admin overlap/recovery, and infrastructure/Firebase billing acceptance remain unverified. No accounts were marked verified manually, no private data was wiped, and no fictional prices were inserted. These checks do not justify closing their acceptance issues.
