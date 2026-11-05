import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFcmSender, type PushEvent } from '../src/fcm.js';

const event: PushEvent = { schemaVersion: '1', type: 'price_target_reached', eventId: 'episode_1', deliveryId: 'push_1', recipientSessionId: 'session_1', trackedItemId: 'tracker_1', productId: 'product_1', observedAt: '2026-11-04T12:00:00.000Z' };
afterEach(() => vi.useRealTimers());
describe('FCM adapter with explicit offline transport', () => {
  it('sends only the strict routing event and reports provider acceptance rather than device delivery', async () => {
    const transport = vi.fn().mockResolvedValue('projects/offline/messages/fixture');
    const result = await createFcmSender(transport)('fixture-token', event);
    expect(result).toEqual({ kind: 'accepted', providerMessageId: 'projects/offline/messages/fixture' });
    expect(transport).toHaveBeenCalledWith({ token: 'fixture-token', data: event, android: { priority: 'normal', ttl: 3600000 } });
  });
  it.each([{ ...event, purchaseUrl: 'https://example.invalid/' }, { ...event, target: '1000' }, { ...event, schemaVersion: '2' }, { ...event, eventId: 5 }])('rejects unsafe/extra or nonstring event fields before contacting transport', async input => {
    const transport = vi.fn();
    expect(await createFcmSender(transport)('fixture-token', input)).toMatchObject({ kind: 'permanent_failure', invalidToken: false });
    expect(transport).not.toHaveBeenCalled();
  });
  it('deactivates only an explicitly invalid/unregistered token outcome', async () => {
    const send = createFcmSender(vi.fn().mockRejectedValue({ code: 'messaging/registration-token-not-registered', message: 'private-token-must-not-escape' }));
    expect(await send('fixture-token', event)).toEqual({ kind: 'permanent_failure', code: 'FCM_INVALID_TOKEN', invalidToken: true });
  });
  it('honors explicit provider backoff and makes no automatic retry', async () => {
    const transport = vi.fn().mockRejectedValue({ code: 'messaging/server-unavailable', httpResponse: { headers: { 'retry-after': '3600' } } });
    expect(await createFcmSender(transport)('fixture-token', event)).toEqual({ kind: 'retryable', code: 'FCM_RETRY_LATER', retryAfterSeconds: 3600 });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('classifies lost transport confirmation as unknown without leaking errors or retrying', async () => {
    const send = createFcmSender(vi.fn().mockRejectedValue(new Error('private-credentials')));
    expect(await send('fixture-token', event)).toEqual({ kind: 'unknown', code: 'FCM_SEND_UNKNOWN' });
  });
  it('bounds waiting time and marks the unresolved send unknown', async () => {
    vi.useFakeTimers();
    const transport = vi.fn(() => new Promise<string>(() => {}));
    const pending = createFcmSender(transport, 10)('fixture-token', event);
    await vi.advanceTimersByTimeAsync(11);
    expect(await pending).toEqual({ kind: 'unknown', code: 'FCM_DEADLINE_UNKNOWN' });
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
