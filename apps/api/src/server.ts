import 'dotenv/config';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { connectDatabase, databaseStatus, disconnectDatabase } from './database.js';
import { createDatabaseIndexes } from './models/index.js';
import { resolveApprovedProductPreview } from './productPreviewResolver.js';
import { startPriceCheckScheduler } from './priceCheckScheduler.js';
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
let stopScheduler: () => Promise<void> = async () => undefined;

const server = app.listen(config.PORT, config.HOST, () => {
  console.info(`API listening on http://${config.HOST}:${config.PORT}`);
});

server.on('error', () => {
  console.error('API failed to listen. Check HOST and PORT.');
  process.exitCode = 1;
});

// The starter can run health checks without requiring a database account.
if (config.MONGODB_URI) {
  void connectDatabase(config.MONGODB_URI).then(createDatabaseIndexes).then(() => {
    if (stopping) return;
    indexesReady = true;
    stopScheduler = startPriceCheckScheduler({ enabled: config.PRICE_SCHEDULER_ENABLED, run: priceChecks.run });
  }).catch(() => {
    // Do not log driver errors: they may contain credentials or connection URLs.
    console.error('Database connection or index setup failed; /api/ready will report unavailable.');
  });
}

let stopping = false;
// Account mail stays disabled until the shared email-budget gate is integrated.

function shutdown() {
  if (stopping) {
    return;
  }

  stopping = true;
  indexesReady = false;
  const stopped = Promise.all([stopScheduler(), priceChecks.stop()]);

  // Allow open requests to finish, but do not leave shutdown waiting forever.
  const timeout = setTimeout(() => process.exit(1), 10_000);

  timeout.unref();

  server.close(() => {
    void stopped.then(disconnectDatabase)
      .then(() => {
        clearTimeout(timeout);
        process.exitCode = 0;
      })
      .catch(() => {
        process.exitCode = 1;
      });
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
