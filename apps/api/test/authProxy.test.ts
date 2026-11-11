import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import * as rates from '../src/authRateLimit.js';

const production = loadConfig({
  NODE_ENV: 'production', HOST: '127.0.0.1', WEB_ORIGINS: 'https://tracker.example.invalid',
  AUTH_JWT_SECRET: 'x'.repeat(32),
});

afterEach(() => vi.restoreAllMocks());

describe('auth client IP behind a local proxy', () => {
  it('uses the rightmost untrusted address, not a client-supplied prefix', async () => {
    const rate = vi.spyOn(rates, 'limitAuthAttempts').mockResolvedValue({ blocked: true, retry: 60 });
    const app = createApp(production, () => 'connected');
    for (const ip of ['198.51.100.10', '198.51.100.11']) {
      await request(app).post('/api/auth/mobile/login')
        .set('X-Forwarded-For', `203.0.113.99, ${ip}`).send({}).expect(429);
    }
    expect(rate.mock.calls.map(call => call.slice(0, 2))).toEqual([
      ['auth-ip', '198.51.100.10'], ['auth-ip', '198.51.100.11'],
    ]);
  });

  it.each([
    ['test', { ...production, NODE_ENV: 'test' as const }],
    ['development', { ...production, NODE_ENV: 'development' as const }],
    ['production wildcard bind', { ...production, HOST: '0.0.0.0' }],
  ])('ignores forwarded addresses in %s', async (_name, config) => {
    const rate = vi.spyOn(rates, 'limitAuthAttempts').mockResolvedValue({ blocked: true, retry: 60 });
    await request(createApp(config, () => 'connected')).post('/api/auth/mobile/login')
      .set('X-Forwarded-For', '198.51.100.10').send({}).expect(429);
    expect(rate.mock.calls[0]?.[1]).toMatch(/^(::ffff:)?127\.0\.0\.1$|^::1$/);
  });

  it('does not trust forwarded headers from a non-loopback peer even on a loopback-configured app', async () => {
    const rate = vi.spyOn(rates, 'limitAuthAttempts').mockResolvedValue({ blocked: true, retry: 60 });
    const wrapper = express();
    wrapper.use((req, _res, next) => {
      Object.defineProperty(req.socket, 'remoteAddress', { value: '192.0.2.15', configurable: true });
      next();
    });
    wrapper.use(createApp(production, () => 'connected'));
    await request(wrapper).post('/api/auth/mobile/login').set('X-Forwarded-For', '198.51.100.10').send({}).expect(429);
    expect(rate.mock.calls[0]?.[1]).toBe('192.0.2.15');
  });
});
