import { runPriceChecks, resumeDuePriceChecks } from './priceChecks.js';

/** Track accepted admin/scheduled work so shutdown drains before MongoDB disconnects. */
export function createManagedPriceChecks(run: typeof runPriceChecks = runPriceChecks, resume: typeof resumeDuePriceChecks = resumeDuePriceChecks) {
  const active = new Set<Promise<unknown>>();
  let stopping = false;
  const execute: typeof runPriceChecks = options => {
    if (stopping) return Promise.reject(new Error('Price checks are stopping.'));
    const work = Promise.resolve().then(() => run(options));
    active.add(work);
    void work.finally(() => active.delete(work)).catch(() => undefined);
    return work;
  };
  const recover = () => {
    if (stopping) return Promise.reject(new Error('Price checks are stopping.'));
    // One existing run per poll bounds recovery work and gives shutdown a boundary.
    const work = Promise.resolve().then(() => resume(1));
    active.add(work);
    void work.finally(() => active.delete(work)).catch(() => undefined);
    return work;
  };
  return {
    run: execute,
    resume: recover,
    async stop() {
      stopping = true;
      await Promise.allSettled([...active]);
    },
  };
}
