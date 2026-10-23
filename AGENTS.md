# Working on Price Tracker

## Project

- COP 4331C, Fall 2026. Finish development by November 10; presentation deadline November 15.
- Game-only MVP, $0 budget: CheapShark API, Steam URLs first, US/USD base games. No paid plans, billing-enabled trials, physical retailers, or fictional demo stores.
- Read `README.md`, `docs/project.md`, and the linked GitHub issue before changing behavior.
- Stack: React + TypeScript + Tailwind, Express + TypeScript + Node.js, MongoDB/Mongoose, Flutter. No Python.
- `apps/api` owns business logic. Web and Flutter share that API; neither client connects to MongoDB or CheapShark directly.
- This is a student MVP. Keep changes small and avoid extra services/frameworks without a concrete need.

## Changes and tests

- Use the existing npm scripts and Flutter commands in the README. Run the checks relevant to your change and report anything you could not run.
- Use `rg` for code searches. Use the repository lockfiles; do not switch package managers casually.
- Keep secrets in ignored environment files. Update `.env.example` and setup instructions when configuration changes.
- Do not commit the local assignment PDF, SDKs, build output, credentials, signing keys, or real user data.
- Link PRs to their issues. Update docs and API examples when a shared contract changes.
- Do not overwrite someone else's uncommitted changes. Ask before destructive operations.

## Rules that matter

- Authenticate and enforce ownership on every private resource. Unverified users cannot log in.
- Store money as integer minor units plus currency. An offer is identified by provider game ID + selected store + market/currency; keep Steam app IDs separate from CheapShark game/deal IDs.
- Compare the chosen Steam offer, never an all-store cheapest price or historical low. Unknown editions/DLC/bundles and missing Steam offers are unsupported, not guessed.
- Never fetch submitted Steam URLs. Parse allowlisted `/app/<id>` URLs locally and call fixed CheapShark endpoints with validated IDs; use safe DNS/redirect checks, timeouts, and bounded requests.
- Cache shared game lookups, respect 429/Retry-After, retain attribution, and use required CheapShark purchase redirects. GOG/Fanatical stay optional until exact matching is proven.
- Send an honest, application-specific `User-Agent` on CheapShark API calls, as its docs require. Never automatically request `/redirect`; it is a human purchase link, not an API endpoint.
- A failed fetch is not a zero price. Preserve the last successful observation.
- Scheduled checks and admin-only manual checks use the same service.
- Alert once per qualifying episode, not once per polling run. Durable per-channel delivery keys must prevent duplicate email/push across retries, overlap, and restarts. See `docs/project.md` for the exact rules and email-provider limitations.
- Never claim an unrun test passed, an upstream listing is supported before integration testing, or a target edit is an actual price drop.
- Use fixtures in normal tests. Demonstrate real game prices by changing the target; no fictional/live-mock provider is required. Do not make live provider calls in CI or bypass access/rate restrictions.

## Documentation

- Write short, plain English. Explain what needs doing and how to know it works.
- Keep required UML in PlantUML, and publish the agreed API on SwaggerHub.
- Wireframes are required; Figma is not. Hosting vendor selection is still open; domains are already handled.
