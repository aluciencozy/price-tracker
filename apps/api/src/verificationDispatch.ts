import { randomBytes } from 'node:crypto';
import mongoose from 'mongoose';
import { AuthTokenModel, UserModel } from './models/account.js';
import { VerificationMailModel } from './models/verificationMail.js';
import { hashSecret, type VerificationSender } from './registration.js';
import type { PasswordResetSender } from './passwordReset.js';

type MailPurpose = 'verify_email' | 'reset_password';
type MailSender = VerificationSender | PasswordResetSender;

/** An interrupted send is uncertain; never reclaim and possibly duplicate it. */
export async function recoverVerificationMail(now = new Date()) {
  await VerificationMailModel.updateMany({
    status: 'sending', startedAt: { $lte: new Date(now.getTime() - 60_000) },
  }, { $set: { status: 'unknown' } }).exec();
  await VerificationMailModel.updateMany({ status: 'pending', expiresAt: { $lte: now } }, { $set: { status: 'superseded' } }).exec();
}

async function dispatchAccountMail(
  senders: Partial<Record<MailPurpose, MailSender>>,
  onlyPurpose?: MailPurpose,
): Promise<boolean> {
  const token = randomBytes(32).toString('hex');
  const claimed = await mongoose.connection.transaction(async session => {
    const now = new Date();
    const filter: Record<string, unknown> = { status: 'pending', expiresAt: { $gt: now } };
    if (onlyPurpose === 'verify_email') filter.$or = [{ purpose: 'verify_email' }, { purpose: { $exists: false } }];
    else if (onlyPurpose) filter.purpose = onlyPurpose;
    const candidate = await VerificationMailModel.findOne(filter).sort({ _id: 1 }).session(session).exec();
    if (!candidate) return null;
    const purpose: MailPurpose = candidate.purpose === 'reset_password' ? 'reset_password' : 'verify_email';
    const sender = senders[purpose];
    if (!sender) return null;
    const deliveryKey = `${purpose === 'verify_email' ? 'verify-email' : 'password-reset'}:${hashSecret(token)}`;
    const job = await VerificationMailModel.findOneAndUpdate({
      _id: candidate._id, status: 'pending', expiresAt: { $gt: now },
    }, { $set: { purpose, status: 'sending', startedAt: now, deliveryKey } }, {
      session, returnDocument: 'after',
    }).exec();
    if (!job) return null;

    const eligibility = purpose === 'verify_email' ? { emailVerifiedAt: null } : { emailVerifiedAt: { $ne: null } };
    const user = await UserModel.findOne({ _id: job.userId, ...eligibility }).session(session).exec();
    const updated = user && await AuthTokenModel.updateOne({
      userId: job.userId, purpose, tokenHash: job.generationHash,
      consumedAt: null, expiresAt: { $gt: now },
    }, { $set: { tokenHash: hashSecret(token) } }, { session }).exec();
    if (!updated || updated.matchedCount !== 1) {
      await VerificationMailModel.updateOne({ _id: job._id, status: 'sending' }, { $set: { status: 'superseded' } }, { session }).exec();
      return null;
    }
    return { id: job._id, generationHash: job.generationHash, purpose, email: user!.email, sender };
  });
  if (!claimed) return false;

  let status: 'sent' | 'failed' | 'unknown' = 'unknown';
  let providerMessageId: string | null = null;
  try {
    const result = await claimed.sender({ email: claimed.email, token });
    status = result.status === 'success' ? 'sent' : result.status === 'unknown' ? 'unknown' : 'failed';
    if (result.status === 'success' && result.messageId.length <= 256) providerMessageId = result.messageId;
  } catch {
    // Provider exceptions do not prove that a message was not accepted.
  }
  await VerificationMailModel.updateOne({
    _id: claimed.id, generationHash: claimed.generationHash, purpose: claimed.purpose, status: 'sending',
  }, { $set: { status, providerMessageId } }).exec();
  return true;
}

/** Compatibility entry point for focused verification-service tests. */
export function dispatchVerificationMail(send: VerificationSender): Promise<boolean> {
  return dispatchAccountMail({ verify_email: send }, 'verify_email');
}

export function dispatchPasswordResetMail(send: PasswordResetSender): Promise<boolean> {
  return dispatchAccountMail({ reset_password: send }, 'reset_password');
}

export function dispatchPendingAccountMail(verification: VerificationSender, reset: PasswordResetSender): Promise<boolean> {
  return dispatchAccountMail({ verify_email: verification, reset_password: reset });
}

/** Managed polling: one active account-mail provider call per process, no in-memory queue. */
function startDispatcher(dispatch: () => Promise<boolean>, connected: () => boolean) {
  let stopping = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<void> | undefined;
  const tick = () => {
    active = (async () => {
      if (!connected()) return;
      await recoverVerificationMail();
      await dispatch();
    })().catch(() => {
      // Leave an interrupted claim non-replayable; never log driver/provider details.
      console.error('Account mail dispatcher unavailable.');
    }).finally(() => {
      if (!stopping) { timer = setTimeout(tick, 1000); timer.unref(); }
    });
  };
  timer = setTimeout(tick, 1000);
  timer.unref();
  return async () => {
    stopping = true;
    if (timer) clearTimeout(timer);
    await active;
  };
}

export function startVerificationDispatcher(send: VerificationSender, connected: () => boolean) {
  return startDispatcher(() => dispatchVerificationMail(send), connected);
}

export function startAccountMailDispatcher(verification: VerificationSender, reset: PasswordResetSender, connected: () => boolean) {
  return startDispatcher(() => dispatchPendingAccountMail(verification, reset), connected);
}
