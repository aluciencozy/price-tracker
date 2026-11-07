import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EMAIL_BUDGET_DAILY_MS, EMAIL_BUDGET_MONTHLY_MS, reserveEmailSend } from '../src/emailBudget.js';
import { EmailBudgetModel, type EmailBudgetRecord } from '../src/models/emailBudget.js';

// A separate opt-in confirms the server is disposable; the URI path is ignored.
const uri = process.env.EMAIL_BUDGET_TEST_DISPOSABLE === '1' ? process.env.TEST_MONGODB_URI : undefined;
describe.skipIf(!uri)('shared Mongo email budget', () => {
  const dbName = `price_tracker_test_email_${randomUUID().replaceAll('-', '')}`;
  const collection = EmailBudgetModel.collection as unknown as mongoose.mongo.Collection<EmailBudgetRecord>;
  beforeAll(async () => {
    await mongoose.connect(uri!, { dbName, serverSelectionTimeoutMS: 5000, autoIndex: false });
  });
  beforeEach(async () => { await collection.deleteMany({}); });
  afterAll(async () => {
    if (mongoose.connection.name === dbName) await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  it('serializes competing invocations, including repeated delivery keys, and survives reconnect', async () => {
    const limits = { dailyLimit: 9, monthlyLimit: 30 };
    expect(await reserveEmailSend(limits)).toMatchObject({ status: 'allowed' });
    const results = await Promise.all(Array.from({ length: 20 }, () => reserveEmailSend(limits)));
    expect(results.filter(r => r.status === 'allowed')).toHaveLength(2);
    expect((await collection.findOne({ _id: 'resend-account' }))?.reservations).toHaveLength(9);
    await mongoose.disconnect();
    await mongoose.connect(uri!, { dbName, serverSelectionTimeoutMS: 5000, autoIndex: false });
    expect(await reserveEmailSend(limits)).toMatchObject({ status: 'deferred', reason: 'exhausted' });
  });

  it('limits concurrent first-use upserts across independent processes', async () => {
    const fixture = fileURLToPath(new URL('./fixtures/emailBudgetRace.ts', import.meta.url));
    const children = Array.from({ length: 8 }, () => {
      const child = spawn(process.execPath, ['--import', 'tsx', fixture], {
        env: { ...process.env, EMAIL_BUDGET_TEST_DB: dbName }, stdio: ['pipe', 'pipe', 'pipe'],
      });
      const lines = createInterface({ input: child.stdout });
      return { child, lines, ready: once(lines, 'line'), exited: once(child, 'exit') };
    });
    try {
      const ready = await Promise.all(children.map(c => c.ready));
      expect(ready.map(line => line[0])).toEqual(Array(8).fill('ready'));
      const responses = children.map(c => once(c.lines, 'line'));
      children.forEach(c => c.child.stdin.end('go'));
      const results = (await Promise.all(responses)).map(line => JSON.parse(String(line[0])) as { status: string });
      const exits = await Promise.all(children.map(c => c.exited));
      expect(exits.every(([code]) => code === 0)).toBe(true);
      const grants = results.filter(r => r.status === 'allowed').length;
      expect(grants).toBeLessThanOrEqual(3);
      expect(grants).toBeGreaterThan(0);
      const record = await collection.findOne({ _id: 'resend-account' });
      expect(record?.reservations.length).toBe(grants * 3);
      expect(record!.reservations.length).toBeLessThanOrEqual(9);
    } finally {
      children.forEach(c => { c.lines.close(); c.child.kill(); });
    }
  }, 30000);

  it('holds monthly headroom after daily capacity expires and computes the boundary', async () => {
    const limits = { dailyLimit: 6, monthlyLimit: 6 };
    const old = new Date(Date.now() - EMAIL_BUDGET_DAILY_MS - 10000);
    await collection.insertOne({ _id: 'resend-account', ...limits,
      reservations: Array(6).fill(old), decisionId: 'fixture', decisionAt: old, allowed: true });
    const result = await reserveEmailSend(limits);
    expect(result.status).toBe('deferred');
    if (result.status === 'deferred') {
      expect(result.reason).toBe('exhausted');
      expect(result.retryAfterMs).toBeGreaterThan(EMAIL_BUDGET_MONTHLY_MS - EMAIL_BUDGET_DAILY_MS - 20000);
      expect(result.retryAfterMs).toBeLessThan(EMAIL_BUDGET_MONTHLY_MS - EMAIL_BUDGET_DAILY_MS);
    }
    await collection.updateOne({ _id: 'resend-account' }, { $set: {
      reservations: Array(6).fill(new Date(Date.now() - EMAIL_BUDGET_MONTHLY_MS - 10000)),
    } });
    expect(await reserveEmailSend(limits)).toMatchObject({ status: 'allowed' });
  });

  it('defers until enough daily reservations cross the rolling boundary', async () => {
    const limits = { dailyLimit: 6, monthlyLimit: 30 };
    const nearBoundary = new Date(Date.now() - EMAIL_BUDGET_DAILY_MS + 20_000);
    await collection.insertOne({ _id: 'resend-account', ...limits,
      reservations: Array(6).fill(nearBoundary), decisionId: 'fixture', decisionAt: nearBoundary, allowed: true });
    const result = await reserveEmailSend(limits);
    expect(result).toMatchObject({ status: 'deferred', reason: 'exhausted' });
    if (result.status === 'deferred') {
      expect(result.retryAfterMs).toBeGreaterThan(10_000);
      expect(result.retryAfterMs).toBeLessThanOrEqual(20_000);
    }
    await collection.updateOne({ _id: 'resend-account' }, { $set: {
      reservations: Array(6).fill(new Date(Date.now() - EMAIL_BUDGET_DAILY_MS - 10_000)),
    } });
    expect(await reserveEmailSend(limits)).toMatchObject({ status: 'allowed' });
  });

  it('blocks different limits from another process', async () => {
    expect(await reserveEmailSend({ dailyLimit: 3, monthlyLimit: 3 })).toMatchObject({ status: 'allowed' });
    expect(await reserveEmailSend({ dailyLimit: 6, monthlyLimit: 6 })).toMatchObject({ status: 'deferred', reason: 'config_mismatch' });
  });
});
