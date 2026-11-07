import { randomBytes } from 'node:crypto';
import mongoose from 'mongoose';
import { sendPasswordReset, type DeliveryOutcome } from './emails.js';
import { AuthTokenModel, SessionModel, UserModel } from './models/account.js';
import { DeviceModel } from './models/device.js';
import { VerificationMailModel } from './models/verificationMail.js';
import { hashPassword, hashSecret } from './registration.js';

export type PasswordResetSender = (details: { email: string; token: string }) => Promise<DeliveryOutcome>;

/** Queue a generic reset request; public handlers do not wait for a mail provider. */
export async function requestPasswordReset(email: string, now = new Date()): Promise<void> {
  const placeholder = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + 30 * 60_000);
  await mongoose.connection.transaction(async session => {
    const cooldown = new Date(now.getTime() - 60_000);
    const user = await UserModel.findOneAndUpdate({
      email, emailVerifiedAt: { $ne: null },
      $or: [{ passwordResetEmailSentAt: null }, { passwordResetEmailSentAt: { $lte: cooldown } }],
    }, { $set: { passwordResetEmailSentAt: now } }, { session, returnDocument: 'after' }).exec();
    if (!user) return;

    await AuthTokenModel.findOneAndUpdate({ userId: user._id, purpose: 'reset_password' }, { $set: {
      tokenHash: hashSecret(placeholder), expiresAt, consumedAt: null,
    } }, { upsert: true, runValidators: true, session }).exec();
    await VerificationMailModel.findOneAndUpdate({ userId: user._id }, { $set: {
      purpose: 'reset_password', generationHash: hashSecret(placeholder), status: 'pending', startedAt: null, availableAt: null,
      deliveryKey: null, providerMessageId: null, expiresAt,
      removeAt: new Date(now.getTime() + 7 * 86_400_000),
    } }, { upsert: true, runValidators: true, session }).exec();
  });
}

/** Consume once, replace the hash, and invalidate sessions/devices in the same transaction. */
export async function completePasswordReset(token: string, password: string): Promise<boolean> {
  const tokenHash = hashSecret(token);
  const now = new Date();
  const eligible = await AuthTokenModel.exists({ tokenHash, purpose: 'reset_password', consumedAt: null, expiresAt: { $gt: now } });
  if (!eligible) return false;
  const passwordHash = await hashPassword(password);

  return mongoose.connection.transaction(async session => {
    const authToken = await AuthTokenModel.findOneAndUpdate({
      tokenHash, purpose: 'reset_password', consumedAt: null, expiresAt: { $gt: new Date() },
    }, { $set: { consumedAt: now } }, { session, returnDocument: 'after' }).exec();
    if (!authToken) return false;

    const user = await UserModel.findOneAndUpdate({ _id: authToken.userId, emailVerifiedAt: { $ne: null } }, {
      $set: { passwordHash }, $inc: { sessionVersion: 1 },
    }, { session, returnDocument: 'after' }).exec();
    if (!user) throw new Error('Password reset account unavailable');

    await SessionModel.updateMany({ userId: user._id, revokedAt: null }, { $set: { revokedAt: now } }, { session }).exec();
    await DeviceModel.updateMany({ userId: user._id, active: true }, { $set: { active: false } }, { session }).exec();
    await VerificationMailModel.updateOne({ userId: user._id, purpose: 'reset_password' }, {
      $set: { status: 'superseded' },
    }, { session }).exec();
    return true;
  });
}

/** Build only allowlisted HTTPS fragments; never derive a link from request headers. */
export function passwordResetSender(origin: string): PasswordResetSender {
  return ({ email, token }) => {
    if (!origin.startsWith('https://')) {
      return Promise.resolve({ status: 'permanent_failure', code: 'password_reset_https_origin_required', attempts: 0 });
    }
    const url = new URL('/reset-password', origin);
    url.hash = `token=${token}`;
    return sendPasswordReset(email, url.href, `password-reset:${hashSecret(token)}`);
  };
}
