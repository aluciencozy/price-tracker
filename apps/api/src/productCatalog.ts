import { ProductModel } from './models/product.js';
import {
  lookupSteamOffer,
  parseSteamAppIdFromUrl,
} from './cheapshark.js';

/** Look up a previously verified/approved Steam game without contacting Steam or CheapShark. */
export async function findApprovedSteamProduct(inputUrl: string) {
  const steamAppId = parseSteamAppIdFromUrl(inputUrl);

  return ProductModel.findOne({
    steamAppId,
    provider: 'cheapshark',
    storeId: '1',
    market: 'US',
    currency: 'USD',
  })
    .select({
      providerGameId: 1,
      steamAppId: 1,
      storeId: 1,
      market: 1,
      currency: 1,
      canonicalSteamUrl: 1,
      title: 1,
      dealId: 1,
      purchaseUrl: 1,
      currentPriceMinor: 1,
      lastSuccessfulCheckAt: 1,
    })
    .lean()
    .exec();
}

/**
 * Refresh a catalog product from CheapShark. Only a validated successful
 * offer updates price/deal fields; a failed lookup records an error while
 * leaving the last successful observation intact.
 */
export async function refreshApprovedSteamProduct(inputUrl: string) {
  const product = await findApprovedSteamProduct(inputUrl);
  if (!product) {
    throw new Error('This Steam game is not in the approved catalog.');
  }

  try {
    const offer = await lookupSteamOffer(product.canonicalSteamUrl);

    if (
      offer.steamAppId !== product.steamAppId ||
      offer.identity.providerGameId !== product.providerGameId ||
      offer.identity.storeId !== product.storeId
    ) {
      throw new Error('CheapShark returned a different approved offer.');
    }

    const updated = await ProductModel.findOneAndUpdate(
      {
        _id: product._id,
        provider: 'cheapshark',
        providerGameId: product.providerGameId,
        storeId: product.storeId,
        market: product.market,
        currency: product.currency,
      },
      {
        $set: {
          title: offer.title,
          canonicalSteamUrl: offer.canonicalSteamUrl,
          dealId: offer.dealId,
          purchaseUrl: offer.purchaseUrl,
          currentPriceMinor: offer.currentPrice.amountMinor,
          retailPriceMinor: offer.retailPrice?.amountMinor ?? null,
          lastSuccessfulCheckAt: new Date(offer.observedAt),
          providerChangedAt: offer.providerChangedAt,
          lastError: null,
        },
      },
      { new: true, runValidators: true },
    )
      .lean()
      .exec();

    if (!updated) {
      throw new Error('The approved product changed during its price check.');
    }

    return updated;
  } catch (error) {
    // Do not overwrite price, purchase link, or last-success time on failure.
    await ProductModel.updateOne(
      { _id: product._id },
      { $set: { lastError: 'Price check failed; previous successful price retained.' } },
    ).exec();
    throw error;
  }
}
