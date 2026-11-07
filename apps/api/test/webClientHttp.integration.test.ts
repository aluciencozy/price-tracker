import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDatabaseIndexes } from '../src/models/index.js';
import { ProductModel } from '../src/models/product.js';
import { UserModel } from '../src/models/account.js';
import { hashPassword } from '../src/registration.js';
import { cheapSharkPurchaseUrl } from '../src/cheapshark.js';
import { dispatchVerificationMail } from '../src/verificationDispatch.js';

// Variable imports keep the API's NodeNext typecheck from compiling the web
// workspace with NodeNext resolution; Vitest still loads the real web modules.
const webClientPath = new URL('../../web/src/client/webClient.ts', import.meta.url).pathname;
const repositoryPath = new URL('../../web/src/client/apiRepository.ts', import.meta.url).pathname;
const uri = process.env.TEST_MONGODB_URI;
const config = loadConfig({ NODE_ENV: 'test', AUTH_JWT_SECRET: 'fixture-only-jwt-secret-at-least-32-characters' });
const origin = config.WEB_ORIGINS[0]!;
const dbName = `price_tracker_test_${randomUUID().replaceAll('-', '')}`;

// Node fetch has no browser cookie jar. This adapter only supplies the allowed
// Origin and stores Set-Cookie values; every request still reaches Express.
function browserFetch(base: string): typeof fetch {
  const cookies = new Map<string, string>();
  return async (input, init) => {
    const url = new URL(String(input));
    if (url.origin !== base || init?.credentials !== 'include') throw new Error('Unexpected transport');
    const headers = new Headers(init.headers);
    headers.set('Origin', origin);
    if (cookies.size) headers.set('Cookie', [...cookies].map(([key, value]) => `${key}=${value}`).join('; '));
    const response = await fetch(input, { ...init, headers });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair, ...attributes] = cookie.split(';');
      const equal = pair!.indexOf('=');
      const key = pair!.slice(0, equal), value = pair!.slice(equal + 1);
      if (!value || attributes.some(value => /^\s*max-age=0\s*$/i.test(value))) cookies.delete(key);
      else cookies.set(key, value);
    }
    return response;
  };
}

describe.skipIf(!uri)('WebClient over real HTTP', () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    const target = new URL(uri!);
    if (target.protocol !== 'mongodb:' || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) ||
        target.username || target.password) throw new Error('Expected local isolated test MongoDB URI');
    await mongoose.connect(uri!, { dbName, autoIndex: false, serverSelectionTimeoutMS: 5000 });
    if (mongoose.connection.name !== dbName || !/^price_tracker_test_[a-f0-9]{32}$/.test(dbName)) throw new Error('Unexpected database');
    await createDatabaseIndexes();
    await ProductModel.create({ provider: 'cheapshark', providerGameId: '36', steamAppId: '620', storeId: '1', market: 'US', currency: 'USD', canonicalSteamUrl: 'https://store.steampowered.com/app/620/', title: 'Portal 2', dealId: 'fixture', purchaseUrl: cheapSharkPurchaseUrl('fixture'), currentPriceMinor: 999, lastSuccessfulCheckAt: new Date(), lastAttemptAt: new Date() });
    const app = createApp(config, () => 'connected', { tracking: {
      cursorSigningSecret: 'fixture-only-cursor-secret-at-least-32-characters',
      resolveProduct: async (id, signal) => { signal.throwIfAborted(); return ProductModel.findById(id).orFail().lean().exec(); },
    } });
    server = await new Promise<Server>(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing listener address');
    base = `http://127.0.0.1:${address.port}`;
  }, 30_000);
  afterAll(async () => {
    if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (mongoose.connection.name === dbName && /^price_tracker_test_[a-f0-9]{32}$/.test(dbName)) await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  it('enforces origin, preflight and JSON parser boundaries over HTTP', async () => {
    const preflight = await fetch(`${base}/api/tracked-items`, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,x-csrf-token' } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-credentials')).toBe('true');
    expect((await fetch(`${base}/api/tracked-items`, { headers: { Origin: 'https://unapproved.invalid' } })).status).toBe(403);
    const malformed = await fetch(`${base}/api/tracked-items`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{bad' });
    expect(malformed.status).toBe(400);
    expect((await malformed.json()).error.code).toBe('MALFORMED_REQUEST');
    expect((await fetch(`${base}/api/tracked-items`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'x'.repeat(20_000) }) })).status).toBe(413);
  });

  it('registers, verifies, tracks and isolates two browser sessions', async () => {
    const { WebClient } = await import(webClientPath);
    const { createApiRepository } = await import(repositoryPath);
    const one = new WebClient({ baseUrl: base, development: true, fetch: browserFetch(base) });
    const two = new WebClient({ baseUrl: base, development: true, fetch: browserFetch(base) });
    const password = 'fixture password for integration';
    const register = async (client: typeof one, email: string) => {
      await client.register({ email, password });
      await expect(client.login({ email, password })).rejects.toMatchObject({ details: { status: 403, code: 'EMAIL_UNVERIFIED' } });
      let token = '';
      expect(await dispatchVerificationMail(async details => { expect(details.email).toBe(email); token = details.token; return { status: 'success', messageId: 'fixture', attempts: 1 }; })).toBe(true);
      expect(token).not.toBe('');
      await client.verifyEmail(token);
      await client.login({ email, password });
      expect((await client.restoreSession())?.email).toBe(email);
    };
    await register(one, 'one@example.invalid');
    // One additional verified fixture avoids exceeding the real per-IP auth limit.
    await UserModel.create({ email: 'two@example.invalid', passwordHash: await hashPassword(password), emailVerifiedAt: new Date() });
    await two.login({ email: 'two@example.invalid', password });
    const repo = createApiRepository(one);
    const preview = await repo.preview('https://store.steampowered.com/app/620/');
    const item = await repo.create({ previewId: preview.id, targetPrice: { amountMinor: 0, currency: 'USD' }, enabled: true, alerts: { email: true, push: false } });
    expect((await repo.list('Portal')).map((entry: { id: string }) => entry.id)).toContain(item.id);
    const edited = await repo.update(item.id, { targetPrice: { amountMinor: 500, currency: 'USD' }, enabled: true, alerts: { email: false, push: true } });
    expect(edited.targetPrice.amountMinor).toBe(500);
    expect(edited.alerts).toEqual({ email: false, push: true });
    expect((await repo.history(item.id)).items).toEqual([]);
    await expect(two.getTrackedItem(item.id)).rejects.toMatchObject({ details: { status: 404 } });
    await expect(two.getHistory(item.id)).rejects.toMatchObject({ details: { status: 404 } });
    expect((await two.listTrackedItems()).items).toEqual([]);
    await repo.remove(item.id);
    await expect(one.getTrackedItem(item.id)).rejects.toMatchObject({ details: { status: 404 } });
    await one.logout();
    expect(await one.restoreSession()).toBeNull();
    expect((await two.restoreSession())?.email).toBe('two@example.invalid');
  }, 30_000);
});
