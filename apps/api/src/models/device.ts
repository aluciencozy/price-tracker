import mongoose, { Schema } from 'mongoose';
import { z } from 'zod';

// Use this same UUID parser at the request boundary and in persistence.
export const installationIdSchema = z.uuid().transform(value => value.toLowerCase());

const deviceSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  sessionId: { type: Schema.Types.ObjectId, ref: 'Session', required: true },
  installationId: { type: String, required: true, lowercase: true, validate: (value: string) => installationIdSchema.safeParse(value).success },
  platform: { type: String, enum: ['android'], required: true },
  pushToken: { type: String, required: true, maxlength: 4096, select: false },
  active: { type: Boolean, required: true, default: true },
}, { timestamps: true, strict: 'throw' });
deviceSchema.index({ installationId: 1 }, { unique: true });
deviceSchema.index({ pushToken: 1 }, { unique: true });
deviceSchema.index({ userId: 1, sessionId: 1, active: 1 });

export const DeviceModel = mongoose.model('Device', deviceSchema);
