import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type FakeResponse = {
  statusCode?: number;
  headers?: Record<string, string>;
  body: string;
  leaveOpen?: boolean;
  hangBeforeResponse?: boolean;
};

type FakeAddress = { address: string; family: 4 | 6 };

// Shared state for the mocked modules below. Tests enqueue provider responses
// instead of contacting CheapShark or MongoDB.
const mockState = vi.hoisted(() => ({
  responses: [] as FakeResponse[],
  addresses: [] as FakeAddress[],
  httpsRequest: vi.fn(),
  dnsLookup: vi.fn(),
  withBudget: vi.fn(),
}));

vi.mock('node:dns/promises', () => ({ lookup: mockState.dnsLookup }));

vi.mock('node:https', () => ({
  default: { request: mockState.httpsRequest },
  request: mockState.httpsRequest,
}));

vi.mock('../src/providerBudget.js', () => ({
  ProviderRateLimitError: class ProviderRateLimitError extends Error {
    constructor(
      readonly retryAt: Date | null,
      readonly retryAfterHeader: string | null = null,
      options?: ErrorOptions,
    ) {
      super('CheapShark rate limited the request.', options);
      this.name = 'ProviderRateLimitError';
    }
  },
  ProviderDeferredError: class ProviderDeferredError extends Error {
    constructor(readonly retryAt: Date) {
      super('The shared CheapShark request budget is temporarily unavailable.');
      this.name = 'ProviderDeferredError';
    }
  },
  withCheapSharkRequestBudget: mockState.withBudget,
}));

import { parseSteamAppId, lookupSteamOffer, usdToCents } from '../src/cheapshark.js';

/** Make the shape returned by CheapShark's steamAppID lookup endpoint. */
function gameMatch(
  steamAppID = '620',
  gameID = '36',
  external = 'Portal 2',
) {
  return { steamAppID, gameID, external };
}

/** Make a single current store deal; use storeID 1 for Steam. */
function storeDeal(
  overrides: Partial<{
    storeID: string;
    price: string;
    retailPrice: string;
    dealID: string;
  }> = {},
) {
  return {
    storeID: '1',
    price: '9.99',
    retailPrice: '19.99',
    dealID: 'steam-deal-abc',
    ...overrides,
  };
}

/** Make the shape returned by CheapShark's games?id= endpoint. */
function gameDetails(
  deals: unknown[] = [storeDeal()],
  steamAppID = '620',
  title = 'Portal 2',
) {
  return { info: { steamAppID, title }, deals };
}

function jsonResponse(body: unknown, statusCode = 200): FakeResponse {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

/** Queue the two ordered responses used by lookupSteamOffer. */
function queueSuccessfulLookup(
  matches: unknown = [gameMatch()],
  details: unknown = gameDetails(),
) {
  queueResponses(jsonResponse(matches), jsonResponse(details));
}

function queueResponses(...responses: FakeResponse[]) {
  mockState.responses.push(...responses);
}

function usePublicDns(addresses: FakeAddress[] = [{ address: '93.184.216.34', family: 4 }]) {
  mockState.addresses = addresses;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockState.responses = [];
  usePublicDns();

  mockState.dnsLookup.mockImplementation(async () => mockState.addresses);
  mockState.withBudget.mockImplementation(
    async (_deadline: number, request: () => Promise<unknown>) => request(),
  );

  mockState.httpsRequest.mockImplementation(
    (_url: URL, options: { lookup?: (...args: unknown[]) => void }, onResponse: (response: PassThrough) => void) => {
      const request = new EventEmitter() as EventEmitter & {
        end: () => void;
        destroy: (error?: Error) => void;
      };

      request.end = () => {
        const lookup = options.lookup;
        if (!lookup) {
          request.emit('error', new Error('Expected the adapter to install safe DNS lookup.'));
          return;
        }

        const callback = (error: Error | null) => {
          if (error) {
            request.emit('error', error);
            return;
          }

          const fixture = mockState.responses.shift();
          if (!fixture) {
            request.emit('error', new Error('No fake CheapShark response was queued.'));
            return;
          }
          if (fixture.hangBeforeResponse) return;

          const response = new PassThrough() as PassThrough & {
            statusCode?: number;
            headers: Record<string, string>;
          };
          response.statusCode = fixture.statusCode ?? 200;
          response.headers = fixture.headers ?? { 'content-type': 'application/json' };
          onResponse(response);
          if (!fixture.leaveOpen) response.end(fixture.body);
        };

        lookup('www.cheapshark.com', {}, callback as (...args: unknown[]) => void);
      };

      request.destroy = (error?: Error) => {
        if (error) request.emit('error', error);
      };

      return request;
    },
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe('CheapShark adapter helpers', () => {
  it('gets the Steam app ID from a confirmed URL', () => {
    expect(parseSteamAppId('https://store.steampowered.com/app/620/')).toBe('620');
  });

  it('rejects an unsupported game', () => {
    expect(() =>
      parseSteamAppId('https://store.steampowered.com/app/999999/'),
    ).toThrow();
  });

  it('converts a USD price to cents', () => {
    expect(usdToCents('9.99')).toBe(999);
    expect(usdToCents('0')).toBe(0);
    expect(usdToCents('12.5')).toBe(1250);
    expect(() => usdToCents('-1.00')).toThrow(/invalid USD price/i);
    expect(() => usdToCents('1.999')).toThrow(/invalid USD price/i);
    expect(() => usdToCents('90071992547409.92')).toThrow(/supported range/i);
  });

  it('can run a complete lookup using queued offline responses', async () => {
    queueSuccessfulLookup();

    const offer = await lookupSteamOffer('https://store.steampowered.com/app/620/');

    expect(offer.identity.providerGameId).toBe('36');
    expect(offer.currentPrice.amountMinor).toBe(999);
    expect(mockState.httpsRequest).toHaveBeenCalledTimes(2);
  });

  it('returns separate exact Steam, CheapShark game, store, and deal IDs', async () => {
    queueSuccessfulLookup(
      [gameMatch('620', '36')],
      gameDetails([storeDeal({ dealID: 'steam-deal-new' })]),
    );

    const offer = await lookupSteamOffer('https://store.steampowered.com/app/620/');

    expect(offer.steamAppId).toBe('620');
    expect(offer.identity.providerGameId).toBe('36');
    expect(offer.identity.storeId).toBe('1');
    expect(offer.dealId).toBe('steam-deal-new');
    expect(offer.identity).toMatchObject({ market: 'US', currency: 'USD' });
  });

  it('keeps stable offer identity when the changing deal ID changes', async () => {
    queueSuccessfulLookup(undefined, gameDetails([storeDeal({ dealID: 'deal-old' })]));
    const first = await lookupSteamOffer('https://store.steampowered.com/app/620/');

    queueSuccessfulLookup(undefined, gameDetails([storeDeal({ dealID: 'deal-new' })]));
    const second = await lookupSteamOffer('https://store.steampowered.com/app/620/');

    expect(second.identity).toEqual(first.identity);
    expect(second.dealId).not.toBe(first.dealId);
  });

  it('rejects a lookup result for a different Steam app ID', async () => {
    queueSuccessfulLookup([gameMatch('220', '59', 'Half-Life 2')]);

    await expect(
      lookupSteamOffer('https://store.steampowered.com/app/620/'),
    ).rejects.toThrow(/exact match/i);
    expect(mockState.httpsRequest).toHaveBeenCalledTimes(1);
  });

  it('rejects an ambiguous exact app ID mapping', async () => {
    queueSuccessfulLookup([
      gameMatch('620', '36'),
      gameMatch('620', '900'),
    ]);

    await expect(
      lookupSteamOffer('https://store.steampowered.com/app/620/'),
    ).rejects.toThrow(/exact match/i);
    expect(mockState.httpsRequest).toHaveBeenCalledTimes(1);
  });

  it('rejects details for a different game even after an exact app ID match', async () => {
    queueSuccessfulLookup(
      [gameMatch('620', '36', 'Portal 2')],
      gameDetails([storeDeal()], '220', 'Half-Life 2'),
    );

    await expect(
      lookupSteamOffer('https://store.steampowered.com/app/620/'),
    ).rejects.toThrow(/different game/i);
  });

  it('selects the Steam deal even when another store is cheaper', async () => {
    queueSuccessfulLookup(
      undefined,
      gameDetails([
        storeDeal({ storeID: '2', price: '0.99', dealID: 'cheap-non-steam' }),
        storeDeal({ storeID: '1', price: '9.99', dealID: 'steam-current' }),
      ]),
    );

    const offer = await lookupSteamOffer('https://store.steampowered.com/app/620/');

    expect(offer.currentPrice.amountMinor).toBe(999);
    expect(offer.dealId).toBe('steam-current');
    expect(offer.identity.storeId).toBe('1');
  });

  it('uses the current deal price rather than a historical low', async () => {
    const details = {
      ...gameDetails([storeDeal({ price: '9.99' })]),
      cheapestPriceEver: { price: '0.99', date: 1 },
    };
    queueSuccessfulLookup(undefined, details);

    const offer = await lookupSteamOffer('https://store.steampowered.com/app/620/');

    expect(offer.currentPrice.amountMinor).toBe(999);
  });

  it('rejects missing or ambiguous Steam offers', async () => {
    queueSuccessfulLookup(undefined, gameDetails([
      storeDeal({ storeID: '2', price: '1.00' }),
    ]));
    await expect(
      lookupSteamOffer('https://store.steampowered.com/app/620/'),
    ).rejects.toThrow(/Steam offer/i);

    queueSuccessfulLookup(undefined, gameDetails([
      storeDeal({ dealID: 'steam-a' }),
      storeDeal({ dealID: 'steam-b' }),
    ]));
    await expect(
      lookupSteamOffer('https://store.steampowered.com/app/620/'),
    ).rejects.toThrow(/Steam offer/i);
  });

  it('accepts a real current zero price and rejects missing or malformed prices', async () => {
    queueSuccessfulLookup(undefined, gameDetails([storeDeal({ price: '0' })]));
    const freeOffer = await lookupSteamOffer('https://store.steampowered.com/app/620/');
    expect(freeOffer.currentPrice.amountMinor).toBe(0);

    queueSuccessfulLookup(undefined, gameDetails([
      { storeID: '1', retailPrice: '19.99', dealID: 'missing-price' },
    ]));
    await expect(
      lookupSteamOffer('https://store.steampowered.com/app/620/'),
    ).rejects.toThrow(/invalid game-offer data/i);

    queueSuccessfulLookup(undefined, gameDetails([storeDeal({ price: '9.999' })]));
    await expect(
      lookupSteamOffer('https://store.steampowered.com/app/620/'),
    ).rejects.toThrow(/invalid USD price/i);
  });

  it('rejects an offer explicitly marked with a non-USD currency', async () => {
    queueSuccessfulLookup(undefined, gameDetails([
      { ...storeDeal(), currency: 'EUR' },
    ]));

    await expect(
      lookupSteamOffer('https://store.steampowered.com/app/620/'),
    ).rejects.toThrow(/invalid game-offer data/i);
  });

  it('rejects malformed response schemas and invalid JSON', async () => {
    queueResponses(jsonResponse([{ gameID: '36', steamAppID: '620' }]));
    await expect(
      lookupSteamOffer('https://store.steampowered.com/app/620/'),
    ).rejects.toThrow(/invalid game-lookup data/i);

    queueResponses({
      body: '{not-json',
      headers: { 'content-type': 'application/json' },
    });
    await expect(
      lookupSteamOffer('https://store.steampowered.com/app/620/'),
    ).rejects.toThrow(/invalid JSON/i);
  });

  it('rejects unsupported Steam URL forms without making a request', async () => {
    const urls = [
      'http://store.steampowered.com/app/620/',
      'https://evil.example/app/620/',
      'https://user@store.steampowered.com/app/620/',
      'https://store.steampowered.com:8443/app/620/',
      'https://store.steampowered.com/app/620/?campaign=x',
      'https://store.steampowered.com/bundle/123/',
      'https://store.steampowered.com/sub/123/',
      'https://store.steampowered.com/app/999999/',
    ];

    for (const url of urls) {
      await expect(lookupSteamOffer(url)).rejects.toThrow();
    }

    expect(mockState.httpsRequest).not.toHaveBeenCalled();
  });

  it('rejects private, loopback, link-local, and mixed public/private DNS answers', async () => {
    const unsafeAddressSets: FakeAddress[][] = [
      [{ address: '10.1.2.3', family: 4 }],
      [{ address: '127.0.0.1', family: 4 }],
      [{ address: '169.254.10.20', family: 4 }],
      [{ address: '::1', family: 6 }],
      [{ address: 'fe80::1', family: 6 }],
      [
        { address: '93.184.216.34', family: 4 },
        { address: '192.168.1.10', family: 4 },
      ],
    ];

    for (const addresses of unsafeAddressSets) {
      usePublicDns(addresses);
      queueSuccessfulLookup();
      await expect(
        lookupSteamOffer('https://store.steampowered.com/app/620/'),
      ).rejects.toThrow(/could not be reached/i);
      expect(mockState.httpsRequest).toHaveBeenCalledTimes(1);
      mockState.httpsRequest.mockClear();
    }
  });

  it('does not follow an HTTP redirect', async () => {
    queueResponses({
      statusCode: 302,
      headers: {
        'content-type': 'application/json',
        location: 'http://127.0.0.1/private',
      },
      body: '{}',
    });

    await expect(
      lookupSteamOffer('https://store.steampowered.com/app/620/'),
    ).rejects.toThrow(/unsuccessful response/i);
    expect(mockState.httpsRequest).toHaveBeenCalledTimes(1);
  });

  it('keeps Retry-After on a 429 response for the shared budget', async () => {
    queueResponses({
      statusCode: 429,
      headers: { 'retry-after': '120', 'content-type': 'application/json' },
      body: '{}',
    });

    await expect(
      lookupSteamOffer('https://store.steampowered.com/app/620/'),
    ).rejects.toMatchObject({ retryAfterHeader: '120' });
  });

  it('rejects oversized response bodies and content-length claims', async () => {
    queueResponses(jsonResponse({ padding: 'x'.repeat(1_000_001) }));
    await expect(
      lookupSteamOffer('https://store.steampowered.com/app/620/'),
    ).rejects.toThrow(/size limit/i);

    queueResponses({
      statusCode: 200,
      headers: {
        'content-type': 'application/json',
        'content-length': '1000001',
      },
      body: '{}',
    });
    await expect(
      lookupSteamOffer('https://store.steampowered.com/app/620/'),
    ).rejects.toThrow(/size limit/i);
  });

  it('times out a request that never receives a response', async () => {
    vi.useFakeTimers();
    queueResponses({ body: '', hangBeforeResponse: true });

    const lookup = lookupSteamOffer('https://store.steampowered.com/app/620/');
    const rejected = expect(lookup).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(10_000);

    await rejected;
  });

  it('builds only the fixed CheapShark endpoints and encodes the purchase link', async () => {
    queueSuccessfulLookup(
      undefined,
      gameDetails([storeDeal({ dealID: 'deal%2Fwith%20space' })]),
    );

    const offer = await lookupSteamOffer('https://store.steampowered.com/app/620/');
    const requestedUrls = mockState.httpsRequest.mock.calls.map(([url]) => String(url));
    const purchase = new URL(offer.purchaseUrl);

    expect(requestedUrls).toEqual([
      'https://www.cheapshark.com/api/1.0/games?steamAppID=620',
      'https://www.cheapshark.com/api/1.0/games?id=36',
    ]);
    expect(purchase.origin).toBe('https://www.cheapshark.com');
    expect(purchase.pathname).toBe('/redirect');
    expect(purchase.searchParams.get('dealID')).toBe('deal/with space');
  });
});
