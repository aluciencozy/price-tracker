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
});
