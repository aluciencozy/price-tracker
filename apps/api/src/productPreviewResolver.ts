import mongoose from 'mongoose';
import { parseSteamUrl } from './cheapshark.js';
import { initialCatalog } from './databaseSetup.js';
import { ProductModel, type ProductRecord } from './models/product.js';
import { refreshSteamProductById } from './productCatalog.js';

export const PRODUCT_PREVIEW_REFRESH_TIMEOUT_MS = 10_000;

export type ProductPreviewProduct = ProductRecord & { _id: mongoose.Types.ObjectId };
export type ProductPreviewResolver = (approvedProductId: string, signal: AbortSignal) => Promise<ProductPreviewProduct>;

const objectIdPattern = /^[a-f0-9]{24}$/;

function assertApprovedProduct(value: unknown): asserts value is ProductPreviewProduct {
  if (!value || typeof value !== 'object' || !('_id' in value) ||
      !(value._id instanceof mongoose.Types.ObjectId)) {
    throw new Error('The approved product catalog is temporarily unavailable.');
  }
  const product = value as ProductPreviewProduct;
  const catalog = initialCatalog.find(entry =>
    entry.steamAppId === product.steamAppId && entry.providerGameId === product.providerGameId,
  );
  if (!catalog || product.provider !== 'cheapshark' || product.storeId !== '1' ||
      product.market !== 'US' || product.currency !== 'USD' || product.title !== catalog.title) {
    throw new Error('The Product is not in the approved Steam catalog.');
  }
  const game = parseSteamUrl(product.canonicalSteamUrl);
  if (game.steamAppId !== product.steamAppId || game.title !== product.title ||
      game.canonicalSteamUrl !== product.canonicalSteamUrl) {
    throw new Error('The Product Steam identity is invalid.');
  }
}

/**
 * Resolver for createProductPreviewService. It accepts only an approved Product
 * ID, honors the shared 24-hour cache, failure backoff and MongoDB provider budget,
 * and passes cancellation through to the bounded CheapShark request. It never
 * writes history or evaluates alert episodes.
 */
export const resolveApprovedProductPreview: ProductPreviewResolver = async (approvedProductId, signal) => {
  signal.throwIfAborted();
  if (!objectIdPattern.test(approvedProductId)) throw new Error('Invalid approved Product ID.');
  const controller = new AbortController();
  const combined = AbortSignal.any([signal, controller.signal]);
  const deadline = Date.now() + PRODUCT_PREVIEW_REFRESH_TIMEOUT_MS;
  // Reserve 1.5 seconds for bounded cooldown persistence and lease cleanup.
  const timer = setTimeout(() => controller.abort(new Error('Price preview timed out.')), PRODUCT_PREVIEW_REFRESH_TIMEOUT_MS - 1_500);
  timer.unref();
  try {
    const approved = await ProductModel.findById(approvedProductId)
      .setOptions({ signal: combined, timeoutMS: PRODUCT_PREVIEW_REFRESH_TIMEOUT_MS, maxTimeMS: 500 }).lean().exec();
    combined.throwIfAborted();
    assertApprovedProduct(approved);

    const refreshed = await refreshSteamProductById(approvedProductId, {
      signal: combined,
      timeoutMs: Math.max(1, deadline - Date.now()),
    });
    assertApprovedProduct(refreshed);
    if (!refreshed._id.equals(approved._id)) throw new Error('The Product identity changed during preview.');
    return refreshed;
  } finally { clearTimeout(timer); }
};
