import mongoose, { Schema } from 'mongoose';

type ProviderBudgetRecord = {
  _id: 'cheapshark' | 'steam';
  leaseUntil: Date;
  leaseToken: string | null;
  nextRequestAt: Date;
  cooldownUntil: Date;
  rateLimitCount: number;
};

const providerBudgetSchema = new Schema<ProviderBudgetRecord>(
  {
    _id: { type: String, required: true },
    leaseUntil: { type: Date, required: true, default: () => new Date(0) },
    leaseToken: { type: String, default: null },
    nextRequestAt: { type: Date, required: true, default: () => new Date(0) },
    cooldownUntil: { type: Date, required: true, default: () => new Date(0) },
    rateLimitCount: { type: Number, required: true, default: 0, min: 0 },
  },
  { versionKey: false, timestamps: true, bufferCommands: false },
);

export const ProviderBudgetModel =
  (mongoose.models.ProviderBudget as mongoose.Model<ProviderBudgetRecord> | undefined) ??
  mongoose.model<ProviderBudgetRecord>('ProviderBudget', providerBudgetSchema);
