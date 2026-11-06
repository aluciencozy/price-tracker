import { createHash, randomBytes, scrypt } from 'node:crypto';
import mongoose from 'mongoose';
import { AuthTokenModel, UserModel } from './models/account.js';
import { sendWithOutcome, type DeliveryOutcome } from './emails.js';

export const hashSecret = (value: string) => createHash('sha256').update(value).digest('hex');
export const accepted = { message: 'If eligible, you will receive an email with next steps.' };
export type VerificationSender = (details: { email: string; token: string }) => Promise<DeliveryOutcome>;

// The deployment selects an exact WEB_ORIGINS entry; request headers never build links.
export function verificationSender(origin: string): VerificationSender {
  return ({ email, token }) => {
    if (!origin.startsWith('https://')) return Promise.resolve({ status: 'permanent_failure', code: 'verification_https_origin_required', attempts: 0 });
    const url = new URL('/verify-email', origin);
    url.hash = `token=${token}`;
    // Plain text deliberately avoids unverified remote template syntax/escaping.
    return sendWithOutcome({
      from: process.env.EMAIL_FROM ?? 'onboarding@resend.dev', to: email,
      subject: 'Verify your Price Tracker email',
      text: `Confirm your email for Price Tracker:\n\n${url.href}\n\nThis link expires in 24 hours. If you did not register, ignore this email.`,
    }, `verify-email:${hashSecret(token)}`);
  };
}

export function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error);
      else resolve(`scrypt$32768$8$1$${salt.toString('hex')}$${key.toString('hex')}`);
    });
  });
}

async function storeToken(userId: mongoose.Types.ObjectId, token: string, now: Date, session: mongoose.ClientSession) {
  await AuthTokenModel.findOneAndUpdate({ userId, purpose: 'verify_email' }, { $set: {
    tokenHash: hashSecret(token), expiresAt: new Date(now.getTime() + 86400000), consumedAt: null,
  } }, { upsert: true, runValidators: true, session }).exec();
}

async function deliver(send: VerificationSender, email: string, token: string) {
  // Never undo committed state on an uncertain/failed send: the link may have arrived.
  // An explicit resend after the cooldown recovers; no background blind retry.
  try { await send({ email, token }); } catch { /* Provider details and secrets stay private. */ }
}

export async function register(input: { email: string; password: string; name?: string }, send: VerificationSender) {
  const passwordHash = await hashPassword(input.password);
  const token = randomBytes(32).toString('hex');
  const now = new Date();
  let created = false;
  try {
    await mongoose.connection.transaction(async session => {
      created = false; // The driver may retry the callback after a write conflict.
      if (await UserModel.exists({ email: input.email }).session(session)) return;
      const [user] = await UserModel.create([{
        email: input.email, passwordHash, name: input.name ?? null, verificationEmailSentAt: now,
      }], { session });
      await storeToken(user!._id, token, now, session);
      created = true;
    });
  } catch (error) {
    if (error instanceof mongoose.mongo.MongoServerError && error.code === 11000) return;
    throw error;
  }
  if (created) await deliver(send, input.email, token);
}

export async function resend(email: string, send: VerificationSender) {
  const token = randomBytes(32).toString('hex');
  const now = new Date();
  const claimed = await mongoose.connection.transaction(async session => {
    const user = await UserModel.findOneAndUpdate({
      email, emailVerifiedAt: null, $or: [
        { verificationEmailSentAt: null },
        { verificationEmailSentAt: { $lte: new Date(now.getTime() - 60000) } },
      ],
    }, { $set: { verificationEmailSentAt: now } }, { returnDocument: 'after', session }).exec();
    if (!user) return false;
    await storeToken(user._id, token, now, session);
    return true;
  });
  if (claimed) await deliver(send, email, token);
}

export async function verify(token: string): Promise<boolean> {
  return mongoose.connection.transaction(async session => {
    const now = new Date();
    const authToken = await AuthTokenModel.findOneAndUpdate({
      tokenHash: hashSecret(token), purpose: 'verify_email', consumedAt: null, expiresAt: { $gt: now },
    }, { $set: { consumedAt: now } }, { returnDocument: 'after', session }).exec();
    if (!authToken) return false;
    const user = await UserModel.updateOne({ _id: authToken.userId, emailVerifiedAt: null }, {
      $set: { emailVerifiedAt: now },
    }, { session }).exec();
    // Abort rather than burn a token whose user could not be updated.
    if (user.matchedCount !== 1) throw new Error('Verification user unavailable');
    return true;
  });
}
