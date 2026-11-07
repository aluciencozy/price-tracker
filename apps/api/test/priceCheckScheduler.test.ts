import { afterEach, describe, expect, it, vi } from 'vitest';
import { startPriceCheckScheduler } from '../src/priceCheckScheduler.js';
import type { PriceCheckRunSummary } from '../src/priceChecks.js';

const summary: PriceCheckRunSummary = {
  createdAt: '2026-11-06T12:00:00.000Z', startedAt: null, finishedAt: null,
  runId: 'scheduled_1', mode: 'scheduled', status: 'complete', total: 0,
  counts: { pending: 0, running: 0, succeeded: 0, failed: 0, skipped: 0 },
  truncated: false, nextRetryAt: null, checks: [],
};

afterEach(() => vi.useRealTimers());

describe('managed price-check scheduler', () => {
  it('does not start work unless integration explicitly enables it', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => summary);
    const resume = vi.fn(async () => []);
    const stop = startPriceCheckScheduler({ enabled: false, runOnStart: true, run, resume });
    await vi.advanceTimersByTimeAsync(0);
    await stop();
    expect(run).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
  });

  it('resumes durable scheduled work before the current slot and stops cleanly', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => summary);
    const resume = vi.fn(async () => []);
    const onRun = vi.fn();
    const stop = startPriceCheckScheduler({
      enabled: true, runOnStart: true, intervalMs: 60_000,
      now: () => new Date(60_000), run, resume, onRun,
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(resume).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith({ runId: 'scheduled_1', mode: 'scheduled' });
    expect(onRun).toHaveBeenCalledWith(summary);
    await stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
