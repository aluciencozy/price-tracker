import request from 'supertest';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { hashPassword, verificationSender } from '../src/registration.js';
import * as emails from '../src/emails.js';

afterEach(() => vi.restoreAllMocks());
const app = createApp(loadConfig({ NODE_ENV: 'test' }), () => 'not_configured');
describe('registration offline boundaries', () => {
  it('fails closed without persistence and never issues a session', async () => {
    const res = await request(app).post('/api/auth/mobile/register').send({ email: 'fixture@example.invalid', password: 'fixture password' }).expect(503);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(res.body.error).toEqual({ code: 'SERVICE_UNAVAILABLE', message: expect.any(String), fields: [], requestId: expect.stringMatching(/^[A-Za-z0-9_-]{1,128}$/), retryAfterSeconds: null, resourceId: null });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['set-cookie']).toBeUndefined();
  });
  it('rejects namespace mixing before persistence', async () => {
    await request(app).post('/api/auth/mobile/register').set('Cookie', 'price_tracker_prelogin_dev=invalid').send({}).expect(400);
    await request(app).post('/api/auth/web/register').set('Authorization', 'Bearer invalid').send({}).expect(400);
  });
  it('denies missing/unapproved browser origins', async () => {
    await request(app).post('/api/auth/web/register').send({}).expect(403);
    const res = await request(app).get('/api/auth/web/csrf').set('Origin', 'https://evil.invalid').expect(403);
    expect(res.headers['set-cookie']).toBeUndefined();
  });
  it('allows credentialed web preflight but not native credentialed CORS', async () => {
    const web = await request(app).options('/api/auth/web/register').set('Origin', 'http://localhost:5173').set('Access-Control-Request-Method', 'POST').expect(204);
    expect(web.headers['access-control-allow-credentials']).toBe('true');
    const mobile = await request(app).options('/api/auth/mobile/register').set('Origin', 'http://localhost:5173').set('Access-Control-Request-Method', 'POST').expect(204);
    expect(mobile.headers['access-control-allow-credentials']).toBeUndefined();
  });
  it('returns bounded contract errors for invalid JSON', async () => {
    const res = await request(app).post('/api/auth/mobile/register').type('json').send('{bad').expect(400);
    expect(res.body.error.code).toBe('MALFORMED_REQUEST');
    expect(res.headers['cache-control']).toBe('no-store');
    const large = await request(app).post('/api/auth/mobile/register').send({ value: 'x'.repeat(20000) }).expect(413);
    expect(large.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });
  it('salts strong password hashes without trimming passwords', async () => {
    const hashes = await Promise.all([hashPassword('  fixture password  '), hashPassword('  fixture password  ')]);
    expect(hashes[0]).toMatch(/^scrypt\$32768\$8\$1\$[a-f0-9]{32}\$[a-f0-9]{128}$/);
    expect(hashes[0]).not.toBe(hashes[1]);
  });
  it('uses safe plain-text links and stable per-token idempotency, not remote templates', async () => {
    const send = vi.spyOn(emails, 'sendWithOutcome').mockResolvedValue({ status: 'success', messageId: 'fixture', attempts: 1 });
    await verificationSender('https://tracker.example.invalid')({ email: 'fixture@example.invalid', token: 'a'.repeat(64) });
    const [payload, key] = send.mock.calls[0]!;
    expect(payload).not.toHaveProperty('template');
    expect(payload).not.toHaveProperty('html');
    expect(payload.text).toContain(`https://tracker.example.invalid/verify-email#token=${'a'.repeat(64)}`);
    expect(key).toMatch(/^verify-email:[a-f0-9]{64}$/);
    expect(key).not.toContain('a'.repeat(64));
  });
  it('refuses insecure production/public HTTP cookie configuration', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow('HTTPS');
    expect(() => loadConfig({ WEB_ORIGINS: 'http://example.invalid' })).toThrow('loopback');
  });
  it('does not send email links to HTTP origins even in development', async () => {
    const send = vi.spyOn(emails, 'sendWithOutcome');
    expect(await verificationSender('http://localhost:5173')({ email: 'fixture@example.invalid', token: 'a'.repeat(64) })).toMatchObject({ status: 'permanent_failure' });
    expect(send).not.toHaveBeenCalled();
  });
});
