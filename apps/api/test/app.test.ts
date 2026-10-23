import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp, type DatabaseStatus } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const config = loadConfig({ NODE_ENV: 'test' });
const app = createApp(config, () => 'not_configured');

describe('health and readiness', () => {
  it('serves health without MongoDB and includes security headers', async () => {
    const response = await request(app).get('/api/health').expect(200);

    expect(response.body).toEqual({
      status: 'ok',
      service: 'price-tracker-api',
      database: 'not_configured',
    });
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it.each<DatabaseStatus>(['not_configured', 'connecting', 'disconnected'])(
    'is not ready when database is %s',
    async (status) => {
      const response = await request(createApp(config, () => status))
        .get('/api/ready')
        .expect(503);

      expect(response.body).toEqual({ status: 'not_ready', database: status });
    },
  );

  it('is ready only when connected', async () => {
    await request(createApp(config, () => 'connected'))
      .get('/api/ready')
      .expect(200);
  });
});

describe('request boundaries', () => {
  it('allows only configured browser origins', async () => {
    const allowed = await request(app)
      .get('/api/health')
      .set('Origin', 'http://localhost:5173');

    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:5173');

    const denied = await request(app)
      .get('/api/health')
      .set('Origin', 'https://untrusted.example');

    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('returns JSON 404', async () => {
    const response = await request(app).get('/missing').expect(404);

    expect(response.body).toEqual({ error: 'Not found' });
  });

  it('rejects malformed JSON without leaking parser internals', async () => {
    const response = await request(app)
      .post('/missing')
      .type('json')
      .send('{bad')
      .expect(400);

    expect(response.body).toEqual({ error: 'Invalid request body' });
  });

  it('bounds request bodies', async () => {
    const response = await request(app)
      .post('/missing')
      .send({ text: 'x'.repeat(20_000) })
      .expect(413);

    expect(response.body).toEqual({ error: 'Request body too large' });
  });
});

describe('environment validation', () => {
  it('has local safe defaults', () => {
    expect(config.PORT).toBe(4000);
    expect(config.MONGODB_URI).toBeUndefined();
  });

  it.each([
    { PORT: '0' },
    { WEB_ORIGINS: '*' },
    { WEB_ORIGINS: 'https://example.com/path' },
  ])('rejects unsafe configuration %j', (env) => {
    expect(() => loadConfig(env)).toThrow('Invalid environment');
  });

  it('does not echo secrets on invalid input', () => {
    expect(() => loadConfig({ MONGODB_URI: 'secret-password' })).toThrow(
      'Invalid environment: MONGODB_URI',
    );
  });
});
