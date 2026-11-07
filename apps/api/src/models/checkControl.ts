import mongoose, { Schema } from 'mongoose';

const schema = new Schema({
  _id: { type: String, required: true },
  runId: { type: String, default: null },
  cursor: { type: Schema.Types.ObjectId, default: null },
  leaseUntil: { type: Date, default: () => new Date(0) },
  leaseToken: { type: String, default: null },
  attempts: { type: Number, default: 0 },
  expiresAt: { type: Date, default: null },
}, { versionKey: false });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const CheckControlModel = mongoose.model('CheckControl', schema);
