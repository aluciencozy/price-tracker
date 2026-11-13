import { lookupSteamOffer, parseSteamUrl, type SteamOffer, type SteamOfferLookupOptions } from './cheapshark.js';
import { ProductModel } from './models/product.js';

export type DiscoveryLookup = (url: string, options: SteamOfferLookupOptions) => Promise<SteamOffer>;

/** Persist only an exact, positively type-validated provider result. Unique indexes arbitrate races. */
export async function discoverSteamProduct(url: string, signal: AbortSignal, lookup: DiscoveryLookup = lookupSteamOffer) {
  signal.throwIfAborted();
  const offer = await lookup(url, { signal, timeoutMs: 8_000 });
  signal.throwIfAborted();
  const identity = offer.identity;
  const steam = { steamAppId: offer.steamAppId, provider: 'cheapshark' as const, storeId: '1' as const, market: 'US' as const, currency: 'USD' as const };
  const provider = { providerGameId: identity.providerGameId, provider: 'cheapshark' as const, storeId: '1' as const, market: 'US' as const, currency: 'USD' as const };
  if (offer.canonicalSteamUrl !== url || parseSteamUrl(url).steamAppId !== offer.steamAppId || identity.provider !== 'cheapshark' || identity.storeId !== '1' ||
      identity.market !== 'US' || identity.currency !== 'USD' || !/^[1-9]\d*$/.test(identity.providerGameId)) {
    throw new Error('Discovered Product identity is invalid.');
  }
  const observedAt = new Date(offer.observedAt);
  if (!Number.isFinite(observedAt.getTime())) throw new Error('Invalid discovery timestamp.');
  const dbOptions = { signal, timeoutMS: 1_000, maxTimeMS: 500 };
  try {
    await ProductModel.updateOne(steam, { $setOnInsert: {
      ...steam, providerGameId: identity.providerGameId, canonicalSteamUrl: url, title: offer.title,
      steamTypeValidatedAt: observedAt, dealId: offer.dealId, purchaseUrl: offer.purchaseUrl,
      currentPriceMinor: offer.currentPrice.amountMinor, retailPriceMinor: offer.retailPrice?.amountMinor ?? null,
      lastSuccessfulCheckAt: observedAt, providerChangedAt: offer.providerChangedAt,
      nextCheckAt: new Date(observedAt.getTime() + 86_400_000), lastAttemptAt: observedAt,
      lastError: null, consecutiveFailures: 0,
    } }, { upsert: true, runValidators: true, ...dbOptions }).exec();
  } catch (error) {
    if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 11000)) throw error;
  }
  signal.throwIfAborted();
  const [bySteam, byProvider] = await Promise.all([
    ProductModel.findOne(steam).setOptions(dbOptions).lean().exec(),
    ProductModel.findOne(provider).setOptions(dbOptions).lean().exec(),
  ]);
  signal.throwIfAborted();
  if (!bySteam || !byProvider || !bySteam._id.equals(byProvider._id) ||
      bySteam.providerGameId !== identity.providerGameId || byProvider.steamAppId !== offer.steamAppId ||
      bySteam.canonicalSteamUrl !== url) throw new Error('Conflicting Product identity.');
  return bySteam;
}
