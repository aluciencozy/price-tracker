# Retailer research for Nick

**Researched October 23, 2026. Development deadline: November 10.**

## Recommendation

Build **one permissioned real-retailer provider, one small permitted HTML scraper, and one controlled mock**. Do not make Amazon, Walmart, or Best Buy access a dependency for the deadline.

- **First technical choice: Shopify**, using a single approved store and selected variants. Its product JSON is much easier than browser scraping. Keychron is a concrete, working real-retailer candidate below, **not an approved integration**. Obtain permission covering automated checks, stored history, alerts, and public display; the current Shopify terms also need review/clearance for this use. Merchant permission alone must not be assumed to override Shopify's restrictions.
- **Reliable scraper: Books to Scrape**, with a tiny allowlisted catalog. It expressly welcomes scraping. Label it “training store — fictional prices,” not a real retailer.
- **Mock: our own fixture-driven provider**, visibly marked simulated, to demonstrate a repeatable drop and notification deduplication. Never alter a live observation to manufacture a sale.
- Add a second real retailer only after the first works end to end. A direct, merchant-authorized JSON feed outside a restricted platform is a better fallback than reverse-engineering a large retailer.

**Permission checkpoint: October 26.** Nick/Alex should identify a cooperating retailer and record approved endpoints, check frequency, fields, retention, alerts, and attribution. If none is available, raise the real-retailer requirement immediately. A live request to a theme demo or a sandbox does **not** satisfy that requirement. This research did not establish an unconditional license to run a public historical-price service against any named real retailer.

### What “verified” means here

- **Live verified:** an unauthenticated HTTP request actually returned the described product data during this research. This does not establish permission, future uptime, or checkout price.
- **Docs verified / API untested:** official documentation or terms were read, but no authenticated product API call was made.
- **Unknown:** approval, contract scope, or pricing could not be established from the public material. Do not turn that into an assumption.

No accounts were created, credentials used, paid services purchased, or CAPTCHAs bypassed. All observations below are dated October 23, 2026; prices and terms can change.

## 1. Shopify: three different interfaces

| Interface | Access and intended use | MVP implications |
| --- | --- | --- |
| Ajax Product API: `GET /{locale}/products/{handle}.js` | Documented, unauthenticated product JSON on Shopify-hosted theme storefronts. No token or client ID. Not supported as the theme Ajax API on headless/custom storefronts. | Smallest parser. Requires an exact store allowlist and a known product handle. Public accessibility is not a third-party price-tracking license. |
| GraphQL Storefront API: `POST /api/2026-10/graphql.json` | Buyer-facing product/cart API. **Tokenless product access exists**; public/private tokens unlock other capabilities. Do not claim every query requires a merchant token. | `MoneyV2` includes decimal `amount` and `currencyCode`; market context can be explicit. Better structured currency handling, but not a way around use restrictions. Pin a version and check GraphQL errors even on HTTP 200. |
| GraphQL Admin API | Merchant-authorized app/OAuth access with scopes and an Admin access token. | Not a public competitor-price endpoint. Do not request customer/order permissions for a price lookup, expose Admin credentials, or assume another store's Admin data is available. |

Official sources: [Ajax overview][s-ajax], [Product API][s-product], [authentication][s-auth], [Storefront API][s-storefront], [MoneyV2][s-money]. Ajax docs say there are no hard rate limits, **but abuse prevention still applies**. This is not permission to poll aggressively. Product JSON is limited to **250 variants**.

### Important current permission constraint

The [Shopify API terms][s-terms], updated **October 7, 2026**, restrict scraping/mining (section 2.3.8), systematic automated collection/product indexes (2.3.14), and disclosure of merchant data (2.3.19). Section 6 addresses merchant authorization, purpose-limited storage, and deletion. Do not recommend “all Shopify stores work, therefore all are permitted.” A tokenless request or permissive robots rule does not remove these restrictions. Seek explicit clearance for the proposed tracker or use an independently authorized retailer feed.

No public per-request fee was specified for Ajax/tokenless product reads in the documentation reviewed. That does not imply unlimited access or free hosting/a production Shopify store. [Dev stores][s-dev] are controlled testing environments, always password protected, cannot process real transactions, and cannot become production stores. Do not promise that creating one supplies an unrestricted public `.js` demo URL.

### Concrete Shopify product candidates

**A. Keychron K2 HE — real retailer, live verified, permission pending**

- Product: <https://www.keychron.com/products/keychron-k2-he-wireless-magnetic-switch-keyboard>
- JSON: <https://www.keychron.com/products/keychron-k2-he-wireless-magnetic-switch-keyboard.js>
- Exact example variant URL: <https://www.keychron.com/products/keychron-k2-he-wireless-magnetic-switch-keyboard?variant=44855814881369>
- JSON returned product ID `7782395215961`, ten variants, and an available “Standard Version / Black / Gateron Double-Rail Magnetic Nebula Switch Version 2” variant `44855814881369`, price `12999`. Special editions were `13999`.
- The HTML separately identified `Shopify.currency.active = "USD"` and `Shopify.country = "US"`. Thus this observed context was **USD 129.99**, not “12999 dollars.” The JSON itself did not carry a currency field.
- [Keychron robots.txt][k-robots] did not disallow this product path, but disallows `/cart`, policies, and other areas for general crawlers. Its AI-crawler permissions are not permission for our scheduled price-tracker bot. [Store terms][k-terms] and Shopify platform terms still need clearance for history/alerts. Do not fetch cart endpoints just to discover currency when disallowed.

**B. Older K2 — useful unavailable/price-range case, live verified**

- Product: <https://www.keychron.com/products/keychron-k2-wireless-mechanical-keyboard>
- JSON: <https://www.keychron.com/products/keychron-k2-wireless-mechanical-keyboard.js>
- Returned 13 variants, product `available: false`, prices from `4999` to `6999`. Variant `39900390359129` was `4999`, `compare_at_price: 7499`, unavailable. Useful evidence that a listed sale price is not a purchasable offer.
- The K2 Pro JSON also worked: <https://www.keychron.com/products/keychron-k2-pro-qmk-via-wireless-mechanical-keyboard.js>; 29 variants, minimum `6799`, unavailable in this observation. Prefer the available K2 HE for a lookup demonstration, subject to permission.

**C. Shopify Dawn theme demo — live platform example, not a real-retailer success**

- Store: <https://theme-dawn-demo.myshopify.com/>
- Product: <https://theme-dawn-demo.myshopify.com/products/louise-slide-sandal>
- JSON: <https://theme-dawn-demo.myshopify.com/products/louise-slide-sandal.js>
- Direct HTTP 200, `text/javascript; charset=utf-8`, valid JSON: product ID `6920722055257`, 21 variants, price `39500`, product available. First variant `39577003753561` (“Buttermilk / 35”) was **unavailable**, despite product-level availability.
- HTML identified **CAD**, so the observed price was **CAD 395.00**, not USD. Do not infer currency from `$`.
- [Dawn demo robots][d-robots] allowed product paths but explicitly disallowed `/cart.js`. It is a theme demonstration, not an express scraping/history license. Use for a small approved technical demonstration, not scheduled production collection without clearance.

### Price, identity, and currency rules

1. Identity is `(provider, store, product ID, variant ID, market, currency)`. Preserve a submitted `?variant=` and verify membership in `variants`; do not silently switch to the first available variant later. If absent, require selection for multi-variant products.
2. Read the selected variant's price and availability. Product `price_min`/`price_max` are ranges, not the price of every variant. `compare_at_price` is a reference/list price, **not a historical observation**. `available` means available for purchase, not necessarily a stock count.
3. For the tested USD/CAD Ajax cases, integer `12999` means `129.99`; keep it as integer minor units. Storefront `MoneyV2.amount` is a **decimal major-unit value**, so `"129.99"` must be converted exactly, not treated as cents. Use a decimal-string parser, not floating-point arithmetic.
4. Do not generalize “Shopify numbers are ISO minor units for every currency.” Shopify's [Liquid variant documentation][s-variant] explicitly describes JPY/KRW values with hundredths appended (1000 JPY represented as 100000). Before adding other currencies, verify the actual endpoint's scale and add fixtures; never blindly use the currency exponent on raw Ajax values. Limit the first adapter to a verified USD or CAD context.
5. Prices are in the customer's **presentment currency**, affected by locale/market/session. Product JSON lacks currency; docs recommend same-context `/cart.js`, **only where permitted**. Otherwise use an authorized fixed-market configuration checked against explicit HTML currency metadata, or Storefront `MoneyV2` with `@inContext(country: US)`. Reject changed/unknown currency rather than relabeling it.
6. Compare the listed one-time product price only. Exclude shipping, taxes, coupons, memberships, subscription allocations, installment amounts, and checkout-only discounts. Reject subscription-only products initially. Never evaluate executable scripts from fetched HTML.

## 2. Large retailer APIs: available does not mean suitable

| Retailer | Current access / eligibility | Pricing evidence | Deadline decision |
| --- | --- | --- | --- |
| Amazon | **Creators API exists** and is the supported successor to PA-API 5. Associates enrollment, target-market approval, credentials, and **10 qualifying sales in the past 30 days** are prerequisites in current official docs. OAuth 2.0 client credentials; Node.js SDK available. | Associates is free to join and the license is royalty-free; no separate public per-call fee schedule found in the reviewed Creators docs. Access/quota is sales-dependent, not an unlimited free data feed. | Exclude without explicit Amazon agreement for tracking/alerts and retention. |
| Walmart | Walmart I/O advertises Affiliate Marketing APIs and localized product/price services. Approval and application credentials are required; Marketplace seller APIs are a separate product, not anonymous consumer catalog access. | I/O labels Affiliate Marketing “Open API” and pickup/delivery services “Subscription Based”; no confirmed public dollar quote or general free-tier entitlement established. | Exclude from critical path; confirm product, approval, price, and history license first. |
| Best Buy | Public developer portal and REST Products API docs remain available; email registration and key activation documented. Affiliate membership is separate, with additional restrictions for entertainment content; Commerce Gateway needs preapproval. | Commonly described as a free developer key; the official pages reviewed publish signup/quotas, not a priced plan. We did not complete signup or verify billing/issuance. | Easier optional current-price API, **not a cleared long-term history provider**. |

These are **docs verified / authenticated APIs untested**. Reading the portal is not proof that this team can obtain a working key today.

### Amazon: the decisive restriction is the use case

- [Creators introduction][a-intro] documents `SearchItems`, `GetItems`, `GetVariations`, and `GetBrowseNodes`. [Deprecation notice][a-deprecation] says PA-API 5 requests now receive `403 AccessDeniedException`. Do not build a new PA-API 5 integration or repeat “Amazon has no API.”
- Current [Program Policies][a-policies] (updated **April 14, 2026**), Participation Requirements **6(y)**: **“Unless otherwise agreed by Amazon, your Site must not have price tracking and/or price alerting functionality.”** API credentials alone do not fix this.
- The IP License restricts aggregation/analysis without express written approval. Non-image Product Advertising Content caching is generally limited to **24 hours**; image binaries may not be cached (image links have a 24-hour limit); ASINs have a separate retention exception. Refreshing today's value does not authorize keeping yesterday's price forever.
- [Creators best practices][a-practices] further specifies **one-hour Offers cache TTL**, with one day for other listed resources. Price display can require adjacent timestamps and the prescribed price/availability disclaimer. Preserve returned affiliate links and Partner tags. A client app has additional caching restrictions; Flutter cannot simply keep an offline copy of the Amazon catalog.
- [API rates][a-rates] documents an initial maximum **1 transaction/second and 8,640/day**, then sales-dependent allocation and loss of access after 30 consecutive days without qualified referring sales. Do not copy older “100,000/day” assumptions.
- Retail HTML scraping is not a workaround: license restrictions exclude data mining and robot extraction, and [Amazon robots][a-robots] has broad agent-specific blocks and sensitive-path restrictions. We did not probe product pages or attempt anti-bot bypass. Multiple sellers, conditions, delivery locations, Prime offers, and variants further complicate matching.

### Walmart: distinguish affiliate data from seller operations

- [Walmart I/O][w-io], [Affiliate Marketing docs][w-affiliate], [pricing snapshot docs][w-snapshot], and the [affiliate program][w-program] establish that product/affiliate data offerings exist. The affiliate site advertises links and data feeds and a fast approval process; that is not a guarantee of API approval for a student tracker.
- I/O's pages returned a JavaScript application shell to the text fetcher. Its public application bundle contained the Affiliate Marketing description, subscription labels, and terms saying the API cannot be used until approval. Those are portal/documentation observations, **not a successful price API call**. The loaded bundle is linked in the source notes below.
- [Marketplace introduction][w-marketplace] explicitly targets sellers and approved solution providers managing items, inventory, orders, and their own pricing. It is not permission to use a seller account as a public consumer-price feed.
- Public I/O terms also restrict redistribution/syndication. A price-history retention entitlement was **not verified**. Ask Walmart to confirm API tier, credentials, quota, fee, permitted app surfaces, persistence, and alerts in writing. Do not import Marketplace supplier terms as if they governed every affiliate API.
- [Walmart.com Terms][w-terms], updated **September 21, 2026**, prohibit automated scraping without express prior written consent and systematic downloading/storage. [Robots][w-robots] disallows `/api/` and `/search`, among other paths; an accessible `/ip/...` page is not blanket permission. HTML/embedded state can contain location-, seller-, and fulfillment-specific offers, with anti-bot interruptions. Do not use it for this MVP.

### Best Buy: good API documentation, incompatible default history license

- [Official API docs][b-docs] describe `GET https://api.bestbuy.com/v1/products/{sku}.json?apiKey=...`, `salePrice`, `regularPrice`, `onlineAvailability`, `priceUpdateDate`, and `priceRestriction`. `salePrice` is a dollar amount, not integer cents. Restriction values include MAP and checkout rebate cases: do not publish a hidden price or scrape a cart to discover it.
- [Developer legal terms][b-legal], last updated **February 23, 2021** and still served on research day, limit storage/cache to **72 hours**, solely as necessary to improve display response times. This is not a license for a rolling historical database, even if each individual request is authorized. The API's “historical products” means past catalog products, not permission to retain daily price history.
- The same page publishes **50,000 calls/day and 5 calls/second**, requires clear source attribution and the Best Buy logo where API content appears, and prohibits pricing analysis for third parties such as competing retailers. Games/CD/DVD/Blu-ray content requires affiliate use or a separate agreement. Use electronics for any approved experiment.
- The docs say response links expire after seven days. That does **not** enlarge the 72-hour storage allowance. Preserve API-provided links and do not expose the API key in clients/logs.
- [Retail-site terms][b-site-terms], updated **September 25, 2026**, expressly prohibit scraping; current [robots][b-robots] also restricts internal pricing, availability, and browse API paths. Product HTML/JSON-LD extraction is technically possible in some responses, but not a permitted alternative for this project. No authenticated price request was tested.

## 3. Simple, permitted HTML scraper candidates

Use Node `fetch` plus a small HTML parser such as Cheerio. No Playwright, browser farm, proxies, login automation, or CAPTCHA service is needed.

| Website | Concrete live-verified URL and result | Permission, parser, limitations |
| --- | --- | --- |
| **Books to Scrape — recommended** | <https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html>; HTML includes “A Light in the Attic,” **GBP 51.77**, “In stock (22 available).” Another candidate: <https://books.toscrape.com/catalogue/tipping-the-velvet_999/index.html> (**discovered, not individually requested**). | The operator's [sandbox page][t-home] explicitly invites developers to validate scrapers; pages say “We love being scraped!” and prices/ratings are random. `.product_main h1`, `.product_main .price_color`, `.product_main .availability`; integer `5177`, currency `GBP`. `/robots.txt` returned 404, not a prohibition and not proof by itself of permission. HTML includes `NOARCHIVE,NOCACHE`: avoid retaining raw third-party HTML publicly; use our own minimal test HTML/fixtures and normalized demo observations rather than archiving pages. |
| **Web Scraper e-commerce training site — backup** | <https://webscraper.io/test-sites/e-commerce/allinone/product/36>; HTTP 200, “Aspire E1-572G,” **USD 581.99**, with explicit `priceCurrency=USD`. | [Test-site landing page][t-web] invites training; [all-in-one home][t-all] says items are not for sale. Use `[itemprop="name"]`, `[itemprop="price"]`, `meta[itemprop="priceCurrency"]`, scoped to the product. [Robots][t-robots] blocks some newer product/pagination/scroll routes; the exact `/test-sites/e-commerce/allinone/product/36` path was not among those disallows when checked. Recheck before enabling a different route. No real sales or useful live price movement. |

An additional parser-learning option is <https://www.scrapethissite.com/pages/simple/> (**live verified**, country rows). The [operator's FAQ][t-faq] expressly permits scraping, requires an identifying user agent, **at most one request/second**, and respect for [robots][t-sts-robots]. It has **no product prices**, so it is not a substitute retailer adapter. Robots disallows `/faq/` and `/lessons/`; do not include them in a crawler. No need to add this provider to the app.

For our two price sandboxes, start with **one product each**, at most one in-flight request/host, at least 2 seconds between requests, and normal daily checks. These are our conservative limits, not claimed provider quotas. Do not crawl all 1,000 books. Sandbox prices usually stay fixed; use the mock, not repeated live requests, to demonstrate alerts. No public test site offers an uptime guarantee.

## 4. Other honest alternatives

### Adafruit: small official real-retailer API, scope clarification needed

[Adafruit Products API][alt-adafruit] publishes unauthenticated JSON endpoints such as `https://www.adafruit.com/api/product/4116` for [PyPortal][alt-pyportal]. Docs include formatted price, optional sale price, stock, quantity discounts, and product URL. **Docs verified; JSON endpoint not requested in this research.**

Rules: **5 requests/minute or less**, **no image hotlinking**, copyrighted content authorized for an “online store.” A student historical-price/alert app is not obviously that use. Ask `legal@adafruit.com` about this scope and history retention before choosing it. [Robots][alt-adafruit-robots] disallows `/api/` for general crawlers, despite the separately published API instructions: do not treat it as permission for an unrestricted crawler. Confirm the intended API integration rather than bypassing robots. No credential purchase or public per-call charge was described. Good small-retailer contact option, not an unconditionally cleared substitute.

### Open Prices: permitted real observations, but not live retailer integration

[Open Food Facts Open Prices][alt-openprices] is an open dataset of actual submitted food prices. Its [API/license documentation][alt-op-api] permits reuse under **ODbL**, with attribution and share-alike/database-combination implications. No account is needed to explore public data; writing requires authentication.

**Live verified:** <https://prices.openfoodfacts.org/api/v1/prices?size=1> returned HTTP 200 JSON, including product code `1541513213246`, **EUR 27.70**, location L'Éléfàn in Grenoble, and observation date **2023-11-27**. This illustrates why `retrievedAt` must not be confused with a new retailer observation. Keep source observation date, product, location, quantity basis, and currency together. Do not send “price dropped today” for a newly downloaded old receipt.

This is useful if the team/instructor explicitly accepts a real **data provider** instead of a retailer integration. It does not satisfy the current “paste retailer URL → current offer” requirement, so do not quietly substitute it. Keep ODbL data separate from restricted retailer data and private watchlists; review sharing obligations before publishing a combined database.

## 5. TypeScript provider boundary and URL safety

All retailer access belongs in `apps/api`, shared by preview, scheduler, and admin-only manual checks. Clients never call retailer APIs or MongoDB directly. A provider should normalize an approved product identity and return fields like:

```ts
type PriceObservation = {
  provider: string;
  productId: string;
  variantId?: string;
  market: string;
  currency: string;
  priceMinor: number; // safe integer, never a binary floating-point dollar value
  available: boolean;
  name: string;
  canonicalUrl: string;
  observedAt: string;
  sourceKind: 'retailer' | 'sandbox' | 'mock' | 'community';
};
```

This is a suggested internal shape, not a new public API contract. Use the team's agreed schema. Optional image URLs require permission and validation; omit images rather than violating hotlink rules. Store provider IDs as strings.

Following [OWASP's SSRF guidance][security], Nick's fetch layer should:

1. Parse with `new URL()`. Accept HTTPS only, no credentials, no unexpected port, and **exact approved hostnames**. Never allow all `*.myshopify.com`, arbitrary “Shopify-looking” domains, suffix matches such as `keychron.com.attacker.example`, shorteners, or arbitrary pasted URLs.
2. Match a provider-specific product path; allow only known query inputs such as numeric `variant`. Rebuild a fixed endpoint from the validated ID/handle. Strip analytics parameters; never copy user-selected hosts, arbitrary paths, or `redirect=` parameters into outbound requests.
3. Resolve and validate **all IPv4/IPv6 destinations**, rejecting loopback, private, link-local, metadata, multicast, and other nonpublic ranges. Bind the connection to a validated address while preserving TLS hostname checks; a separate DNS check followed by an unchecked lookup is vulnerable to rebinding. Apply to retries and fallback addresses too.
4. Default to `redirect: 'manual'` and reject redirects. If a provider demonstrably needs them, cap at two and independently recheck scheme, exact host, DNS/IP, and permitted path at every hop. Never forward auth headers/cookies to another origin. Normalize a known `www` alias locally rather than following arbitrary redirects.
5. Set a **10-second total request deadline including body reading**, bounded response size (for example 1 MiB), content-type/schema checks, and a host-level concurrency/rate budget. Some Ajax JSON uses `text/javascript`; permit that only for the known endpoint and parse as JSON, never execute it.
6. Identify the app honestly. Stop on access-denied/CAPTCHA/security rejection. Respect `Retry-After` for 429; bounded exponential backoff for temporary failures, no rapid retries on 403/404. Do not rotate IPs, spoof a search engine, or use private browser endpoints.
7. Treat missing variant, changed currency, malformed amount, timeout, HTML instead of JSON, and access denial as failures. Preserve the last successful price; no zero-price history entry or alert. Show stale/unavailable status separately. Validate image redirects too if the backend ever fetches images; safest MVP is no image proxy.

## 6. Storage, tests, and finish line

**Store history only when the source license permits it.** An API key grants access, not ownership of all returned data. Maintain per-provider approved fields, retention, attribution, and whether history/alerts are permitted. Do not dump complete retailer payloads or copyrighted descriptions into MongoDB/Git. Restricted content must also be removed from logs, fixtures, exports, backups, and caches according to the applicable agreement; a TTL on the latest-price collection alone is insufficient.

- **Oct 23–26:** resolve real-source permission; freeze one exact host, market, currency, and product URL pattern. Record any outstanding approval as a blocker, not “supported.”
- **Oct 27–30:** implement shared safe HTTP client, one real provider behind its approval gate, Books parser, and mock. Add fixtures for selected/unavailable variants, price ranges, reference prices, currencies, invalid JSON, and missing selectors. Keep CI offline.
- **Oct 31–Nov 4:** connect scheduled and manual checks to the same service; fetch each shared product once, store only successful authorized observations, and verify per-user target evaluation. Live checks are explicit manual smoke checks, not routine CI tests.
- **Nov 5–10:** verify web and Flutter show identical source/market/currency, historical observations and stale states; run repeat/concurrent checks without duplicate alerts. Demonstrate one **real approved retailer lookup**, one **sandbox scrape**, and a separately labeled **simulated drop**. Freeze before presentation prep.

Required security fixtures: credential-bearing URL, wrong scheme/port, deceptive hostname, private IPv4/IPv6 DNS, rebinding attempt, cross-host/private redirect, redirect loop, oversized body, timeout, 429 and 403. Required money fixtures: USD `12999`, CAD `39500`, Storefront `"129.99"`, missing/changed currency, unavailable selected variant, and “compare at” not entering history.

**Research validation only:** the documented live HTTP observations were performed; no provider implementation, automated parser tests, authenticated retailer API smoke tests, or permission approvals were completed by this research task.

## Official source index

All sources accessed October 23, 2026. Legal update dates are stated above; undated docs are not assigned an invented publication date. Links to candidate products are in their sections.

[s-ajax]: https://shopify.dev/docs/api/ajax
[s-product]: https://shopify.dev/docs/api/ajax/reference/product
[s-auth]: https://shopify.dev/docs/api/usage/authentication
[s-storefront]: https://shopify.dev/docs/api/storefront/latest
[s-money]: https://shopify.dev/docs/api/storefront/latest/objects/MoneyV2
[s-variant]: https://shopify.dev/docs/api/liquid/objects/variant
[s-terms]: https://www.shopify.com/legal/api-terms
[s-dev]: https://shopify.dev/docs/apps/build/stores/development-stores
[k-robots]: https://www.keychron.com/robots.txt
[k-terms]: https://www.keychron.com/policies/terms-of-service
[d-robots]: https://theme-dawn-demo.myshopify.com/robots.txt
[a-intro]: https://affiliate-program.amazon.com/creatorsapi/docs/en-us/introduction
[a-deprecation]: https://affiliate-program.amazon.com/creatorsapi/docs/en-us/paapiv5-deprecation
[a-policies]: https://affiliate-program.amazon.com/help/operating/policies/
[a-practices]: https://affiliate-program.amazon.com/creatorsapi/docs/en-us/concepts/best-programming-practices
[a-rates]: https://affiliate-program.amazon.com/creatorsapi/docs/en-us/concepts/api-rates
[a-robots]: https://www.amazon.com/robots.txt
[w-io]: https://walmart.io/apirefservices
[w-affiliate]: https://walmart.io/docs/affiliates/v1/introduction
[w-snapshot]: https://walmart.io/docs/opd/v1/catalog-pricing-and-availability-snapshot
[w-program]: https://affiliates.walmart.com/
[w-marketplace]: https://developer.walmart.com/us-marketplace/docs/introduction-to-marketplace-apis
[w-terms]: https://www.walmart.com/help/article/walmart-com-terms-of-use/3b75080af40340d6bbd596f116fae5a0
[w-robots]: https://www.walmart.com/robots.txt
[b-docs]: https://bestbuyapis.github.io/api-documentation/
[b-legal]: https://developer.bestbuy.com/legal
[b-site-terms]: https://www.bestbuy.com/site/help-topics/terms-and-conditions/pcmcat204400050067.c?id=pcmcat204400050067
[b-robots]: https://www.bestbuy.com/robots.txt
[t-home]: https://toscrape.com/
[t-web]: https://webscraper.io/test-sites
[t-all]: https://webscraper.io/test-sites/e-commerce/allinone
[t-robots]: https://webscraper.io/robots.txt
[t-faq]: https://www.scrapethissite.com/faq/
[t-sts-robots]: https://www.scrapethissite.com/robots.txt
[alt-adafruit]: https://www.adafruit.com/products_api
[alt-pyportal]: https://www.adafruit.com/product/4116
[alt-adafruit-robots]: https://www.adafruit.com/robots.txt
[alt-openprices]: https://github.com/openfoodfacts/open-prices
[alt-op-api]: https://github.com/openfoodfacts/open-prices/blob/main/API.md
[security]: https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html

For reproducibility, Walmart I/O's [terms page](https://walmart.io/termsandcondition) and service descriptions were inspected in its openly loaded [client bundle](https://i5.walmartimages.com/dfw/63fd9f59-97c5/e11b7d18-ddab-4016-80d8-ab98d363dbf5/v1/subapp-client.bundle.052f474eee3824f5f86b.js), not through private endpoints. The bundle filename may change. This is weaker evidence than an approved developer contract; verify the rendered current pages with Walmart before implementation.
