import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { cookiePolicy } from '../src/sessionSecurity.js';

describe('session configuration and cookie policy', () => {
  it('requires a persistent JWT key in production and rejects keys shorter than 32 characters', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', WEB_ORIGINS: 'https://tracker.example' }))
      .toThrow('Production AUTH_JWT_SECRET is required');
    expect(() => loadConfig({ NODE_ENV: 'test', AUTH_JWT_SECRET: 'short' }))
      .toThrow('Invalid environment: AUTH_JWT_SECRET');
  });

  it('uses Secure host-only production cookie names and a loopback-only local exception', () => {
    const production = loadConfig({
      NODE_ENV: 'production', WEB_ORIGINS: 'https://tracker.example',
      AUTH_JWT_SECRET: 'fixture-production-signing-key-32-bytes-minimum',
    });
    expect(cookiePolicy(production)).toMatchObject({
      secure: true,
      sessionName: '__Host-price_tracker_session',
      preloginName: '__Host-price_tracker_prelogin',
      options: { httpOnly: true, secure: true, sameSite: 'lax', path: '/' },
    });

    const local = loadConfig({ NODE_ENV: 'development', WEB_ORIGINS: 'http://127.0.0.1:5173' });
    expect(cookiePolicy(local)).toMatchObject({
      secure: false, sessionName: 'price_tracker_session_dev', preloginName: 'price_tracker_prelogin_dev',
    });
    expect(() => loadConfig({ NODE_ENV: 'development', WEB_ORIGINS: 'http://192.168.1.20:5173' }))
      .toThrow('HTTP WEB_ORIGINS must use exact loopback hosts');
  });
});
