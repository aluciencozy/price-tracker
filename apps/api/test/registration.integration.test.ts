import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { AuthLimitModel, AuthTokenModel, PreloginModel, SessionModel, UserModel } from '../src/models/account.js';
import { createDatabaseIndexes } from '../src/models/index.js';
import { hashSecret, register as enqueueRegister, resend as enqueueResend, verify, type VerificationSender } from '../src/registration.js';
import { csrfForSecret } from '../src/sessionSecurity.js';
import { VerificationMailModel } from '../src/models/verificationMail.js';
import { dispatchVerificationMail, recoverVerificationMail, startVerificationDispatcher } from '../src/verificationDispatch.js';

const uri = process.env.TEST_MONGODB_URI;
describe.skipIf(!uri)('registration routes with real MongoDB transactions', () => {
  const dbName = `price_tracker_auth_test_${randomUUID().replaceAll('-', '')}`;
  const sent: { email: string; token: string }[] = [];
  const send = vi.fn(async (details: { email: string; token: string }) => {
    sent.push(details);
    return { status: 'success' as const, messageId: 'fixture', attempts: 1 };
  });
  const config = loadConfig({ NODE_ENV: 'test' });
  const app = createApp(config, () => 'connected');
  const credentials = { email: 'fixture@example.invalid', password: '  fixture password  ', name: 'Player' };
  const post = (action: string, body: object) => request(app).post(`/api/auth/mobile/${action}`).send(body);
  // Service tests explicitly dispatch; the HTTP app never calls a provider.
  const register = async (input: typeof credentials, sender: VerificationSender) => {
    await enqueueRegister(input);
    await dispatchVerificationMail(sender);
  };
  const resend = async (email: string, sender: VerificationSender) => {
    await enqueueResend(email);
    await dispatchVerificationMail(sender);
  };
  beforeAll(async () => {
    await mongoose.connect(uri!, { dbName, autoIndex: false, serverSelectionTimeoutMS: 5000 });
    await createDatabaseIndexes();
  }, 30000);
  beforeEach(async () => {
    await Promise.all([UserModel.deleteMany({}), AuthTokenModel.deleteMany({}), SessionModel.deleteMany({}), AuthLimitModel.deleteMany({}), PreloginModel.deleteMany({})]);
    await VerificationMailModel.deleteMany({});
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
    await dispatchVerificationMail(send);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('token');
    const user = await UserModel.findOne().select('+passwordHash').orFail();
    expect(user.email).toBe(credentials.email);
    expect(user.passwordHash).toMatch(/^scrypt\$/);
    expect(user.emailVerifiedAt).toBeNull();
    const token = await AuthTokenModel.findOne().select('+tokenHash').orFail();
    expect(token.tokenHash).toBe(hashSecret(sent[0]!.token));
    expect(token.expiresAt.getTime() - Date.now()).toBeGreaterThan(86300000);
    // Correct credentials remain insufficient until email verification.
    const unverifiedLogin = await post('login', { email: credentials.email, password: credentials.password }).expect(403);
    expect(unverifiedLogin.body.error.code).toBe('EMAIL_UNVERIFIED');
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
    await dispatchVerificationMail(send);
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
    await dispatchVerificationMail(send);
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
    await dispatchVerificationMail(send);
    expect(await UserModel.countDocuments()).toBe(1);
    expect(await AuthTokenModel.countDocuments()).toBe(1);
    await UserModel.updateOne({}, { $set: { verificationEmailSentAt: new Date(0) } });
    await post('resend-verification', { email: credentials.email }).expect(202);
    await dispatchVerificationMail(send);
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
    const second = createApp(config, () => 'connected');
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
    await dispatchVerificationMail(send);
    expect(response.headers['set-cookie']).toBeUndefined();
    await PreloginModel.updateMany({}, { $set: { expiresAt: new Date(0) } });
    await agent.post('/api/auth/web/verify-email').set('Origin', config.WEB_ORIGINS[0]!).set('X-CSRF-Token', first.body.csrfToken).send({ token: sent[0]!.token }).expect(403);
  });
  it('accepts only active verified session-bound CSRF on web account forms', async () => {
    const secret = 's'.repeat(43);
    const csrf = csrfForSecret(secret);
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
  it('completes eligible and duplicate registration responses while provider delivery is blocked', async () => {
    await enqueueRegister(credentials);
    let release!: () => void;
    let entered!: () => void;
    const providerEntered = new Promise<void>(resolve => { entered = resolve; });
    const providerRelease = new Promise<void>(resolve => { release = resolve; });
    let providerCompleted = false;
    const blocked = dispatchVerificationMail(async () => {
      entered();
      await providerRelease;
      providerCompleted = true;
      return { status: 'success', messageId: 'fixture', attempts: 1 };
    });
    await providerEntered;
    try {
      const eligible = await post('register', { ...credentials, email: 'second@example.invalid' }).expect(202);
      const duplicate = await post('register', credentials).expect(202);
      expect(eligible.body).toEqual(duplicate.body);
      expect(providerCompleted).toBe(false);
      expect(await VerificationMailModel.countDocuments({ status: 'pending' })).toBe(1);
    } finally { release(); await blocked; }
  });
  it('completes eligible, unknown, verified and cooldown resend responses without waiting on a blocked provider', async () => {
    await enqueueRegister(credentials);
    await UserModel.create({ email: 'verified@example.invalid', passwordHash: 'fixture', emailVerifiedAt: new Date() });
    let release!: () => void;
    let entered!: () => void;
    const providerEntered = new Promise<void>(resolve => { entered = resolve; });
    const providerRelease = new Promise<void>(resolve => { release = resolve; });
    let providerCompleted = false;
    const blocked = dispatchVerificationMail(async () => {
      entered(); await providerRelease; providerCompleted = true;
      return { status: 'unknown', code: 'fixture_uncertain', attempts: 1 };
    });
    await providerEntered;
    try {
      await UserModel.updateOne({ email: credentials.email }, { $set: { verificationEmailSentAt: new Date(0) } });
      const responses = await Promise.all([
        post('resend-verification', { email: credentials.email }).expect(202),
        post('resend-verification', { email: 'absent@example.invalid' }).expect(202),
        post('resend-verification', { email: 'verified@example.invalid' }).expect(202),
      ]);
      const cooldown = await post('resend-verification', { email: credentials.email }).expect(202);
      for (const response of responses) expect(response.body).toEqual(cooldown.body);
      expect(providerCompleted).toBe(false);
      expect(await VerificationMailModel.countDocuments()).toBe(1);
    } finally { release(); await blocked; }
    // Old in-flight completion cannot finalize the explicitly rotated pending job.
    expect((await VerificationMailModel.findOne())!.status).toBe('pending');
    await dispatchVerificationMail(send);
    expect(await verify(sent[0]!.token)).toBe(true);
  });
  it('rolls back user and token when enqueue storage fails', async () => {
    vi.spyOn(VerificationMailModel, 'findOneAndUpdate').mockImplementationOnce(() => { throw new Error('fixture outbox failure'); });
    await post('register', credentials).expect(503);
    expect(await UserModel.countDocuments()).toBe(0);
    expect(await AuthTokenModel.countDocuments()).toBe(0);
    expect(await VerificationMailModel.countDocuments()).toBe(0);
  });
  it('recovers a pending job after reconnect, stores no raw secrets, and dispatches it once', async () => {
    await enqueueRegister(credentials);
    const before = await AuthTokenModel.findOne().select('+tokenHash').orFail();
    await mongoose.disconnect();
    await mongoose.connect(uri!, { dbName, autoIndex: false });
    expect(await dispatchVerificationMail(send)).toBe(true);
    expect(await dispatchVerificationMail(send)).toBe(false);
    expect(sent).toHaveLength(1);
    const stored = await AuthTokenModel.findOne().select('+tokenHash').orFail();
    expect(stored.tokenHash).not.toBe(before.tokenHash);
    expect(stored.expiresAt).toEqual(before.expiresAt);
    const job = await VerificationMailModel.findOne().lean();
    expect(JSON.stringify(job)).not.toContain(sent[0]!.token);
    expect(job!.deliveryKey).toBe(`verify-email:${hashSecret(sent[0]!.token)}`);
    expect(job!.providerMessageId).toBe('fixture');
    expect(await verify(sent[0]!.token)).toBe(true);
  });
  it.each(['unknown', 'retryable_failure', 'permanent_failure'] as const)('never automatically replays a %s outcome', async status => {
    await enqueueRegister(credentials);
    const sender: VerificationSender = vi.fn(async details => {
      sent.push(details);
      return { status, code: 'fixture', attempts: 1 };
    });
    await dispatchVerificationMail(sender);
    await recoverVerificationMail(new Date(Date.now() + 120000));
    expect(await dispatchVerificationMail(sender)).toBe(false);
    expect(sender).toHaveBeenCalledTimes(1);
    expect((await VerificationMailModel.findOne())!.status).toBe(status === 'unknown' ? 'unknown' : 'failed');
    expect(await verify(sent[0]!.token)).toBe(true);
  });
  it('marks interrupted sends unknown without reclaiming, even if an old provider call later completes', async () => {
    await enqueueRegister(credentials);
    let entered!: () => void;
    let release!: () => void;
    const providerEntered = new Promise<void>(resolve => { entered = resolve; });
    const providerRelease = new Promise<void>(resolve => { release = resolve; });
    const blocked = dispatchVerificationMail(async details => {
      sent.push(details); entered(); await providerRelease;
      return { status: 'success', messageId: 'fixture', attempts: 1 };
    });
    await providerEntered;
    try {
      await recoverVerificationMail(new Date(Date.now() + 120000));
      expect((await VerificationMailModel.findOne())!.status).toBe('unknown');
      expect(await dispatchVerificationMail(send)).toBe(false);
    } finally { release(); await blocked; }
    expect((await VerificationMailModel.findOne())!.status).toBe('unknown');
    expect(await verify(sent[0]!.token)).toBe(true);
  });
  it('does not resend after an accepted provider response whose status write failed', async () => {
    await enqueueRegister(credentials);
    const write = vi.spyOn(VerificationMailModel, 'updateOne').mockImplementationOnce(() => { throw new Error('fixture finalization failure'); });
    await expect(dispatchVerificationMail(send)).rejects.toThrow('fixture finalization failure');
    write.mockRestore();
    await recoverVerificationMail(new Date(Date.now() + 120000));
    expect(await dispatchVerificationMail(send)).toBe(false);
    expect(sent).toHaveLength(1);
    expect((await VerificationMailModel.findOne())!.status).toBe('unknown');
  });
  it('expires pending jobs instead of minting a later token with extended lifetime', async () => {
    await enqueueRegister(credentials);
    await VerificationMailModel.updateMany({}, { $set: { expiresAt: new Date(0) } });
    await recoverVerificationMail();
    expect(await dispatchVerificationMail(send)).toBe(false);
    expect(sent).toHaveLength(0);
    expect((await VerificationMailModel.findOne())!.status).toBe('superseded');
  });
  it('rolls back a failed claim before sending, so pending work is safely recoverable', async () => {
    await enqueueRegister(credentials);
    const before = await AuthTokenModel.findOne().select('+tokenHash').orFail();
    const write = vi.spyOn(AuthTokenModel, 'updateOne').mockImplementationOnce(() => { throw new Error('fixture claim failure'); });
    await expect(dispatchVerificationMail(send)).rejects.toThrow('fixture claim failure');
    write.mockRestore();
    expect(send).not.toHaveBeenCalled();
    expect((await VerificationMailModel.findOne())!.status).toBe('pending');
    expect((await AuthTokenModel.findOne().select('+tokenHash'))!.tokenHash).toBe(before.tokenHash);
    expect(await dispatchVerificationMail(send)).toBe(true);
    expect(await verify(sent[0]!.token)).toBe(true);
  });
  it('rolls back resend cooldown and token rotation if its outbox update fails', async () => {
    await register(credentials, send);
    await UserModel.updateOne({}, { $set: { verificationEmailSentAt: new Date(0) } });
    vi.spyOn(VerificationMailModel, 'findOneAndUpdate').mockImplementationOnce(() => { throw new Error('fixture outbox failure'); });
    await post('resend-verification', { email: credentials.email }).expect(503);
    expect((await UserModel.findOne())!.verificationEmailSentAt).toEqual(new Date(0));
    expect((await VerificationMailModel.findOne())!.status).toBe('sent');
    expect(await verify(sent[0]!.token)).toBe(true);
  });
  it('bounds the managed dispatcher to one active provider call and stops without claiming more work', async () => {
    await enqueueRegister(credentials);
    await enqueueRegister({ ...credentials, email: 'second@example.invalid' });
    let entered!: () => void;
    let release!: () => void;
    const providerEntered = new Promise<void>(resolve => { entered = resolve; });
    const providerRelease = new Promise<void>(resolve => { release = resolve; });
    const sender = vi.fn(async () => {
      entered(); await providerRelease;
      return { status: 'success' as const, messageId: 'fixture', attempts: 1 };
    });
    const stop = startVerificationDispatcher(sender, () => true);
    await providerEntered;
    const stopped = stop();
    expect(sender).toHaveBeenCalledTimes(1);
    expect(await VerificationMailModel.countDocuments({ status: 'pending' })).toBe(1);
    release();
    await stopped;
    expect(sender).toHaveBeenCalledTimes(1);
    expect(await VerificationMailModel.countDocuments({ status: 'pending' })).toBe(1);
  });
});
