import assert from 'node:assert/strict';
import test from 'node:test';
import { hourlyRunId, runHourlyPriceCheck } from '../deploy/vm/hourly-price-check.mjs';

const now = new Date('2026-11-10T23:30:00Z');
function fixture(result) {
  const calls = [];
  return { calls, dependencies: {
    connect: async () => { calls.push('connect'); },
    disconnect: async () => { calls.push('disconnect'); },
    indexes: async () => { calls.push('indexes'); },
    resume: async limit => { assert.equal(limit, 1); calls.push('resume'); },
    run: async options => { calls.push(options); return result; },
  } };
}
test('same UTC hour retains identity across retries and day boundary advances it', () => {
  assert.equal(hourlyRunId(now), hourlyRunId(new Date('2026-11-10T23:59:59Z')));
  assert.notEqual(hourlyRunId(now), hourlyRunId(new Date('2026-11-11T00:00:00Z')));
  assert.throws(() => hourlyRunId(new Date('invalid')));
});
test('uses shared scheduled check and recovery services with a bounded selection', async () => {
  const { calls, dependencies } = fixture({ runId: hourlyRunId(now), status: 'complete', counts: { succeeded: 2 } });
  const result = await runHourlyPriceCheck(dependencies, 'fixture-uri', now);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(calls, ['connect', 'indexes', 'resume', { runId: hourlyRunId(now), mode: 'scheduled', maxProducts: 100 }, 'disconnect']);
});
test('global contention defers instead of claiming another run as this hour', async () => {
  const { dependencies } = fixture({ runId: 'active_admin_run', status: 'running' });
  assert.equal((await runHourlyPriceCheck(dependencies, 'fixture-uri', now)).exitCode, 75);
});
test('partial work remains a failure and disconnects for lease-safe recovery', async () => {
  const { calls, dependencies } = fixture({ runId: hourlyRunId(now), status: 'partial', counts: { failed: 1 } });
  assert.equal((await runHourlyPriceCheck(dependencies, 'fixture-uri', now)).exitCode, 1);
  assert.equal(calls.at(-1), 'disconnect');
});
test('startup failure still closes its database connection', async () => {
  const { calls, dependencies } = fixture(null);
  dependencies.indexes = async () => { throw new Error('fixture'); };
  await assert.rejects(runHourlyPriceCheck(dependencies, 'fixture-uri', now));
  assert.equal(calls.at(-1), 'disconnect');
});
