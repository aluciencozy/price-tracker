import express from 'express';
import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { requireAdmin, requireVerifiedUser } from '../src/authMiddleware.js';
import { limitAuthAttempts } from '../src/authRateLimit.js';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { AuthLimitModel, AuthTokenModel, PreloginModel, SessionModel, UserModel } from '../src/models/account.js';
import { DeviceModel } from '../src/models/device.js';
import { createDatabaseIndexes } from '../src/models/index.js';
import { VerificationMailModel } from '../src/models/verificationMail.js';
import { hashSecret, hashPassword } from '../src/registration.js';
import { dispatchPasswordResetMail } from '../src/verificationDispatch.js';
import { verifyPassword } from '../src/passwordVerification.js';
import * as passwordVerification from '../src/passwordVerification.js';
import { completePasswordReset, requestPasswordReset } from '../src/passwordReset.js';

const uri = process.env.TEST_MONGODB_URI;
describe.skipIf(!uri)('verified account sessions and password reset', () => {
  const dbName = `price_tracker_account_test_${randomUUID().replaceAll('-', '')}`;
  const signingKey = 'fixture-only-jwt-signing-key-at-least-32-characters-long';
  const config = loadConfig({ NODE_ENV: 'test', AUTH_JWT_SECRET: signingKey });
  const app = createApp(config, () => 'connected');
  const credentials = { email: 'player@example.invalid', password: '  fixture password  ' };
  const passwordHashPromise = hashPassword(credentials.password);
  const origin = config.WEB_ORIGINS[0]!;
  let passwordHash: string;

  beforeAll(async () => {
    passwordHash = await passwordHashPromise;
    await mongoose.connect(uri!, { dbName, autoIndex: false, serverSelectionTimeoutMS: 5000 });
    await createDatabaseIndexes();
  }, 30_000);
  beforeEach(async () => {
    await Promise.all([
      UserModel.deleteMany({}), AuthTokenModel.deleteMany({}), SessionModel.deleteMany({}),
      AuthLimitModel.deleteMany({}), PreloginModel.deleteMany({}), DeviceModel.deleteMany({}),
      VerificationMailModel.deleteMany({}),
    ]);
    await UserModel.create({ email: credentials.email, passwordHash, emailVerifiedAt: new Date() });
  });
  afterAll(async () => {
    if (mongoose.connection.name === dbName) await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  it('shares the private session limit across routers and preserves other sessions', async () => {
    const user = await UserModel.findOne({ email: credentials.email }).orFail();
    const createSession = async (secret: string) => SessionModel.create({ userId: user._id, transport: 'web',
      secretHash: hashSecret(secret), expiresAt: new Date(Date.now() + 60_000) });
    const firstSecret = 'a'.repeat(43), secondSecret = 'b'.repeat(43);
    const first = await createSession(firstSecret);
    await createSession(secondSecret);
    const routes = express();
    routes.get('/one', requireVerifiedUser(config), (_req, res) => res.sendStatus(204));
    routes.get('/two', requireVerifiedUser(config), (_req, res) => res.sendStatus(204));
    // All entry points/processes consume the same durable counter.
    const fixedNow = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(fixedNow);
    try {
      await Promise.all(Array.from({ length: 119 }, () => limitAuthAttempts('private-session', String(first._id), 120, 60_000)));
      await request(routes).get('/one').set('Cookie', `price_tracker_session_dev=${firstSecret}`).expect(204);
      const rejected = await request(routes).get('/two').set('Cookie', `price_tracker_session_dev=${firstSecret}`).expect(429);
      expect(rejected.body.error.code).toBe('RATE_LIMITED');
      expect(Number(rejected.headers['retry-after'])).toBeGreaterThan(0);
      expect(rejected.body.error.retryAfterSeconds).toBe(Number(rejected.headers['retry-after']));
      await request(routes).get('/two').set('Cookie', `price_tracker_session_dev=${secondSecret}`).expect(204);
      await request(routes).get('/one').expect(401);
    } finally { clock.mockRestore(); }
  });

  it('enforces transport, origin and CSRF for mixed-case mounted account paths', async () => {
    for (const action of ['login', 'register', 'logout', 'verify-email', 'resend-verification', 'forgot-password', 'reset-password']) {
      await request(app).post(`/API/AUTH/WeB/${action.toUpperCase()}`).set('Origin', origin).send({}).expect(403);
      await request(app).post(`/API/AUTH/MoBiLe/${action.toUpperCase()}`)
        .set('Cookie', 'price_tracker_prelogin_dev=fixture').send({}).expect(400);
      await request(app).post(`/API/AUTH/WeB/${action}`).set('Origin', 'https://unapproved.invalid').send({}).expect(403);
    }
    await request(app).post('/API/AUTH/WEB/login').set('Origin', 'https://unapproved.invalid')
      .set('Authorization', 'Bearer fixture').send(credentials).expect(400);
    await request(app).get('/API/AUTH/WeB/CSRF').set('Origin', 'https://unapproved.invalid').expect(403);
    await request(app).get('/API/AUTH/MOBILE/ME').set('Cookie', 'price_tracker_prelogin_dev=fixture').expect(400);
    expect(await SessionModel.countDocuments()).toBe(0);
  });

  it('consumes prelogin on successful login, but not on failure, and rejects concurrent replay', async () => {
    const bootstrap = await request(app).get('/api/auth/web/csrf').expect(200);
    const cookie = String(bootstrap.headers['set-cookie']).split(';')[0]!;
    const csrf = bootstrap.body.csrfToken as string;
    await request(app).post('/api/auth/web/login').set('Cookie', cookie).set('Origin', origin)
      .set('X-CSRF-Token', csrf).send({ ...credentials, password: 'wrong fixture password' }).expect(401);
    expect(await PreloginModel.countDocuments()).toBe(1);
    const attempt = () => request(app).post('/api/auth/web/login').set('Cookie', cookie).set('Origin', origin)
      .set('X-CSRF-Token', csrf).send(credentials);
    const results = await Promise.all([attempt(), attempt()]);
    expect(results.filter(result => result.status === 200)).toHaveLength(1);
    expect(await PreloginModel.countDocuments()).toBe(0);
    await request(app).post('/api/auth/web/forgot-password').set('Cookie', cookie).set('Origin', origin)
      .set('X-CSRF-Token', csrf).send({ email: credentials.email }).expect(403);
  });

  it('returns the identity throttle retry header and matching body for verification', async () => {
    const token = 'a'.repeat(64);
    const { limitAuthAttempts } = await import('../src/authRateLimit.js');
    for (let i = 0; i < 5; i++) await limitAuthAttempts('auth-identity', hashSecret(token), 5, 900_000);
    const response = await request(app).post('/api/auth/mobile/verify-email').send({ token }).expect(429);
    expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
    expect(response.body.error.retryAfterSeconds).toBe(Number(response.headers['retry-after']));
  });

  it.each(['web', 'mobile'] as const)('rejects %s login paused after password verification when reset commits', async transport => {
    await requestPasswordReset(credentials.email);
    let token = '';
    await dispatchPasswordResetMail(async details => { token = details.token; return { status: 'success', messageId: 'fixture', attempts: 1 }; });
    const bootstrap = transport === 'web' ? await request(app).get('/api/auth/web/csrf').expect(200) : null;
    let entered!: () => void;
    let release!: () => void;
    const paused = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const original = passwordVerification.verifyPassword;
    const spy = vi.spyOn(passwordVerification, 'verifyPassword').mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      entered();
      await gate;
      return result;
    });
    try {
      const login = request(app).post(`/api/auth/${transport}/login`).send(credentials);
      if (bootstrap) login.set('Cookie', String(bootstrap.headers['set-cookie']).split(';')[0]!).set('Origin', origin).set('X-CSRF-Token', bootstrap.body.csrfToken);
      const pending = login.then(response => response);
      await paused;
      expect(await completePasswordReset(token, 'new race fixture password')).toBe(true);
      release();
      expect((await pending).status).toBe(401);
      expect(await SessionModel.countDocuments({ revokedAt: null })).toBe(0);
    } finally { release(); spy.mockRestore(); }
  });

  it.each(['web', 'mobile'] as const)('invalidates %s session when account version changes even without explicit revocation', async transport => {
    const agent = request.agent(app);
    const bootstrap = transport === 'web' ? await agent.get('/api/auth/web/csrf').expect(200) : null;
    const login = agent.post(`/api/auth/${transport}/login`).send(credentials);
    if (bootstrap) login.set('Origin', origin).set('X-CSRF-Token', bootstrap.body.csrfToken);
    const response = await login.expect(200);
    const csrf = transport === 'web' ? (await agent.get('/api/auth/web/csrf').expect(200)).body.csrfToken : '';
    await UserModel.updateOne({ email: credentials.email }, { $inc: { sessionVersion: 1 } });
    const me = agent.get(`/api/auth/${transport}/me`);
    if (transport === 'mobile') me.set('Authorization', `Bearer ${response.body.accessToken}`);
    await me.expect(401);
    if (transport === 'web') {
      await agent.post('/api/auth/web/forgot-password').set('Origin', origin).set('X-CSRF-Token', csrf)
        .send({ email: credentials.email }).expect(403);
    }
  });

  it('serializes reset behind an issuance that already wrote its account fence', async () => {
    await requestPasswordReset(credentials.email);
    let token = '';
    await dispatchPasswordResetMail(async details => { token = details.token; return { status: 'success', messageId: 'fixture', attempts: 1 }; });
    let entered!: () => void;
    let release!: () => void;
    const paused = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const original = SessionModel.create.bind(SessionModel);
    const spy = vi.spyOn(SessionModel, 'create').mockImplementationOnce((async (...args: Parameters<typeof original>) => {
      entered();
      await gate;
      return original(...args);
    }) as typeof SessionModel.create);
    try {
      const pendingLogin = request(app).post('/api/auth/mobile/login').send(credentials).then(response => response);
      await paused;
      const reset = completePasswordReset(token, 'new fenced fixture password');
      release();
      const login = await pendingLogin;
      expect(await reset).toBe(true);
      if (login.status === 200) {
        await request(app).get('/api/auth/mobile/me').set('Authorization', `Bearer ${login.body.accessToken}`).expect(401);
      } else expect(login.status).toBe(401);
      expect(await SessionModel.countDocuments({ revokedAt: null })).toBe(0);
    } finally { release(); spy.mockRestore(); }
  });

  it('uses p=3 registration hashes, generic invalid credentials, and refuses unverified users', async () => {
    await UserModel.updateOne({ email: credentials.email }, { $unset: { sessionVersion: 1 } });
    const good = await request(app).post('/api/auth/mobile/login').send(credentials).expect(200);
    expect(good.body.tokenType).toBe('Bearer');
    expect(good.body.expiresIn).toBe(604800);
    expect(good.headers['set-cookie']).toBeUndefined();
    expect(good.body.user.emailVerified).toBe(true);
    expect(JSON.stringify(good.body)).not.toContain('passwordHash');
    await request(app).get('/api/auth/mobile/me').set('Authorization', `Bearer ${good.body.accessToken}`).expect(200);

    const badPassword = await request(app).post('/api/auth/mobile/login').send({ ...credentials, password: 'different fixture password' }).expect(401);
    const absent = await request(app).post('/api/auth/mobile/login').send({ ...credentials, email: 'absent@example.invalid' }).expect(401);
    expect(badPassword.body.error).toMatchObject({ code: 'INVALID_CREDENTIALS', message: absent.body.error.message });

    await UserModel.updateOne({ email: credentials.email }, { $set: { emailVerifiedAt: null } });
    const rejected = await request(app).post('/api/auth/mobile/login').send(credentials).expect(403);
    expect(rejected.body.error.code).toBe('EMAIL_UNVERIFIED');
    expect(await SessionModel.countDocuments()).toBe(1);
  });

  it('creates fixed web cookie sessions, binds CSRF to that session, and revokes devices on logout', async () => {
    const agent = request.agent(app);
    const bootstrap = await agent.get('/api/auth/web/csrf').expect(200);
    expect(bootstrap.headers['cache-control']).toContain('no-store');
    expect(String(bootstrap.headers['set-cookie'])).toContain('HttpOnly');
    expect(String(bootstrap.headers['set-cookie'])).toContain('SameSite=Lax');

    await request(app).post('/api/auth/web/login').send(credentials).expect(403);
    await request(app).get('/api/auth/web/csrf').set('Origin', 'https://unapproved.invalid').expect(403);
    const login = await agent.post('/api/auth/web/login')
      .set('Origin', origin).set('X-CSRF-Token', bootstrap.body.csrfToken).send(credentials).expect(200);
    expect(login.body.accessToken).toBeUndefined();
    expect(login.body.user.emailVerified).toBe(true);
    const cookieHeader = login.headers['set-cookie'];
    const cookie = (Array.isArray(cookieHeader) ? cookieHeader : cookieHeader ? [cookieHeader] : [])
      .find(value => value.startsWith('price_tracker_session_dev='));
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).not.toContain('Secure');

    const session = await SessionModel.findById(login.body.sessionId).orFail();
    expect(session.expiresAt.getTime() - Date.now()).toBeGreaterThan(604_790_000);
    expect(session.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(604_800_000);
    await agent.get('/api/auth/web/me').expect(200);
    const sessionBootstrap = await agent.get('/api/auth/web/csrf').expect(200);
    expect(sessionBootstrap.body.expiresAt).toBe(session.expiresAt.toISOString());
    expect(sessionBootstrap.headers['set-cookie']).toBeUndefined();

    const device = await DeviceModel.create({
      userId: session.userId, sessionId: session._id, installationId: randomUUID(),
      platform: 'android', pushToken: `fixture-${randomUUID()}`,
    });
    await agent.post('/api/auth/web/logout').set('Origin', origin)
      .set('X-CSRF-Token', sessionBootstrap.body.csrfToken).expect(204);
    expect((await DeviceModel.findById(device._id))!.active).toBe(false);
    await request(app).get('/api/auth/web/me').set('Cookie', cookie!.split(';')[0]!).expect(401);
  });

  it('checks JWT signature and expiry on each request and revokes mobile devices on logout', async () => {
    const login = await request(app).post('/api/auth/mobile/login').send(credentials).expect(200);
    const session = await SessionModel.findById(login.body.sessionId).orFail();
    const device = await DeviceModel.create({
      userId: session.userId, sessionId: session._id, installationId: randomUUID(),
      platform: 'android', pushToken: `fixture-${randomUUID()}`,
    });
    const expired = await new SignJWT({ sid: String(session._id), ver: 0 })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(String(session.userId)).setIssuer('price-tracker-api').setAudience('price-tracker-mobile')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 100).setExpirationTime(Math.floor(Date.now() / 1000) - 1)
      .sign(new TextEncoder().encode(signingKey));
    await request(app).get('/api/auth/mobile/me').set('Authorization', `Bearer ${expired}`).expect(401);
    await request(app).get('/api/auth/mobile/me')
      .set('Authorization', `Bearer ${login.body.accessToken.slice(0, -1)}x`).expect(401);

    await request(app).post('/api/auth/mobile/logout')
      .set('Authorization', `Bearer ${login.body.accessToken}`).expect(204);
    expect((await SessionModel.findById(session._id))!.revokedAt).toBeInstanceOf(Date);
    expect((await DeviceModel.findById(device._id))!.active).toBe(false);
    await request(app).get('/api/auth/mobile/me')
      .set('Authorization', `Bearer ${login.body.accessToken}`).expect(401);
  });

  it('deactivates native device bindings when the fixed server-side session expires', async () => {
    const login = await request(app).post('/api/auth/mobile/login').send(credentials).expect(200);
    const session = await SessionModel.findById(login.body.sessionId).orFail();
    const device = await DeviceModel.create({
      userId: session.userId, sessionId: session._id, installationId: randomUUID(),
      platform: 'android', pushToken: `fixture-${randomUUID()}`,
    });
    await SessionModel.updateOne({ _id: session._id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    await request(app).get('/api/auth/mobile/me')
      .set('Authorization', `Bearer ${login.body.accessToken}`).expect(401);
    expect((await SessionModel.findById(session._id))!.revokedAt).toBeInstanceOf(Date);
    expect((await DeviceModel.findById(device._id))!.active).toBe(false);
  });

  it('rotates a supplied web cookie or native JWT and deactivates the old session devices', async () => {
    const webAgent = request.agent(app);
    const preloginCsrf = (await webAgent.get('/api/auth/web/csrf').expect(200)).body.csrfToken as string;
    const firstWeb = await webAgent.post('/api/auth/web/login').set('Origin', origin)
      .set('X-CSRF-Token', preloginCsrf).send(credentials).expect(200);
    const webSession = await SessionModel.findById(firstWeb.body.sessionId).orFail();
    const webDevice = await DeviceModel.create({
      userId: webSession.userId, sessionId: webSession._id, installationId: randomUUID(),
      platform: 'android', pushToken: `fixture-${randomUUID()}`,
    });
    const webCsrf = (await webAgent.get('/api/auth/web/csrf').expect(200)).body.csrfToken as string;
    const secondWeb = await webAgent.post('/api/auth/web/login').set('Origin', origin)
      .set('X-CSRF-Token', webCsrf).send(credentials).expect(200);
    expect(secondWeb.body.sessionId).not.toBe(firstWeb.body.sessionId);
    expect((await SessionModel.findById(webSession._id))!.revokedAt).toBeInstanceOf(Date);
    expect((await DeviceModel.findById(webDevice._id))!.active).toBe(false);
    await webAgent.get('/api/auth/web/me').expect(200);

    const firstMobile = await request(app).post('/api/auth/mobile/login').send(credentials).expect(200);
    const mobileSession = await SessionModel.findById(firstMobile.body.sessionId).orFail();
    const mobileDevice = await DeviceModel.create({
      userId: mobileSession.userId, sessionId: mobileSession._id, installationId: randomUUID(),
      platform: 'android', pushToken: `fixture-${randomUUID()}`,
    });
    const secondMobile = await request(app).post('/api/auth/mobile/login')
      .set('Authorization', `Bearer ${firstMobile.body.accessToken}`).send(credentials).expect(200);
    expect(secondMobile.body.sessionId).not.toBe(firstMobile.body.sessionId);
    expect((await SessionModel.findById(mobileSession._id))!.revokedAt).toBeInstanceOf(Date);
    expect((await DeviceModel.findById(mobileDevice._id))!.active).toBe(false);
    await request(app).get('/api/auth/mobile/me')
      .set('Authorization', `Bearer ${firstMobile.body.accessToken}`).expect(401);
    await request(app).get('/api/auth/mobile/me')
      .set('Authorization', `Bearer ${secondMobile.body.accessToken}`).expect(200);
  });

  it('sets the shared verified principal and rejects mixed transports and non-current web CSRF', async () => {
    const webAgent = request.agent(app);
    const prelogin = (await webAgent.get('/api/auth/web/csrf').expect(200)).body.csrfToken as string;
    const webLogin = await webAgent.post('/api/auth/web/login').set('Origin', origin)
      .set('X-CSRF-Token', prelogin).send(credentials).expect(200);
    const webCsrf = (await webAgent.get('/api/auth/web/csrf').expect(200)).body.csrfToken as string;
    const mobileLogin = await request(app).post('/api/auth/mobile/login').send(credentials).expect(200);

    const probe = express();
    probe.use(express.json());
    probe.get('/private', requireVerifiedUser(config), (_req, res) => res.json(res.locals.principal));
    probe.post('/private', requireVerifiedUser(config), (_req, res) => res.json(res.locals.principal));
    probe.get('/admin', requireVerifiedUser(config), requireAdmin, (_req, res) => res.status(204).send());

    const mobilePrincipal = await request(probe).get('/private')
      .set('Authorization', `Bearer ${mobileLogin.body.accessToken}`).expect(200);
    expect(mobilePrincipal.body).toEqual({
      userId: mobileLogin.body.user.id, sessionId: mobileLogin.body.sessionId,
      transport: 'mobile', role: 'user',
    });
    const cookieHeader = webLogin.headers['set-cookie'];
    const webCookie = (Array.isArray(cookieHeader) ? cookieHeader : cookieHeader ? [cookieHeader] : [])
      .find(value => value.startsWith('price_tracker_session_dev='))?.split(';')[0];
    const privateAgent = request.agent(probe);
    const webPrincipal = await privateAgent.post('/private').set('Cookie', webCookie!)
      .set('Origin', origin).set('X-CSRF-Token', webCsrf).expect(200);
    expect(webPrincipal.body).toMatchObject({ sessionId: webLogin.body.sessionId, transport: 'web', role: 'user' });
    await request(probe).post('/private').set('Cookie', webCookie!)
      .set('X-CSRF-Token', webCsrf).expect(403);
    await request(probe).post('/private').set('Cookie', webCookie!)
      .set('Origin', 'https://unapproved.invalid').set('X-CSRF-Token', webCsrf).expect(403);
    await request(probe).get('/private').set('Cookie', webCookie!)
      .set('Authorization', `Bearer ${mobileLogin.body.accessToken}`).expect(400);
    await request(probe).get('/private').set('Authorization', `Bearer ${mobileLogin.body.accessToken}`)
      .set('Cookie', 'price_tracker_prelogin_dev=not-a-session').expect(400);
    await request(probe).get('/admin').set('Authorization', `Bearer ${mobileLogin.body.accessToken}`).expect(403);
  });

  it('returns the same forgot response and queues reset mail without invoking a sender', async () => {
    await UserModel.create({ email: 'unverified@example.invalid', passwordHash, emailVerifiedAt: null });
    const unknown = await request(app).post('/api/auth/mobile/forgot-password')
      .send({ email: 'absent@example.invalid' }).expect(202);
    const unverified = await request(app).post('/api/auth/mobile/forgot-password')
      .send({ email: 'unverified@example.invalid' }).expect(202);
    const eligible = await request(app).post('/api/auth/mobile/forgot-password')
      .send({ email: credentials.email }).expect(202);
    expect(unknown.body).toEqual(eligible.body);
    expect(unverified.body).toEqual(eligible.body);
    expect(await VerificationMailModel.countDocuments({ status: 'pending', purpose: 'reset_password' })).toBe(1);
    const token = await AuthTokenModel.findOne({ purpose: 'reset_password' }).select('+tokenHash').orFail();
    expect(token.tokenHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('completes the web forgot/reset flow only after explicit CSRF-protected POSTs and does not log in', async () => {
    const agent = request.agent(app);
    const csrf = (await agent.get('/api/auth/web/csrf').expect(200)).body.csrfToken as string;
    const forgot = await agent.post('/api/auth/web/forgot-password').set('Origin', origin)
      .set('X-CSRF-Token', csrf).send({ email: credentials.email }).expect(202);
    expect(forgot.body).toEqual({ message: 'If eligible, you will receive an email with next steps.' });

    let token: string | undefined;
    await dispatchPasswordResetMail(async details => {
      token = details.token;
      return { status: 'success', messageId: 'fixture-only', attempts: 1 };
    });
    const reset = await agent.post('/api/auth/web/reset-password').set('Origin', origin)
      .set('X-CSRF-Token', csrf).send({ token, password: 'new web fixture password' }).expect(204);
    expect(String(reset.headers['set-cookie'])).toContain('price_tracker_session_dev=');
    expect(String(reset.headers['set-cookie'])).toContain('price_tracker_prelogin_dev=');
    expect(JSON.stringify(reset.body)).not.toContain('accessToken');
    await agent.get('/api/auth/web/me').expect(401);
  });

  it('sends only through the fake dispatcher and atomically resets once, revoking all sessions/devices', async () => {
    const mobileLogin = await request(app).post('/api/auth/mobile/login').send(credentials).expect(200);
    const webAgent = request.agent(app);
    const prelogin = (await webAgent.get('/api/auth/web/csrf').expect(200)).body.csrfToken as string;
    const webLogin = await webAgent.post('/api/auth/web/login').set('Origin', origin)
      .set('X-CSRF-Token', prelogin).send(credentials).expect(200);
    const webSession = await SessionModel.findById(webLogin.body.sessionId).orFail();
    const mobileSession = await SessionModel.findById(mobileLogin.body.sessionId).orFail();
    const devices = await DeviceModel.create([
      { userId: webSession.userId, sessionId: webSession._id, installationId: randomUUID(), platform: 'android', pushToken: `fixture-${randomUUID()}` },
      { userId: mobileSession.userId, sessionId: mobileSession._id, installationId: randomUUID(), platform: 'android', pushToken: `fixture-${randomUUID()}` },
    ]);

    await request(app).post('/api/auth/mobile/forgot-password').send({ email: credentials.email }).expect(202);
    let resetToken: string | undefined;
    const fakeSender = async (details: { email: string; token: string }) => {
      expect(details.email).toBe(credentials.email);
      resetToken = details.token;
      return { status: 'success' as const, messageId: 'fixture-only', attempts: 1 };
    };
    expect(await dispatchPasswordResetMail(fakeSender)).toBe(true);
    expect(resetToken).toMatch(/^[a-f0-9]{64}$/);
    const persisted = await VerificationMailModel.findOne({ userId: webSession.userId }).lean();
    expect(JSON.stringify(persisted)).not.toContain(resetToken);

    const reset = await request(app).post('/api/auth/mobile/reset-password')
      .send({ token: resetToken, password: 'new fixture password' }).expect(204);
    expect(reset.headers['set-cookie']).toBeUndefined();
    await request(app).get('/api/auth/mobile/me').set('Authorization', `Bearer ${mobileLogin.body.accessToken}`).expect(401);
    await webAgent.get('/api/auth/web/me').expect(401);
    expect((await SessionModel.findById(webSession._id))!.revokedAt).toBeInstanceOf(Date);
    expect((await SessionModel.findById(mobileSession._id))!.revokedAt).toBeInstanceOf(Date);
    for (const device of devices) expect((await DeviceModel.findById(device._id))!.active).toBe(false);
    expect(await verifyPassword('new fixture password', (await UserModel.findOne().select('+passwordHash').orFail()).passwordHash)).toBe(true);
    expect(await verifyPassword(credentials.password, (await UserModel.findOne().select('+passwordHash').orFail()).passwordHash)).toBe(false);
    await request(app).post('/api/auth/mobile/reset-password')
      .send({ token: resetToken, password: 'another fixture password' }).expect(400);
    expect(await AuthTokenModel.countDocuments({ tokenHash: hashSecret(resetToken!), purpose: 'reset_password', consumedAt: null })).toBe(0);
  });

  it('consumes a reset token exactly once under concurrent submissions', async () => {
    await requestPasswordReset(credentials.email);
    let token: string | undefined;
    await dispatchPasswordResetMail(async details => {
      token = details.token;
      return { status: 'success', messageId: 'fixture-only', attempts: 1 };
    });
    const results = await Promise.all([
      completePasswordReset(token!, 'first concurrent password'),
      completePasswordReset(token!, 'second concurrent password'),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const saved = (await UserModel.findOne().select('+passwordHash').orFail()).passwordHash;
    expect(await verifyPassword('first concurrent password', saved) || await verifyPassword('second concurrent password', saved)).toBe(true);
  });

  it('rolls back token consumption, password change, session revocation and device invalidation together', async () => {
    const secret = randomUUID().replaceAll('-', '').padEnd(43, 'x');
    const session = await SessionModel.create({
      userId: (await UserModel.findOne().orFail())._id, transport: 'web',
      secretHash: hashSecret(secret), expiresAt: new Date(Date.now() + 60_000),
    });
    const device = await DeviceModel.create({
      userId: session.userId, sessionId: session._id, installationId: randomUUID(),
      platform: 'android', pushToken: `fixture-${randomUUID()}`,
    });
    await requestPasswordReset(credentials.email);
    let token: string | undefined;
    await dispatchPasswordResetMail(async details => {
      token = details.token;
      return { status: 'success', messageId: 'fixture-only', attempts: 1 };
    });

    vi.spyOn(DeviceModel, 'updateMany').mockImplementationOnce(() => { throw new Error('fixture device update failure'); });
    await expect(completePasswordReset(token!, 'replacement fixture password')).rejects.toThrow('fixture device update failure');
    vi.restoreAllMocks();
    expect((await AuthTokenModel.findOne({ purpose: 'reset_password' }))!.consumedAt).toBeNull();
    expect((await UserModel.findOne().select('+passwordHash').orFail()).passwordHash).toBe(passwordHash);
    expect((await SessionModel.findById(session._id))!.revokedAt).toBeNull();
    expect((await DeviceModel.findById(device._id))!.active).toBe(true);
    expect(await completePasswordReset(token!, 'replacement fixture password')).toBe(true);
  });
});
