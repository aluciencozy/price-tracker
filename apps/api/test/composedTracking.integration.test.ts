import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDatabaseIndexes } from '../src/models/index.js';
import { ProductModel } from '../src/models/product.js';
import { SessionModel, UserModel } from '../src/models/account.js';
import { hashPassword, hashSecret } from '../src/registration.js';
import { cheapSharkPurchaseUrl } from '../src/cheapshark.js';

const uri = process.env.TEST_MONGODB_URI;
const config = loadConfig({ NODE_ENV: 'test', AUTH_JWT_SECRET: 'fixture-only-jwt-secret-at-least-32-characters' });
const origin = config.WEB_ORIGINS[0]!;
const password = 'fixture password for integration';
const secret = 'fixture-only-cursor-secret-at-least-32-characters';
const app = createApp(config, () => 'connected', { tracking: {
  cursorSigningSecret: secret,
  resolveProduct: async (id, signal) => {
    signal.throwIfAborted();
    return ProductModel.findById(id).orFail().lean().exec();
  },
} });

describe('composed tracking boundary', () => {
  it('leaves tracking unmounted without an explicitly supplied resolver', async () => {
    await request(createApp(config, () => 'connected')).get('/api/tracked-items').expect(404);
  });
  it('handles preflight and parser errors without database access', async () => {
    const preflight = await request(app).options('/api/tracked-items/abc').set('Origin', origin)
      .set('Access-Control-Request-Method', 'PATCH').set('Access-Control-Request-Headers', 'content-type,x-csrf-token').expect(204);
    expect(preflight.headers['access-control-allow-credentials']).toBe('true');
    expect(preflight.headers['access-control-allow-methods']).toContain('PATCH');
    await request(app).options('/api/auth/web/login').set('Origin', 'https://unapproved.invalid')
      .set('Access-Control-Request-Method', 'POST').expect(403);
    const native = await request(app).options('/api/auth/mobile/login').set('Origin', origin)
      .set('Access-Control-Request-Method', 'POST').expect(204);
    expect(native.headers['access-control-allow-credentials']).toBeUndefined();
    await request(app).get('/api/tracked-items').set('Origin', 'https://unapproved.invalid').expect(403);
    const malformed = await request(app).post('/api/tracked-items').type('json').send('{bad').expect(400);
    expect(malformed.body.error).toMatchObject({ code: 'MALFORMED_REQUEST', fields: [], resourceId: null });
    expect(malformed.headers['cache-control']).toBe('no-store');
    await request(app).post('/api/tracked-items').send({ text: 'x'.repeat(20_000) }).expect(413);
  });
});

describe.skipIf(!uri)('real sessions with offline preview and isolated MongoDB', () => {
  const dbName = `price_tracker_test_${randomUUID().replaceAll('-', '')}`;
  beforeAll(async () => {
    if (!/^price_tracker_test_[a-f0-9]{32}$/.test(dbName)) throw new Error('Invalid disposable database.');
    await mongoose.connect(uri!, { dbName, autoIndex: false, serverSelectionTimeoutMS: 5000 });
    if (mongoose.connection.name !== dbName) throw new Error('Unexpected database.');
    await createDatabaseIndexes();
    const passwordHash = await hashPassword(password);
    await UserModel.create([{ email: 'one@example.invalid', passwordHash, emailVerifiedAt: new Date() },
      { email: 'two@example.invalid', passwordHash, emailVerifiedAt: new Date() }]);
    await ProductModel.create({ provider: 'cheapshark', providerGameId: '36', steamAppId: '620', storeId: '1', market: 'US', currency: 'USD',
      canonicalSteamUrl: 'https://store.steampowered.com/app/620/', title: 'Portal 2', dealId: 'fixture',
      purchaseUrl: cheapSharkPurchaseUrl('fixture'), currentPriceMinor: 999, lastSuccessfulCheckAt: new Date(), lastAttemptAt: new Date() });
  }, 30_000);
  afterAll(async () => {
    if (mongoose.connection.name === dbName) await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
  it('counts each authenticated tracking request once across both enforcement layers', async () => {
    const user = await UserModel.findOne({ email: 'one@example.invalid' }).orFail();
    const credential = 'c'.repeat(43);
    await SessionModel.create({ userId: user._id, transport: 'web', secretHash: hashSecret(credential),
      expiresAt: new Date(Date.now() + 5 * 60_000) });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000);
    try {
      for (let count = 0; count < 120; count++) {
        await request(app).get('/api/tracked-items').set('Cookie', `price_tracker_session_dev=${credential}`).expect(200);
      }
      const blocked = await request(app).get('/api/tracked-items').set('Cookie', `price_tracker_session_dev=${credential}`).expect(429);
      expect(blocked.body.error.retryAfterSeconds).toBe(Number(blocked.headers['retry-after']));
    } finally { clock.mockRestore(); }
  });
  it('enforces web CSRF, ownership and revoked sessions through mounted routes', async () => {
    const one = request.agent(app);
    const bootstrap = await one.get('/api/auth/web/csrf').expect(200);
    await one.post('/api/auth/web/login').set('Origin', origin).set('X-CSRF-Token', bootstrap.body.csrfToken)
      .send({ email: 'one@example.invalid', password }).expect(200);
    const csrf = (await one.get('/api/auth/web/csrf').expect(200)).body.csrfToken;
    await one.post('/api/product-previews').set('Origin', origin).send({ url: 'https://store.steampowered.com/app/620/' }).expect(403);
    const preview = await one.post('/api/product-previews').set('Origin', origin).set('X-CSRF-Token', csrf)
      .send({ url: 'https://store.steampowered.com/app/620/' }).expect(201);
    const item = await one.post('/api/tracked-items').set('Origin', origin).set('X-CSRF-Token', csrf)
      .set('Idempotency-Key', randomUUID()).send({ previewId: preview.body.id, targetPrice: { amountMinor: 0, currency: 'USD' }, enabled: true, alerts: { email: true, push: false } }).expect(201);
    const list = await one.get('/api/tracked-items').query({ q: 'Portal' }).expect(200);
    expect(list.body.items.map((entry: { id: string }) => entry.id)).toContain(item.body.id);
    await one.patch(`/api/tracked-items/${item.body.id}`).set('Origin', origin).set('X-CSRF-Token', csrf)
      .send({ targetPrice: { amountMinor: 500, currency: 'USD' } }).expect(200);
    const history = await one.get(`/api/tracked-items/${item.body.id}/history`).expect(200);
    expect(history.body.items).toEqual([]);
    const two = request.agent(app);
    const start = await two.get('/api/auth/web/csrf').expect(200);
    await two.post('/api/auth/web/login').set('Origin', origin).set('X-CSRF-Token', start.body.csrfToken)
      .send({ email: 'two@example.invalid', password }).expect(200);
    await two.get(`/api/tracked-items/${item.body.id}`).expect(404);
    await two.get(`/api/tracked-items/${item.body.id}/history`).expect(404);
    await one.delete(`/api/tracked-items/${item.body.id}`).set('Origin', origin).set('X-CSRF-Token', csrf).expect(204);
    await one.get(`/api/tracked-items/${item.body.id}`).expect(404);
    await one.post('/api/auth/web/logout').set('Origin', origin).set('X-CSRF-Token', csrf).expect(204);
    await one.get('/api/tracked-items').expect(401);
  });
  it('accepts an active native session but rejects mixed browser and bearer credentials', async () => {
    const login = await request(app).post('/api/auth/mobile/login')
      .send({ email: 'one@example.invalid', password }).expect(200);
    const authorization = `Bearer ${login.body.accessToken}`;
    await request(app).get('/api/tracked-items').set('Authorization', authorization).expect(200);
    await request(app).get('/api/tracked-items').set('Authorization', authorization)
      .set('Cookie', 'price_tracker_prelogin_dev=fixture').expect(400);
    await request(app).post('/api/auth/mobile/logout').set('Authorization', authorization).expect(204);
    await request(app).get('/api/tracked-items').set('Authorization', authorization).expect(401);
  });
  it('mounts shared admin checks with current roles and contract rate metadata, without watched products', async () => {
    const login = await request(app).post('/api/auth/mobile/login')
      .send({ email: 'one@example.invalid', password }).expect(200);
    const authorization = `Bearer ${login.body.accessToken}`;
    await request(app).post('/api/admin/price-checks').set('Authorization', authorization).send({}).expect(403);
    await UserModel.updateOne({ email: 'one@example.invalid' }, { $set: { role: 'admin' } });
    const queued = await request(app).post('/api/admin/price-checks').set('Authorization', authorization).send({}).expect(202);
    expect(queued.headers.location).toBe(`/api/admin/price-checks/${queued.body.id}`);
    expect(queued.body).not.toHaveProperty('checks');
    await request(app).get(String(queued.headers.location)).set('Authorization', authorization).expect(200);
    const limited = await request(app).post('/api/admin/price-checks').set('Authorization', authorization).send({}).expect(429);
    expect(limited.body.error.retryAfterSeconds).toBe(Number(limited.headers['retry-after']));
  });
});
