import type { Product } from './data/types';

// Human navigation only. Never fetch or prefetch the purchase redirect.
export function steamPurchaseUrl(product: Product): string | null {
  if (
    product.currentPrice === null ||
    !Number.isSafeInteger(product.currentPrice.amountMinor) ||
    product.currentPrice.amountMinor < 0 ||
    product.currentPrice.currency !== 'USD' ||
    product.identity.provider !== 'cheapshark' ||
    product.identity.storeId !== '1' ||
    product.identity.market !== 'US' ||
    product.identity.currency !== 'USD' ||
    product.storeName !== 'Steam' ||
    !/^[1-9]\d*$/.test(product.steamAppId) ||
    product.canonicalSteamUrl !==
      `https://store.steampowered.com/app/${product.steamAppId}/` ||
    !product.dealId
  )
    return null;
  try {
    // Preserve the raw/percent-encoded CheapShark regression: encode exactly once.
    const id = decodeURIComponent(product.dealId).trim();
    if (!id) return null;
    const url = new URL('https://www.cheapshark.com/redirect');
    url.searchParams.set('dealID', id);
    return url.toString();
  } catch {
    return null;
  }
}
