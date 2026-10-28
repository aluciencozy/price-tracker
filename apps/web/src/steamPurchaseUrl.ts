import type { SteamGame } from './types/SteamGame';

// Build a human navigation link only. Never fetch the purchase redirect.
export function steamPurchaseUrl(game: SteamGame): string | null {
  const offer = game.steamOffer;
  if (
    game.currentPrice === null ||
    !offer ||
    offer.storeId !== '1' ||
    offer.steamAppId !== game.appId ||
    offer.currency !== 'USD' ||
    game.currency !== 'USD'
  )
    return null;

  try {
    // CheapShark can return percent-encoded IDs. Decode once before URLSearchParams encodes them.
    const dealId = decodeURIComponent(offer.dealId).trim();
    if (!dealId) return null;
    const url = new URL('https://www.cheapshark.com/redirect');
    url.searchParams.set('dealID', dealId);
    return url.toString();
  } catch {
    return null;
  }
}
