# Live CheapShark adapter lookup — November 9, 2026

## Scope and setup

- Ran the existing `verify:cheapshark-adapter` script once against the reviewed application adapter. This is the live adapter check requested by issue [#12](https://github.com/aluciencozy/price-tracker/issues/12), not a scheduled price check.
- Used Node.js 24.22.1 and a disposable local MongoDB 8.0.16 replica set. The process environment was cleared; only an explicit loopback test URI was supplied, and dotenv was pointed at a nonexistent file. No application `.env`, account, provider credential, or real user data was used.
- The MongoDB database was reserved for this run's shared provider-request budget. Its state was retained; it was not reset or dropped. Only provider-budget state was written. No price-history observation was created.
- This report records normalized result fields only. No raw provider payload, deal ID, or purchase URL is retained.

## Result

| Field | Observed result |
| --- | --- |
| Lookup time | `2026-11-09T19:39:16.672Z` (UTC) |
| Game | Portal 2; Steam app ID `620` |
| Exact provider identity | CheapShark game ID `36`; Steam store ID `1` |
| Market and currency | US / USD |
| Provider-reported current offer | USD 9.99 (`999` cents) |
| Provider change timestamp | Not supplied by the adapter (`null`) |
| Source | CheapShark, with Steam US/USD attribution |

The adapter made these two fixed API requests in sequence:

1. `/api/1.0/games?steamAppID=620` — response passed the adapter's 2xx, JSON, and schema checks.
2. `/api/1.0/games?id=36` — response passed the adapter's 2xx, JSON, and exact Steam identity checks.

The exact numeric HTTP status codes were not captured, so this report does not claim HTTP 200. The adapter returns a normalized offer only after both responses pass its success and validation checks. No retry or alternate request was made. No submitted Steam URL or CheapShark purchase redirect was fetched; the adapter only constructs a human purchase link for callers.

USD 9.99 is a dated provider observation, not a direct Steam checkout quote. No provider change time was supplied, and this is not evidence of a new discount or price drop. This one lookup validates only the Portal 2 path; it does not expand the supported-game catalog or establish general upstream availability.

## Reproduction and limits

From the repository root, use the existing script with an approved disposable local replica-set URI:

```sh
MONGODB_URI="$APPROVED_LOCAL_MONGODB_URI" npm run verify:cheapshark-adapter --workspace @price-tracker/api
```

Set `APPROVED_LOCAL_MONGODB_URI` to a loopback replica-set URI with a dedicated test database. Preserve the database's shared provider-budget and cooldown state; do not clear or reset it to force a request. The adapter uses two fixed provider requests, a 10-second per-request timeout, a 30-second total lookup deadline, and its shared minimum request interval. A rate limit or blocked/unavailable source should end the attempt; do not retry with another account, IP, endpoint, or provider.

This lookup did not run a tracker check, save history, send email or push, test a user account, or verify deployment. It does not resolve the pending approval for observed-price history retention, prove a daily worker, or complete email, Firebase/Android, remote-host, or end-to-end acceptance. The separate October 26 source proof remains historical evidence and is not replaced by this dated adapter result.

No application code or normal test suite was changed or rerun for this documentation-only evidence update. Issue #12 remains open until the reviewed evidence is merged and the parent records closure.
