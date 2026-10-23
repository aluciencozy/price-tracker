# Game price data — $0 MVP

**Decision updated October 26, 2026.** This replaces the earlier physical-retailer/scraping plan. The filename stays the same so existing issue links keep working.

For short explanations of why other stores do not fit, see [the provider decision guide](provider-decisions.md). This file covers the selected game integration.

## Live source proof — passed October 26

The live Steam URL-to-offer test was completed on October 26. It is not an unresolved research assignment for the team.

| Input Steam URL | Exact app ID | CheapShark game ID | Selected store | Reported current price |
| --- | --- | --- | --- | --- |
| `https://store.steampowered.com/app/620/` (Portal 2) | `620` | `36` | Steam `1` | USD 9.99 / `999` cents |
| `https://store.steampowered.com/app/220/` (Half-Life 2) | `220` | `59` | Steam `1` | USD 9.99 / `999` cents |

These two games are the initial validated base-game catalog. This is not support for every Steam app. Add a game only after the same exact-match and current-Steam-offer tests pass.

Both ID-resolution requests and both game-offer requests returned **HTTP 200**, from **16:34:26 to 16:34:42 UTC** on October 26. No API key, account, payment, proxy rotation, or fabricated data was used. The returned historical lows were USD 0.99; the check correctly used the current Steam offers instead.

- [Saved measured output](cheapshark-proof.json): request URLs, statuses, timestamps, returned IDs and prices.
- Reproduce explicitly from the repository root: `node scripts/verify-cheapshark.mjs`.
- The script uses Node.js's normal `fetch`, one honest application `User-Agent`, five-second pacing between requests, and no retries after a 429. Five seconds is our conservative test spacing, not a published provider quota.
- The API docs **require a User-Agent**. The successful value was `PriceTracker-COP4331C/0.1 (+https://github.com/aluciencozy/price-tracker)`. Earlier generic requests were rate-limited (429). We did not establish that the header alone caused the different results; the actual backend-compatible client is now proven.
- The provider's `/redirect` route is **not an API**. Its docs explicitly say it blocks automation. An unnecessary server-side redirect probe returned 403; no bypass or further automated redirect probe was attempted. Generate its documented link for human navigation, not worker fetching.
- This proves the source and exact two-game mapping. It does not mean our Express adapter, notifications, UI, every game, or long-term service availability are already implemented or proven. The live script is opt-in and never runs in normal CI.

## Decision

Use **CheapShark's free public API**, with **Steam URLs first**, **individual PC base games**, **US market**, and **USD prices**. This is a game price tracker, not an HTML scraper. The course does not require a particular commercial retailer or a scraping implementation.

- Steam is the only required store for the November 10 freeze.
- GOG and Fanatical are optional after exact game/store/edition matching is tested. Their upstream presence is not a promise that our app supports their URLs.
- Other stores, physical goods, consoles, bundles, DLC, subscriptions, and guessed editions are outside the MVP.
- No paid API, payment card, trial dependency, account rotation, or automatic billing. Apply the same $0 rule to database, hosting, scheduling, email, Firebase, and course-tool access; verify free quotas in the infrastructure/email issues.
- No fictional training store or required live mock provider. Automated tests use offline fixtures; the presentation uses real prices and a changed user target.

## Sources and what was actually checked

| Source | Evidence and limit |
| --- | --- |
| [Official API documentation](https://apidocs.cheapshark.com/) / [publisher's collection JSON](https://apidocs.cheapshark.com/api/collections/530355/RWTspajP?environment=530355-45dba261-4cf3-4cf2-aaa8-cc00b8ae4533&segregateAuth=true&versionTag=latest) | Full published documentation read directly. Confirms free/no-key API, required User-Agent and purchase links, USD pricing, 429/Retry-After, game ID lookup, and multiple-game lookup for up to 25 games. Purchase redirects explicitly block automation. No paid account or key used. |
| [Live stores endpoint](https://www.cheapshark.com/api/1.0/stores) | HTTP 200 on October 26. Steam `1`, GOG `7`, Fanatical `15` active. Also lists other real stores, but that alone does not enable them in our app. |
| [Steam price query](https://www.cheapshark.com/api/1.0/deals?storeID=1&pageSize=1) | Live research request returned Metro 2033 Redux, Steam app `286690`, provider game `109746`, reported sale price `1.99`, normal price `19.99`. This is a dated API observation, not a promised current checkout price. |
| [GOG price query](https://www.cheapshark.com/api/1.0/deals?storeID=7&pageSize=1) | Live research request returned Grim Fandango Remastered with reported price `2.25`. Demonstrates real upstream store data, not correct GOG URL/edition mapping in our app. |
| [Fanatical price query](https://www.cheapshark.com/api/1.0/deals?storeID=15&pageSize=1) | Live research request returned Frosthaven with reported price `25.19`. No Fanatical URL integration has been implemented or proven. |
| [Steam-app-ID lookup](https://www.cheapshark.com/api/1.0/games?steamAppID=620) | Earlier automated requests were rate-limited (429). Native Node.js calls with the documented application identity successfully resolved Portal 2 and Half-Life 2, followed by their Steam offers. All four final requests returned 200; see the saved proof above. |
| [About/FAQ](https://www.cheapshark.com/about) | Describes real authorized game distributors, source pricing generally refreshed hourly, and no accuracy/availability guarantee. Our application starts with daily checks. |
| [Terms page](https://www.cheapshark.com/terms) | The text fetch showed site chrome/footer, not a separate substantive terms body. Do not infer extra rights from that absence. Current API usage and retention requirements are recorded in #3. |

**Research result:** [#3](https://github.com/aluciencozy/price-tracker/issues/3) is complete with two real Steam URL-to-current-offer lookups and the published usage rules. [#12](https://github.com/aluciencozy/price-tracker/issues/12) implements the actual application adapter from that proof. Keep its normal failure/identity tests; do not hand the completed research back to Nick as a blocker.

## Endpoint sequence for Nick

These are implementation instructions, not endpoints already implemented in our Express API.

1. Parse an allowed Steam URL locally, for example `https://store.steampowered.com/app/286690/`. Extract the numeric Steam app ID. Never fetch the submitted URL.
2. Call the fixed CheapShark lookup endpoint: `GET https://www.cheapshark.com/api/1.0/games?steamAppID=<appId>`.
3. Require an exact `steamAppID` match and an unambiguous CheapShark `gameID`. Do not use title similarity or pick the first unrelated search result. Steam `/app/` URLs can identify DLC as well as games: begin with a small confirmed base-game catalog and reject unvalidated content types.
4. Use `GET https://www.cheapshark.com/api/1.0/games?id=<gameId>` to obtain game details and its store offers. The successful proof confirms `info.steamAppID`, `info.title`, and `deals[]` with `storeID`, `price`, `retailPrice`, and `dealID`.
5. Select only the current offer whose `storeID` is `1` (Steam). Do not use `cheapest`, `cheapestPriceEver`, a normal/list price, or a different store's offer as the current Steam price. A missing Steam offer is unavailable/unsupported, not zero and not permission to switch stores.
6. Parse the reported USD decimal string exactly into integer cents, e.g. `"1.99"` becomes `199`. Validate safe integer/range, currency, game ID, store ID, and price presence. A genuine reported zero price is valid only after those checks; never default missing prices to zero.
7. Return normalized metadata plus provider game ID, Steam app ID, store ID, market/currency, price, successful fetch time, optional source-change time, and the current CheapShark deal purchase link.

Steam app IDs, CheapShark game IDs, store IDs, and deal IDs are different identifiers. Store them separately as strings. A changing deal ID must not create a duplicate tracked game or reset alert state.

### Stable identity and store boundaries

Use `(provider, providerGameId, storeId, market, currency)` for a shared offer. Keep the Steam app ID as a verified external identity. Multiple users tracking the same Steam game share that offer; each user's target/preferences remain private.

GOG and Fanatical stay disabled until an explicit extension validates their URL/edition mapping and correct per-store prices. If an extension returns several stores in one game response, reuse that response instead of fetching once per watcher/store. Do not quietly change a watch from “this game on Steam” to “cheapest anywhere.”

## API use and $0 safeguards

- Use the documented public API rather than scraping CheapShark HTML or individual stores. No API key or paid subscription is needed for this provider.
- Send a descriptive, honest application `User-Agent` on every API request; it is required. Do not impersonate a browser or search engine.
- Free does not mean unlimited. Cache metadata/offer lookups, share them across users, and choose a small initial catalog. Start with one in-flight provider request; tune only from documented guidance and observed behavior.
- Honor `429` and `Retry-After`. Where no retry duration is supplied, use bounded backoff and postpone the job rather than hammering the endpoint. No proxy/IP rotation, extra accounts, or rate-limit workarounds.
- Preview must be authenticated/rate-limited and reuse valid cached data; opening the dashboard must not trigger a provider call. Scheduler and admin checks share the same provider budget and locks.
- Keep attribution visible. Purchase buttons in web, Flutter, and alert messages use the documented CheapShark redirect format, `https://www.cheapshark.com/redirect?dealID=...`, preserving the deal ID correctly. Test encoding offline; do not strip affiliate routing, replace it with direct purchase links, or automatically fetch the redirect.
- Do not build a cached copy of the full provider catalog. The docs warn that excessive automated catalog collection can cause a permanent block. Limit checks to the small watched catalog, cache metadata, and use the documented multiple-game lookup (up to 25 IDs) where useful. This proof does not establish unlimited background capacity.
- The docs prefer direct browser/app calls and say bulk catalog caching may cause a permanent block. Our use is a small shared watched-game list for daily checks and alerts, not a full catalog. A backend is required because clients may be closed. If CheapShark blocks this pattern, contact them or reduce scope; do not bypass it. This is a use-pattern risk, not a granted exception.
- Keep our own successful dated observations from the project onward, subject to confirmed API terms. A historical-low summary is not a time series. Do not bulk redistribute the provider's dataset or archive complete payloads/reviews/descriptions.
- Cache/state expiry must surface as stale/unavailable, not a new successful check. Distinguish when we fetched the response from when the provider says a price changed; do not invent today's sale from an old source timestamp.
- Stop or reduce usage at free service limits. No service signup, payment method, or subscription was created during this research; the team must verify deployment/email/free-tier limits separately before choosing them.

## URL and response safety

Accept only explicitly configured Steam hosts, HTTPS, the normal port, and numeric `/app/` IDs. Reject embedded credentials, deceptive suffix hosts, arbitrary query redirects, non-web schemes, bundles, subscriptions, unsupported content, and private-IP URLs. A title slug or analytics parameter does not change the Steam app identity.

Construct outbound requests from fixed `https://www.cheapshark.com/api/1.0/` paths and validated IDs, never from user-controlled hosts or paths. Validate actual DNS/IP destinations, reject nonpublic addresses, and reject redirects by default. If any redirect is required later, validate each hop and keep requests within the approved provider hosts. Apply a total timeout, response-size bound, schema checks, and sanitized errors. Do not evaluate scripts, use arbitrary image proxies, or accept an arbitrary purchase URL from a request body.

Offline fixtures should cover exact/wrong/ambiguous app matches; distinct game/store/deal IDs; a cheaper non-Steam offer; historical-low versus current price; missing Steam offer; DLC/bundle rejection; malformed/missing/zero price; USD parsing; 429/Retry-After; timeout; oversized/invalid response; and malicious URLs/redirects. No live provider calls in normal CI.

## Presentation without invented prices

1. Add a real validated Steam base game with a valid current Steam offer.
2. Start with a target below that reported price and show a nonqualifying check.
3. Raise the target above the same real price and trigger the admin-only shared check service.
4. Show the real email and Android push for the qualifying episode.
5. Repeat the check and show no duplicate delivery. Show history and the same tracker in React and Flutter.

Say explicitly that the target changed, not that a new sale happened. Provider failures must not trigger alerts. Pure tests can simulate price transitions to test rearming without creating a fictional live store. If the provider is unavailable during presentation, use a clearly identified recording of prior real evidence—not a fabricated live response.

## Not in this release

No Amazon/Walmart/Best Buy/Target/Shopify integrations, merchant-permission campaign, Books to Scrape, training-store parser, extra paid data provider, or live mock-price mode. Best Buy and Target are not in the current CheapShark store list; adding their game prices would require separate work. GOG/Fanatical are optional, not a release dependency.

The original course stack, authentication, history, daily worker, email, Android push, testing, diagrams, SwaggerHub, November 10 freeze, and November 11–15 preparation buffer stay in place.
