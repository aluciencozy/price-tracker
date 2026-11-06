import mongoose, { Schema } from 'mongoose';

// One bounded-size row per account, replaced only by an explicit new generation.
// No recipient/password/raw verification secret is persisted in this outbox.
const schema = new Schema({
  userId: { type: Schema.Types.ObjectId, required: true, unique: true },
  generationHash: { type: String, required: true },
  status: { type: String, enum: ['pending', 'sending', 'sent', 'failed', 'unknown', 'superseded'], required: true },
  startedAt: { type: Date, default: null },
  deliveryKey: { type: String, default: null },
  providerMessageId: { type: String, default: null },
  expiresAt: { type: Date, required: true },
  removeAt: { type: Date, required: true, expires: 0 },
}, { timestamps: true, strict: 'throw' });
schema.index({ status: 1, expiresAt: 1 });
export const VerificationMailModel = mongoose.model('VerificationMail', schema);
