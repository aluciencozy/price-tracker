import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { SessionModel, UserModel } from '../src/models/account.js';
import { DeviceModel } from '../src/models/device.js';
import { createDatabaseIndexes } from '../src/models/index.js';
import { hashPassword } from '../src/registration.js';
import { completePasswordReset, requestPasswordReset } from '../src/passwordReset.js';
import { dispatchPasswordResetMail } from '../src/verificationDispatch.js';

const uri = process.env.TEST_MONGODB_URI;
const key = 'fixture-only-mobile-jwt-secret-at-least-32-characters';
const config = loadConfig({ NODE_ENV: 'test', AUTH_JWT_SECRET: key });
const app = createApp(config, () => 'connected');
const input = () => ({ installationId: randomUUID(), platform: 'android', pushToken: `fixture-${randomUUID()}` });

describe('mounted device transport without a database', () => {
  it('uses the common readiness envelope and does not allow browser credentials on native preflight', async () => {
    const unavailable = createApp(config, () => 'connecting');
    const failure = await request(unavailable).post('/api/devices').send(input()).expect(503);
    expect(failure.body.error).toMatchObject({ code: 'SERVICE_UNAVAILABLE', fields: [], resourceId: null });
    expect(failure.headers['cache-control']).toBe('no-store');
    const preflight = await request(app).options('/api/devices/fixture').set('Origin', config.WEB_ORIGINS[0]!)
      .set('Access-Control-Request-Method', 'PUT').expect(204);
    expect(preflight.headers['access-control-allow-methods']).toContain('PUT');
    expect(preflight.headers['access-control-allow-credentials']).toBeUndefined();
    await request(app).post('/api/devices').set('Cookie', 'price_tracker_prelogin_dev=fixture').send(input()).expect(400);
    await request(app).post('/api/devices').set('Authorization', 'Bearer fixture')
      .set('Cookie', 'price_tracker_session_dev=fixture').send(input()).expect(400);
    await request(app).post('/api/devices').set('Origin', 'https://unapproved.invalid').send(input()).expect(403);
    await request(app).get('/api/health').expect(200);
  });
  it('keeps installation cleanup inside readiness, native-cookie and origin boundaries', async () => {
    const path = `/api/devices/installation/${randomUUID()}`;
    const unavailable = createApp(config, () => 'connecting');
    const failure = await request(unavailable).delete(path).expect(503);
    expect(failure.body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(failure.headers['cache-control']).toBe('no-store');
    for (const cookie of ['price_tracker_prelogin_dev=fixture', 'price_tracker_session_dev=fixture', '__Host-price_tracker_session=fixture', '__Host-price_tracker_prelogin=fixture']) {
      await request(app).delete(path).set('Cookie', cookie).expect(400);
      await request(app).delete(path).set('Authorization', 'Bearer fixture').set('Cookie', cookie).expect(400);
    }
    await request(app).delete(path).set('Origin', 'https://unapproved.invalid').expect(403);
    const preflight = await request(app).options(path).set('Origin', config.WEB_ORIGINS[0]!)
      .set('Access-Control-Request-Method', 'DELETE').expect(204);
    expect(preflight.headers['access-control-allow-credentials']).toBeUndefined();
  });
});

describe.skipIf(!uri)('mounted devices with real verified mobile sessions', () => {
  const dbName = `price_tracker_test_${randomUUID().replaceAll('-', '')}`;
  const password = 'fixture mobile password';
  let passwordHash: string;
  const login = async (email = 'owner@example.invalid') => {
    const response = await request(app).post('/api/auth/mobile/login').send({ email, password }).expect(200);
    return response.body.accessToken as string;
  };
  beforeAll(async () => {
    passwordHash = await hashPassword(password);
    await mongoose.connect(uri!, { dbName, autoIndex: false, serverSelectionTimeoutMS: 5000 });
    await createDatabaseIndexes();
  }, 30000);
  beforeEach(async () => {
    for (const collection of Object.values(mongoose.connection.collections)) await collection.deleteMany({});
    await UserModel.create(['owner', 'other'].map(name => ({ email: `${name}@example.invalid`, passwordHash, emailVerifiedAt: new Date() })));
  });
  afterAll(async () => {
    if (mongoose.connection.name === dbName) await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  it('registers, rotates and removes through real JWT middleware without exposing tokens', async () => {
    const token = await login();
    const body = input();
    const saved = await request(app).post('/api/devices').set('Authorization', `Bearer ${token}`).send(body).expect(201);
    expect(saved.body).not.toHaveProperty('pushToken');
    expect(saved.body).not.toHaveProperty('userId');
    expect(saved.headers['cache-control']).toBe('no-store');
    await request(app).put(`/api/devices/${saved.body.id}`).set('Authorization', `Bearer ${token}`)
      .send({ ...body, pushToken: 'fixture-rotated-token' }).expect(200);
    await request(app).post('/api/devices').set('Authorization', `Bearer ${token}`).send({ ...body, userId: saved.body.sessionId }).expect(422);
    await request(app).delete(`/api/devices/${saved.body.id}`).set('Authorization', `Bearer ${token}`).send({}).expect(400);
    await request(app).delete(`/api/devices/${saved.body.id}`).set('Authorization', `Bearer ${token}`).expect(204);
    expect(await DeviceModel.countDocuments()).toBe(0);
  });

  it('enforces ownership and switches an installation only with possession of its current token', async () => {
    const owner = await login(), other = await login('other@example.invalid');
    const body = input();
    const saved = await request(app).post('/api/devices').set('Authorization', `Bearer ${owner}`).send(body).expect(201);
    await request(app).put(`/api/devices/${saved.body.id}`).set('Authorization', `Bearer ${other}`).send(body).expect(404);
    await request(app).delete(`/api/devices/${saved.body.id}`).set('Authorization', `Bearer ${other}`).expect(404);
    await request(app).post('/api/devices').set('Authorization', `Bearer ${other}`).send({ ...body, pushToken: 'different-fixture' }).expect(409);
    await request(app).post('/api/devices').set('Authorization', `Bearer ${other}`).send(body).expect(201);
    await request(app).delete(`/api/devices/${saved.body.id}`).set('Authorization', `Bearer ${owner}`).expect(404);
    await request(app).post('/api/auth/mobile/logout').set('Authorization', `Bearer ${other}`).expect(204);
    await request(app).post('/api/devices').set('Authorization', `Bearer ${other}`).send(body).expect(401);
    expect((await DeviceModel.findById(saved.body.id))?.active).toBe(false);
  });

  it('removes a current installation without its device ID and repeats with empty 204 responses', async () => {
    const token = await login();
    for (const installationId of [randomUUID().toUpperCase(), '019A50A0-0000-7000-8000-000000000001']) {
      await request(app).post('/api/devices').set('Authorization', `Bearer ${token}`).send({ ...input(), installationId }).expect(201);
      for (let repeat = 0; repeat < 2; repeat++) {
        const removed = await request(app).delete(`/api/devices/installation/${installationId}`).set('Authorization', `Bearer ${token}`).expect(204);
        expect(removed.text).toBe('');
        expect(removed.headers['cache-control']).toBe('no-store');
      }
    }
    expect(await DeviceModel.countDocuments()).toBe(0);
    await request(app).delete(`/api/devices/${new mongoose.Types.ObjectId()}`).set('Authorization', `Bearer ${token}`).expect(404);
  });

  it('does not reveal or delete foreign accounts or another mobile session of the same account', async () => {
    const first = await login(), second = await login(), other = await login('other@example.invalid');
    const body = input();
    const saved = await request(app).post('/api/devices').set('Authorization', `Bearer ${first}`).send(body).expect(201);
    const path = `/api/devices/installation/${body.installationId}`;
    for (const token of [second, other]) await request(app).delete(path).set('Authorization', `Bearer ${token}`).expect(204);
    expect(await DeviceModel.countDocuments({ _id: saved.body.id, active: true })).toBe(1);
    await request(app).post('/api/devices').set('Authorization', `Bearer ${second}`).send(body).expect(201);
    await request(app).delete(path).set('Authorization', `Bearer ${first}`).expect(204);
    expect(await DeviceModel.countDocuments({ _id: saved.body.id, active: true })).toBe(1);
    await request(app).post('/api/devices').set('Authorization', `Bearer ${other}`).send(body).expect(201);
    await request(app).delete(path).set('Authorization', `Bearer ${second}`).expect(204);
    expect(await DeviceModel.countDocuments({ _id: saved.body.id, active: true })).toBe(1);
    await request(app).delete(path).set('Authorization', `Bearer ${other}`).expect(204);
    expect(await DeviceModel.countDocuments()).toBe(0);
  });

  it('rejects installation cleanup bodies, invalid UUIDs and every query without modifying bindings', async () => {
    const token = await login(), body = input();
    await request(app).post('/api/devices').set('Authorization', `Bearer ${token}`).send(body).expect(201);
    const path = `/api/devices/installation/${body.installationId}`;
    for (const payload of [{}, { userId: 'foreign' }, null]) {
      await request(app).delete(path).set('Authorization', `Bearer ${token}`).set('Content-Type', 'application/json')
        .send(JSON.stringify(payload)).expect(400);
    }
    await request(app).delete(path).set('Authorization', `Bearer ${token}`).set('Content-Type', 'text/plain').send('body').expect(400);
    for (const query of ['?userId=foreign', '?sessionId=foreign', '?installationId=foreign', '?x=1&x=2']) {
      const failure = await request(app).delete(path + query).set('Authorization', `Bearer ${token}`).expect(422);
      expect(failure.body.error.code).toBe('VALIDATION_ERROR');
    }
    for (const uuid of ['not-a-uuid', '00000000-0000-4000-0000-000000000000']) {
      const failure = await request(app).delete(`/api/devices/installation/${uuid}`).set('Authorization', `Bearer ${token}`).expect(422);
      expect(failure.body.error.code).toBe('VALIDATION_ERROR');
    }
    expect(await DeviceModel.countDocuments({ active: true })).toBe(1);
  });

  it('requires a current verified JWT for installation cleanup, not browser CSRF credentials', async () => {
    const token = await login(), path = `/api/devices/installation/${randomUUID()}`;
    await request(app).delete(path).expect(401);
    await request(app).delete(path).set('Authorization', 'Bearer invalid').expect(401);
    const user = await UserModel.findOne({ email: 'owner@example.invalid' }).orFail();
    const session = await SessionModel.findOne({ userId: user._id }).orFail();
    const expired = await new SignJWT({ sid: String(session._id), ver: 0 }).setProtectedHeader({ alg: 'HS256' })
      .setSubject(String(user._id)).setIssuer('price-tracker-api').setAudience('price-tracker-mobile')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 120).setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(new TextEncoder().encode(key));
    await request(app).delete(path).set('Authorization', `Bearer ${expired}`).expect(401);
    await UserModel.updateOne({ _id: user._id }, { $set: { emailVerifiedAt: null } });
    await request(app).delete(path).set('Authorization', `Bearer ${token}`).expect(401);
    await UserModel.updateOne({ _id: user._id }, { $set: { emailVerifiedAt: new Date() } });
    await SessionModel.updateOne({ _id: session._id }, { $set: { revokedAt: new Date() } });
    await request(app).delete(path).set('Authorization', `Bearer ${token}`).expect(401);
    await request(app).delete(path).set('Origin', config.WEB_ORIGINS[0]!).set('X-CSRF-Token', 'fixture')
      .set('Cookie', 'price_tracker_session_dev=fixture').expect(400);
  });

  it('counts installation cleanup once toward the unchanged 120 requests per session limit', async () => {
    const token = await login(), path = `/api/devices/installation/${randomUUID()}`;
    // Keep the fixed minute window stable even if the test starts near its boundary.
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    try {
      for (let count = 0; count < 120; count++) {
        await request(app).delete(path).set('Authorization', `Bearer ${token}`).expect(204);
      }
      const limited = await request(app).delete(path).set('Authorization', `Bearer ${token}`).expect(429);
      expect(limited.body.error.code).toBe('RATE_LIMITED');
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    } finally { clock.mockRestore(); }
  });

  it('rejects a real web session with valid CSRF and mixed bearer credentials without deleting the native binding', async () => {
    const token = await login(), body = input();
    await request(app).post('/api/devices').set('Authorization', `Bearer ${token}`).send(body).expect(201);
    const web = request.agent(app);
    const bootstrap = await web.get('/api/auth/web/csrf').expect(200);
    await web.post('/api/auth/web/login').set('Origin', config.WEB_ORIGINS[0]!)
      .set('X-CSRF-Token', bootstrap.body.csrfToken).send({ email: 'owner@example.invalid', password }).expect(200);
    const csrf = await web.get('/api/auth/web/csrf').expect(200);
    const path = `/api/devices/installation/${body.installationId}`;
    for (const bearer of [false, true]) {
      const removal = web.delete(path).set('Origin', config.WEB_ORIGINS[0]!).set('X-CSRF-Token', csrf.body.csrfToken);
      if (bearer) removal.set('Authorization', `Bearer ${token}`);
      const response = await removal.expect(400);
      expect(response.body.error.code).toBe('AUTH_AMBIGUOUS');
    }
    expect(await DeviceModel.countDocuments({ active: true })).toBe(1);
  });

  it('rejects absent, invalid, expired, unverified and version-invalidated JWTs', async () => {
    const token = await login();
    await request(app).post('/api/devices').send(input()).expect(401);
    await request(app).post('/api/devices').set('Authorization', 'Bearer invalid').send(input()).expect(401);
    const user = await UserModel.findOne({ email: 'owner@example.invalid' }).orFail();
    const session = await SessionModel.findOne({ userId: user._id }).orFail();
    const expired = await new SignJWT({ sid: String(session._id), ver: 0 }).setProtectedHeader({ alg: 'HS256' })
      .setSubject(String(user._id)).setIssuer('price-tracker-api').setAudience('price-tracker-mobile')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 120).setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(new TextEncoder().encode(key));
    await request(app).post('/api/devices').set('Authorization', `Bearer ${expired}`).send(input()).expect(401);
    await UserModel.updateOne({ _id: user._id }, { $set: { emailVerifiedAt: null } });
    await request(app).post('/api/devices').set('Authorization', `Bearer ${token}`).send(input()).expect(401);
    await UserModel.updateOne({ _id: user._id }, { $set: { emailVerifiedAt: new Date() }, $inc: { sessionVersion: 1 } });
    await request(app).post('/api/devices').set('Authorization', `Bearer ${token}`).send(input()).expect(401);
  });

  it('rejects a previously valid device session after actual password reset', async () => {
    const token = await login();
    await request(app).post('/api/devices').set('Authorization', `Bearer ${token}`).send(input()).expect(201);
    await requestPasswordReset('owner@example.invalid');
    let secret = '';
    await dispatchPasswordResetMail(async details => { secret = details.token; return { status: 'success', messageId: 'fixture', attempts: 1 }; });
    expect(await completePasswordReset(secret, 'new fixture mobile password')).toBe(true);
    await request(app).post('/api/devices').set('Authorization', `Bearer ${token}`).send(input()).expect(401);
    expect(await DeviceModel.countDocuments({ active: true })).toBe(0);
  });
});
