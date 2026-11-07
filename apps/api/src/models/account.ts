import mongoose, { Schema } from 'mongoose';

const options = { timestamps: true, strict: 'throw' as const };
const userSchema = new Schema({
  email: { type: String, required: true, trim: true, lowercase: true, maxlength: 254 },
  passwordHash: { type: String, required: true, select: false },
  name: { type: String, default: null, maxlength: 100 },
  emailVerifiedAt: { type: Date, default: null },
  verificationEmailSentAt: { type: Date, default: null },
  passwordResetEmailSentAt: { type: Date, default: null },
  sessionVersion: { type: Number, default: 0, min: 0, required: true },
  sessionFence: { type: Number, default: 0 },
  role: { type: String, enum: ['user', 'admin'], default: 'user', required: true },
}, options);
userSchema.index({ email: 1 }, { unique: true });

const sessionSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  transport: { type: String, enum: ['web', 'mobile'], required: true },
  sessionVersion: { type: Number, default: 0, min: 0, required: true },
  secretHash: { type: String, select: false, default: null },
  csrfHash: { type: String, select: false, default: null },
  expiresAt: { type: Date, required: true },
  revokedAt: { type: Date, default: null },
}, options);
sessionSchema.index({ userId: 1, revokedAt: 1 });
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
sessionSchema.index({ secretHash: 1 }, { unique: true, partialFilterExpression: { secretHash: { $type: 'string' } } });

const authTokenSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  purpose: { type: String, enum: ['verify_email', 'reset_password'], required: true },
  tokenHash: { type: String, required: true, match: /^[a-f0-9]{64}$/, select: false },
  expiresAt: { type: Date, required: true },
  consumedAt: { type: Date, default: null },
}, options);
authTokenSchema.index({ userId: 1, purpose: 1 }, { unique: true });
authTokenSchema.index({ tokenHash: 1 }, { unique: true });
authTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const UserModel = mongoose.model('User', userSchema);
export const SessionModel = mongoose.model('Session', sessionSchema);
export const AuthTokenModel = mongoose.model('AuthToken', authTokenSchema);

const preloginSchema = new Schema({
  secretHash: { type: String, required: true, unique: true },
  expiresAt: { type: Date, required: true, expires: 0 },
}, options);
export const PreloginModel = mongoose.model('Prelogin', preloginSchema);

const authLimitSchema = new Schema({
  key: { type: String, required: true, unique: true },
  attempts: { type: Number, required: true },
  expiresAt: { type: Date, required: true, expires: 0 },
}, options);
export const AuthLimitModel = mongoose.model('AuthLimit', authLimitSchema);
