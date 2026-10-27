# Web wireframes

Reviewable layout sketches for [Issue #5](https://github.com/aluciencozy/price-tracker/issues/5). Open an SVG in a browser or an editor's image preview. These files replace the standalone `UiPrototype.tsx` reference. The running implementation is in `apps/web/src/`.

| Screen | Wireframe |
| --- | --- |
| Home | [01-home.svg](01-home.svg) |
| Login | [02-login.svg](02-login.svg) |
| Registration | [03-register.svg](03-register.svg) |
| Email verification | [04-verification.svg](04-verification.svg) |
| Forgot password | [05-forgot-password.svg](05-forgot-password.svg) |
| Reset password | [06-reset-password.svg](06-reset-password.svg) |
| Watchlist and example catalog | [07-watchlist.svg](07-watchlist.svg) |
| Add tracker | [08-add-tracker.svg](08-add-tracker.svg) |
| Edit tracker | [09-edit-tracker.svg](09-edit-tracker.svg) |
| Game details and history | [10-game-details-history.svg](10-game-details-history.svg) |
| Notification preferences | [11-notification-preferences.svg](11-notification-preferences.svg) |
| Loading, empty, validation, expired session, unavailable price, unsupported bundle/DLC/edition | [12-preview-states.svg](12-preview-states.svg) |

The sketches show structure and content, not exact colors or spacing. Prices are illustrative USD values, not live Steam quotes. Account actions and notification preferences are frontend previews; observed history is empty. The notification screen reflects the current preview controls, not completed Android push integration.

The details sketch documents the purchase action: use CheapShark's redirect with the matching Steam offer's deal ID. Portal 2 and Half-Life 2 in the running app use dated October 26 offer snapshots from `docs/cheapshark-proof.json`; those deals may have changed or expired. Other prices are illustrative, and Stardew Valley is a missing-offer fixture. Missing prices or valid matching deal IDs leave purchasing unavailable. Unsupported-item sketches correspond to separate DLC, bundle, and edition previews; real game-type and edition validation requires the API. No ordinary-user price-check action is included. The separate API connection tool checks health only.

On narrow web viewports, navigation wraps, columns stack, and the watchlist table scrolls horizontally. These SVGs describe the web app, not the separate Flutter wireframes.
