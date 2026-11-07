import mongoose, { Schema } from 'mongoose';

export type EmailBudgetRecord = {
  _id: 'resend-account';
  reservations: Date[];
  dailyLimit: number;
  monthlyLimit: number;
  decisionId: string;
  decisionAt: Date;
  allowed: boolean;
};

const schema = new Schema<EmailBudgetRecord>({
  _id: { type: String, required: true },
  reservations: { type: [Date], required: true },
  dailyLimit: { type: Number, required: true },
  monthlyLimit: { type: Number, required: true },
  decisionId: { type: String, required: true },
  decisionAt: { type: Date, required: true },
  allowed: { type: Boolean, required: true },
}, { versionKey: false });

export const EmailBudgetModel =
  (mongoose.models.EmailBudget as mongoose.Model<EmailBudgetRecord> | undefined) ??
  mongoose.model<EmailBudgetRecord>('EmailBudget', schema);
