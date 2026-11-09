import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
