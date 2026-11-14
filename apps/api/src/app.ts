import cors from 'cors';
import express, { type ErrorRequestHandler } from 'express';
import helmet from 'helmet';
import type { Config } from './config.js';
import { registrationRouter } from './registrationRouter.js';
import { accountError } from './accountError.js';
import { requireVerifiedUser, type AuthPrincipal } from './authMiddleware.js';
import { createProductPreviewService, type ProductPreviewResolver } from './productPreviews.js';
import { createTrackingRouter } from './trackingRouter.js';
import { createAdminPriceCheckRouter } from './adminPriceCheckRouter.js';
import type { runPriceChecks } from './priceChecks.js';
import { createDeviceRouter } from './deviceRouter.js';

export type DatabaseStatus =
  | 'not_configured'
  | 'connecting'
  | 'connected'
  | 'disconnected';

export function createApp(config: Config, databaseStatus: () => DatabaseStatus, options?: {
  tracking?: { resolveProduct: ProductPreviewResolver; cursorSigningSecret: string };
  runPriceChecks?: typeof runPriceChecks;
}) {
  const app = express();

  // Only a trusted local reverse proxy may supply the client address. The proxy
  // must replace incoming forwarding headers; the local port is not public.
  if (config.NODE_ENV === 'production' && ['127.0.0.1', '::1'].includes(config.HOST)) {
    app.set('trust proxy', 'loopback');
  }
  app.disable('x-powered-by');
  app.use(helmet());

  app.use(cors((req, callback) => callback(null, {
    origin: config.WEB_ORIGINS,
    credentials: !/^\/api\/(?:auth\/mobile|devices)(?:\/|$)/i.test(req.path),
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-CSRF-Token', 'Idempotency-Key', 'Authorization'],
    exposedHeaders: ['Retry-After', 'Location'],
    preflightContinue: true,
  })));
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    // Account routes apply their own transport-aware ordering and origin checks.
    if ((req.method === 'OPTIONS' || !/^\/auth(?:\/|$)/i.test(req.path)) && req.get('Origin') && !config.WEB_ORIGINS.includes(req.get('Origin')!)) {
      return accountError(res, 403, 'ORIGIN_DENIED', 'Origin is not allowed.');
    }
    if (req.method === 'OPTIONS') return res.status(204).end();
    return next();
  });

  app.use('/api/auth', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.use(express.json({ limit: '16kb' }));
  app.use('/api/auth', registrationRouter(config, () => databaseStatus() === 'connected'));
  const devices = createDeviceRouter(async (_req, res) => res.locals.principal as AuthPrincipal);
  const authenticateDevice = requireVerifiedUser(config, 'mobile');
  app.use('/api', (req, res, next) => {
    if (!/^\/devices(?:\/|$)/i.test(req.path)) return next();
    if (databaseStatus() !== 'connected') return accountError(res, 503, 'SERVICE_UNAVAILABLE', 'Device registration is unavailable.');
    return authenticateDevice(req, res, error => {
      if (error) return next(error);
      return devices(req, res, next);
    });
  });
  if (options?.tracking) {
    const tracking = createTrackingRouter(requireVerifiedUser(config), options.tracking.cursorSigningSecret, {
      createPreview: createProductPreviewService({ resolveProduct: options.tracking.resolveProduct }),
      runPriceChecks: options.runPriceChecks,
      ownedRefreshAvailable: config.PRICE_RETRY_WORKER_ENABLED,
    });
    // Avoid the router's authentication middleware intercepting unrelated API paths.
    app.use('/api', (req, res, next) => {
      if (!/^\/(?:product-previews|tracked-items|tracked-item-refreshes)(?:\/|$)/i.test(req.path)) return next();
      if (databaseStatus() !== 'connected') return accountError(res, 503, 'SERVICE_UNAVAILABLE', 'Tracking is unavailable.');
      return tracking(req, res, next);
    });
    const admin = createAdminPriceCheckRouter(requireVerifiedUser(config), { run: options.runPriceChecks });
    app.use('/api', (req, res, next) => {
      if (!/^\/admin\/price-checks(?:\/|$)/i.test(req.path)) return next();
      if (databaseStatus() !== 'connected') return accountError(res, 503, 'SERVICE_UNAVAILABLE', 'Price checks are unavailable.');
      return admin(req, res, next);
    });
  }

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

  app.use((request, response) => {
    if (/^\/api(?:\/|$)/i.test(request.path)) return accountError(response, 404, 'NOT_FOUND', 'Not found.');
    response.status(404).json({ error: 'Not found' });
  });

  const errorHandler: ErrorRequestHandler = (error: unknown, request, response, _next) => {
    const status =
      typeof error === 'object' && error !== null && 'status' in error
        ? error.status
        : undefined;

    if (/^\/api(?:\/|$)/i.test(request.path)) {
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
