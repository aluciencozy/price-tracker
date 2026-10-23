# Provider decisions

**Reviewed October 23–26, 2026. Updated October 26.**

Our MVP tracks PC base games. It uses CheapShark and starts with Steam. The budget is **$0**.

This guide explains why we did not choose other stores or APIs. “Not selected” does not mean “impossible forever.” A new agreement or changed terms could change a decision. Check the linked source before future use. These are project decisions under published terms, not a legal opinion about all scraping.

## Quick answer

| Store or provider | Main reason | MVP decision |
| --- | --- | --- |
| Best Buy | API data can be cached for at most 72 hours, only to improve display response time. Game content has extra license conditions. | Do not use it for our stored price history. |
| Amazon | Site terms restrict data extraction. Its affiliate program also forbids price tracking/alerts without a separate agreement. | No Amazon scraper or affiliate API. |
| Target | Site terms restrict scraping and systematic storage of listings/prices. No usable free public price API was verified. | No Target integration. |
| Walmart | Site terms require written consent for scraping and prohibit systematic download/storage. Affiliate access/history rights were not verified. | No Walmart integration. |
| CheapShark | Free API for real game prices, with required purchase links and rate limits. Exact Steam lookup proved October 26. | Selected; app adapter still to build. |

## Best Buy: we cannot keep permanent price history under the default API terms

- Published API limits are **50,000 calls per day** and **5 calls per second**.
- The request limit is not the main problem for our small app.
- The API terms allow a saved copy for **no more than 72 hours**. This is a temporary cache, only to improve the response time when displaying data.
- This does **not** give us permission to keep daily prices in MongoDB as a permanent history database.
- Deleting entries after 72 hours does not automatically make a price-history feature allowed. The stated cache purpose still applies.
- Game/CD/DVD/Blu-ray API content also requires affiliate use or a separate signed agreement.
- Getting an API key does not remove these conditions. We have not obtained an exception.

**Decision:** exclude Best Buy from this MVP. We cannot use its default API license for the history feature we planned. We also cannot get Best Buy prices from CheapShark's current store list.

Source: [Best Buy API terms and rate table](https://developer.bestbuy.com/legal), especially **License Grant and Proprietary Rights**, **Prohibited Uses**, and **Rate Limit**. The served terms say February 23, 2021; checked again October 26, 2026.

## Amazon: scraping and the affiliate API have separate problems

### Direct scraping

- Amazon's standard site-use license excludes data mining, robots, and similar data extraction tools.
- Public product pages are not blanket permission to build a scheduled scraper.
- Our October 26 request for the Conditions page returned HTTP 503. We did not bypass the failure or prove a reliable product scraper.
- A 503 response alone does not prove its cause. We do not claim that it is always a CAPTCHA or that every request is impossible.

### Amazon's own affiliate API

- Amazon **does have an API**: Creators API. “Amazon has no API” is incorrect.
- Associates Program Participation Requirements **6(y)** say: “Unless otherwise agreed by Amazon, your Site must not have price tracking and/or price alerting functionality.”
- Its content also has retention/display restrictions. An API key is not permission to keep permanent history.
- These affiliate conditions apply to that program. Do not treat them as the contract for every independent data provider.

**Decision:** no Amazon scraper or Amazon affiliate API for the MVP. We have no separate approval for our use. We will not use proxies, browser tricks, or extra accounts to get around restrictions.

Sources: [Amazon Conditions of Use](https://www.amazon.com/gp/help/customer/display.html?nodeId=GLSBYFE9MGKKQXXM), **License and Access**; [Associates Program Policies](https://affiliate-program.amazon.com/help/operating/policies/), **Participation Requirements 6(y)** and **IP License**. The Conditions restriction was visible in the official search index; the direct page fetch failed. The affiliate policy text was read directly on October 26.

## Target: our price scraper is not authorized under the standard site terms

- Target's terms restrict data extraction, scraping, mining, and creating a database by systematically downloading or storing site content.
- The restricted content includes product listings, descriptions, **prices**, and images, except as allowed by its limited license.
- The ordinary personal-shopping license is not general approval for our shared scheduled price-history app. We have no separate Target authorization.
- We did not verify a free public consumer-price API for our app.
- We therefore have **no confirmed API request limit** to quote. Do not invent a number or assume an internal website endpoint is a public API.

**Decision:** no Target scraper or API integration in this MVP. Target is also absent from CheapShark's current store list.

Source: [Target Terms & Conditions](https://www.target.com/c/terms-conditions/-/N-4sr7l), the site-use/license and prohibited-use text. Checked October 26. The text fetch missed the body, but the public page's embedded content contained the scraping/storage restrictions; no private API or login was used.

## Walmart: written consent is required for the scraping route

- Walmart's site terms prohibit systematic download and storage of its materials.
- They also prohibit robots and scraping/data-mining tools without express prior written consent.
- We do not have that consent.
- Walmart's Marketplace APIs are for seller operations. They are not an anonymous consumer-price feed.
- Affiliate/product APIs exist, but this team's approval, $0 access, and right to keep price history were not verified.

**Decision:** no Walmart scraper or direct API in the MVP. Do not claim that Walmart has no APIs; our intended access and use are not established.

Sources: [Walmart.com Terms of Use](https://www.walmart.com/help/article/walmart-com-terms-of-use/3b75080af40340d6bbd596f116fae5a0), **sections 2 and 11**; [Walmart I/O](https://walmart.io/apirefservices); [Marketplace API introduction](https://developer.walmart.com/us-marketplace/docs/introduction-to-marketplace-apis). The retail terms say September 21, 2026; checked October 26.

## Other options we considered

| Option | What blocks or limits our use | Decision and source |
| --- | --- | --- |
| Shopify stores, including Keychron | Public product JSON works technically. It does not establish permission for repeated collection, storage, and alerts. Applicable platform and store terms still need review; no approval for our proposed use was obtained. | Outside the game MVP. [Shopify API terms](https://www.shopify.com/legal/api-terms), sections 2.3 and 6; [Keychron terms](https://www.keychron.com/policies/terms-of-service). Do not label all Shopify stores approved or all access impossible. |
| Adafruit | Official product API: at most **5 requests/minute** and no image hotlinking. Its stated content permission is for an “online store.” Our history/alert app is not clearly covered. | Scope approval unresolved; not selected. [Product API rules](https://www.adafruit.com/products_api). |
| Kroger | Public APIs are free. However, default API terms restrict permanent copies/databases and saved content beyond the cache header, unless otherwise permitted by the owner or law. | Do not assume we can retain daily prices. Not selected. [API terms](https://developer.kroger.com/terms), section 5(e). |
| DigiKey | The API agreement prohibits using the API/data to update or create our own information database. | Conflicts with our stored-history plan. Not selected. [API agreement](https://developer.digikey.com/api-user-agreement), section 5.1(e). |
| Mouser | A free Search API exists. Search-indexed API terms include storage restrictions, but the full terms could not be retrieved reliably in this review. We did not verify a history exception. | Not cleared; no claim of a confirmed usable quota or permission. [API terms](https://www.mouser.com/en/apiterms/). |
| eBay's official Buy APIs | Production access requires approval and agreements. Approval is not guaranteed; sandbox access does not prove access to real listings. | Not a deadline dependency. [Production requirements](https://developer.ebay.com/api-docs/buy/static/buy-requirements.html). |
| IsThereAnyDeal | Its API terms prohibit an app that could compete with IsThereAnyDeal or its projects. A game price tracker may fall into that category. | Do not use it without clarification/approval. [Official API terms](https://github.com/IsThereAnyDeal/API/blob/master/TERMS_OF_SERVICE.md). |
| OpenWeb Ninja | Advertises $0/no-card plans with **100 requests/month per listed retailer API** and hard caps. This can cover a tiny daily demo, not a large watchlist. Its terms pass original-source rights/compliance responsibility to the user. Authenticated use and those rights were not established for our app. | A limited technical candidate, not a permission shortcut. Not selected after the game-only decision. [Example free plan](https://www.openwebninja.com/api/real-time-amazon-data), [terms section 2](https://www.openwebninja.com/terms). |
| ShopSavvy and other paid APIs | A paid plan or card-required trial does not meet the $0 rule. A short trial is not a stable project dependency. | Not selected. [ShopSavvy plans](https://shopsavvy.com/data). No signup or purchase was made. |
| Books to Scrape and other training stores | They do not sell the real products our users want to track. | Not a user-facing integration or presentation substitute. Offline test fixtures remain allowed. |

## Why CheapShark is selected, and what is still open

- Its public API supplies real game-store prices and is free without an API key.
- The API documentation requires CheapShark purchase links. We must keep that routing and attribution.
- It rate-limits requests. We must cache shared data, respect 429/Retry-After, and use bounded backoff. “Free” does not mean unlimited.
- The docs prefer direct browser/app calls and warn that bulk catalog caching may cause a permanent block. Our use is a small shared watched-game list for daily checks and alerts, not a catalog copy. A backend is needed because clients may be closed. If CheapShark blocks that pattern, contact them or reduce scope; do not bypass it. This is a use-pattern risk, not an exception we were granted.
- Real Steam, GOG, and Fanatical price records were retrieved. The store list marks them active.
- The exact Steam URL-to-offer source lookup is **now proven** for Portal 2 and Half-Life 2. On October 26, native Node.js calls returned four HTTP 200 responses; both Steam offers were USD 9.99. [Measured results](cheapshark-proof.json).
- Earlier automated requests were rate-limited (429). The full API docs require a descriptive application `User-Agent`, which the successful Node requests supplied. We did not prove that this header was the only reason for the different result; future clients must still honor real rate limits.
- `/redirect` is a human purchase link, not an API. The docs say it blocks automated access. An extra server-side probe returned 403; this is not a failure of the price API. Do not automate that route.
- [Issue #3](https://github.com/aluciencozy/price-tracker/issues/3) records the completed source proof. The full app, its provider adapter, and actual browser/mobile purchase-link behavior still need implementation/testing; those are not claimed complete.
- Steam is required. GOG/Fanatical remain optional until exact mapping is tested. A store in the API list is not automatically supported by our app.

Sources: [API documentation](https://apidocs.cheapshark.com/), [live store list](https://www.cheapshark.com/api/1.0/stores), and [the detailed integration notes](retailer-research.md).

## Rules for any future provider

1. Check cost, account approval, request limits, storage/history rights, alert use, and required links.
2. Record the source and review date. Mark unknown information as unknown.
3. Test an exact product/game URL. A search result or a working documentation page is not a working integration.
4. Do not use a third-party scraper API as proof that a retailer granted permission.
5. Do not treat `robots.txt` as a complete license or a legal ruling.
6. Do not assume that a school assignment creates an exception to the provider's terms.
7. Change the MVP plan only after the team reviews the result. Do not silently add spending or unsupported stores.
