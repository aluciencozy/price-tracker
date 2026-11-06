import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { AuthLimitModel, AuthTokenModel, PreloginModel, SessionModel, UserModel } from '../src/models/account.js';
import { createDatabaseIndexes } from '../src/models/index.js';
import { hashSecret, register, resend, verify } from '../src/registration.js';

const uri = process.env.TEST_MONGODB_URI;
describe.skipIf(!uri)('registration routes with real MongoDB transactions', () => {
  const dbName = `price_tracker_auth_test_${randomUUID().replaceAll('-', '')}`;
  const sent: { email: string; token: string }[] = [];
  const send = vi.fn(async (details: { email: string; token: string }) => {
    sent.push(details);
    return { status: 'success' as const, messageId: 'fixture', attempts: 1 };
  });
  const config = loadConfig({ NODE_ENV: 'test' });
  const app = createApp(config, () => 'connected', send);
  const credentials = { email: 'fixture@example.invalid', password: '  fixture password  ', name: 'Player' };
  const post = (action: string, body: object) => request(app).post(`/api/auth/mobile/${action}`).send(body);
  beforeAll(async () => {
    await mongoose.connect(uri!, { dbName, autoIndex: false, serverSelectionTimeoutMS: 5000 });
    await createDatabaseIndexes();
  }, 30000);
  beforeEach(async () => {
    await Promise.all([UserModel.deleteMany({}), AuthTokenModel.deleteMany({}), SessionModel.deleteMany({}), AuthLimitModel.deleteMany({}), PreloginModel.deleteMany({})]);
    sent.length = 0;
    send.mockClear();
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    if (mongoose.connection.name === dbName) await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
  it('registers normalized accounts, stores only hashes, verifies once, and never logs in', async () => {
    const res = await post('register', { ...credentials, email: ' FIXTURE@Example.Invalid ' }).expect(202);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('token');
    const user = await UserModel.findOne().select('+passwordHash').orFail();
    expect(user.email).toBe(credentials.email);
    expect(user.passwordHash).toMatch(/^scrypt\$/);
    expect(user.emailVerifiedAt).toBeNull();
    const token = await AuthTokenModel.findOne().select('+tokenHash').orFail();
    expect(token.tokenHash).toBe(hashSecret(sent[0]!.token));
    expect(token.expiresAt.getTime() - Date.now()).toBeGreaterThan(86300000);
    // Login is deliberately outside #8; an unverified account has no login/session path here.
    await post('login', credentials).expect(404);
    expect(await SessionModel.countDocuments()).toBe(0);
    await post('verify-email', { token: sent[0]!.token }).expect(204);
    await post('verify-email', { token: sent[0]!.token }).expect(400);
    expect((await UserModel.findOne())!.emailVerifiedAt).toBeInstanceOf(Date);
    expect(await SessionModel.countDocuments()).toBe(0);
  });
  it('returns identical generic responses for duplicate/unknown/ineligible accounts', async () => {
    const first = await post('register', credentials).expect(202);
    const duplicate = await post('register', { ...credentials, password: 'different password' }).expect(202);
    const unknown = await post('resend-verification', { email: 'absent@example.invalid' }).expect(202);
    expect(duplicate.body).toEqual(first.body);
    expect(unknown.body).toEqual(first.body);
    expect(sent).toHaveLength(1);
  });
  it.each([
    { ...credentials, extra: true }, { ...credentials, password: 'short' },
    { ...credentials, name: '' }, { ...credentials, email: 'bad' },
    { ...credentials, password: '😀'.repeat(129) },
  ])('strictly rejects invalid fields %j', async body => {
    await post('register', body).expect(422);
    expect(await UserModel.countDocuments()).toBe(0);
  });
  it('enforces expiry even before MongoDB TTL cleanup and never consumes via GET', async () => {
    await post('register', credentials).expect(202);
    const token = sent[0]!.token;
    await request(app).get(`/api/auth/mobile/verify-email?token=${token}`).expect(404);
    expect((await AuthTokenModel.findOne())!.consumedAt).toBeNull();
    await AuthTokenModel.updateOne({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    await post('verify-email', { token }).expect(400);
    expect((await UserModel.findOne())!.emailVerifiedAt).toBeNull();
  });
  it('rejects non-JSON request media types', async () => {
    const res = await request(app).post('/api/auth/mobile/register').type('text').send('fixture').expect(415);
    expect(res.body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });
  it('rolls back token consumption after a failed user write, allowing retry', async () => {
    await register(credentials, send);
    const token = sent[0]!.token;
    const spy = vi.spyOn(UserModel, 'updateOne').mockImplementationOnce(() => { throw new Error('fixture write failure'); });
    await post('verify-email', { token }).expect(503);
    spy.mockRestore();
    expect((await AuthTokenModel.findOne())!.consumedAt).toBeNull();
    await post('verify-email', { token }).expect(204);
  });
  it('rolls back user creation when token storage fails', async () => {
    vi.spyOn(AuthTokenModel, 'findOneAndUpdate').mockImplementationOnce(() => { throw new Error('fixture token failure'); });
    await post('register', credentials).expect(503);
    expect(await UserModel.countDocuments()).toBe(0);
    expect(sent).toHaveLength(0);
  });
  it('does not delete an account/token after a thrown or uncertain email result', async () => {
    send.mockRejectedValueOnce(new Error('fixture send failure'));
    await post('register', credentials).expect(202);
    expect(await UserModel.countDocuments()).toBe(1);
    expect(await AuthTokenModel.countDocuments()).toBe(1);
    await UserModel.updateOne({}, { $set: { verificationEmailSentAt: new Date(0) } });
    await post('resend-verification', { email: credentials.email }).expect(202);
    await post('verify-email', { token: sent[0]!.token }).expect(204);
  });
  it('serializes concurrent registration and sends exactly one initial email', async () => {
    await Promise.all(Array.from({ length: 5 }, () => register(credentials, send)));
    expect(await UserModel.countDocuments()).toBe(1);
    expect(await AuthTokenModel.countDocuments()).toBe(1);
    expect(sent).toHaveLength(1);
  });
  it('preserves committed tokens for every non-success mail outcome', async () => {
    const unknownSender = vi.fn(async () => ({ status: 'unknown' as const, code: 'fixture_uncertain', attempts: 3 }));
    await register(credentials, unknownSender);
    expect(await UserModel.countDocuments()).toBe(1);
    expect((await AuthTokenModel.findOne())!.consumedAt).toBeNull();
    expect(unknownSender).toHaveBeenCalledTimes(1);
  });
  it('does not rotate or mail a verified account', async () => {
    await register(credentials, send);
    expect(await verify(sent[0]!.token)).toBe(true);
    await UserModel.updateOne({}, { $set: { verificationEmailSentAt: new Date(0) } });
    await resend(credentials.email, send);
    expect(sent).toHaveLength(1);
    expect((await AuthTokenModel.findOne())!.consumedAt).not.toBeNull();
  });
  it('keeps a token unconsumed when its user cannot be updated', async () => {
    await register(credentials, send);
    await UserModel.deleteMany({});
    await expect(verify(sent[0]!.token)).rejects.toThrow('Verification user unavailable');
    expect((await AuthTokenModel.findOne())!.consumedAt).toBeNull();
  });
  it('serializes concurrent resend, invalidates the previous token and honors initial cooldown', async () => {
    await register(credentials, send);
    const original = sent[0]!.token;
    await resend(credentials.email, send);
    expect(sent).toHaveLength(1);
    await UserModel.updateOne({}, { $set: { verificationEmailSentAt: new Date(0) } });
    await Promise.all(Array.from({ length: 5 }, () => resend(credentials.email, send)));
    expect(sent).toHaveLength(2);
    expect(await verify(original)).toBe(false);
    expect(await verify(sent[1]!.token)).toBe(true);
  });
  it('rolls back cooldown and preserves old token when resend storage fails', async () => {
    await register(credentials, send);
    await UserModel.updateOne({}, { $set: { verificationEmailSentAt: new Date(0) } });
    vi.spyOn(AuthTokenModel, 'findOneAndUpdate').mockImplementationOnce(() => { throw new Error('fixture token failure'); });
    await post('resend-verification', { email: credentials.email }).expect(503);
    expect((await UserModel.findOne())!.verificationEmailSentAt).toEqual(new Date(0));
    expect(await verify(sent[0]!.token)).toBe(true);
  });
  it('only accepts a token once across concurrent verification attempts', async () => {
    await register(credentials, send);
    const results = await Promise.all(Array.from({ length: 5 }, () => verify(sent[0]!.token)));
    expect(results.filter(Boolean)).toHaveLength(1);
  });
  it('serializes verification against resend without resurrecting a consumed token', async () => {
    await register(credentials, send);
    await UserModel.updateOne({}, { $set: { verificationEmailSentAt: new Date(0) } });
    await Promise.all([verify(sent[0]!.token), resend(credentials.email, send)]);
    const user = await UserModel.findOne().orFail();
    if (!user.emailVerifiedAt) expect(await verify(sent.at(-1)!.token)).toBe(true);
    else expect((await AuthTokenModel.findOne())!.consumedAt).not.toBeNull();
    expect(await verify(sent[0]!.token)).toBe(false);
  });
  it('enforces shared per-IP limits across transports and process-local app instances', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => post('resend-verification', { email: 'absent@example.invalid' })));
    expect(results.filter(result => result.status === 202)).toHaveLength(5);
    expect(results.filter(result => result.status === 429)).toHaveLength(3);
    const second = createApp(config, () => 'connected', send);
    const response = await request(second).post('/api/auth/mobile/register').send(credentials).expect(429);
    expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
  });
  it('binds CSRF to a persistent prelogin cookie, rejects foreign tokens, and accepts web registration', async () => {
    const agent = request.agent(app);
    const first = await agent.get('/api/auth/web/csrf').expect(200);
    const second = await agent.get('/api/auth/web/csrf').expect(200);
    expect(second.body).toEqual(first.body);
    expect(first.headers['set-cookie']![0]).toContain('HttpOnly');
    await agent.post('/api/auth/web/register').set('Origin', config.WEB_ORIGINS[0]!).send(credentials).expect(403);
    await request(app).post('/api/auth/web/register').set('Origin', config.WEB_ORIGINS[0]!).set('X-CSRF-Token', first.body.csrfToken).send(credentials).expect(403);
    const response = await agent.post('/api/auth/web/register').set('Origin', config.WEB_ORIGINS[0]!).set('X-CSRF-Token', first.body.csrfToken).send(credentials).expect(202);
    expect(response.headers['set-cookie']).toBeUndefined();
    await PreloginModel.updateMany({}, { $set: { expiresAt: new Date(0) } });
    await agent.post('/api/auth/web/verify-email').set('Origin', config.WEB_ORIGINS[0]!).set('X-CSRF-Token', first.body.csrfToken).send({ token: sent[0]!.token }).expect(403);
  });
  it('accepts only active verified session-bound CSRF on web account forms', async () => {
    const secret = 's'.repeat(64);
    const csrf = 'c'.repeat(64);
    const user = await UserModel.create({ email: credentials.email, passwordHash: 'fixture', emailVerifiedAt: new Date() });
    const session = await SessionModel.create({ userId: user._id, transport: 'web', secretHash: hashSecret(secret), csrfHash: hashSecret(csrf), expiresAt: new Date(Date.now() + 60000) });
    const mutation = () => request(app).post('/api/auth/web/resend-verification').set('Origin', config.WEB_ORIGINS[0]!).set('Cookie', `price_tracker_session_dev=${secret}`).set('X-CSRF-Token', csrf).send({ email: 'absent@example.invalid' });
    await mutation().expect(202);
    const bootstrap = await request(app).get('/api/auth/web/csrf').set('Cookie', `price_tracker_session_dev=${secret}`).expect(200);
    expect(bootstrap.headers['set-cookie']).toBeUndefined();
    expect(bootstrap.body.expiresAt).toBe(session.expiresAt.toISOString());
    const repeated = await request(app).get('/api/auth/web/csrf').set('Cookie', `price_tracker_session_dev=${secret}`).expect(200);
    expect(repeated.body).toEqual(bootstrap.body);
    await request(app).post('/api/auth/web/resend-verification').set('Origin', config.WEB_ORIGINS[0]!).set('Cookie', `price_tracker_session_dev=${secret}`).set('X-CSRF-Token', bootstrap.body.csrfToken).send({ email: 'absent@example.invalid' }).expect(202);
    await SessionModel.updateOne({ _id: session._id }, { $set: { revokedAt: new Date() } });
    await mutation().expect(403);
  });
  it('hides identity-specific throttling behind the generic response', async () => {
    const start = Math.floor(Date.now() / 900000) * 900000;
    await AuthLimitModel.create({ key: hashSecret(`auth-identity:${credentials.email}:${start}`), attempts: 5, expiresAt: new Date(start + 900000) });
    const res = await post('register', credentials).expect(202);
    expect(res.body).toEqual({ message: 'If eligible, you will receive an email with next steps.' });
    expect(await UserModel.countDocuments()).toBe(0);
    expect(res.headers['retry-after']).toBeUndefined();
  });
});
