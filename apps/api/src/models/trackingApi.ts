import mongoose, { Schema } from 'mongoose';

const ref = (name: string) => ({ type: Schema.Types.ObjectId, ref: name, required: true });
const options = { timestamps: false, strict: 'throw' as const };

/** User-bound preview capability. Keep expired rows briefly so owned expiry is distinguishable from a foreign ID. */
const productPreviewSchema = new Schema({
  userId: ref('User'),
  productId: ref('Product'),
  product: { type: Schema.Types.Mixed, required: true },
  expiresAt: { type: Date, required: true },
  purgeAt: { type: Date, required: true },
}, options);
productPreviewSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });
productPreviewSchema.index({ userId: 1, expiresAt: 1 });

/** Successful create responses are persisted with the tracker in one transaction for 24-hour replay. */
const idempotencyRecordSchema = new Schema({
  userId: ref('User'),
  key: { type: String, required: true, match: /^[0-9a-f-]{36}$/ },
  requestHash: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
  response: { type: Schema.Types.Mixed, required: true },
  location: { type: String, required: true, maxlength: 200 },
  expiresAt: { type: Date, required: true },
}, options);
idempotencyRecordSchema.index({ userId: 1, key: 1 }, { unique: true });
idempotencyRecordSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const ProductPreviewModel = mongoose.model('ProductPreview', productPreviewSchema);
export const TrackingIdempotencyModel = mongoose.model('TrackingIdempotency', idempotencyRecordSchema);
