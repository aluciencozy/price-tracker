import { runPriceChecks, resumeDuePriceChecks, type PriceCheckRunSummary } from './priceChecks.js';

const DAY_MS = 24 * 60 * 60 * 1_000;

export type PriceCheckSchedulerOptions = {
  /** Must be set by the API integration owner; the loop is inert by default. */
  enabled?: boolean;
  intervalMs?: number;
  runOnStart?: boolean;
  run?: typeof runPriceChecks;
  resume?: typeof resumeDuePriceChecks;
  now?: () => Date;
  onError?: (error: unknown) => void;
  onRun?: (summary: PriceCheckRunSummary) => void;
};

/** A small managed daily loop; no hosting vendor or external scheduler is assumed. */
export function startPriceCheckScheduler(options: PriceCheckSchedulerOptions = {}): () => Promise<void> {
  if (options.enabled !== true) return async () => undefined;

  const requestedInterval = options.intervalMs ?? DAY_MS;
  if (!Number.isFinite(requestedInterval) || requestedInterval < 60_000 || requestedInterval > 2_147_483_647) {
    throw new Error('Price-check interval must be between one minute and the maximum Node timer interval.');
  }
  const intervalMs = Math.floor(requestedInterval);
  const run = options.run ?? runPriceChecks;
  const resume = options.resume ?? resumeDuePriceChecks;
  const now = options.now ?? (() => new Date());
  let stopping = false;
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> | null = null;

  const tick = async () => {
    if (stopping) return;
    try {
      await resume();
      const slot = Math.floor(now().getTime() / intervalMs);
      const summary = await run({ runId: `scheduled_${slot}`, mode: 'scheduled' });
      options.onRun?.(summary);
    } catch (error) {
      if (options.onError) options.onError(error);
      else console.error('Scheduled price check failed; inspect persisted run status.');
    }
  };

  const schedule = (delayMs: number) => {
    if (stopping) return;
    timer = setTimeout(() => {
      inFlight = tick().finally(() => {
        inFlight = null;
        schedule(intervalMs);
      });
    }, delayMs);
    timer.unref();
  };

  schedule(options.runOnStart === true ? 0 : intervalMs);

  return async () => {
    stopping = true;
    if (timer) clearTimeout(timer);
    await inFlight;
  };
}
