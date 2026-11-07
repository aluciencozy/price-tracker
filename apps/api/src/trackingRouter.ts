import { createHash, randomUUID } from 'node:crypto';
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { AuthLimitModel } from './models/account.js';
import { HistoryError, createHistoryService } from './history.js';
import type { ProductPreviewService } from './productPreviews.js';
import { createTrackedItemService } from './trackedItems.js';
import { TrackingError } from './trackingErrors.js';

export type VerifiedPrincipal = {
  userId: string;
  sessionId: string;
  transport: 'web' | 'mobile';
  role: 'user' | 'admin';
};

type PrincipalLocals = { principal?: VerifiedPrincipal };
type Route = (request: Request, response: Response) => Promise<void>;

const activePreviewByUser = new Map<string, number>();

function principalFrom(response: Response): VerifiedPrincipal {
  const principal = (response.locals as PrincipalLocals).principal;
  if (!principal || !/^[a-f0-9]{24}$/.test(principal.userId) ||
      typeof principal.sessionId !== 'string' || !principal.sessionId ||
      !['web', 'mobile'].includes(principal.transport) || !['user', 'admin'].includes(principal.role)) {
    throw new TrackingError(401, 'AUTH_REQUIRED', 'Sign in to use the tracking API.');
  }
  return principal;
}

async function fixedWindowLimit(scope: string, identity: string, maximum: number): Promise<number | null> {
  const windowMs = 60_000;
  const now = Date.now();
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const expiresAt = new Date(windowStart + windowMs);
  const key = createHash('sha256').update(`tracking-preview:${scope}:${identity}:${windowStart}`).digest('hex');
  let row;
  try {
    row = await AuthLimitModel.findOneAndUpdate({ key }, {
      $inc: { attempts: 1 }, $setOnInsert: { expiresAt },
    }, { upsert: true, returnDocument: 'after' }).exec();
  } catch (error) {
    if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 11000)) throw error;
    row = await AuthLimitModel.findOneAndUpdate({ key }, { $inc: { attempts: 1 } }, { returnDocument: 'after' }).orFail().exec();
  }
  return row!.attempts > maximum ? Math.max(1, Math.ceil((expiresAt.getTime() - now) / 1000)) : null;
}

function bodyless(request: Request): boolean {
  const length = request.get('Content-Length');
  return (length !== undefined && Number(length) > 0) || request.get('Transfer-Encoding') !== undefined;
}

function requireJson(request: Request): void {
  const type = request.get('Content-Type') ?? '';
  if (!/^application\/json(?:\s*;|$)/i.test(type)) throw new TrackingError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Use application/json.');
}

function duplicateQuery(request: Request): void {
  if (bodyless(request)) throw new TrackingError(400, 'MALFORMED_REQUEST', 'This request must not include a body.');
}

function errorEnvelope(response: Response, error: unknown): void {
  const requestId = randomUUID();
  let known: TrackingError;
  if (error instanceof TrackingError) {
    known = error;
  } else if (error instanceof HistoryError) {
    known = new TrackingError(error.status, error.code, error.message);
  } else {
    known = new TrackingError(500, 'INTERNAL_ERROR', 'The request could not be completed.');
  }
  if (known.retryAfterSeconds !== null) response.set('Retry-After', String(known.retryAfterSeconds));
  response.status(known.status).set('Cache-Control', 'no-store').json({ error: {
    code: known.code,
    message: known.message,
    fields: known.fields,
    requestId,
    retryAfterSeconds: known.retryAfterSeconds,
    resourceId: known.resourceId,
  } });
}

function endpoint(handler: Route): RequestHandler {
  return (request, response) => {
    void handler(request, response).catch(error => errorEnvelope(response, error));
  };
}

async function enterPreviewSlot(userId: string, request: Request): Promise<() => void> {
  const active = activePreviewByUser.get(userId) ?? 0;
  if (active >= 2) throw new TrackingError(429, 'RATE_LIMITED', 'Too many previews are already running.', [], 1);
  activePreviewByUser.set(userId, active + 1);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const remaining = (activePreviewByUser.get(userId) ?? 1) - 1;
    if (remaining <= 0) activePreviewByUser.delete(userId);
    else activePreviewByUser.set(userId, remaining);
  };
  try {
    const peer = request.ip || request.socket.remoteAddress || 'unknown';
    const ipRetry = await fixedWindowLimit('preview-ip', peer, 20);
    if (ipRetry !== null) throw new TrackingError(429, 'RATE_LIMITED', 'The preview request limit was reached.', [], ipRetry);
    const userRetry = await fixedWindowLimit('preview-user', userId, 5);
    if (userRetry !== null) throw new TrackingError(429, 'RATE_LIMITED', 'The preview request limit was reached.', [], userRetry);
    return release;
  } catch (error) {
    release();
    throw error;
  }
}

/**
 * Auth is always injected. The provided middleware must validate a verified,
 * revocable session, reject ambiguous transports, and enforce web Origin/CSRF
 * on every mutation before setting res.locals.principal.
 */
export function createTrackingRouter(
  requireVerifiedUser: RequestHandler,
  cursorSigningSecret: string,
  options: { createPreview: ProductPreviewService; now?: () => Date },
) {
  const router = Router();
  const previews = options.createPreview;
  const trackers = createTrackedItemService(cursorSigningSecret, { now: options.now });
  const history = createHistoryService(cursorSigningSecret);

  router.use((_request, response, next) => {
    response.set('Cache-Control', 'no-store');
    next();
  });
  router.use(requireVerifiedUser);

  router.post('/product-previews', endpoint(async (request, response) => {
    const principal = principalFrom(response);
    requireJson(request);
    const release = await enterPreviewSlot(principal.userId, request);
    try {
      const result = await previews(principal.userId, request.body);
      response.status(201).json(result);
    } finally {
      release();
    }
  }));

  router.get('/tracked-items', endpoint(async (request, response) => {
    duplicateQuery(request);
    const result = await trackers.listOwnedItems(principalFrom(response).userId, request.query);
    response.json(result);
  }));

  router.post('/tracked-items', endpoint(async (request, response) => {
    const principal = principalFrom(response);
    requireJson(request);
    const result = await trackers.createOwnedItem(principal.userId, request.body, request.get('Idempotency-Key'));
    response.set('Location', result.location).status(result.status).json(result.body);
  }));

  router.get('/tracked-items/:id/history', endpoint(async (request, response) => {
    duplicateQuery(request);
    const result = await history(principalFrom(response).userId, String(request.params.id ?? ''), request.query);
    response.json(result);
  }));

  router.get('/tracked-items/:id', endpoint(async (request, response) => {
    duplicateQuery(request);
    response.json(await trackers.readOwnedItem(principalFrom(response).userId, request.params.id));
  }));

  router.patch('/tracked-items/:id', endpoint(async (request, response) => {
    const principal = principalFrom(response);
    requireJson(request);
    response.json(await trackers.updateOwnedItem(principal.userId, request.params.id, request.body));
  }));

  router.delete('/tracked-items/:id', endpoint(async (request, response) => {
    duplicateQuery(request);
    await trackers.deleteOwnedItem(principalFrom(response).userId, request.params.id);
    response.status(204).send();
  }));

  return router;
}
