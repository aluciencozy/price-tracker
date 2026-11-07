import mongoose, { Schema } from 'mongoose';

type AccountMail = {
  _id: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  purpose: 'verify_email' | 'reset_password';
  generationHash: string;
  status: 'pending' | 'sending' | 'sent' | 'failed' | 'unknown' | 'superseded';
  startedAt: Date | null;
  availableAt: Date | null;
  deliveryKey: string | null;
  providerMessageId: string | null;
  expiresAt: Date;
  removeAt: Date;
};

// Legacy model/collection name retained for the existing verification outbox.
// One bounded-size account-mail row stores hashes, never recipient/password/raw token.
const schema = new Schema({
  userId: { type: Schema.Types.ObjectId, required: true, unique: true },
  // One account can have only one pending account message at a time. A reset
  // replaces stale verification delivery state (and vice versa) atomically.
  purpose: { type: String, enum: ['verify_email', 'reset_password'], default: 'verify_email', required: true },
  generationHash: { type: String, required: true },
  status: { type: String, enum: ['pending', 'sending', 'sent', 'failed', 'unknown', 'superseded'], required: true },
  startedAt: { type: Date, default: null },
  availableAt: { type: Date, default: null },
  deliveryKey: { type: String, default: null },
  providerMessageId: { type: String, default: null },
  expiresAt: { type: Date, required: true },
  removeAt: { type: Date, required: true, expires: 0 },
}, { timestamps: true, strict: 'throw' });
schema.index({ status: 1, expiresAt: 1 });
export const VerificationMailModel = mongoose.model<AccountMail>('VerificationMail', schema);
