import { randomBytes } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { SignJWT } from 'jose';
import mongoose from 'mongoose';
import { z } from 'zod';
import type { Config } from './config.js';
import { accountError as fail } from './accountError.js';
import { limitAuthAttempts } from './authRateLimit.js';
import { requireVerifiedUser, type AuthPrincipal } from './authMiddleware.js';
import { PreloginModel, SessionModel, UserModel } from './models/account.js';
import { DeviceModel } from './models/device.js';
import { accepted, hashSecret, register, resend, verify } from './registration.js';
import { completePasswordReset, requestPasswordReset } from './passwordReset.js';
import { verifyPassword } from './passwordVerification.js';
import { activeMobileToken, activeWebSession, allowedOrigin, cookiePolicy, csrfForSecret, hasWebAuthCookie, validWebMutationCsrf, webPreloginSecret, webSessionSecret } from './sessionSecurity.js';

const email = z.string().trim().toLowerCase().max(254).regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
const password = z.string().refine(value => Array.from(value).length >= 12 && Array.from(value).length <= 128);
const registration = z.strictObject({
  email, password,
  name: z.string().trim().min(1).refine(value => Array.from(value).length <= 100).optional(),
});
const loginBody = z.strictObject({ email, password });
const emailBody = z.strictObject({ email });
const tokenBody = z.strictObject({ token: z.string().min(32).max(512).regex(/^[A-Za-z0-9_-]+$/) });
const resetBody = z.strictObject({ token: z.string().min(32).max(512).regex(/^[A-Za-z0-9_-]+$/), password });
const genericCredentialsError = (res: Response) => fail(res, 401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
const JWT_ISSUER = 'price-tracker-api';
const JWT_AUDIENCE = 'price-tracker-mobile';
const SESSION_SECONDS = 7 * 24 * 60 * 60;

type PublicUserSource = {
  _id: mongoose.Types.ObjectId;
  email: string;
  name?: string | null;
  role: string;
  createdAt: Date;
};

function publicUser(user: PublicUserSource) {
  return {
    id: String(user._id), email: user.email, name: user.name ?? null,
    emailVerified: true, role: user.role, createdAt: user.createdAt.toISOString(),
  };
}

function jsonBody(req: Request, res: Response): boolean {
  if (!req.is('application/json')) {
    fail(res, 415, 'UNSUPPORTED_MEDIA_TYPE', 'Use application/json.');
    return false;
  }
  return true;
}

function noBody(req: Request, res: Response): boolean {
  const declaredLength = Number(req.headers['content-length'] ?? 0);
  if (req.body === undefined && declaredLength === 0 && req.headers['transfer-encoding'] === undefined) return true;
  fail(res, 400, 'MALFORMED_REQUEST', 'This operation does not accept a body.');
  return false;
}

async function limited(res: Response, scope: string, value: string, maximum = 5, windowMs = 900_000) {
  const result = await limitAuthAttempts(scope, value, maximum, windowMs);
  if (result.blocked) res.set('Retry-After', String(result.retry));
  return result;
}

function sessionVersionFilter(version: number) {
  return version === 0 ? { $or: [{ sessionVersion: 0 }, { sessionVersion: { $exists: false } }] } : { sessionVersion: version };
}

async function revokeSession(sessionId: mongoose.Types.ObjectId, userId: mongoose.Types.ObjectId, now: Date, transaction: mongoose.ClientSession) {
  const revoked = await SessionModel.findOneAndUpdate({
    _id: sessionId, userId, revokedAt: null,
  }, { $set: { revokedAt: now } }, { session: transaction }).exec();
  if (revoked) await DeviceModel.updateMany({ sessionId, active: true }, { $set: { active: false } }, { session: transaction }).exec();
}

async function login(req: Request, res: Response, config: Config, transport: 'web' | 'mobile') {
  try {
    const ipRate = await limited(res, 'auth-ip', req.ip ?? 'unknown');
    if (ipRate.blocked) return fail(res, 429, 'RATE_LIMITED', 'Try again later.');
    if (!jsonBody(req, res)) return;
    const parsed = loginBody.safeParse(req.body);
    if (!parsed.success) return fail(res, 422, 'VALIDATION_ERROR', 'Check the account fields.');
    const accountRate = await limited(res, 'auth-identity', parsed.data.email);
    if (accountRate.blocked) return fail(res, 429, 'RATE_LIMITED', 'Try again later.');

    const user = await UserModel.findOne({ email: parsed.data.email }).select('+passwordHash').exec();
    const passwordMatches = await verifyPassword(parsed.data.password, user?.passwordHash);
    if (!user || !passwordMatches) return genericCredentialsError(res);
    // Reveal verification state only after credentials have been proven.
    if (!user.emailVerifiedAt) return fail(res, 403, 'EMAIL_UNVERIFIED', 'Verify your email before signing in.');
    if (transport === 'mobile' && !config.AUTH_JWT_SECRET) {
      return fail(res, 503, 'SERVICE_UNAVAILABLE', 'Native login is not configured.');
    }

    const sessionId = new mongoose.Types.ObjectId();
    const nowSeconds = Math.floor(Date.now() / 1000);
    const expiresAt = new Date((nowSeconds + SESSION_SECONDS) * 1000);
    const version = user.sessionVersion ?? 0;
    let sessionCredential: string;
    let accessToken: string | undefined;
    let csrfHash: string | null = null;
    if (transport === 'web') {
      sessionCredential = randomBytes(32).toString('base64url');
      csrfHash = hashSecret(csrfForSecret(sessionCredential));
    } else {
      accessToken = await new SignJWT({ sid: String(sessionId), ver: version })
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setSubject(String(user._id)).setIssuer(JWT_ISSUER).setAudience(JWT_AUDIENCE)
        .setIssuedAt(nowSeconds).setExpirationTime(nowSeconds + SESSION_SECONDS)
        .sign(new TextEncoder().encode(config.AUTH_JWT_SECRET!));
      sessionCredential = accessToken;
    }

    let previousMobile: { session: { _id: mongoose.Types.ObjectId; userId: mongoose.Types.ObjectId } } | null = null;
    if (transport === 'mobile') {
      const oldToken = req.get('Authorization')?.match(/^Bearer ([A-Za-z0-9._-]{1,8192})$/)?.[1];
      if (oldToken) previousMobile = await activeMobileToken(config, oldToken);
    }
    const previousWebSecret = transport === 'web' ? webSessionSecret(req, config) : null;
    const preloginSecret = transport === 'web' ? webPreloginSecret(req, config) : null;
    const usedPrelogin = !!preloginSecret && req.get('X-CSRF-Token') === csrfForSecret(preloginSecret);
    const created = await mongoose.connection.transaction(async transaction => {
      const versionCondition = sessionVersionFilter(version);
      const stillValid = await UserModel.updateOne({
        _id: user._id, passwordHash: user.passwordHash, emailVerifiedAt: { $ne: null }, ...versionCondition,
      }, { $inc: { sessionFence: 1 } }, { session: transaction }).exec();
      if (!stillValid.matchedCount) return false;

      if (preloginSecret) {
        const consumed = await PreloginModel.deleteOne({ secretHash: hashSecret(preloginSecret), expiresAt: { $gt: new Date() } }, { session: transaction }).exec();
        if (usedPrelogin && !consumed.deletedCount) return false;
      }

      if (previousWebSecret) {
        const old = await SessionModel.findOneAndUpdate({
          secretHash: hashSecret(previousWebSecret), transport: 'web', revokedAt: null, expiresAt: { $gt: new Date() },
        }, { $set: { revokedAt: new Date() } }, { session: transaction }).exec();
        if (old) await DeviceModel.updateMany({ sessionId: old._id, active: true }, { $set: { active: false } }, { session: transaction }).exec();
      }
      if (previousMobile) await revokeSession(previousMobile.session._id, previousMobile.session.userId, new Date(), transaction);

      await SessionModel.create([{
        _id: sessionId, userId: user._id, transport, sessionVersion: version,
        secretHash: hashSecret(sessionCredential), csrfHash, expiresAt,
      }], { session: transaction });
      return true;
    });
    if (!created) return genericCredentialsError(res);

    if (transport === 'web') {
      const cookies = cookiePolicy(config);
      res.cookie(cookies.sessionName, sessionCredential, { ...cookies.options, expires: expiresAt, maxAge: SESSION_SECONDS * 1000 });
      res.clearCookie(cookies.preloginName, cookies.options);
      return res.json({ user: publicUser(user as unknown as PublicUserSource), sessionId: String(sessionId), expiresAt: expiresAt.toISOString() });
    }
    return res.json({
      accessToken, tokenType: 'Bearer', expiresIn: SESSION_SECONDS,
      expiresAt: expiresAt.toISOString(), sessionId: String(sessionId), user: publicUser(user as unknown as PublicUserSource),
    });
  } catch {
    return fail(res, 503, 'SERVICE_UNAVAILABLE', 'Account service is unavailable.');
  }
}

export function registrationRouter(config: Config, connected: () => boolean) {
  const router = Router();

  // All auth replies are private. Browser mutations need an exact Origin and
  // cookie-bound CSRF token; native auth routes reject web cookies.
  router.use(async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const transport = req.path.split('/')[1]?.toLowerCase();
    if (transport !== 'web' && transport !== 'mobile') return next();
    if ((transport === 'web' && req.headers.authorization !== undefined) ||
        (transport === 'mobile' && hasWebAuthCookie(req))) {
      return fail(res, 400, 'AUTH_AMBIGUOUS', 'Use the correct authentication transport.');
    }
    if (!allowedOrigin(req, config, transport === 'web' && req.method !== 'GET')) {
      return fail(res, 403, 'ORIGIN_DENIED', 'Origin is not allowed.');
    }
    if (!connected()) return fail(res, 503, 'SERVICE_UNAVAILABLE', 'Account service is unavailable.');
    if (transport === 'web' && req.method !== 'GET' && !await validWebMutationCsrf(req, config, true)) {
      return fail(res, 403, 'CSRF_INVALID', 'Obtain a valid CSRF token first.');
    }
    return next();
  });

  router.get('/web/csrf', async (req, res) => {
    try {
      const rate = await limited(res, 'csrf-ip', req.ip ?? 'unknown', 60, 60_000);
      if (rate.blocked) return fail(res, 429, 'RATE_LIMITED', 'Try again later.');
      if (!noBody(req, res)) return;
      const sessionSecret = webSessionSecret(req, config);
      if (sessionSecret) {
        const active = await activeWebSession(sessionSecret);
        if (active) {
          const csrfToken = csrfForSecret(sessionSecret);
          const result = await SessionModel.updateOne({ _id: active.session._id, revokedAt: null, expiresAt: { $gt: new Date() } }, {
            $set: { csrfHash: hashSecret(csrfToken) },
          }).exec();
          if (result.matchedCount === 1) return res.json({ csrfToken, expiresAt: active.session.expiresAt.toISOString() });
        }
      }

      let secret = webPreloginSecret(req, config);
      let expiresAt = secret
        ? (await PreloginModel.findOne({ secretHash: hashSecret(secret), expiresAt: { $gt: new Date() } }).exec())?.expiresAt
        : undefined;
      if (!secret || !expiresAt) {
        secret = randomBytes(32).toString('base64url');
        expiresAt = new Date(Date.now() + 30 * 60_000);
        await PreloginModel.create({ secretHash: hashSecret(secret), expiresAt });
        const cookies = cookiePolicy(config);
        res.cookie(cookies.preloginName, secret, { ...cookies.options, expires: expiresAt, maxAge: 30 * 60_000 });
      }
      return res.json({ csrfToken: csrfForSecret(secret), expiresAt: expiresAt.toISOString() });
    } catch {
      return fail(res, 503, 'SERVICE_UNAVAILABLE', 'Account service is unavailable.');
    }
  });

  for (const transport of ['web', 'mobile'] as const) {
    for (const action of ['register', 'resend-verification', 'verify-email'] as const) {
      router.post(`/${transport}/${action}`, async (req, res) => {
        if (action !== 'verify-email' && config.NODE_ENV === 'production' && !config.ACCOUNT_MAIL_ENABLED) {
          return fail(res, 503, 'SERVICE_UNAVAILABLE', 'Account email is temporarily unavailable. Please try again later.');
        }
        try {
          const ipRate = await limited(res, 'auth-ip', req.ip ?? 'unknown');
          if (ipRate.blocked) return fail(res, 429, 'RATE_LIMITED', 'Try again later.');
          if (!jsonBody(req, res)) return;
          const schema = action === 'register' ? registration : action === 'verify-email' ? tokenBody : emailBody;
          const parsed = schema.safeParse(req.body);
          if (!parsed.success) return fail(res, 422, 'VALIDATION_ERROR', 'Check the account fields.');
          const input = parsed.data;
          const identity = 'email' in input ? input.email : hashSecret(input.token);
          const accountRate = await limited(res, 'auth-identity', identity);
          if (accountRate.blocked) {
            if (action !== 'verify-email') {
              res.removeHeader('Retry-After');
              return res.status(202).json(accepted);
            }
            return fail(res, 429, 'RATE_LIMITED', 'Try again later.');
          }
          if (action === 'register') await register(input as z.infer<typeof registration>);
          else if (action === 'resend-verification') await resend((input as z.infer<typeof emailBody>).email);
          else {
            if (!await verify((input as z.infer<typeof tokenBody>).token)) {
              return fail(res, 400, 'TOKEN_INVALID', 'This link is invalid or expired.');
            }
            return res.status(204).send();
          }
          return res.status(202).json(accepted);
        } catch {
          return fail(res, 503, 'SERVICE_UNAVAILABLE', 'Account service is unavailable.');
        }
      });
    }
  }

  for (const transport of ['web', 'mobile'] as const) {
    router.post(`/${transport}/forgot-password`, async (req, res) => {
      if (config.NODE_ENV === 'production' && !config.ACCOUNT_MAIL_ENABLED) {
        return fail(res, 503, 'SERVICE_UNAVAILABLE', 'Account email is temporarily unavailable. Please try again later.');
      }
      try {
        const ipRate = await limited(res, 'auth-ip', req.ip ?? 'unknown');
        if (ipRate.blocked) return fail(res, 429, 'RATE_LIMITED', 'Try again later.');
        if (!jsonBody(req, res)) return;
        const parsed = emailBody.safeParse(req.body);
        if (!parsed.success) return fail(res, 422, 'VALIDATION_ERROR', 'Check the account fields.');
        const accountRate = await limited(res, 'auth-identity', parsed.data.email);
        if (accountRate.blocked) res.removeHeader('Retry-After');
        else await requestPasswordReset(parsed.data.email);
        // Same response for unknown, unverified, throttled and eligible accounts.
        return res.status(202).json(accepted);
      } catch {
        return fail(res, 503, 'SERVICE_UNAVAILABLE', 'Account service is unavailable.');
      }
    });

    router.post(`/${transport}/reset-password`, async (req, res) => {
      try {
        const ipRate = await limited(res, 'auth-ip', req.ip ?? 'unknown');
        if (ipRate.blocked) return fail(res, 429, 'RATE_LIMITED', 'Try again later.');
        if (!jsonBody(req, res)) return;
        const parsed = resetBody.safeParse(req.body);
        if (!parsed.success) return fail(res, 422, 'VALIDATION_ERROR', 'Check the account fields.');
        const accountRate = await limited(res, 'auth-identity', hashSecret(parsed.data.token));
        if (accountRate.blocked) return fail(res, 429, 'RATE_LIMITED', 'Try again later.');
        if (!await completePasswordReset(parsed.data.token, parsed.data.password)) {
          return fail(res, 400, 'TOKEN_INVALID', 'This link is invalid or expired.');
        }
        if (transport === 'web') {
          const cookies = cookiePolicy(config);
          res.clearCookie(cookies.sessionName, cookies.options);
          res.clearCookie(cookies.preloginName, cookies.options);
        }
        return res.status(204).send();
      } catch {
        return fail(res, 503, 'SERVICE_UNAVAILABLE', 'Account service is unavailable.');
      }
    });
  }

  router.post('/web/login', (req, res) => login(req, res, config, 'web'));
  router.post('/mobile/login', (req, res) => login(req, res, config, 'mobile'));

  router.get('/web/me', requireVerifiedUser(config, 'web'), (req, res) => {
    if (!noBody(req, res)) return;
    const principal = res.locals.principal as AuthPrincipal;
    void UserModel.findById(principal.userId).exec().then(user => {
      if (!user || !user.emailVerifiedAt) return fail(res, 401, 'SESSION_REVOKED', 'Sign in to continue.');
      return res.json(publicUser(user as unknown as PublicUserSource));
    }).catch(() => fail(res, 503, 'SERVICE_UNAVAILABLE', 'Account service is unavailable.'));
  });

  router.get('/mobile/me', requireVerifiedUser(config, 'mobile'), (req, res) => {
    if (!noBody(req, res)) return;
    const principal = res.locals.principal as AuthPrincipal;
    void UserModel.findById(principal.userId).exec().then(user => {
      if (!user || !user.emailVerifiedAt) return fail(res, 401, 'SESSION_REVOKED', 'Sign in to continue.');
      return res.json(publicUser(user as unknown as PublicUserSource));
    }).catch(() => fail(res, 503, 'SERVICE_UNAVAILABLE', 'Account service is unavailable.'));
  });

  router.post('/web/logout', requireVerifiedUser(config, 'web'), async (req, res) => {
    if (!noBody(req, res)) return;
    try {
      const principal = res.locals.principal as AuthPrincipal;
      await mongoose.connection.transaction(async transaction => {
        const session = await SessionModel.findOneAndUpdate({
          _id: principal.sessionId, userId: principal.userId, transport: 'web', revokedAt: null,
        }, { $set: { revokedAt: new Date() } }, { session: transaction }).exec();
        if (session) await DeviceModel.updateMany({ sessionId: session._id, active: true }, { $set: { active: false } }, { session: transaction }).exec();
      });
      const cookies = cookiePolicy(config);
      res.clearCookie(cookies.sessionName, cookies.options);
      res.clearCookie(cookies.preloginName, cookies.options);
      return res.status(204).send();
    } catch {
      return fail(res, 503, 'SERVICE_UNAVAILABLE', 'Account service is unavailable.');
    }
  });

  router.post('/mobile/logout', requireVerifiedUser(config, 'mobile'), async (req, res) => {
    if (!noBody(req, res)) return;
    try {
      const principal = res.locals.principal as AuthPrincipal;
      await mongoose.connection.transaction(async transaction => {
        const session = await SessionModel.findOneAndUpdate({
          _id: principal.sessionId, userId: principal.userId, transport: 'mobile', revokedAt: null,
        }, { $set: { revokedAt: new Date() } }, { session: transaction }).exec();
        if (session) await DeviceModel.updateMany({ sessionId: session._id, active: true }, { $set: { active: false } }, { session: transaction }).exec();
      });
      return res.status(204).send();
    } catch {
      return fail(res, 503, 'SERVICE_UNAVAILABLE', 'Account service is unavailable.');
    }
  });

  return router;
}
