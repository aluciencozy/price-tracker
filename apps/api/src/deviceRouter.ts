import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { DeviceError, registerDevice, updateDevice, removeDevice, type MobilePrincipal } from './devices.js';

/** Supply the real native bearer authenticator, including cookie-ambiguity rejection. */
export function createDeviceRouter(authenticate: (request: Request, response: Response) => Promise<MobilePrincipal>) {
  const router = Router();
  const handle = (operation: (request: Request, principal: MobilePrincipal, response: Response) => Promise<void>) => async (request: Request, response: Response) => {
    try { await operation(request, await authenticate(request, response), response); }
    catch (error) {
      const known = error instanceof DeviceError;
      response.status(known ? error.status : 503).set('Cache-Control', 'no-store').json({ error: {
        code: known ? error.code : 'SERVICE_UNAVAILABLE', message: known ? error.message : 'Device registration is temporarily unavailable.',
        fields: [], requestId: randomUUID(), retryAfterSeconds: null, resourceId: null,
      } });
    }
  };
  router.post('/devices', handle(async (request, principal, response) => {
    response.status(201).set('Cache-Control', 'no-store').json(await registerDevice(principal, request.body));
  }));
  router.put('/devices/:id', handle(async (request, principal, response) => {
    response.set('Cache-Control', 'no-store').json(await updateDevice(principal, String(request.params.id), request.body));
  }));
  router.delete('/devices/:id', handle(async (request, principal, response) => {
    if (request.body !== undefined || Number(request.headers['content-length'] ?? 0) > 0 || request.headers['transfer-encoding']) {
      throw new DeviceError(400, 'MALFORMED_REQUEST', 'Device removal does not accept a body.');
    }
    await removeDevice(principal, String(request.params.id));
    response.status(204).set('Cache-Control', 'no-store').end();
  }));
  return router;
}
