import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function hourlyRunId(now = new Date()) {
  const time = now.getTime();
  if (!Number.isFinite(time)) throw new Error('Invalid schedule time.');
  return `scheduled_hourly_${Math.floor(time / 3_600_000)}`;
}

export async function runHourlyPriceCheck(dependencies, uri, now = new Date()) {
  const runId = hourlyRunId(now);
  try {
    await dependencies.connect(uri);
    await dependencies.indexes();
    await dependencies.resume(1);
    const result = await dependencies.run({ runId, mode: 'scheduled', maxProducts: 100 });
    // A concurrent admin/API run can hold the global lease. A later invocation
    // resumes due work first and selects its current UTC-hour slot.
    if (result.runId !== runId) return { runId, status: 'deferred', exitCode: 75 };
    return { runId, status: result.status, counts: result.counts, exitCode: result.status === 'complete' ? 0 : 1 };
  } finally {
    await dependencies.disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    // Resolve once, so a deployment cannot mix modules from two releases.
    const release = realpathSync('/srv/price-tracker/current');
    const load = path => import(pathToFileURL(`${release}/apps/api/dist/${path}`).href);
    const { loadConfig } = await load('config.js');
    const config = loadConfig();
    if (!config.PRICE_TRACKING_ENABLED || !config.MONGODB_URI) throw new Error('Tracking is not configured.');
    const database = await load('database.js');
    const models = await load('models/index.js');
    const checks = await load('priceChecks.js');
    const result = await runHourlyPriceCheck({
      connect: database.connectDatabase, disconnect: database.disconnectDatabase,
      indexes: models.createDatabaseIndexes, resume: checks.resumeDuePriceChecks,
      run: checks.runPriceChecks,
    }, config.MONGODB_URI);
    console.log(JSON.stringify(result));
    process.exitCode = result.exitCode;
  } catch {
    console.error('Hourly price check failed. Inspect persisted run status; no credentials or raw provider errors logged.');
    process.exitCode = 1;
  }
}
