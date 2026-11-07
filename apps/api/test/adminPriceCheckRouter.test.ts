import express from 'express';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it, vi } from 'vitest';
import { createAdminPriceCheckRouter, publicPriceCheck } from '../src/adminPriceCheckRouter.js';
import type { PriceCheckRunSummary } from '../src/priceChecks.js';

export const summary: PriceCheckRunSummary = {
  createdAt: '2026-11-06T12:00:00.000Z', startedAt: '2026-11-06T12:00:00.000Z', finishedAt: '2026-11-06T12:01:00.000Z',
  runId: 'admin_request_123', mode: 'admin', status: 'complete', total: 0,
  counts: { pending: 0, running: 0, succeeded: 0, failed: 0, skipped: 0 },
  truncated: false, nextRetryAt: null, checks: [],
};

describe('admin contract', () => {
  it('maps exact strict aggregate DTOs to the actual OpenAPI schema', () => {
    const contract = JSON.parse(readFileSync(new URL('../../../docs/api/openapi.json', import.meta.url), 'utf8'));
    const definitions = JSON.parse(JSON.stringify(contract.components.schemas).replaceAll('#/components/schemas/', '#/$defs/'));
    const ajv = new Ajv2020({ strict: true, strictTypes: false });
    addFormats.default(ajv);
    const validate = ajv.compile({ $defs: definitions, $ref: '#/$defs/PriceCheck' });
    for (const value of [summary, { ...summary, status: 'running' as const, finishedAt: null }, {
      ...summary, status: 'partial' as const, total: 2, counts: { ...summary.counts, failed: 1, succeeded: 1 },
    }]) expect(validate(publicPriceCheck(value)), JSON.stringify(validate.errors)).toBe(true);
    expect(publicPriceCheck(summary)).not.toHaveProperty('checks');
  });
  it('denies ordinary and absent principals before querying or rate limiting', async () => {
    for (const role of [null, 'user']) {
      const app = express();
      const limit = vi.fn(async () => null);
      app.use(createAdminPriceCheckRouter((_req, res, next) => {
        if (role) res.locals.principal = { userId: 'owner', sessionId: 'sid', transport: 'web', role };
        next();
      }, { limit }));
      const response = await request(app).post('/admin/price-checks').send({ role: 'admin' }).expect(role ? 403 : 401);
      expect(response.body.error.code).toBe(role ? 'ADMIN_REQUIRED' : 'AUTH_REQUIRED');
      expect(limit).not.toHaveBeenCalled();
    }
  });
});
