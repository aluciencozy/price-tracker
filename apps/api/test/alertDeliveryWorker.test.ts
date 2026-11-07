import { describe, expect, it, vi } from 'vitest';
import { createPriceAlertDeliveryWorker } from '../src/alertDeliveryWorker.js';

describe('price-alert delivery worker lifecycle and bounds', () => {
  it('is inert until an explicit batch or start call', () => {
    const emailSender = vi.fn();
    const pushSender = vi.fn();
    const service = createPriceAlertDeliveryWorker({ emailSender, pushSender });
    expect(service).toHaveProperty('runBatch');
    expect(service).toHaveProperty('start');
    expect(service).toHaveProperty('stop');
    expect(emailSender).not.toHaveBeenCalled();
    expect(pushSender).not.toHaveBeenCalled();
  });

  it('requires an explicit push sender and rejects unbounded worker settings', () => {
    expect(() => createPriceAlertDeliveryWorker({} as never)).toThrow('A push sender is required.');
    const pushSender = vi.fn();
    expect(() => createPriceAlertDeliveryWorker({ pushSender, batchSize: 101 })).toThrow('Invalid alert batch size.');
    expect(() => createPriceAlertDeliveryWorker({ pushSender, maxAttempts: 6 })).toThrow('Invalid alert retry limit.');
    expect(() => createPriceAlertDeliveryWorker({ pushSender, pollIntervalMs: 100 })).toThrow('Invalid alert poll interval.');
    expect(() => createPriceAlertDeliveryWorker({ pushSender, leaseMs: 10_000 })).toThrow('Invalid alert lease duration.');
  });
});
