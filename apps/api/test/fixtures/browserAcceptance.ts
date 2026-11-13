/** Explicit LOCAL TEST harness. Imported only by its fixture tests, never server.ts. */
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import express from 'express';
import type { Server } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createDatabaseIndexes } from '../../src/models/index.js';
import { ProductModel } from '../../src/models/product.js';
import { PriceHistoryModel } from '../../src/models/tracking.js';
import { startAccountMailDispatcher } from '../../src/verificationDispatch.js';
import { sendWithOutcome } from '../../src/emails.js';
import { reserveEmailSend } from '../../src/emailBudget.js';

const uri = 'mongodb://127.0.0.1:27119/?replicaSet=pt_mvp_test';
const databasePattern = /^price_tracker_test_browser_[a-f0-9]{32}$/;

/** Only a single loopback MongoDB host, without credentials or an application database. */
export function browserTestMongoAddress(value: string | undefined): { host: string; port: number } {
  try {
    const url = new URL(value ?? '');
    if (url.protocol !== 'mongodb:' || !['127.0.0.1', 'localhost'].includes(url.hostname) ||
        !url.port || url.username || url.password || !['', '/'].includes(url.pathname) || url.hash) throw new Error();
    const port = Number(url.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error();
    return { host: url.hostname, port };
  } catch {
    throw new Error('A single local TEST_MONGODB_URI without credentials or a database is required.');
  }
}

export function assertBrowserTestDatabase(dbName: string) {
  const address = browserTestMongoAddress(process.env.TEST_MONGODB_URI);
  if (process.env.BROWSER_TEST_DISPOSABLE !== '1' || !databasePattern.test(dbName) ||
      mongoose.connection.name !== dbName || mongoose.connection.readyState !== 1 ||
      mongoose.connection.host !== address.host || mongoose.connection.port !== address.port) {
    throw new Error('Refusing to seed outside the guarded browser-test database.');
  }
}

/** Synthetic QA-only observations, never recorded Steam prices. */
export async function seedBrowserProducts(dbName: string, history: boolean, now = new Date()) {
  assertBrowserTestDatabase(dbName);
  for (const game of [{ steamAppId: '620', providerGameId: '36', title: 'Portal 2', prices: [1499, 1199, 999] },
    { steamAppId: '220', providerGameId: '59', title: 'Half-Life 2', prices: [799, 1299, 999] }]) {
    const product = await ProductModel.create({ provider: 'cheapshark', storeId: '1', market: 'US', currency: 'USD',
      steamAppId: game.steamAppId, providerGameId: game.providerGameId, title: game.title,
      canonicalSteamUrl: `https://store.steampowered.com/app/${game.steamAppId}/`,
      currentPriceMinor: 999, retailPriceMinor: null, dealId: 'browser-fixture', steamTypeValidatedAt: now,
      purchaseUrl: 'https://www.cheapshark.com/redirect?dealID=browser-fixture',
      lastSuccessfulCheckAt: new Date(now.getTime() - 60_000), lastAttemptAt: new Date(now.getTime() - 60_000), nextCheckAt: new Date(now.getTime() + 86400000) });
    if (history) {
      for (const [index, priceMinor] of game.prices.entries()) {
        await PriceHistoryModel.create({ productId: product._id, checkId: `browser-qa-${game.steamAppId}-${index + 1}`,
          priceMinor, currency: 'USD', observedAt: new Date(now.getTime() - (2 - index) * 86400000 - 60_000),
          source: 'CheapShark', dealId: 'browser-fixture' });
      }
    }
  }
}

async function main() {
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
if (mongoose.connection.name !== dbName || !databasePattern.test(dbName)) {
  throw new Error('Refusing unexpected browser-test database.');
}
await createDatabaseIndexes();
await seedBrowserProducts(dbName, process.env.BROWSER_TEST_HISTORY === '1');
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
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
