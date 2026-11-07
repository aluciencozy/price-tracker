import { describe, expect, it, vi } from 'vitest';
import { createManagedPriceChecks } from '../src/managedPriceChecks.js';
import type { runPriceChecks, PriceCheckRunSummary } from '../src/priceChecks.js';

describe('managed accepted price work', () => {
  it('drains accepted work and refuses replacement work during shutdown', async () => {
    let release!: (value: PriceCheckRunSummary) => void;
    const pending = new Promise<PriceCheckRunSummary>(resolve => { release = resolve; });
    const run = vi.fn<typeof runPriceChecks>(() => pending);
    const managed = createManagedPriceChecks(run);
    const work = managed.run({ runId: 'fixture-run', mode: 'admin' });
    let stopped = false;
    const stop = managed.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    await expect(managed.run({ runId: 'fixture-other', mode: 'admin' })).rejects.toThrow('stopping');
    release({} as PriceCheckRunSummary);
    await work; await stop;
    expect(stopped).toBe(true); expect(run).toHaveBeenCalledTimes(1);
  });
});
