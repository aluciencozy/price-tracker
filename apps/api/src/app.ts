import cors from 'cors';
import express, { type ErrorRequestHandler } from 'express';
import helmet from 'helmet';
import type { Config } from './config.js';
import { registrationRouter } from './registrationRouter.js';
import { accountError } from './accountError.js';

export type DatabaseStatus =
  | 'not_configured'
  | 'connecting'
  | 'connected'
  | 'disconnected';

export function createApp(config: Config, databaseStatus: () => DatabaseStatus) {
  const app = express();

  app.disable('x-powered-by');
  app.use(helmet());

  app.use('/api/auth/web', cors({
    origin: config.WEB_ORIGINS, credentials: true, methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'X-CSRF-Token', 'Idempotency-Key'], exposedHeaders: ['Retry-After'],
  }));
  app.use(
    cors({
      origin(origin, callback) {
        // Native clients and CLI requests have no Origin; browsers must match exactly.
        callback(null, !origin || config.WEB_ORIGINS.includes(origin));
      },
      methods: ['GET', 'HEAD', 'POST'],
      credentials: false,
    }),
  );

  app.use('/api/auth', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.use(express.json({ limit: '16kb' }));
  app.use('/api/auth', registrationRouter(config, () => databaseStatus() === 'connected'));

  // Liveness stays available even when MongoDB has not been configured.
  app.get('/api/health', (_request, response) => {
    response.json({
      status: 'ok',
      service: 'price-tracker-api',
      database: databaseStatus(),
    });
  });

  // Readiness is stricter: persistence must be connected before it reports success.
  app.get('/api/ready', (_request, response) => {
    const database = databaseStatus();
    const ready = database === 'connected';

    response.status(ready ? 200 : 503).json({
      status: ready ? 'ready' : 'not_ready',
      database,
    });
  });

  app.use((_request, response) => {
    response.status(404).json({ error: 'Not found' });
  });

  const errorHandler: ErrorRequestHandler = (error: unknown, request, response, _next) => {
    const status =
      typeof error === 'object' && error !== null && 'status' in error
        ? error.status
        : undefined;

    if (request.path.startsWith('/api/auth/')) {
      const code = status === 413 ? 'PAYLOAD_TOO_LARGE' : status === 400 ? 'MALFORMED_REQUEST' : 'INTERNAL_ERROR';
      accountError(response, status === 413 ? 413 : status === 400 ? 400 : 500, code, 'Invalid account request.');
      return;
    }
    // Send safe messages instead of exposing parser errors or internal details.
    if (status === 413) {
      response.status(413).json({ error: 'Request body too large' });
    } else if (status === 400) {
      response.status(400).json({ error: 'Invalid request body' });
    } else {
      response.status(500).json({ error: 'Internal server error' });
    }
  };

  app.use(errorHandler);

  return app;
}
