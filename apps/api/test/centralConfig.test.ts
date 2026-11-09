import { describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { loadConfig } from '../src/config.js';
import { connectDatabase } from '../src/database.js';

describe('central runtime activation gates', () => {
  it('defaults to no real tracking or scheduler and requires a stable cursor secret for opt-in', () => {
    const config = loadConfig({ NODE_ENV: 'test' });
    expect(config.PRICE_TRACKING_ENABLED).toBe(false);
    expect(config.PRICE_SCHEDULER_ENABLED).toBe(false);
    expect(() => loadConfig({ PRICE_TRACKING_ENABLED: 'true' })).toThrow('TRACKING_CURSOR_SECRET');
    expect(() => loadConfig({ PRICE_SCHEDULER_ENABLED: 'true' })).toThrow('Scheduled checks');
    expect(() => loadConfig({ PRICE_TRACKING_ENABLED: 'yes' })).toThrow('Invalid environment');
  });
  it('passes preview-safe selection, queue and socket bounds without enabling buffering', async () => {
    const connect = vi.spyOn(mongoose, 'connect').mockResolvedValue(mongoose);
    try {
      await connectDatabase('mongodb://127.0.0.1/fixture');
      expect(connect).toHaveBeenCalledWith('mongodb://127.0.0.1/fixture', {
        serverSelectionTimeoutMS: 1000, waitQueueTimeoutMS: 500, connectTimeoutMS: 1000,
        socketTimeoutMS: 1000, bufferCommands: false,
      });
    } finally { connect.mockRestore(); }
  });
  it('keeps delivery/recovery opt-ins off and validates enabled prerequisites without exposing values', () => {
    const config = loadConfig({ NODE_ENV: 'test' });
    for (const key of ['ACCOUNT_MAIL_ENABLED', 'PRICE_EMAIL_ENABLED', 'PRICE_PUSH_ENABLED', 'PRICE_RETRY_WORKER_ENABLED'] as const) expect(config[key]).toBe(false);
    expect(() => loadConfig({ ACCOUNT_MAIL_ENABLED: 'yes' })).toThrow('Invalid environment: ACCOUNT_MAIL_ENABLED');
    expect(() => loadConfig({ ACCOUNT_MAIL_ENABLED: 'true' })).toThrow('MONGODB_URI');
    expect(() => loadConfig({ PRICE_RETRY_WORKER_ENABLED: 'true' })).toThrow('requires explicitly enabled tracking');
    const base = { MONGODB_URI: 'mongodb://fixture.invalid/test', PRICE_TRACKING_ENABLED: 'true', TRACKING_CURSOR_SECRET: 'fixture-secret-at-least-32-characters' };
    expect(() => loadConfig({ ...base, PRICE_PUSH_ENABLED: 'true' })).toThrow('FIREBASE_PROJECT_ID');
    expect(() => loadConfig({ ...base, PRICE_EMAIL_ENABLED: 'true' })).toThrow('RESEND_SEND_API_KEY');
    const mail = { ...base, RESEND_SEND_API_KEY: 'fixture', EMAIL_FROM: 'fixture@example.invalid' };
    expect(() => loadConfig({ ...mail, PRICE_EMAIL_ENABLED: 'true' })).toThrow('TEMPLATE_PRICE_ALERT_ID');
    expect(() => loadConfig({ ...mail, ACCOUNT_MAIL_ENABLED: 'true' })).toThrow('HTTPS');
    expect(() => loadConfig({ WORKER_POLL_INTERVAL_MS: '999' })).toThrow('WORKER_POLL_INTERVAL_MS');
    expect(() => loadConfig({ PRICE_RETRY_INTERVAL_MS: '59999' })).toThrow('PRICE_RETRY_INTERVAL_MS');
    expect(() => loadConfig({ ...mail, ACCOUNT_MAIL_ENABLED: 'true', WEB_ORIGINS: 'https://fixture.invalid', TEMPLATE_PASSWORD_RESET_ID: 'fixture' })).not.toThrow();
  });
});
