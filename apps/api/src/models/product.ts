import mongoose, { Schema } from 'mongoose';

export type ProductRecord = {
  provider: 'cheapshark';
  providerGameId: string;
  steamAppId: string;
  storeId: '1';
  market: 'US';
  currency: 'USD';
  canonicalSteamUrl: string;
  title: string;
  steamTypeValidatedAt?: Date | null;
  steamTypeRejected?: boolean;
  dealId: string | null;
  purchaseUrl: string | null;
  currentPriceMinor: number | null;
  retailPriceMinor: number | null;
  lastSuccessfulCheckAt: Date | null;
  providerChangedAt: Date | null;
  nextCheckAt: Date | null;
  lastAttemptAt: Date | null;
  lastError: string | null;
  consecutiveFailures: number;
  refreshLeaseUntil: Date | null;
  refreshLeaseToken: string | null;
};

/** Shared game/store offer record. User targets belong in a separate tracker model. */
const productSchema = new Schema<ProductRecord>(
  {
    provider: { type: String, enum: ['cheapshark'], required: true },
    providerGameId: { type: String, required: true, match: /^[1-9]\d*$/ },
    steamAppId: { type: String, required: true, match: /^[1-9]\d*$/ },
    storeId: { type: String, enum: ['1'], required: true },
    market: { type: String, enum: ['US'], required: true },
    currency: { type: String, enum: ['USD'], required: true },
    canonicalSteamUrl: { type: String, required: true },
    title: { type: String, required: true, trim: true, maxlength: 300 },
    steamTypeValidatedAt: { type: Date, default: null },
    steamTypeRejected: { type: Boolean, default: false },
    dealId: { type: String, default: null },
    purchaseUrl: { type: String, default: null },
    currentPriceMinor: { type: Number, default: null, min: 0, validate: (value: number | null) => value === null || Number.isSafeInteger(value) },
    retailPriceMinor: { type: Number, default: null, min: 0, validate: (value: number | null) => value === null || Number.isSafeInteger(value) },
    lastSuccessfulCheckAt: { type: Date, default: null },
    providerChangedAt: { type: Date, default: null },
    nextCheckAt: { type: Date, default: null },
    lastAttemptAt: { type: Date, default: null },
    lastError: { type: String, default: null, maxlength: 500 },
    consecutiveFailures: { type: Number, default: 0, min: 0 },
    refreshLeaseUntil: { type: Date, default: null },
    refreshLeaseToken: { type: String, default: null },
  },
  { timestamps: true, versionKey: false, bufferCommands: false },
);

// Stable provider/store identity: a changing deal ID must not create a new product.
productSchema.index(
  { provider: 1, providerGameId: 1, storeId: 1, market: 1, currency: 1 },
  { unique: true },
);

// One approved Steam app maps to one shared CheapShark Steam product in this MVP.
productSchema.index({ steamAppId: 1, provider: 1, storeId: 1, market: 1, currency: 1 }, { unique: true });

const existingProductModel = mongoose.models.Product as
  | mongoose.Model<ProductRecord>
  | undefined;

export const ProductModel =
  existingProductModel ?? mongoose.model<ProductRecord>('Product', productSchema);
