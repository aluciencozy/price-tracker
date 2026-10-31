import { z } from 'zod';

const API_ORIGIN = 'https://www.cheapshark.com';
const USER_AGENT =
  'PriceTracker-COP4331C/0.1 (nickwesterfeld@gmail.com; +https://github.com/aluciencozy/price-tracker)';
const STEAM_STORE_ID = '1';
const MAX_RESPONSE_BYTES = 1_000_000;

// These are the only confirmed base games from issue #3. Expand this list only
// after the same exact-match/current-Steam-offer checks have been completed.
const CONFIRMED_GAMES = new Map([
  ['620', 'Portal 2'],
  ['220', 'Half-Life 2'],
]);

const lookupMatchSchema = z.object({
  gameID: z.string().regex(/^[1-9]\d*$/),
  steamAppID: z.string().regex(/^[1-9]\d*$/),
  external: z.string().min(1).max(300),
});

const detailsSchema = z.object({
  info: z.object({
    steamAppID: z.string().regex(/^[1-9]\d*$/),
    title: z.string().min(1).max(300),
  }),
  deals: z.array(
    z.object({
      storeID: z.string().regex(/^\d+$/),
      price: z.string().max(32),
      retailPrice: z.string().max(32).optional(),
      dealID: z.string().min(1).max(256),
    }),
  ),
});

export type SteamOffer = {
  identity: {
    provider: 'cheapshark';
    providerGameId: string;
    storeId: '1';
    market: 'US';
    currency: 'USD';
  };
  steamAppId: string;
  canonicalSteamUrl: string;
  title: string;
  storeName: 'Steam';
  source: {
    name: 'CheapShark';
    url: 'https://www.cheapshark.com/';
    attribution: string;
  };
  currentPrice: { amountMinor: number; currency: 'USD' };
  retailPrice: { amountMinor: number; currency: 'USD' } | null;
  dealId: string;
  purchaseUrl: string;
  observedAt: string;
  providerChangedAt: null;
};

const attribution =
  'Prices supplied by CheapShark; Steam US/USD base-game offer, excluding taxes and checkout adjustments.';

/** Parse the submitted Steam URL locally. This function never requests Steam. */
export function parseSteamUrl(input: string) {
  let url: URL;

  try {
    url = new URL(input.trim());
  } catch {
    throw new Error('Paste a valid Steam base-game URL.');
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
    throw new Error('Use an HTTPS store.steampowered.com URL without extra parameters.');
  }

  if (/^\/(?:bundle|sub)\//.test(url.pathname)) {
    throw new Error('Steam bundles and subscriptions are not supported.');
  }

  const match = /^\/app\/([1-9]\d{0,31})(?:\/[^/]+)?\/?$/.exec(url.pathname);
  const steamAppId = match?.[1];
  const title = steamAppId ? CONFIRMED_GAMES.get(steamAppId) : undefined;

  if (!steamAppId || !title) {
    throw new Error('This Steam game is not in the confirmed supported-game list.');
  }

  return {
    steamAppId,
    title,
    canonicalSteamUrl: `https://store.steampowered.com/app/${steamAppId}/`,
  };
}

// Convenience helper for callers that only need the numeric ID.
export function parseSteamAppId(input: string): string {
  return parseSteamUrl(input).steamAppId;
}

/** Convert a CheapShark USD decimal string to exact integer cents. */
export function usdToCents(price: string): number {
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(price);

  if (!match) throw new Error('CheapShark returned an invalid USD price.');

  const cents =
    BigInt(match[1]!) * 100n + BigInt((match[2] ?? '').padEnd(2, '0'));

  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('CheapShark price exceeds the supported range.');
  }

  return Number(cents);
}

async function requestJson(path: string): Promise<unknown> {
  // Callers construct paths only from validated numeric provider IDs.
  const url = new URL(path, API_ORIGIN);
  if (url.origin !== API_ORIGIN || !url.pathname.startsWith('/api/1.0/games')) {
    throw new Error('Invalid CheapShark endpoint.');
  }

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error('CheapShark could not be reached or the request timed out.');
  }

  if (response.status === 429) {
    const retryAfter = response.headers.get('retry-after');
    await response.body?.cancel();
    throw new Error(`CheapShark rate limited the request (Retry-After: ${retryAfter ?? 'unknown'}).`);
  }

  if (response.status < 200 || response.status >= 300) {
    await response.body?.cancel();
    throw new Error('CheapShark returned an unsuccessful response.');
  }

  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error('CheapShark response exceeded the size limit.');
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error('CheapShark returned an empty response.');

  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('CheapShark response exceeded the size limit.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return JSON.parse(new TextDecoder().decode(body)) as unknown;
  } catch {
    throw new Error('CheapShark returned invalid JSON.');
  }
}

function purchaseUrl(dealId: string): string {
  // CheapShark's dealID may already contain percent escapes. Decode once and
  // let URLSearchParams encode it once for the human purchase link.
  let rawDealId: string;
  try {
    rawDealId = decodeURIComponent(dealId);
  } catch {
    throw new Error('CheapShark returned an invalid deal ID.');
  }

  const url = new URL('/redirect', API_ORIGIN);
  url.searchParams.set('dealID', rawDealId);
  return url.href;
}

/** Resolve a Steam URL to its current Steam offer through CheapShark. */
export async function lookupSteamOffer(input: string): Promise<SteamOffer> {
  const game = parseSteamUrl(input);

  const rawMatches = await requestJson(
    `/api/1.0/games?steamAppID=${encodeURIComponent(game.steamAppId)}`,
  );
  const matchesResult = z.array(lookupMatchSchema).safeParse(rawMatches);
  if (!matchesResult.success) {
    throw new Error('CheapShark returned invalid game-lookup data.');
  }

  const matches = matchesResult.data.filter(
    (match) => match.steamAppID === game.steamAppId,
  );
  if (matches.length !== 1 || matches[0]!.external !== game.title) {
    throw new Error('CheapShark did not return one exact match for this Steam game.');
  }

  const providerGameId = matches[0]!.gameID;
  const rawDetails = await requestJson(
    `/api/1.0/games?id=${encodeURIComponent(providerGameId)}`,
  );
  const detailsResult = detailsSchema.safeParse(rawDetails);
  if (!detailsResult.success) {
    throw new Error('CheapShark returned invalid game-offer data.');
  }

  const details = detailsResult.data;
  if (
    details.info.steamAppID !== game.steamAppId ||
    details.info.title !== game.title
  ) {
    throw new Error('CheapShark returned details for a different game.');
  }

  const offers = details.deals.filter((deal) => deal.storeID === STEAM_STORE_ID);
  if (offers.length !== 1) {
    throw new Error('No unambiguous current Steam offer is available.');
  }

  const offer = offers[0]!;
  const retailPriceCents = offer.retailPrice === undefined
    ? null
    : usdToCents(offer.retailPrice);

  return {
    identity: {
      provider: 'cheapshark',
      providerGameId,
      storeId: '1',
      market: 'US',
      currency: 'USD',
    },
    steamAppId: game.steamAppId,
    canonicalSteamUrl: game.canonicalSteamUrl,
    title: game.title,
    storeName: 'Steam',
    source: {
      name: 'CheapShark',
      url: 'https://www.cheapshark.com/',
      attribution,
    },
    currentPrice: { amountMinor: usdToCents(offer.price), currency: 'USD' },
    retailPrice: retailPriceCents === null
      ? null
      : { amountMinor: retailPriceCents, currency: 'USD' },
    dealId: offer.dealID,
    purchaseUrl: purchaseUrl(offer.dealID),
    observedAt: new Date().toISOString(),
    providerChangedAt: null,
  };
}
