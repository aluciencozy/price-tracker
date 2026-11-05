import { randomUUID } from 'node:crypto';
import { Router, type Request } from 'express';
import { createHistoryService, HistoryError } from './history.js';

/** The API auth owner must supply verified session authentication. No default,
 * request-header shortcut, development identity, or anonymous route is provided. */
export function createHistoryRouter(authenticate: (request: Request) => Promise<{ userId: string }>, signingSecret: string) {
  const router = Router();
  const readHistory = createHistoryService(signingSecret);
  router.get('/tracked-items/:id/history', async (request, response) => {
    const requestId = randomUUID();
    try {
      const principal = await authenticate(request);
      const result = await readHistory(principal.userId, request.params.id, request.query);
      response.set('Cache-Control', 'no-store').json(result);
    } catch (error) {
      const known = error instanceof HistoryError;
      response.status(known ? error.status : 503).set('Cache-Control', 'no-store').json({ error: {
        code: known ? error.code : 'SERVICE_UNAVAILABLE',
        message: known ? error.message : 'History is temporarily unavailable.',
        fields: [], requestId, retryAfterSeconds: null, resourceId: null,
      } });
    }
  });
  return router;
}
