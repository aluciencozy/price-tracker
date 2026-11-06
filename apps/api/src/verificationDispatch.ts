import { randomBytes } from 'node:crypto';
import mongoose from 'mongoose';
import { AuthTokenModel, UserModel } from './models/account.js';
import { VerificationMailModel } from './models/verificationMail.js';
import { hashSecret, type VerificationSender } from './registration.js';

/** Never reclaim sending jobs: a crash may have occurred after provider acceptance. */
export async function recoverVerificationMail(now = new Date()) {
  await VerificationMailModel.updateMany({
    status: 'sending', startedAt: { $lte: new Date(now.getTime() - 60000) },
  }, { $set: { status: 'unknown' } });
  await VerificationMailModel.updateMany({ status: 'pending', expiresAt: { $lte: now } }, { $set: { status: 'superseded' } });
}

/** A job can be claimed once. Only pending (never sending/unknown/failed) is eligible. */
export async function dispatchVerificationMail(send: VerificationSender): Promise<boolean> {
  const token = randomBytes(32).toString('hex');
  const claimed = await mongoose.connection.transaction(async session => {
    const now = new Date();
    const job = await VerificationMailModel.findOneAndUpdate({ status: 'pending', expiresAt: { $gt: now } }, {
      $set: { status: 'sending', startedAt: now, deliveryKey: `verify-email:${hashSecret(token)}` },
    }, { session, returnDocument: 'after', sort: { _id: 1 } });
    if (!job) return null;
    const user = await UserModel.findOne({ _id: job.userId, emailVerifiedAt: null }).session(session);
    const updated = user && await AuthTokenModel.updateOne({
      userId: job.userId, purpose: 'verify_email', tokenHash: job.generationHash,
      consumedAt: null, expiresAt: { $gt: now },
    }, { $set: { tokenHash: hashSecret(token) } }, { session });
    if (!updated || updated.matchedCount !== 1) {
      await VerificationMailModel.updateOne({ _id: job._id }, { $set: { status: 'superseded' } }, { session });
      return null;
    }
    return { id: job._id, generationHash: job.generationHash, email: user!.email };
  });
  if (!claimed) return false;
  let status: 'sent' | 'failed' | 'unknown' = 'unknown';
  let providerMessageId: string | null = null;
  try {
    const result = await send({ email: claimed.email, token });
    status = result.status === 'success' ? 'sent' : result.status === 'unknown' ? 'unknown' : 'failed';
    if (result.status === 'success' && result.messageId.length <= 256) providerMessageId = result.messageId;
  } catch { /* An exception cannot establish whether the provider accepted mail. */ }
  // A concurrent explicit resend may have replaced the row. Never finalize its new job.
  await VerificationMailModel.updateOne({ _id: claimed.id, generationHash: claimed.generationHash, status: 'sending' }, { $set: { status, providerMessageId } });
  return true;
}

/** Managed polling: one active job/process, no request-triggered promises or in-memory queue. */
export function startVerificationDispatcher(send: VerificationSender, connected: () => boolean) {
  let stopping = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<void> | undefined;
  const tick = () => {
    active = (async () => {
      if (!connected()) return;
      await recoverVerificationMail();
      await dispatchVerificationMail(send);
    })().catch(() => {
      // Leave an interrupted claim non-replayable. Do not log provider/driver secrets.
      console.error('Verification dispatcher unavailable.');
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
