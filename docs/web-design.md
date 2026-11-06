# Web design and sample interactions

References #10, #19, #21 and #24. This is visual/sample work, not completed API integration or course acceptance.

## Design choices

The web app uses a compact, game-first list rather than a dashboard. Artwork, last-known Steam prices and targets lead; teal marks primary actions. No sidebar, gradients, fake savings, dark theme, or theme switch.

- Approximate palette anchors: off-white `#f9fdff`, ink `#031a1e`, teal `#00bba7`, white `#ffffff`, pale cool surfaces/borders. Exact supplied OKLCH tokens live in `apps/web/src/styles.css`.
- System UI typography for readable interface text. JetBrains Mono remains bundled locally; its OFL copyright/license ships at `/licenses/JetBrainsMono-OFL.txt`.
- Centered 1088px content; centered landing, left-aligned application pages; 8px base radius. A bordered watchlist surface groups search and game rows; dividers and restrained shadows structure other content.
- Primary buttons use dark text. Essential control edges, focus rings, and error text use darker semantic derivatives rather than the pale brand border or white-on-teal. Components use semantic variables, not scattered palette values.
- Feedback: brief control color changes and dialog entry; Motion animates the offer-preview transition and dialog contents. Reduced motion disables those entry animations and the dialog/overlay fade. Routine typing and prices do not animate. Radix owns confirmation focus trapping/restoration; exits unmount immediately.

At narrow widths, rows, prices and actions stack. The short illustrative chart fits its dates on a phone; longer history and the data table can scroll in their own regions. There are no fixed-height text containers.

## What is usable

- Landing and Try sample; populated/searchable watchlist; exact local Steam URL preview; target/preferences/save; details; edit/cancel; confirmed removal.
- URL navigation, direct details/edit links, browser back, and `?q=` search. In-memory changes reset on refresh, with an honest missing-tracker view for removed sample IDs.
- Dated CheapShark prices and purchase links; zero versus unknown prices; retained successful observation on failure; separate provider-change time (unknown in the proof). Target edits never change price or history.
- Illustrative seven-day history, visibly labeled at the chart and its data table. This is not actual observed history or an upstream historical-low series.
- Per-tracker enabled/email/Android-push choices. No browser push, fake deliveries, scheduler, or notification inbox.
- Registration, verification/result/resend, sign-in/out, forgot/reset, account, unverified-account and expired-link previews. Fixed sample email; passwords exist only in transient form state and are cleared on success. Never enter real credentials.
- Expandable developer scenarios for loading, empty, offline, expired session, save failure, failed check, missing offer, free price, unsupported DLC/bundle/edition, and empty/failed history. Explicit manual-only health diagnostic preserved from the merged prototype.

The two real game identities/quotes come from `docs/cheapshark-proof.json`; local artwork sources and usage limits are in `apps/web/public/art/README.md`. No default runtime network access except same-origin bundled assets. The reference PNG was only read, never copied or committed.

## API-wiring handoff

`apps/web/src/data/types.ts` exports `Money`, `Product`, `ProductPreview`, `TrackedItem`, `Preferences`, `Observation`, `PriceHistory`, `RepositoryError`, and `TrackerRepository`. Product/preview/tracker fields follow the proposed shared contract shape; IDs remain separate opaque strings, money is USD integer cents. Local sample image paths are intentionally not HTTP-schema URLs.

The injectable async boundary:

```ts
list(query?: string): Promise<TrackedItem[]>
get(id: string): Promise<TrackedItem>
preview(url: string): Promise<ProductPreview>
create(input: Preferences & { previewId: string }): Promise<TrackedItem>
update(id: string, input: Preferences): Promise<TrackedItem>
remove(id: string): Promise<void>
history(trackerId: string): Promise<PriceHistory>
```

`<App repository={repository} />` injects an implementation; default is a fresh `createSampleRepository()` per app mount. Screens never import fixture arrays. `PriceHistory` is a presentation wrapper `{illustrative, items}`; an HTTP adapter must explicitly use `illustrative: false`, preserve authorized tracker history, and handle the contract's pagination/window metadata. The current two-item watchlist filters locally; HTTP pagination/search must be handled deliberately, not limited silently to the first page.

Sample create requires a repository-issued 10-minute preview ID. Both repositories reject duplicates during preview with `RepositoryError('duplicate', message, existingTrackerId)` and retain save-time protection against concurrent additions. API preview walks the owned, unfiltered watchlist by exact provider game/store/market/currency identity, stopping on a match; repeated cursors or the 100-page bound are errors. A failed lookup blocks preferences until retry succeeds. The route keeps an unexpired preview for retry, clearing it on URL edits or disposal. No shared HTTP schema changed.

The internal repository preview method accepts an optional callback when duplicate lookup starts. API repositories also provide optional `clearPreview()` and `cancelSearch()` methods for draft and request cleanup. Error codes are presentation categories mapped from strict API responses, with no sample fallback.

`steamPurchaseUrl(product)` retains the original raw/percent-encoded deal-ID safety regression. It checks exact Steam/US/USD identity, matching canonical app URL, valid price and deal ID, then constructs a fixed CheapShark human redirect with one encoded parameter. It never fetches it. Real API decoding must enforce the strict product/purchase cross-field contract before rendering.

The web app includes opt-in API transport for HttpOnly-cookie sessions, CSRF, private routes, token handoff, validated responses, pagination, and retries. See [web API wiring](web-api-wiring.md) for its limits. Sample account navigation is not authentication; failed API requests never become sample success. This UI work does not implement backend services or prove live integration.

## Earlier browser QA (October 28)

Run on October 28, 2026 in Chromium through `agent-browser`, in sample mode only.
Viewports: 1440×1000, 820×1100, 390×844, and 320×720.

- No main page had horizontal page overflow at any of the four widths. Below
  680px the history chart scrolls inside its own region and now shows a visible
  “Scroll sideways to see every day” hint.
- A forced dark OS preference still rendered the light theme (`color-scheme:
  light`, off-white page background).
- Reduced motion removed press/dialog scaling; only 150ms background-color
  transitions remained.
- Keyboard focus rings were visible. The remove dialog focused its cancel
  action, Escape closed it, and focus returned to “Remove game”. Route changes
  focused the page heading.
- axe-core 4.10.3 found no WCAG 2 A/AA violations on the 11 desktop pages
  scanned (home, watchlist, details, add, edit, account, login, register,
  forgot, reset, verify).
- Sample mode made no XHR/fetch requests, external-origin requests, cookies,
  local/session storage writes, or service-worker registrations. The console
  held only Vite and React development messages. Primary-button dark text on
  teal was confirmed in computed style.

Screenshots are in `docs/screenshots/web/`:

| Screen | Files |
| --- | --- |
| Home | [desktop](screenshots/web/home-desktop.png), [tablet](screenshots/web/home-tablet.png), [mobile](screenshots/web/home-mobile.png) |
| Watchlist | [desktop](screenshots/web/watchlist-desktop.png), [mobile](screenshots/web/watchlist-mobile.png) |
| Details and history | [desktop](screenshots/web/details-desktop.png), [mobile](screenshots/web/details-mobile.png) |
| Add and edit | [add](screenshots/web/add-desktop.png), [edit](screenshots/web/edit-desktop.png) |
| Account and sign-in | [account](screenshots/web/account-desktop.png), [sign-in](screenshots/web/auth-login-desktop.png) |
| Failed check | [desktop](screenshots/web/scenario-failed-check.png) |

Not covered: real API mode, a live backend, screen-reader output, a physical
mobile browser, or provider calls. Those belong to the wiring PR and backend
work.

## November 6 usability review — PR #52

References #19 and #24. Authenticated API users now see Watchlist and Account throughout the site, including homepage actions. Sample navigation remains a local preview.

Search distinguishes an empty watchlist from no matches. API queries wait 300 ms after typing; previous results remain explicitly labeled during loading and failure. Retry preserves the query, Clear search resets it, and expired sessions clear private results. After a rejected Save, the target receives focus and its error clears when corrected to a valid value, including $0.00.

Both sample and API preview detect existing trackers before showing preferences. API lookup failure requires Retry; it does not mean the game is unsaved. Server-side save-time duplicate enforcement remains necessary for concurrent additions. Preview and removal confirmations appear immediately with reduced motion enabled.

**Checks:** `npm run check` passed lint, both typechecks, 15 contract tests, 91 API tests, 241 web tests, and both builds. The 42 MongoDB integration tests were skipped because `TEST_MONGODB_URI` was unset. The API test server requires permission to bind local ports outside the sandbox.

**Chromium 158:** checked home, watchlist, details, edit, add, account and sign-in at 320×844 with no page overflow. Checked watchlist, details, edit and add at 200% CSS zoom in a 1280×900 viewport, also without page overflow. CSS zoom is a reflow check, not verification of the browser's native zoom control. Reduced-motion preview/dialog entry, preview heading focus, target correction, dialog focus trapping, Escape and trigger-focus restoration passed.

API-mode browser checks used intercepted offline responses: authenticated homepage/navigation, duplicate preview, failed duplicate lookup followed by Retry without another preview request, retained previous search results after failure, no matches, and Clear search. These checks do not establish real backend integration or provider support. No live pricing or purchase redirects were fetched.

New screenshots: [watchlist](screenshots/web/usability-watchlist-320.png), [sample duplicate](screenshots/web/usability-duplicate-320.png), [offer preferences](screenshots/web/usability-preview-320.png), [API duplicate with intercepted responses](screenshots/web/usability-api-duplicate-320.png). Earlier screenshots and October 28 results above remain historical evidence.

Dialog scrollbar follow-up: the inner entry slide temporarily extended its scrollable content by 8px. Dialog contents now fade without sliding; the outer fade/scale remains. Chromium frame sampling found no overflow during entry at 1280×900 or 390×844. A 320×260 viewport still scrolls to the confirmation actions, so short-screen access is preserved.

To repeat the sample checks, run `npm run dev:web`, open Try sample, and use a 320px viewport. Preview a seeded game to open its existing tracker, remove it, then add it again. Submit an invalid target, correct it to $0.00, and check focus and error feedback. Enable reduced motion in browser emulation and open/close the removal confirmation using Tab, Shift+Tab and Escape. Repeat the affected tracker screens with 200% CSS zoom. API behavior is also covered by `npm test --workspace @price-tracker/web` with offline fixtures.

## Validation and remaining review

On Node 24, `npm run check` runs lint, API/web typechecks, tests, and both builds. Offline tests cover money/URL safety, repository CRUD/isolation/preview expiry, no-network sample behavior, duplicate/save/cancel/remove flows, per-item preferences, stale/unknown/free prices, history alternatives/errors, account previews and the retained health/purchase contracts.

**October 28, 2026:** `npm run check` passed: lint, both typechecks, **85 web tests + 14 API tests**, both builds. `npm audit` reported zero vulnerabilities. A direct OKLCH-to-linear-sRGB token calculation gives approximately 7.27:1 primary text, 5.30:1 muted text on muted background, 4.49:1 control border on background (4.60:1 on white), 6.92:1 focus ring on background, and 8.71:1 error text on white. Rendered combinations were then checked with axe, as described above.

The mobile chart hint changed no behavior; after it was added, `npm run check` again passed **85 web tests + 14 API tests** with clean lint, type checks, and builds. No live CheapShark price/redirect, real account/mailbox, MongoDB, cross-client ownership, durable alert deduplication, or Android delivery was tested by this design work.
