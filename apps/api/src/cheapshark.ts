import { Resolver } from 'node:dns/promises';
import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import https from 'node:https';
import { z } from 'zod';
import {
  ProviderRateLimitError,
  withCheapSharkRequestBudget,
  withProviderRequestBudget,
} from './providerBudget.js';

const API_ORIGIN = 'https://www.cheapshark.com';
const USER_AGENT =
  'PriceTracker-COP4331C/0.1 (nickwesterfeld@gmail.com; +https://github.com/aluciencozy/price-tracker)';
const STEAM_STORE_ID = '1';
const MAX_RESPONSE_BYTES = 1_000_000;
const REQUEST_TIMEOUT_MS = 10_000;
const LOOKUP_TIMEOUT_MS = 30_000;

function abortError(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : Object.assign(new Error('CheapShark lookup was cancelled.'), { name: 'AbortError' });
}

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
  'Prices supplied by CheapShark; exact Steam app US/USD offer, excluding taxes and checkout adjustments.';

export class SteamGameUnsupportedError extends Error {
  constructor() {
    super('Steam game type is unsupported or unclassifiable.');
    this.name = 'SteamGameUnsupportedError';
  }
}

function validSteamAppId(id: string): boolean {
  return /^[1-9]\d{0,31}$/.test(id) && BigInt(id) <= BigInt(Number.MAX_SAFE_INTEGER);
}

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
  if (!steamAppId || !validSteamAppId(steamAppId)) {
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

/** Syntax only: eligibility must be established by the provider lookup. */
export function parseSteamUrl(input: string): ReturnType<typeof parseSteamUrlLocally> & { title?: string } {
  return parseSteamUrlLocally(input);
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

function safeCheapSharkLookup(signal: AbortSignal, allowedHost: 'www.cheapshark.com' | 'store.steampowered.com'): NonNullable<https.RequestOptions['lookup']> {
  return (hostname, options, callback) => {
    if (hostname.toLowerCase() !== allowedHost) {
      const error = Object.assign(new Error('Blocked outbound hostname.'), { code: 'EACCES' });
      callback(error, '', 0);
      return;
    }
    if (signal.aborted) {
      callback(abortError(signal), '', 0);
      return;
    }

    // Resolver.cancel() actively cancels the A/AAAA queries if a request or
    // its total deadline is aborted; late DNS results can never open a socket.
    const resolver = new Resolver();
    const cancel = () => resolver.cancel();
    signal.addEventListener('abort', cancel, { once: true });
    const noAddressRecord = (error: unknown) => typeof error === 'object' && error !== null &&
      'code' in error && (error.code === 'ENODATA' || error.code === 'ENOTFOUND');
    void Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]).then(results => {
      if (signal.aborted) throw abortError(signal);
      const addresses: Array<{ address: string; family: 4 | 6 }> = [];
      for (const [index, result] of results.entries()) {
        const family = index === 0 ? 4 : 6;
        if (result.status === 'fulfilled') {
          addresses.push(...result.value.map(address => ({ address, family: family as 4 | 6 })));
        } else if (!noAddressRecord(result.reason)) {
          throw result.reason;
        }
      }
      if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
        throw Object.assign(new Error('Blocked or unavailable CheapShark DNS destination.'), { code: 'EACCES' });
      }

      const requestedFamily = typeof options === 'number' ? options : options.family;
      const candidates = requestedFamily
        ? addresses.filter(({ family }) => family === requestedFamily)
        : addresses;
      if (!candidates.length) {
        throw Object.assign(new Error('No safe DNS address for the requested family.'), { code: 'EAI_ADDRFAMILY' });
      }

      if (typeof options === 'object' && options.all) callback(null, candidates);
      else {
        const selected = candidates[0]!;
        callback(null, selected.address, selected.family);
      }
    }).catch(error => {
      callback(signal.aborted ? abortError(signal) : Object.assign(
        new Error('CheapShark DNS lookup failed or resolved to an unsafe address.'),
        { code: typeof error === 'object' && error !== null && 'code' in error ? error.code : 'EAI_AGAIN' },
      ), '', 0);
    }).finally(() => signal.removeEventListener('abort', cancel));
  };
}

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

async function requestJson(path: string, deadline: number, signal?: AbortSignal, provider: 'cheapshark' | 'steam' = 'cheapshark'): Promise<unknown> {
  signal?.throwIfAborted();
  const requestController = new AbortController();
  const requestSignal = signal ? AbortSignal.any([signal, requestController.signal]) : requestController.signal;
  // Callers construct paths only from validated numeric provider IDs.
  const origin = provider === 'steam' ? 'https://store.steampowered.com' : API_ORIGIN;
  const url = new URL(path, origin);
  if (url.origin !== origin || url.pathname !== (provider === 'steam' ? '/api/appdetails' : '/api/1.0/games')) {
    throw new Error('Invalid provider endpoint.');
  }

  const budget = provider === 'steam'
    ? <T>(work: () => Promise<T>) => withProviderRequestBudget('steam', deadline, work, requestSignal)
    : <T>(work: () => Promise<T>) => withCheapSharkRequestBudget(deadline, work, requestSignal);
  return budget(async () => {
    requestSignal.throwIfAborted();
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('CheapShark lookup deadline expired.');

    return new Promise<unknown>((resolve, reject) => {
      const timeoutMs = Math.min(REQUEST_TIMEOUT_MS, remaining);
      let responseReceived = false;
      let activeResponse: IncomingMessage | null = null;
      let settled = false;
      const clear = () => {
        clearTimeout(timer);
        requestSignal.removeEventListener('abort', onAbort);
      };
      const finish = (error?: unknown, value?: unknown) => {
        if (settled) return;
        settled = true;
        clear();
        if (error !== undefined) reject(error);
        else resolve(value);
      };
      const request = https.request(
        url,
        {
          method: 'GET',
          headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
          agent: false,
          servername: url.hostname,
          lookup: safeCheapSharkLookup(requestSignal, provider === 'steam' ? 'store.steampowered.com' : 'www.cheapshark.com'),
        },
        (response) => {
          responseReceived = true;
          activeResponse = response;
          void readJsonResponse(response).then(value => finish(undefined, value), error => finish(error));
        },
      );

      const onAbort = () => {
        const error = abortError(requestSignal);
        finish(error);
        request.destroy(error);
        activeResponse?.destroy(error);
      };
      const timer = setTimeout(() => {
        requestController.abort(new Error('CheapShark request timed out.'));
      }, timeoutMs);
      timer.unref();

      request.on('error', error => {
        if (!responseReceived) {
          finish(requestSignal.aborted
            ? abortError(requestSignal)
            : new Error(error.message.includes('timed out')
              ? 'CheapShark request timed out.'
              : 'CheapShark could not be reached or DNS validation failed.'));
        }
      });

      if (requestSignal.aborted) onAbort();
      else requestSignal.addEventListener('abort', onAbort, { once: true });
      if (!settled) request.end();
    });
  });
}

/** Positive storefront type classification only; Steam does not guarantee edition classification. */
export async function validateSteamGameType(steamAppId: string, deadline: number, signal?: AbortSignal): Promise<void> {
  if (!validSteamAppId(steamAppId)) throw new Error('Invalid Steam app ID.');
  const raw = await requestJson(`/api/appdetails?appids=${steamAppId}&cc=us&l=english`, deadline, signal, 'steam');
  const envelope = z.record(z.string(), z.unknown()).safeParse(raw);
  if (!envelope.success) throw new Error('Steam returned invalid metadata.');
  const entry = z.object({ success: z.boolean(), data: z.unknown().optional() }).safeParse(envelope.data[steamAppId]);
  if (!entry.success) throw new Error('Steam returned invalid metadata.');
  if (!entry.data.success) throw new SteamGameUnsupportedError();
  const data = z.object({ steam_appid: z.number().int().safe(), type: z.string() }).safeParse(entry.data.data);
  if (!data.success || String(data.data.steam_appid) !== steamAppId) throw new Error('Steam returned invalid metadata.');
  if (data.data.type !== 'game') throw new SteamGameUnsupportedError();
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
export type SteamOfferLookupOptions = { signal?: AbortSignal; timeoutMs?: number };

export async function lookupSteamOffer(input: string, options: SteamOfferLookupOptions = {}): Promise<SteamOffer> {
  options.signal?.throwIfAborted();
  const game = parseSteamUrl(input);
  const requestedTimeout = options.timeoutMs ?? LOOKUP_TIMEOUT_MS;
  if (!Number.isFinite(requestedTimeout) || requestedTimeout < 1) {
    throw new Error('CheapShark lookup timeout is invalid.');
  }
  const durationMs = Math.min(Math.floor(requestedTimeout), LOOKUP_TIMEOUT_MS);
  const deadline = Date.now() + durationMs;
  const deadlineController = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, deadlineController.signal])
    : deadlineController.signal;
  const deadlineTimer = setTimeout(
    () => deadlineController.abort(new Error('CheapShark lookup timed out.')),
    durationMs,
  );
  deadlineTimer.unref();

  try {
    return await lookupSteamOfferWithinDeadline(game, deadline, signal);
  } finally {
    clearTimeout(deadlineTimer);
  }
}

async function lookupSteamOfferWithinDeadline(game: ReturnType<typeof parseSteamUrl>, deadline: number, signal: AbortSignal): Promise<SteamOffer> {
  signal.throwIfAborted();
  await validateSteamGameType(game.steamAppId, deadline, signal);
  const rawMatches = await requestJson(
    `/api/1.0/games?steamAppID=${encodeURIComponent(game.steamAppId)}`,
    deadline,
    signal,
  );
  const matchesResult = z.array(lookupMatchSchema).safeParse(rawMatches);
  if (!matchesResult.success) {
    throw new Error('CheapShark returned invalid game-lookup data.');
  }

  const matches = matchesResult.data.filter(
    (match) => match.steamAppID === game.steamAppId,
  );
  const gameIds = [...new Set(matches.map(match => match.gameID))];
  if (gameIds.length !== 1) {
    throw new Error('CheapShark did not return one exact match for this Steam game.');
  }

  const providerGameId = gameIds[0]!;
  const rawDetails = await requestJson(
    `/api/1.0/games?id=${encodeURIComponent(providerGameId)}`,
    deadline,
    signal,
  );
  const detailsResult = detailsSchema.safeParse(rawDetails);
  if (!detailsResult.success) {
    throw new Error('CheapShark returned invalid game-offer data.');
  }

  const details = detailsResult.data;
  if (
    details.info.steamAppID !== game.steamAppId
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
    title: details.info.title,
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
