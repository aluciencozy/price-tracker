import mongoose, { Schema } from 'mongoose';

export type PriceCheckMode = 'scheduled' | 'admin' | 'cli' | 'user';
export type PriceCheckRunStatus = 'pending' | 'running' | 'complete' | 'partial';
export type PriceCheckItemStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';

export type PriceCheckRecord = {
  _id: mongoose.Types.ObjectId;
  createdAt?: Date;
  entryType: 'run' | 'product';
  runId: string;
  mode: PriceCheckMode;
  status: PriceCheckRunStatus | PriceCheckItemStatus;
  productId: mongoose.Types.ObjectId | null;
  checkId: string | null;
  attempts: number;
  availableAt: Date;
  nextRetryAt: Date | null;
  leaseToken: string | null;
  leaseUntil: Date | null;
  observationId: mongoose.Types.ObjectId | null;
  result: 'refreshed' | 'cached' | null;
  errorCode: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  truncated: boolean;
  selectionComplete: boolean;
  ownerUserId: mongoose.Types.ObjectId | null;
  trackedItemId: mongoose.Types.ObjectId | null;
};

const recordSchema = new Schema<PriceCheckRecord>(
  {
    entryType: { type: String, enum: ['run', 'product'], required: true },
    runId: { type: String, required: true, maxlength: 64 },
    mode: { type: String, enum: ['scheduled', 'admin', 'cli', 'user'], required: true },
    ownerUserId: { type: Schema.Types.ObjectId, default: null },
    trackedItemId: { type: Schema.Types.ObjectId, default: null },
    status: {
      type: String,
      enum: ['pending', 'running', 'complete', 'partial', 'succeeded', 'failed', 'skipped'],
      required: true,
    },
    productId: { type: Schema.Types.ObjectId, default: null },
    checkId: { type: String, default: null, maxlength: 128 },
    attempts: { type: Number, default: 0, min: 0, validate: Number.isSafeInteger },
    availableAt: { type: Date, default: Date.now },
    nextRetryAt: { type: Date, default: null },
    leaseToken: { type: String, default: null, select: false },
    leaseUntil: { type: Date, default: null },
    observationId: { type: Schema.Types.ObjectId, default: null },
    result: { type: String, enum: ['refreshed', 'cached', null], default: null },
    errorCode: { type: String, default: null, maxlength: 64 },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    truncated: { type: Boolean, default: false },
    selectionComplete: { type: Boolean, default: false },
  },
  { timestamps: true, versionKey: false, strict: 'throw' },
);

recordSchema.index(
  { runId: 1 },
  { unique: true, partialFilterExpression: { entryType: 'run' } },
);
recordSchema.index(
  { runId: 1, productId: 1 },
  { unique: true, partialFilterExpression: { entryType: 'product' } },
);
recordSchema.index(
  { checkId: 1 },
  { unique: true, partialFilterExpression: { checkId: { $type: 'string' } } },
);
recordSchema.index({ entryType: 1, status: 1, nextRetryAt: 1, leaseUntil: 1 });
recordSchema.index({ runId: 1, entryType: 1, status: 1, availableAt: 1 });

const existingModel = mongoose.models.PriceCheck as mongoose.Model<PriceCheckRecord> | undefined;
export const PriceCheckModel = existingModel ?? mongoose.model<PriceCheckRecord>('PriceCheck', recordSchema);
