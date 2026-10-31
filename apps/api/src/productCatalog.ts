import { ProductModel } from './models/product.js';
import { parseSteamAppIdFromUrl } from './cheapshark.js';

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
