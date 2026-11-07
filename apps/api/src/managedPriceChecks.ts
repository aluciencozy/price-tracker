import { runPriceChecks } from './priceChecks.js';

/** Track accepted admin/scheduled work so shutdown drains before MongoDB disconnects. */
export function createManagedPriceChecks(run: typeof runPriceChecks = runPriceChecks) {
  const active = new Set<Promise<unknown>>();
  let stopping = false;
  const execute: typeof runPriceChecks = options => {
    if (stopping) return Promise.reject(new Error('Price checks are stopping.'));
    const work = Promise.resolve().then(() => run(options));
    active.add(work);
    void work.finally(() => active.delete(work)).catch(() => undefined);
    return work;
  };
  return {
    run: execute,
    async stop() {
      stopping = true;
      await Promise.allSettled([...active]);
    },
  };
}
