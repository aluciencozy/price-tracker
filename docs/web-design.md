# Web design and sample interactions

References #10, #19, #21 and #24. This is visual/sample work, not completed API integration or course acceptance.

## Design choices

The reference image informed whitespace, compact navigation, alignment, and monospace hierarchy—not its dark/orange palette or terminal decoration. The memorable element is the spacious two-line landing headline; the rest stays quiet. Roomy rows and small game art replace cover grids and dashboard statistics. No sidebar, gradients, fake savings, dark theme, or theme switch.

- Approximate palette anchors: off-white `#f9fdff`, ink `#031a1e`, teal `#00bba7`, white `#ffffff`, pale cool surfaces/borders. Exact supplied OKLCH tokens live in `apps/web/src/styles.css`.
- JetBrains Mono, locally bundled through Fontsource, weights 400/500/600/700. The OFL copyright/license ships at `/licenses/JetBrainsMono-OFL.txt`.
- Centered 1088px content; centered landing, left-aligned application pages; 8px base radius. Dividers structure rows, cool low-opacity layered shadows elevate forms and confirmations.
- Primary buttons use dark text. Essential control edges, focus rings, and error text use darker semantic derivatives rather than the pale brand border or white-on-teal. Components use semantic variables, not scattered palette values.
- Feedback: 150ms press response; occasional dialog entry uses 200ms opacity/scale with the shared strong ease-out. Routine typing, rows, navigation and prices never move. Reduced motion removes scale and skeleton pulsing. Radix owns confirmation focus trapping/restoration; exits unmount immediately.

The design deliberately avoids a generic statistics/card dashboard: the watchlist itself is the application. At narrow widths, rows, prices and actions stack; the chart/table scroll inside their own regions rather than shrinking labels beyond readability. There are no fixed-height text containers.

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

Sample create requires a repository-issued 10-minute preview ID and rejects duplicates with `RepositoryError('duplicate', message, existingTrackerId)`. Error codes are local presentation categories; the HTTP adapter must map strict API errors without silently falling back to sample data. Other categories include validation, unsupported, missing-offer, not-found, offline, save-error, expired and preview-expired.

`steamPurchaseUrl(product)` retains the original raw/percent-encoded deal-ID safety regression. It checks exact Steam/US/USD identity, matching canonical app URL, valid price and deal ID, then constructs a fixed CheapShark human redirect with one encoded parameter. It never fetches it. Real API decoding must enforce the strict product/purchase cross-field contract before rendering.

This PR has **no HTTP auth/business transport**. The separate wiring PR owns persistent HttpOnly-cookie sessions, CSRF, bootstrap/logout/revocation, private-route/ownership handling, safe link-token handoff, strict response validation, pagination, request serialization/idempotency, and real error/retry semantics. Do not mistake sample account navigation for authentication. Replace sample-specific copy/disclosure explicitly in live mode; a failed live request must not become sample success. No backend services are implemented here.

## Browser QA

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

## Validation and remaining review

On Node 24, `npm run check` runs lint, API/web typechecks, tests, and both builds. Offline tests cover money/URL safety, repository CRUD/isolation/preview expiry, no-network sample behavior, duplicate/save/cancel/remove flows, per-item preferences, stale/unknown/free prices, history alternatives/errors, account previews and the retained health/purchase contracts.

**October 28, 2026:** `npm run check` passed: lint, both typechecks, **85 web tests + 14 API tests**, both builds. `npm audit` reported zero vulnerabilities. A direct OKLCH-to-linear-sRGB token calculation gives approximately 7.27:1 primary text, 5.30:1 muted text on muted background, 4.49:1 control border on background (4.60:1 on white), 6.92:1 focus ring on background, and 8.71:1 error text on white. Rendered combinations were then checked with axe, as described above.

The mobile chart hint changed no behavior; after it was added, `npm run check` again passed **85 web tests + 14 API tests** with clean lint, type checks, and builds. No live CheapShark price/redirect, real account/mailbox, MongoDB, cross-client ownership, durable alert deduplication, or Android delivery was tested by this design work.
