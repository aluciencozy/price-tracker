import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging, type Message } from 'firebase-admin/messaging';
import { z } from 'zod';

const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const pushEventSchema = z.object({
  schemaVersion: z.literal('1'), type: z.literal('price_target_reached'),
  eventId: identifier, deliveryId: identifier, recipientSessionId: identifier,
  trackedItemId: identifier, productId: identifier, observedAt: z.iso.datetime(),
}).strict();
export type PushEvent = z.infer<typeof pushEventSchema>;
export type PushOutcome =
  | { kind: 'accepted'; providerMessageId: string }
  | { kind: 'retryable'; code: string; retryAfterSeconds: number }
  | { kind: 'permanent_failure'; code: string; invalidToken: boolean }
  | { kind: 'unknown'; code: string };
type Transport = (message: Message) => Promise<string>;

/** No automatic application retry. A deadline can leave a send in flight;
 * unknown outcomes must never be blindly resent by the outbox worker. */
export function createFcmSender(transport: Transport, timeoutMs = 15000) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error('Invalid FCM deadline.');
  return async (token: string, rawEvent: unknown): Promise<PushOutcome> => {
    const event = pushEventSchema.safeParse(rawEvent);
    if (!event.success || typeof token !== 'string' || token.length < 1 || token.length > 4096) {
      return { kind: 'permanent_failure', code: 'FCM_INVALID_REQUEST', invalidToken: false };
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const pending = transport({ token, data: event.data, android: { priority: 'normal', ttl: 3600000 } });
      const result = await Promise.race([
        pending,
        new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); }),
      ]);
      if (result === null) return { kind: 'unknown', code: 'FCM_DEADLINE_UNKNOWN' };
      if (typeof result !== 'string' || result.length === 0 || result.length > 1024) return { kind: 'unknown', code: 'FCM_RESPONSE_UNKNOWN' };
      return { kind: 'accepted', providerMessageId: result };
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
      if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') {
        return { kind: 'permanent_failure', code: 'FCM_INVALID_TOKEN', invalidToken: true };
      }
      if (code === 'messaging/message-rate-exceeded' || code === 'messaging/device-message-rate-exceeded' || code === 'messaging/server-unavailable' || code === 'messaging/quota-exceeded') {
        let retryAfterSeconds = 60;
        // Read only an explicit numeric Retry-After; never expose raw SDK errors,
        // provider response bodies, private tokens or credential paths.
        if (typeof error === 'object' && error !== null && 'httpResponse' in error) {
          const response = error.httpResponse;
          if (typeof response === 'object' && response !== null && 'headers' in response) {
            const headers = response.headers;
            if (typeof headers === 'object' && headers !== null && 'retry-after' in headers) {
              const value = headers['retry-after'];
              if (typeof value === 'string' && /^\d{1,5}$/.test(value)) retryAfterSeconds = Math.max(60, Math.min(86400, Number(value)));
            }
          }
        }
        return { kind: 'retryable', code: 'FCM_RETRY_LATER', retryAfterSeconds };
      }
      if (code === 'messaging/invalid-argument' || code === 'messaging/invalid-payload' || code === 'messaging/mismatched-credential' || code === 'app/invalid-credential') {
        return { kind: 'permanent_failure', code: 'FCM_REQUEST_OR_CONFIG_REJECTED', invalidToken: false };
      }
      return { kind: 'unknown', code: 'FCM_SEND_UNKNOWN' };
    } finally { if (timer) clearTimeout(timer); }
  };
}

/** Credentials come only from deployment-managed Application Default Credentials.
 * Construct explicitly from the worker; importing this module sends nothing. */
export function createFirebaseFcmSender(projectId: string) {
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)) throw new Error('Invalid Firebase project ID.');
  const name = `price-tracker-${projectId}`;
  try {
    const app = getApps().find(app => app.name === name) ?? initializeApp({ projectId, credential: applicationDefault() }, name);
    return createFcmSender(message => getMessaging(app).send(message));
  } catch { throw new Error('FCM configuration is unavailable. Check deployment-managed credentials.'); }
}
