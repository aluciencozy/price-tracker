import mongoose, { Schema } from 'mongoose';

export const HISTORY_RETENTION_DAYS = 90;
export const cents = {
  type: Number,
  required: true,
  min: 0,
  validate: { validator: Number.isSafeInteger, message: 'Expected nonnegative safe integer USD cents.' },
};
const ref = (name: string) => ({ type: Schema.Types.ObjectId, ref: name, required: true });
const options = { timestamps: true, strict: 'throw' as const };

const trackedItemSchema = new Schema({
  userId: ref('User'),
  productId: ref('Product'),
  targetPriceMinor: cents,
  currency: { type: String, enum: ['USD'], default: 'USD', required: true },
  enabled: { type: Boolean, default: true, required: true },
  alerts: {
    email: { type: Boolean, default: true, required: true },
    push: { type: Boolean, default: false, required: true },
  },
  targetRevision: { type: Number, required: true, default: 0, min: 0, validate: Number.isSafeInteger },
  episodeSequence: { type: Number, required: true, default: 0, min: 0, validate: Number.isSafeInteger },
  episodeId: { type: String, default: null, maxlength: 128 },
  episodeOpen: { type: Boolean, required: true, default: false },
  lastEvaluatedAt: { type: Date, default: null },
  lastObservationId: { type: Schema.Types.ObjectId, ref: 'PriceHistory', default: null },
}, options);
trackedItemSchema.index({ userId: 1, productId: 1 }, { unique: true });
trackedItemSchema.index({ productId: 1, enabled: 1 });
trackedItemSchema.index({ userId: 1, createdAt: 1, _id: 1 });

const historySchema = new Schema({
  productId: { ...ref('Product'), immutable: true },
  checkId: { type: String, required: true, maxlength: 128, immutable: true },
  priceMinor: { ...cents, immutable: true },
  currency: { type: String, enum: ['USD'], required: true, immutable: true },
  observedAt: { type: Date, required: true, immutable: true },
  providerChangedAt: { type: Date, default: null, immutable: true },
  source: { type: String, enum: ['CheapShark'], required: true, immutable: true },
  dealId: { type: String, required: true, maxlength: 1024, immutable: true },
}, { ...options, timestamps: false });
historySchema.index({ productId: 1, checkId: 1 }, { unique: true });
historySchema.index({ productId: 1, observedAt: 1, _id: 1 });
historySchema.index({ observedAt: 1 }, { expireAfterSeconds: HISTORY_RETENTION_DAYS * 86400 });

const deliverySchema = new Schema({
  trackedItemId: ref('TrackedItem'),
  userId: ref('User'),
  productId: ref('Product'),
  observationId: ref('PriceHistory'),
  episodeId: { type: String, required: true, maxlength: 128 },
  channel: { type: String, enum: ['email', 'push'], required: true },
  status: { type: String, enum: ['pending', 'sending', 'sent', 'retryable', 'permanent_failure', 'unknown', 'cancelled'], required: true, default: 'pending' },
  attempts: { type: Number, required: true, default: 0, min: 0, validate: Number.isSafeInteger },
  availableAt: { type: Date, required: true, default: Date.now },
  leaseToken: { type: String, default: null, select: false },
  leaseUntil: { type: Date, default: null },
  providerMessageId: { type: String, default: null, select: false },
  lastErrorCode: { type: String, default: null, maxlength: 100 },
  sentAt: { type: Date, default: null },
}, options);
deliverySchema.index({ trackedItemId: 1, episodeId: 1, channel: 1 }, { unique: true });
deliverySchema.index({ status: 1, availableAt: 1, leaseUntil: 1 });

export const TrackedItemModel = mongoose.model('TrackedItem', trackedItemSchema);
export const PriceHistoryModel = mongoose.model('PriceHistory', historySchema);
export const NotificationDeliveryModel = mongoose.model('NotificationDelivery', deliverySchema);
