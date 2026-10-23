import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

// This is an explicit live research check, not a normal CI test or a full app feature.
const userAgent = 'PriceTracker-COP4331C/0.1 (+https://github.com/aluciencozy/price-tracker)';
const apiOrigin = 'https://www.cheapshark.com';
const games = [
  { steamUrl: 'https://store.steampowered.com/app/620/', title: 'Portal 2' },
  { steamUrl: 'https://store.steampowered.com/app/220/', title: 'Half-Life 2' },
];

const report = {
  scope: 'Live Steam URL-to-offer API proof; purchase redirects are for human navigation only.',
  startedAt: new Date().toISOString(),
  runtime: process.version,
  userAgent,
  paidRequests: false,
  apiKeyUsed: false,
  requests: [],
  games: [],
  passed: false,
};

function usdToCents(amount) {
  const match = typeof amount === 'string'
    ? /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(amount)
    : null;

  assert.ok(match, `Invalid USD price: ${amount}`);

  const cents = BigInt(match[1]) * 100n + BigInt((match[2] ?? '').padEnd(2, '0'));

  assert.ok(cents <= BigInt(Number.MAX_SAFE_INTEGER), 'Price exceeds safe integer range');

  return Number(cents);
}

async function request(path, accept) {
  // Use one fixed client and origin. Stop on throttling; never rotate identities or retry a ban.
  if (report.requests.length > 0) {
    await delay(5000);
  }

  const url = new URL(path, apiOrigin);

  assert.equal(url.origin, apiOrigin);

  const response = await fetch(url, {
    headers: { 'User-Agent': userAgent, Accept: accept },
    redirect: 'manual',
    signal: AbortSignal.timeout(20000),
  });

  report.requests.push({
    url: url.href,
    receivedAt: new Date().toISOString(),
    status: response.status,
    responseDate: response.headers.get('date'),
    retryAfter: response.headers.get('retry-after'),
  });

  if (response.status === 429) {
    await response.body?.cancel();

    throw new Error(`Rate limited; stop and respect Retry-After: ${response.headers.get('retry-after') ?? 'not supplied'}`);
  }

  return response;
}

async function getJson(parameters) {
  const query = new URLSearchParams(parameters);
  const response = await request(`/api/1.0/games?${query}`, 'application/json');

  assert.equal(response.status, 200, `Unexpected API status: ${response.status}`);
  assert.match(response.headers.get('content-type') ?? '', /application\/json/i);

  return response.json();
}

try {
  for (const game of games) {
    const input = new URL(game.steamUrl);

    assert.equal(input.origin, 'https://store.steampowered.com');

    const path = /^\/app\/([1-9]\d*)\/$/.exec(input.pathname);

    assert.ok(path, 'Expected a canonical Steam app URL');

    const steamAppId = path[1];
    const matches = await getJson({ steamAppID: steamAppId });

    assert.ok(Array.isArray(matches), 'Expected a game lookup array');

    const exact = matches.filter((item) => item.steamAppID === steamAppId);

    assert.equal(exact.length, 1, 'Expected one exact Steam app ID match');
    assert.match(exact[0].gameID, /^[1-9]\d*$/);
    assert.equal(exact[0].external, game.title);

    const details = await getJson({ id: exact[0].gameID });

    assert.equal(details.info?.steamAppID, steamAppId);
    assert.equal(details.info?.title, game.title);
    assert.ok(Array.isArray(details.deals), 'Expected store offers');

    const steamOffers = details.deals.filter((offer) => offer.storeID === '1');

    assert.equal(steamOffers.length, 1, 'Expected one current Steam offer');

    const offer = steamOffers[0];
    const priceMinor = usdToCents(offer.price);

    assert.equal(typeof offer.dealID, 'string');
    assert.ok(offer.dealID.length > 0);

    // API deal IDs are already URL-encoded. Decode once before URLSearchParams encodes them.
    const purchase = new URL('/redirect', apiOrigin);

    purchase.searchParams.set('dealID', decodeURIComponent(offer.dealID));

    // The provider explicitly blocks automated access to /redirect. Generate the
    // documented link for human navigation, but do not request or follow it here.
    report.games.push({
      steamUrl: input.href,
      title: game.title,
      steamAppId,
      cheapSharkGameId: exact[0].gameID,
      storeId: offer.storeID,
      currency: 'USD',
      currentPrice: offer.price,
      priceMinor,
      retailPrice: offer.retailPrice,
      allStoreCheapest: exact[0].cheapest,
      historicalLow: details.cheapestPriceEver?.price,
      purchaseUrl: purchase.href,
      purchaseRedirectProbed: false,
    });
  }

  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();

  console.log(JSON.stringify(report, null, 2));
}
