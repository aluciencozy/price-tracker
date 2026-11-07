/** Explicit LOCAL TEST harness. Never imported by server.ts or normal test suites. */
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import express from 'express';
import type { Server } from 'node:http';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createDatabaseIndexes } from '../../src/models/index.js';
import { ProductModel } from '../../src/models/product.js';
import { startAccountMailDispatcher } from '../../src/verificationDispatch.js';
import { sendWithOutcome } from '../../src/emails.js';
import { reserveEmailSend } from '../../src/emailBudget.js';

const uri = 'mongodb://127.0.0.1:27060/?replicaSet=pt_test';
if (process.env.BROWSER_TEST_DISPOSABLE !== '1' || process.env.TEST_MONGODB_URI !== uri) {
  throw new Error('Explicit disposable browser-test opt-in and approved TEST_MONGODB_URI required.');
}
const dbName = `price_tracker_test_browser_${randomUUID().replaceAll('-', '')}`;
console.info(`Fixture database: ${dbName}`);
const origin = 'http://127.0.0.1:5176';
const mailbox: Array<{ email: string; purpose: string; url: string }> = [];
let server: Server | undefined;
let stopMail: (() => Promise<void>) | undefined;
let stopRequested = false;
let wake!: () => void;
const stopped = new Promise<void>(resolve => { wake = resolve; });
const requestStop = () => { stopRequested = true; wake(); };
process.once('SIGINT', requestStop);
process.once('SIGTERM', requestStop);
try {
await mongoose.connect(uri, { dbName, autoIndex: false, serverSelectionTimeoutMS: 1000,
  connectTimeoutMS: 1000, socketTimeoutMS: 1000, waitQueueTimeoutMS: 500, bufferCommands: false });
if (mongoose.connection.name !== dbName || !/^price_tracker_test_browser_[a-f0-9]{32}$/.test(dbName)) {
  throw new Error('Refusing unexpected browser-test database.');
}
await createDatabaseIndexes();
for (const game of [{ steamAppId: '620', providerGameId: '36', title: 'Portal 2' },
  { steamAppId: '220', providerGameId: '59', title: 'Half-Life 2' }]) {
  await ProductModel.create({ ...game, provider: 'cheapshark', storeId: '1', market: 'US', currency: 'USD',
    canonicalSteamUrl: `https://store.steampowered.com/app/${game.steamAppId}/`,
    currentPriceMinor: 999, retailPriceMinor: null, dealId: 'browser-fixture',
    purchaseUrl: 'https://www.cheapshark.com/redirect?dealID=browser-fixture',
    lastSuccessfulCheckAt: new Date(), lastAttemptAt: new Date(), nextCheckAt: new Date(Date.now() + 86400000) });
}
const config = loadConfig({ NODE_ENV: 'test', WEB_ORIGINS: origin,
  AUTH_JWT_SECRET: 'local-browser-test-only-never-a-production-secret' });
const app = express();
// Local-only inspection endpoint, not part of the application API or a real mailbox.
app.get('/api/__fixture/mailbox', (_req, res) => res.set('Cache-Control', 'no-store').json({ fixture: true, messages: mailbox }));
app.use(createApp(config, () => mongoose.connection.readyState === 1 ? 'connected' : 'disconnected', {
  tracking: { cursorSigningSecret: 'local-browser-test-only-cursor-secret', resolveProduct: async (id, signal) => {
    signal.throwIfAborted();
    return ProductModel.findById(id).orFail().lean().exec();
  } },
  // Browser QA may prove authorization rejection, but never enqueue provider work.
  runPriceChecks: async () => { throw new Error('Checks disabled in browser fixture harness.'); },
}));
const sender = (purpose: 'verify-email' | 'reset-password') => async ({ email, token }: { email: string; token: string }) => {
  const url = `${origin}/${purpose}#token=${token}`;
  return sendWithOutcome({ from: 'fixture@example.invalid', to: email, subject: 'LOCAL TEST ONLY', text: url },
    `browser-${purpose}-${token}`, async () => {
      mailbox.push({ email, purpose, url });
      return { data: { id: randomUUID() }, error: null, headers: null };
    }, reserveEmailSend);
};
if (stopRequested) throw new Error('Fixture startup interrupted.');
server = app.listen(4016, '127.0.0.1');
await new Promise<void>((resolve, reject) => {
  server!.once('listening', resolve);
  server!.once('error', reject);
});
if (stopRequested) throw new Error('Fixture startup interrupted.');
stopMail = startAccountMailDispatcher(sender('verify-email'), sender('reset-password'), () => mongoose.connection.readyState === 1);
console.info('LOCAL FIXTURES ONLY: API 127.0.0.1:4016; web origin 127.0.0.1:5176; mailbox /api/__fixture/mailbox. No external sends or checks.');
await stopped;
} catch {
  console.error('Fixture startup failed or was interrupted. No other service was stopped.');
  process.exitCode = 1;
} finally {
  // Bound shutdown; on timeout do not drop data while a task may still use it.
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let cleanupExpired = false;
  try {
    await Promise.race([
      (async () => {
        if (server?.listening) {
          await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
        }
        await stopMail?.();
        if (!cleanupExpired && /^price_tracker_test_browser_[a-f0-9]{32}$/.test(dbName) && mongoose.connection.name === dbName && mongoose.connection.readyState === 1) {
          await mongoose.connection.dropDatabase();
        }
        await mongoose.disconnect();
      })(),
      new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => { cleanupExpired = true; reject(new Error('Shutdown timeout')); }, 10_000); }),
    ]);
  } catch {
    console.error(`Fixture cleanup incomplete. Inspect only the printed fixture database ${dbName}; do not bulk-drop databases.`);
    process.exitCode = 1;
    server?.closeAllConnections();
    // Close the local driver; do not stop the MongoDB server.
    await Promise.race([mongoose.disconnect(), new Promise<void>(resolve => setTimeout(resolve, 1000))]);
  } finally {
    if (timeout) clearTimeout(timeout);
    process.removeListener('SIGINT', requestStop);
    process.removeListener('SIGTERM', requestStop);
  }
}
