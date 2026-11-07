import { createHash } from 'node:crypto';
import { AuthLimitModel } from './models/account.js';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');

/** Shared fixed-window limits across API instances and account transports. */
export async function limitAuthAttempts(scope: string, value: string, maximum = 5, windowMs = 900_000) {
  const now = Date.now();
  const start = Math.floor(now / windowMs) * windowMs;
  const key = digest(`${scope}:${value}:${start}`);
  let row;
  try {
    row = await AuthLimitModel.findOneAndUpdate({ key }, {
      $inc: { attempts: 1 }, $setOnInsert: { expiresAt: new Date(start + windowMs) },
    }, { upsert: true, returnDocument: 'after' }).exec();
  } catch (error) {
    // Two first requests can race to insert the unique fixed-window key.
    if (!(error instanceof Error) || !('code' in error) || error.code !== 11000) throw error;
    row = await AuthLimitModel.findOneAndUpdate({ key }, { $inc: { attempts: 1 } }, { returnDocument: 'after' }).orFail().exec();
  }
  return { blocked: row!.attempts > maximum, retry: Math.max(1, Math.ceil((start + windowMs - now) / 1000)) };
}
