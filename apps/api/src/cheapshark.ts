import { lookup as dnsLookup } from 'node:dns/promises';
import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import https from 'node:https';
import { z } from 'zod';
import {
  ProviderRateLimitError,
  withCheapSharkRequestBudget,
} from './providerBudget.js';

const API_ORIGIN = 'https://www.cheapshark.com';
const USER_AGENT =
  'PriceTracker-COP4331C/0.1 (nickwesterfeld@gmail.com; +https://github.com/aluciencozy/price-tracker)';
const STEAM_STORE_ID = '1';
const MAX_RESPONSE_BYTES = 1_000_000;
const REQUEST_TIMEOUT_MS = 10_000;
const LOOKUP_TIMEOUT_MS = 30_000;

const BLOCKED_IPV4_CIDRS: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

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
      currency: z.literal('USD').optional(),
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

/** Parse a Steam /app/ URL locally. This function never requests Steam. */
function parseSteamUrlLocally(input: string) {
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
  if (!steamAppId) {
    throw new Error('Use an individual Steam /app/<id>/ game URL.');
  }

  return {
    steamAppId,
    canonicalSteamUrl: `https://store.steampowered.com/app/${steamAppId}/`,
  };
}

/** Extract a syntactically valid app ID for an approved-catalog database lookup. */
export function parseSteamAppIdFromUrl(input: string): string {
  return parseSteamUrlLocally(input).steamAppId;
}

/** Parse a URL and require that the app ID is in the initial confirmed catalog. */
export function parseSteamUrl(input: string) {
  const parsed = parseSteamUrlLocally(input);
  const title = CONFIRMED_GAMES.get(parsed.steamAppId);

  if (!title) {
    throw new Error('This Steam game is not in the confirmed supported-game list.');
  }

  return {
    steamAppId: parsed.steamAppId,
    title,
    canonicalSteamUrl: parsed.canonicalSteamUrl,
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

function ipv4Number(address: string): number | null {
  if (isIP(address) !== 4) return null;
  const octets = address.split('.').map(Number);
  return octets.reduce((value, octet) => value * 256 + octet, 0);
}

function inIpv4Cidr(address: number, network: string, prefix: number): boolean {
  const networkNumber = ipv4Number(network);
  if (networkNumber === null) return true;
  const mask = prefix === 0 ? 0 : (0xffff_ffff << (32 - prefix)) >>> 0;
  return ((address & mask) >>> 0) === ((networkNumber & mask) >>> 0);
}

function ipv6Groups(address: string): number[] | null {
  if (isIP(address) !== 6 || address.includes('%')) return null;

  let normalized = address.toLowerCase();
  if (normalized.includes('.')) {
    const lastColon = normalized.lastIndexOf(':');
    const embeddedIpv4 = ipv4Number(normalized.slice(lastColon + 1));
    if (embeddedIpv4 === null) return null;
    const high = Math.floor(embeddedIpv4 / 0x1_0000).toString(16);
    const low = (embeddedIpv4 % 0x1_0000).toString(16);
    normalized = `${normalized.slice(0, lastColon + 1)}${high}:${low}`;
  }

  const halves = normalized.split('::');
  if (halves.length > 2) return null;

  const parseHalf = (half: string): number[] | null => {
    if (!half) return [];
    const groups = half.split(':');
    if (groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
    return groups.map((group) => Number.parseInt(group, 16));
  };

  const left = parseHalf(halves[0]!);
  const right = parseHalf(halves[1] ?? '');
  if (!left || !right) return null;

  if (halves.length === 1) {
    return left.length === 8 ? left : null;
  }

  const zeroGroups = 8 - left.length - right.length;
  if (zeroGroups < 1) return null;
  return [...left, ...Array.from({ length: zeroGroups }, () => 0), ...right];
}

function isPublicAddress(address: string): boolean {
  const family = isIP(address);

  if (family === 4) {
    const numericAddress = ipv4Number(address);
    return numericAddress !== null && !BLOCKED_IPV4_CIDRS.some(
      ([network, prefix]) => inIpv4Cidr(numericAddress, network, prefix),
    );
  }

  if (family !== 6) return false;
  const groups = ipv6Groups(address);
  if (!groups) return false;

  // Permit only global-unicast IPv6, excluding documentation and transition
  // ranges that can carry or represent non-public IPv4 destinations.
  const globalUnicast = groups[0]! >= 0x2000 && groups[0]! <= 0x3fff;
  const documentation =
    (groups[0] === 0x2001 && groups[1] === 0x0db8) ||
    (groups[0] === 0x3fff && (groups[1]! & 0xf000) === 0);
  const transitionOrSpecial =
    (groups[0] === 0x2001 && groups[1]! <= 0x01ff) ||
    groups[0] === 0x2002 ||
    (groups[0] === 0x2001 && groups[1]! >= 0x0010 && groups[1]! <= 0x002f) ||
    (groups[0] === 0x2001 && groups[1] === 0x0002 && groups[2] === 0);

  return globalUnicast && !documentation && !transitionOrSpecial;
}

const safeCheapSharkLookup: NonNullable<https.RequestOptions['lookup']> = (
  hostname,
  options,
  callback,
) => {
  if (hostname.toLowerCase() !== 'www.cheapshark.com') {
    const error = Object.assign(new Error('Blocked outbound hostname.'), { code: 'EACCES' });
    callback(error, '', 0);
    return;
  }

  void dnsLookup(hostname, { all: true, verbatim: true }).then(
    (addresses) => {
      if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
        const error = Object.assign(new Error('Blocked non-public DNS destination.'), { code: 'EACCES' });
        callback(error, '', 0);
        return;
      }

      const requestedFamily = typeof options === 'number' ? options : options.family;
      const candidates = requestedFamily
        ? addresses.filter(({ family }) => family === requestedFamily)
        : addresses;
      if (!candidates.length) {
        const error = Object.assign(new Error('No safe DNS address for the requested family.'), { code: 'EAI_ADDRFAMILY' });
        callback(error, '', 0);
        return;
      }

      if (typeof options === 'object' && options.all) {
        callback(null, candidates);
      } else {
        const selected = candidates[0]!;
        callback(null, selected.address, selected.family);
      }
    },
    () => {
      const error = Object.assign(new Error('CheapShark DNS lookup failed.'), { code: 'EAI_AGAIN' });
      callback(error, '', 0);
    },
  );
};

async function readJsonResponse(response: IncomingMessage): Promise<unknown> {
  if (response.statusCode === 429) {
    const retryAfter = response.headers['retry-after'];
    response.destroy();
    throw new ProviderRateLimitError(
      null,
      Array.isArray(retryAfter) ? retryAfter[0] ?? null : retryAfter ?? null,
    );
  }

  if (response.statusCode === undefined || response.statusCode < 200 || response.statusCode >= 300) {
    response.destroy();
    throw new Error('CheapShark returned an unsuccessful response.');
  }

  if (!/application\/json/i.test(response.headers['content-type'] ?? '')) {
    response.destroy();
    throw new Error('CheapShark returned an unexpected content type.');
  }

  const contentLength = Number(response.headers['content-length']);
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    response.destroy();
    throw new Error('CheapShark response exceeded the size limit.');
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      response.destroy();
      throw new Error('CheapShark response exceeded the size limit.');
    }
    chunks.push(buffer);
  }

  try {
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8')) as unknown;
  } catch {
    throw new Error('CheapShark returned invalid JSON.');
  }
}

async function requestJson(path: string, deadline: number): Promise<unknown> {
  // Callers construct paths only from validated numeric provider IDs.
  const url = new URL(path, API_ORIGIN);
  if (url.origin !== API_ORIGIN || !url.pathname.startsWith('/api/1.0/games')) {
    throw new Error('Invalid CheapShark endpoint.');
  }

  return withCheapSharkRequestBudget(deadline, async () => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('CheapShark lookup deadline expired.');

    return new Promise<unknown>((resolve, reject) => {
      const timeoutMs = Math.min(REQUEST_TIMEOUT_MS, remaining);
      let responseReceived = false;
      const request = https.request(
        url,
        {
          method: 'GET',
          headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
          agent: false,
          servername: url.hostname,
          lookup: safeCheapSharkLookup,
        },
        (response) => {
          responseReceived = true;
          void readJsonResponse(response).then(resolve, reject).finally(() => clearTimeout(timer));
        },
      );

      const timer = setTimeout(() => {
        request.destroy(new Error('CheapShark request timed out.'));
      }, timeoutMs);
      timer.unref();

      request.once('error', () => {
        clearTimeout(timer);
        if (!responseReceived) {
          reject(new Error('CheapShark could not be reached, DNS validation failed, or the request timed out.'));
        }
      });

      request.end();
    });
  });
}

/** Build a human purchase link only; never fetch this redirect automatically. */
export function cheapSharkPurchaseUrl(dealId: string): string {
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
  const deadline = Date.now() + LOOKUP_TIMEOUT_MS;

  const rawMatches = await requestJson(
    `/api/1.0/games?steamAppID=${encodeURIComponent(game.steamAppId)}`,
    deadline,
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
    deadline,
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
    purchaseUrl: cheapSharkPurchaseUrl(offer.dealID),
    observedAt: new Date().toISOString(),
    providerChangedAt: null,
  };
}
