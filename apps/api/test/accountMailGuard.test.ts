import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { PreloginModel } from '../src/models/account.js';
import * as rates from '../src/authRateLimit.js';
import * as registration from '../src/registration.js';
import * as resets from '../src/passwordReset.js';
import { csrfForSecret } from '../src/sessionSecurity.js';

const origin = 'https://tracker.example.invalid';
const config = loadConfig({ NODE_ENV: 'production', WEB_ORIGINS: origin, AUTH_JWT_SECRET: 'x'.repeat(32) });
const secret = 'a'.repeat(43);
const body = { email: 'fixture@example.invalid', password: 'fixture password' };
const actions = ['register', 'resend-verification', 'forgot-password'] as const;
const app = createApp(config, () => 'connected');

afterEach(() => vi.restoreAllMocks());

describe('production account mail guard', () => {
  it.each(['web', 'mobile'] as const)('rejects all mail-dependent %s requests before rate limits or account services', async transport => {
    const rate = vi.spyOn(rates, 'limitAuthAttempts');
    const register = vi.spyOn(registration, 'register');
    const resend = vi.spyOn(registration, 'resend');
    const forgot = vi.spyOn(resets, 'requestPasswordReset');
    const csrf = vi.spyOn(PreloginModel, 'exists').mockReturnValue(Promise.resolve({ _id: 'fixture' }) as never);
    for (const action of actions) {
      for (const email of ['fixture@example.invalid', 'other@example.invalid']) {
        const call = request(app).post(`/api/auth/${transport}/${action}`).send({ ...body, email });
        if (transport === 'web') call.set('Origin', origin).set('Cookie', `__Host-price_tracker_prelogin=${secret}`).set('X-CSRF-Token', csrfForSecret(secret));
        const response = await call.expect(503);
        expect(response.body.error).toMatchObject({ code: 'SERVICE_UNAVAILABLE', message: 'Account email is temporarily unavailable. Please try again later.' });
        expect(response.headers['cache-control']).toBe('no-store');
      }
    }
    expect(rate).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
    expect(resend).not.toHaveBeenCalled();
    expect(forgot).not.toHaveBeenCalled();
    if (transport === 'web') expect(csrf).toHaveBeenCalledTimes(6);
  });

  it('preserves origin, CSRF and transport checks before the guard', async () => {
    await request(app).post('/api/auth/web/register').send(body).expect(403).expect(({ body: result }) => expect(result.error.code).toBe('ORIGIN_DENIED'));
    await request(app).post('/api/auth/web/register').set('Origin', origin).send(body).expect(403).expect(({ body: result }) => expect(result.error.code).toBe('CSRF_INVALID'));
    await request(app).post('/api/auth/mobile/register').set('Cookie', '__Host-price_tracker_prelogin=invalid').send(body).expect(400).expect(({ body: result }) => expect(result.error.code).toBe('AUTH_AMBIGUOUS'));
  });

  it.each(['web', 'mobile'] as const)('still processes existing %s verification and reset tokens', async transport => {
    vi.spyOn(PreloginModel, 'exists').mockReturnValue(Promise.resolve({ _id: 'fixture' }) as never);
    vi.spyOn(rates, 'limitAuthAttempts').mockResolvedValue({ blocked: false, retry: 1 });
    const verify = vi.spyOn(registration, 'verify').mockResolvedValue(true);
    const reset = vi.spyOn(resets, 'completePasswordReset').mockResolvedValue(true);
    for (const action of ['verify-email', 'reset-password']) {
      const call = request(app).post(`/api/auth/${transport}/${action}`).send({ token: 'b'.repeat(43), ...(action === 'reset-password' ? { password: body.password } : {}) });
      if (transport === 'web') call.set('Origin', origin).set('Cookie', `__Host-price_tracker_prelogin=${secret}`).set('X-CSRF-Token', csrfForSecret(secret));
      await call.expect(204);
    }
    expect(verify).toHaveBeenCalledOnce();
    expect(reset).toHaveBeenCalledOnce();
  });

  it.each([
    ['test mail disabled', { ...config, NODE_ENV: 'test' as const }],
    ['production mail enabled', { ...config, ACCOUNT_MAIL_ENABLED: true }],
  ])('retains generic 202 behavior for %s', async (_label, settings) => {
    vi.spyOn(rates, 'limitAuthAttempts').mockResolvedValue({ blocked: false, retry: 1 });
    const register = vi.spyOn(registration, 'register').mockResolvedValue(undefined);
    const resend = vi.spyOn(registration, 'resend').mockResolvedValue(undefined);
    const forgot = vi.spyOn(resets, 'requestPasswordReset').mockResolvedValue(undefined);
    const configuredApp = createApp(settings, () => 'connected');
    const responses = [];
    for (const action of actions) {
      responses.push((await request(configuredApp).post(`/api/auth/mobile/${action}`).send(action === 'register' ? body : { email: body.email }).expect(202)).body);
    }
    expect(responses[0]).toEqual(responses[1]);
    expect(responses[1]).toEqual(responses[2]);
    expect(register).toHaveBeenCalledOnce();
    expect(resend).toHaveBeenCalledOnce();
    expect(forgot).toHaveBeenCalledOnce();
  });
});
