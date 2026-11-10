import 'dotenv/config';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { connectDatabase, databaseStatus, disconnectDatabase } from './database.js';
import { createDatabaseIndexes } from './models/index.js';
import { resolveApprovedProductPreview } from './productPreviewResolver.js';
import { startBackgroundWorkers } from './backgroundWorkers.js';
import { createManagedPriceChecks } from './managedPriceChecks.js';

const config = loadConfig();
let indexesReady = false;
const priceChecks = createManagedPriceChecks();
const app = createApp(config, () => {
  const status = databaseStatus(config.MONGODB_URI);
  return status === 'connected' && !indexesReady ? 'connecting' : status;
}, config.PRICE_TRACKING_ENABLED ? { runPriceChecks: priceChecks.run, tracking: {
  resolveProduct: resolveApprovedProductPreview, cursorSigningSecret: config.TRACKING_CURSOR_SECRET!,
} } : undefined);
let stopWorkers: () => Promise<void> = async () => undefined;

const server = app.listen(config.PORT, config.HOST, () => {
  console.info(`API listening on http://${config.HOST}:${config.PORT}`);
});

server.on('error', () => {
  console.error('API failed to listen. Check HOST and PORT.');
  process.exitCode = 1;
  shutdown();
});

// The starter can run health checks without requiring a database account.
let stopping = false;
let startup: Promise<void> = Promise.resolve();
if (config.MONGODB_URI) {
  startup = connectDatabase(config.MONGODB_URI).then(() => {
    if (!stopping) return createDatabaseIndexes();
  }).then(() => {
    if (stopping) return;
    stopWorkers = startBackgroundWorkers(config, () => !stopping && indexesReady && databaseStatus(config.MONGODB_URI) === 'connected', priceChecks);
    indexesReady = true;
  }).catch(() => {
    // Do not log driver/adapter errors: they may contain credentials or URLs.
    console.error('Database, indexes or worker setup failed; /api/ready will report unavailable.');
  });
}
function shutdown() {
  if (stopping) {
    return;
  }

  stopping = true;
  indexesReady = false;
  const stopped = Promise.all([stopWorkers(), priceChecks.stop(), startup]);

  // Allow open requests to finish, but do not leave shutdown waiting forever.
  const timeout = setTimeout(() => process.exit(1), 60_000);

  timeout.unref();

  server.close(() => {
    void stopped.then(disconnectDatabase)
      .then(() => {
        clearTimeout(timeout);
        process.exitCode ??= 0;
      })
      .catch(() => {
        process.exitCode = 1;
      });
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
