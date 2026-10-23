import 'dotenv/config';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { connectDatabase, databaseStatus, disconnectDatabase } from './database.js';

const config = loadConfig();
const app = createApp(config, () => databaseStatus(config.MONGODB_URI));

const server = app.listen(config.PORT, config.HOST, () => {
  console.info(`API listening on http://${config.HOST}:${config.PORT}`);
});

server.on('error', () => {
  console.error('API failed to listen. Check HOST and PORT.');
  process.exitCode = 1;
});

// The starter can run health checks without requiring a database account.
if (config.MONGODB_URI) {
  void connectDatabase(config.MONGODB_URI).catch(() => {
    // Do not log driver errors: they may contain credentials or connection URLs.
    console.error('Database connection failed; /api/ready will report unavailable.');
  });
}

let stopping = false;

function shutdown() {
  if (stopping) {
    return;
  }

  stopping = true;

  // Allow open requests to finish, but do not leave shutdown waiting forever.
  const timeout = setTimeout(() => process.exit(1), 10_000);

  timeout.unref();

  server.close(() => {
    void disconnectDatabase()
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
