# Working on Price Tracker

## Project

- COP 4331C, Fall 2026. Finish development by November 10; presentation deadline November 15.
- Read `README.md`, `docs/project.md`, and the linked GitHub issue before changing behavior.
- Stack: React + TypeScript + Tailwind, Express + TypeScript + Node.js, MongoDB/Mongoose, Flutter. No Python.
- `apps/api` owns business logic. Web and Flutter share that API; neither client connects to MongoDB or retailer APIs directly.
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
- Store money as integer minor units plus currency. Product identity includes the selected variant/market where needed.
- Never fetch arbitrary user URLs. Use provider allowlists, safe DNS/redirect checks, timeouts, and bounded requests.
- A failed fetch is not a zero price. Preserve the last successful observation.
- Scheduled checks and admin-only manual checks use the same service.
- Alert once per qualifying episode, not once per polling run. Durable per-channel delivery keys must prevent duplicate email/push across retries, overlap, and restarts. See `docs/project.md` for the exact rules and email-provider limitations.
- Never claim a mock price is live retailer data or an unrun test passed.
- Use fixtures in normal tests. Do not scrape live stores in CI or bypass retailer restrictions.

## Documentation

- Write short, plain English. Explain what needs doing and how to know it works.
- Keep required UML in PlantUML, and publish the agreed API on SwaggerHub.
- Wireframes are required; Figma is not. Hosting vendor selection is still open; domains are already handled.
