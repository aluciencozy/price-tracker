import 'dotenv/config';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { connectDatabase, databaseStatus, disconnectDatabase } from './database.js';
import { createDatabaseIndexes } from './models/index.js';
import { startVerificationDispatcher } from './verificationDispatch.js';
import { verificationSender } from './registration.js';

const config = loadConfig();
let indexesReady = false;
const app = createApp(config, () => {
  const status = databaseStatus(config.MONGODB_URI);
  return status === 'connected' && !indexesReady ? 'connecting' : status;
});

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
    indexesReady = true;
  }).catch(() => {
    // Do not log driver errors: they may contain credentials or connection URLs.
    console.error('Database connection or index setup failed; /api/ready will report unavailable.');
  });
}

let stopping = false;
const stopVerificationDispatcher = startVerificationDispatcher(
  verificationSender(config.WEB_ORIGINS[0]!),
  () => indexesReady && databaseStatus(config.MONGODB_URI) === 'connected',
);

function shutdown() {
  if (stopping) {
    return;
  }

  stopping = true;

  // Allow open requests to finish, but do not leave shutdown waiting forever.
  const timeout = setTimeout(() => process.exit(1), 10_000);

  timeout.unref();

  server.close(() => {
    void stopVerificationDispatcher().then(disconnectDatabase)
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
