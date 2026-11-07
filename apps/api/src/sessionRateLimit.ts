import type { Response } from 'express';
import { accountError } from './accountError.js';
import { limitAuthAttempts } from './authRateLimit.js';

// Authentication and an injected private router may both enforce the policy.
// Count a response once, while the durable counter remains shared by processes.
const applied = new WeakMap<Response, string>();

export async function consumePrivateSessionLimit(response: Response, sessionId: string): Promise<boolean> {
  if (applied.get(response) === sessionId) return true;
  const rate = await limitAuthAttempts('private-session', sessionId, 120, 60_000);
  if (rate.blocked) {
    response.set('Retry-After', String(rate.retry));
    accountError(response, 429, 'RATE_LIMITED', 'The session request limit was reached.');
    return false;
  }
  applied.set(response, sessionId);
  return true;
}
