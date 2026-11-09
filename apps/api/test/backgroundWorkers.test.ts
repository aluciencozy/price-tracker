import { afterEach, describe, expect, it, vi } from 'vitest';
import { startBackgroundWorkers } from '../src/backgroundWorkers.js';
import { loadConfig } from '../src/config.js';
import type { createPriceAlertDeliveryWorker } from '../src/alertDeliveryWorker.js';
import type { PriceCheckRunSummary } from '../src/priceChecks.js';

const base = { NODE_ENV: 'test', MONGODB_URI: 'mongodb://fixture.invalid/test', PRICE_TRACKING_ENABLED: 'true', TRACKING_CURSOR_SECRET: 'fixture-cursor-secret-at-least-32-characters' };
const checks = () => ({ run: vi.fn(async ({ runId }: { runId: string }) => ({ runId } as PriceCheckRunSummary)), resume: vi.fn(async () => []) });
afterEach(() => vi.useRealTimers());

describe('background worker composition', () => {
  it('starts no work by default, even with credentials present', async () => {
    vi.useFakeTimers();
    const price = checks(), createPush = vi.fn(), createAlerts = vi.fn(), accountDispatch = vi.fn();
    const stop = startBackgroundWorkers(loadConfig({ ...base, RESEND_SEND_API_KEY: 'fixture-key', FIREBASE_PROJECT_ID: 'fixture-project' }), () => true, price, { createPush, createAlerts, accountDispatch });
    await vi.advanceTimersByTimeAsync(86400000);
    await stop();
    for (const call of [price.run, price.resume, createPush, createAlerts, accountDispatch]) expect(call).not.toHaveBeenCalled();
  });

  it('polls daily UTC slots separately from bounded frequent recovery and gates disconnection', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-09T23:59:00Z'));
    const price = checks();
    let connected = false;
    const stop = startBackgroundWorkers(loadConfig({ ...base, PRICE_SCHEDULER_ENABLED: 'true', PRICE_RETRY_WORKER_ENABLED: 'true' }), () => connected, price);
    await vi.advanceTimersByTimeAsync(0);
    expect(price.run).not.toHaveBeenCalled();
    connected = true;
    await vi.advanceTimersByTimeAsync(60000);
    expect(price.run).toHaveBeenCalledWith({ runId: `scheduled_${Math.floor(Date.now() / 86400000)}`, mode: 'scheduled' });
    await vi.advanceTimersByTimeAsync(180000);
    expect(price.run).toHaveBeenCalledTimes(1);
    expect(price.resume.mock.calls.length).toBeGreaterThan(0);
    connected = false;
    const count = price.resume.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60000);
    expect(price.resume).toHaveBeenCalledTimes(count);
    await stop();
    await vi.advanceTimersByTimeAsync(86400000);
    expect(price.run).toHaveBeenCalledTimes(1);
  });

  it('does not overlap local scheduled/recovery work and drains a paused call on stop', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const price = checks();
    price.run.mockImplementation(async () => { await pending; return {} as PriceCheckRunSummary; });
    const stop = startBackgroundWorkers(loadConfig({ ...base, PRICE_SCHEDULER_ENABLED: 'true', PRICE_RETRY_WORKER_ENABLED: 'true' }), () => true, price);
    await vi.advanceTimersByTimeAsync(180000);
    expect(price.run).toHaveBeenCalledTimes(1);
    expect(price.resume).not.toHaveBeenCalled();
    let drained = false;
    const stopped = stop().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    release();
    await stopped;
    await vi.advanceTimersByTimeAsync(180000);
    expect(price.run).toHaveBeenCalledTimes(1);
  });

  it('retries a slot deferred by an admin run, then starts a new identity after UTC midnight', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-09T23:58:00Z'));
    const price = checks();
    price.run.mockResolvedValueOnce({ runId: 'active_admin_run' } as PriceCheckRunSummary);
    const stop = startBackgroundWorkers(loadConfig({ ...base, PRICE_SCHEDULER_ENABLED: 'true' }), () => true, price);
    await vi.advanceTimersByTimeAsync(0);
    const firstId = price.run.mock.calls[0]![0].runId;
    await vi.advanceTimersByTimeAsync(60000);
    expect(price.run.mock.calls[1]![0].runId).toBe(firstId);
    await vi.advanceTimersByTimeAsync(60000);
    expect(price.run.mock.calls[2]![0].runId).not.toBe(firstId);
    await vi.advanceTimersByTimeAsync(60000);
    expect(price.run).toHaveBeenCalledTimes(3);
    await stop();
  });

  it.each(['email', 'push'] as const)('constructs only the enabled %s channel', async channel => {
    vi.useFakeTimers();
    const runBatch = vi.fn<ReturnType<typeof createPriceAlertDeliveryWorker>['runBatch']>(async () => ({ claimed: 0, sent: 0, retryable: 0, permanentFailure: 0, unknown: 0, cancelled: 0 }));
    const createAlerts = vi.fn<typeof createPriceAlertDeliveryWorker>(() => ({ runBatch, start() {}, stop: async () => {} }));
    const createPush = vi.fn(() => vi.fn());
    const stop = startBackgroundWorkers(loadConfig({ ...base,
      PRICE_EMAIL_ENABLED: String(channel === 'email'), PRICE_PUSH_ENABLED: String(channel === 'push'),
      RESEND_SEND_API_KEY: 'fixture', EMAIL_FROM: 'fixture@example.invalid', TEMPLATE_PRICE_ALERT_ID: 'fixture-template',
      FIREBASE_PROJECT_ID: 'fixture-project', AUTH_JWT_SECRET: 'fixture-jwt-secret-at-least-32-characters',
    }), () => true, checks(), { createAlerts, createPush });
    expect(createAlerts.mock.calls[0]![0].channels).toEqual([channel]);
    expect(createPush).toHaveBeenCalledTimes(channel === 'push' ? 1 : 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(runBatch).toHaveBeenCalledTimes(1);
    await stop();
    expect(runBatch.mock.calls[0]![0]!()).toBe(true);
  });

  it('does not strand any timers if enabled Firebase construction fails', async () => {
    vi.useFakeTimers();
    const accountDispatch = vi.fn(), onError = vi.fn();
    const config = loadConfig({ ...base, PRICE_PUSH_ENABLED: 'true', ACCOUNT_MAIL_ENABLED: 'true',
      WEB_ORIGINS: 'https://fixture.invalid', RESEND_SEND_API_KEY: 'fixture', EMAIL_FROM: 'fixture@example.invalid',
      TEMPLATE_PASSWORD_RESET_ID: 'fixture-template', FIREBASE_PROJECT_ID: 'fixture-project', AUTH_JWT_SECRET: 'fixture-jwt-secret-at-least-32-characters' });
    expect(() => startBackgroundWorkers(config, () => true, checks(), { accountDispatch, onError,
      createPush: () => { throw new Error('fixture initialization failure'); },
    })).toThrow('fixture initialization failure');
    await vi.advanceTimersByTimeAsync(60000);
    expect(accountDispatch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('serializes account dispatch, reports only fixed codes, and waits for its active call', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const accountDispatch = vi.fn(async () => { await pending; throw new Error('secret provider error'); });
    const onError = vi.fn();
    const stop = startBackgroundWorkers(loadConfig({ ...base, ACCOUNT_MAIL_ENABLED: 'true', WEB_ORIGINS: 'https://fixture.invalid',
      RESEND_SEND_API_KEY: 'fixture', EMAIL_FROM: 'fixture@example.invalid', TEMPLATE_PASSWORD_RESET_ID: 'fixture-template',
    }), () => true, checks(), { accountDispatch, onError });
    await vi.advanceTimersByTimeAsync(60000);
    expect(accountDispatch).toHaveBeenCalledTimes(1);
    let drained = false;
    const stopped = stop().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    release(); await stopped;
    expect(onError).toHaveBeenCalledExactlyOnceWith('ACCOUNT_MAIL_DISPATCH_FAILED');
    await vi.advanceTimersByTimeAsync(60000);
    expect(accountDispatch).toHaveBeenCalledTimes(1);
  });
});
