import { randomUUID } from 'node:crypto';
import type { Response } from 'express';

export function accountError(res: Response, status: number, code: string, message: string) {
  const retry = Number(res.get('Retry-After'));
  return res.status(status).json({ error: {
    code, message, fields: [], requestId: randomUUID(),
    retryAfterSeconds: Number.isSafeInteger(retry) && retry > 0 ? retry : null,
    resourceId: null,
  } });
}
