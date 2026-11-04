import mongoose, { Schema } from 'mongoose';

const deviceSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  sessionId: { type: Schema.Types.ObjectId, ref: 'Session', required: true },
  installationId: { type: String, required: true, match: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i },
  platform: { type: String, enum: ['android'], required: true },
  pushToken: { type: String, required: true, maxlength: 4096, select: false },
  active: { type: Boolean, required: true, default: true },
}, { timestamps: true, strict: 'throw' });
deviceSchema.index({ installationId: 1 }, { unique: true });
deviceSchema.index({ pushToken: 1 }, { unique: true });
deviceSchema.index({ userId: 1, sessionId: 1, active: 1 });

export const DeviceModel = mongoose.model('Device', deviceSchema);
