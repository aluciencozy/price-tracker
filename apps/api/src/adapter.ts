// apps/api/src/cheapshark.ts

const CHEAPSHARK_ORIGIN = 'https://www.cheapshark.com';
const USER_AGENT =
  'PriceTracker-COP4331C/0.1 (+https://github.com/aluciencozy/price-tracker)';
const STEAM_STORE_ID = '1';

const confirmedGames = new Map([
  ['620', 'Portal 2'],
  ['220', 'Half-Life 2'],
]);

export type SteamOffer = {
  provider: 'cheapshark';
  providerGameId: string;
  steamAppId: string;
  storeId: '1';
  market: 'US';
  currency: 'USD';
  title: string;
  canonicalSteamUrl: string;
  currentPriceCents: number;
  retailPriceCents: number | null;
  dealId: string;
  purchaseUrl: string;
  source: 'CheapShark';
  fetchedAt: string;
  providerChangedAt: string | null;
};

type CheapSharkGameMatch = {
  gameID: string;
  steamAppID: string;
  external: string;
};

type CheapSharkDetails = {
  info: {
    steamAppID: string;
    title: string;
  };
  deals: Array<{
    storeID: string;
    price: string;
    retailPrice: string;
    dealID: string;
  }>;
};

function parseSteamUrl(input: string) {
  let url: URL;

  try {
    url = new URL(input);
  } catch {
    throw new Error('Enter a valid Steam game URL.');
  }

  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'store.steampowered.com' ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('Use an HTTPS Steam store URL.');
  }

  const match = /^\/app\/([1-9]\d*)(?:\/[^/]+)?\/?$/.exec(url.pathname);
  const steamAppId = match?.[1];

  if (!steamAppId || !confirmedGames.has(steamAppId)) {
    throw new Error('This Steam game is not supported yet.');
  }

  return {
    steamAppId,
    title: confirmedGames.get(steamAppId)!,
    canonicalSteamUrl: `https://store.steampowered.com/app/${steamAppId}/`,
  };
}

function usdToCents(price: string): number {
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(price);

  if (!match) {
    throw new Error('CheapShark returned an invalid USD price.');
  }

  const cents =
    BigInt(match[1]!) * 100n +
    BigInt((match[2] ?? '').padEnd(2, '0'));

  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Price is too large.');
  }

  return Number(cents);
}

async function requestJson<T>(path: string): Promise<T> {
  // TODO: add an abort timeout, reject redirects, and cap response size.
  // The URL must always use CHEAPSHARK_ORIGIN and a path built from validated IDs.
  const response = await fetch(new URL(path, CHEAPSHARK_ORIGIN), {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
    },
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  });

  if (response.status === 429) {
    throw new Error(
      `CheapShark rate limited the request. Retry-After: ${
        response.headers.get('retry-after') ?? 'not provided'
      }`,
    );
  }

  if (!response.ok) {
    throw new Error('CheapShark request failed.');
  }

  return (await response.json()) as T; // TODO: validate response shape.
}

export async function lookupSteamOffer(input: string): Promise<SteamOffer> {
  const game = parseSteamUrl(input);

  // TODO: cache shared lookups and coordinate the request budget.
  const matches = await requestJson<CheapSharkGameMatch[]>(
    `/api/1.0/games?steamAppID=${encodeURIComponent(game.steamAppId)}`,
  );

  const exactMatches = matches.filter(
    (match) => match.steamAppID === game.steamAppId,
  );

  if (exactMatches.length !== 1) {
    throw new Error('Could not identify this game unambiguously.');
  }

  const match = exactMatches[0]!;

  const details = await requestJson<CheapSharkDetails>(
    `/api/1.0/games?id=${encodeURIComponent(match.gameID)}`,
  );

  if (
    details.info.steamAppID !== game.steamAppId ||
    details.info.title !== game.title
  ) {
    throw new Error('CheapShark returned a mismatched game.');
  }

  const steamOffers = details.deals.filter(
    (deal) => deal.storeID === STEAM_STORE_ID,
  );

  if (steamOffers.length !== 1) {
    throw new Error('No unambiguous current Steam offer is available.');
  }

  const offer = steamOffers[0]!;
  const dealId = decodeURIComponent(offer.dealID);

  return {
    provider: 'cheapshark',
    providerGameId: match.gameID,
    steamAppId: game.steamAppId,
    storeId: '1',
    market: 'US',
    currency: 'USD',
    title: game.title,
    canonicalSteamUrl: game.canonicalSteamUrl,
    currentPriceCents: usdToCents(offer.price),
    retailPriceCents: usdToCents(offer.retailPrice),
    dealId: offer.dealID,
    purchaseUrl: `${CHEAPSHARK_ORIGIN}/redirect?dealID=${encodeURIComponent(dealId)}`,
    source: 'CheapShark',
    fetchedAt: new Date().toISOString(),
    providerChangedAt: null, // TODO: map only if CheapShark supplies a valid timestamp.
  };
}