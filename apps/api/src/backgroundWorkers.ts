import type { Config } from './config.js';
import { createPriceAlertDeliveryWorker, type AlertDeliveryWorkerOptions } from './alertDeliveryWorker.js';
import { createFirebaseFcmSender } from './fcm.js';
import { verificationSender } from './registration.js';
import { passwordResetSender } from './passwordReset.js';
import { dispatchPendingAccountMail, recoverVerificationMail } from './verificationDispatch.js';
import type { createManagedPriceChecks } from './managedPriceChecks.js';

const DAY_MS = 86400000;
type Checks = Pick<ReturnType<typeof createManagedPriceChecks>, 'run' | 'resume'>;
type Dependencies = {
  accountDispatch?: () => Promise<unknown>;
  createAlerts?: typeof createPriceAlertDeliveryWorker;
  createPush?: typeof createFirebaseFcmSender;
  now?: () => Date;
  onError?: (code: string) => void;
};

/** Construct only after database indexes are ready. No channel is enabled by credentials. */
export function startBackgroundWorkers(config: Config, connected: () => boolean, checks: Checks, dependencies: Dependencies = {}) {
  let stopping = false;
  const stops: Array<() => Promise<void>> = [];
  const now = dependencies.now ?? (() => new Date());
  const report = (code: string) => {
    try { (dependencies.onError ?? console.error)(code); } catch { /* Reporting cannot change delivery state. */ }
  };
  const unavailable = () => stopping || !connected();
  // Finish adapter construction before scheduling any loops. A startup error
  // cannot strand a live mail timer while the API remains unready.
  let alertWorker: ReturnType<typeof createPriceAlertDeliveryWorker> | undefined;
  if (config.PRICE_EMAIL_ENABLED || config.PRICE_PUSH_ENABLED) {
    const options: AlertDeliveryWorkerOptions = {
      channels: [ ...(config.PRICE_EMAIL_ENABLED ? ['email' as const] : []), ...(config.PRICE_PUSH_ENABLED ? ['push' as const] : []) ],
      batchSize: 5, onError: report,
    };
    if (config.PRICE_PUSH_ENABLED) options.pushSender = (dependencies.createPush ?? createFirebaseFcmSender)(config.FIREBASE_PROJECT_ID!);
    alertWorker = (dependencies.createAlerts ?? createPriceAlertDeliveryWorker)(options);
  }

  // Each loop schedules after completion, never accumulates queued ticks, and
  // waits for its current bounded operation before shutdown can disconnect MongoDB.
  function poll(interval: number, code: string, work: () => Promise<unknown>) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active: Promise<void> | undefined;
    const tick = () => {
      active = (async () => { if (!unavailable()) await work(); })()
        .catch(() => report(code)).finally(() => {
          if (!stopping) { timer = setTimeout(tick, interval); timer.unref(); }
        });
    };
    timer = setTimeout(tick, 0);
    timer.unref();
    stops.push(async () => { if (timer) clearTimeout(timer); await active; });
  }

  // Separate clock rates: create one daily UTC-slot run, but recover due work
  // every minute. Local scheduled/recovery ticks do not overlap; MongoDB leases
  // additionally protect against admin work and accidentally duplicated processes.
  let priceBusy = false;
  let scheduledSlot: number | undefined;
  if (config.PRICE_SCHEDULER_ENABLED) poll(60000, 'PRICE_SCHEDULE_FAILED', async () => {
    const slot = Math.floor(now().getTime() / DAY_MS);
    if (priceBusy || scheduledSlot === slot) return;
    priceBusy = true;
    try {
      const runId = `scheduled_${slot}`;
      const summary = await checks.run({ runId, mode: 'scheduled' });
      // Global contention can return the already-active admin/other run instead.
      // Only remember our slot after its own durable run actually exists.
      if (summary.runId === runId) scheduledSlot = slot;
    } finally { priceBusy = false; }
  });
  if (config.PRICE_RETRY_WORKER_ENABLED) poll(config.PRICE_RETRY_INTERVAL_MS, 'PRICE_RECOVERY_FAILED', async () => {
    if (priceBusy) return;
    priceBusy = true;
    try { await checks.resume(); } finally { priceBusy = false; }
  });

  if (config.ACCOUNT_MAIL_ENABLED) {
    const verification = verificationSender(config.WEB_ORIGINS[0]!);
    const reset = passwordResetSender(config.WEB_ORIGINS[0]!);
    const dispatch = dependencies.accountDispatch ?? (async () => {
      await recoverVerificationMail();
      if (!unavailable()) await dispatchPendingAccountMail(verification, reset);
    });
    poll(config.WORKER_POLL_INTERVAL_MS, 'ACCOUNT_MAIL_DISPATCH_FAILED', dispatch);
  }
  if (alertWorker) poll(config.WORKER_POLL_INTERVAL_MS, 'ALERT_DELIVERY_BATCH_FAILED', () => alertWorker.runBatch(unavailable));

  return async () => {
    stopping = true;
    await Promise.all(stops.map(stop => stop()));
  };
}
