import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import type { Config } from './config.js';
import { AuthLimitModel, PreloginModel, SessionModel, UserModel } from './models/account.js';
import { accepted, hashSecret, register, resend, verify } from './registration.js';
import { accountError as fail } from './accountError.js';

const email = z.string().trim().toLowerCase().max(254).regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
const registration = z.strictObject({
  email,
  password: z.string().refine(value => Array.from(value).length >= 12 && Array.from(value).length <= 128),
  name: z.string().trim().min(1).refine(value => Array.from(value).length <= 100).optional(),
});
const emailBody = z.strictObject({ email });
const tokenBody = z.strictObject({ token: z.string().min(32).max(512).regex(/^[A-Za-z0-9_-]+$/) });
const cookieNames = ['__Host-price_tracker_session', '__Host-price_tracker_prelogin', 'price_tracker_session_dev', 'price_tracker_prelogin_dev'];
const equal = (a: string, b: string) => Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// Fixed windows are database-backed and shared by every process/transport.
// Expiry is enforced here, not by asynchronous TTL deletion.
async function limited(scope: string, value: string, maximum = 5, windowMs = 900000) {
  const now = Date.now();
  const start = Math.floor(now / windowMs) * windowMs;
  const key = hashSecret(`${scope}:${value}:${start}`);
  let row;
  try {
    row = await AuthLimitModel.findOneAndUpdate({ key }, {
      $inc: { attempts: 1 }, $setOnInsert: { expiresAt: new Date(start + windowMs) },
    }, { upsert: true, returnDocument: 'after' }).exec();
  } catch (error) {
    // Two first requests can race to insert the unique key.
    if (!(error instanceof Error) || !('code' in error) || error.code !== 11000) throw error;
    row = await AuthLimitModel.findOneAndUpdate({ key }, { $inc: { attempts: 1 } }, { returnDocument: 'after' }).orFail().exec();
  }
  return { blocked: row!.attempts > maximum, retry: Math.ceil((start + windowMs - now) / 1000) };
}

export function registrationRouter(config: Config, connected: () => boolean) {
  const router = Router();
  const production = config.NODE_ENV === 'production';
  const preloginName = production ? '__Host-price_tracker_prelogin' : 'price_tracker_prelogin_dev';
  const sessionName = production ? '__Host-price_tracker_session' : 'price_tracker_session_dev';

  router.use(async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const transport = req.path.split('/')[1];
    if (transport !== 'web' && transport !== 'mobile') return next();
    const cookies = new Map((req.headers.cookie ?? '').split(';').map(part => {
      const at = part.indexOf('=');
      return [part.slice(0, at).trim(), part.slice(at + 1)] as const;
    }));
    if ((transport === 'web' && req.headers.authorization !== undefined) ||
        (transport === 'mobile' && cookieNames.some(name => cookies.has(name)))) {
      return fail(res, 400, 'AUTH_AMBIGUOUS', 'Use the correct authentication transport.');
    }
    const origin = req.get('Origin');
    if ((origin && !config.WEB_ORIGINS.includes(origin)) ||
        (transport === 'web' && req.method !== 'GET' && !origin)) {
      return fail(res, 403, 'ORIGIN_DENIED', 'Origin is not allowed.');
    }
    if (!connected()) return fail(res, 503, 'SERVICE_UNAVAILABLE', 'Account service is unavailable.');
    try {
      if (transport === 'web' && req.method !== 'GET') {
        const csrf = req.get('X-CSRF-Token') ?? '';
        let valid = false;
        const prelogin = cookies.get(preloginName);
        if (prelogin && /^[a-f0-9]{64}$/.test(prelogin)) {
          valid = equal(csrf, hashSecret(`csrf:${prelogin}`)) && !!await PreloginModel.exists({
            secretHash: hashSecret(prelogin), expiresAt: { $gt: new Date() },
          });
        }
        const secret = cookies.get(sessionName);
        if (!valid && secret) {
          const session = await SessionModel.findOne({ secretHash: hashSecret(secret), transport: 'web', revokedAt: null,
            expiresAt: { $gt: new Date() }, csrfHash: hashSecret(csrf) }).exec();
          valid = !!session && !!await UserModel.exists({ _id: session.userId, emailVerifiedAt: { $ne: null } });
        }
        if (!valid) return fail(res, 403, 'CSRF_INVALID', 'Obtain a valid CSRF token first.');
      }
      next();
    } catch { return fail(res, 503, 'SERVICE_UNAVAILABLE', 'Account service is unavailable.'); }
  });

  router.get('/web/csrf', async (req, res) => {
    try {
      const rate = await limited('csrf-ip', req.ip ?? 'unknown', 60, 60000);
      if (rate.blocked) return fail(res.set('Retry-After', String(rate.retry)), 429, 'RATE_LIMITED', 'Try again later.');
      const sessionSecret = (req.headers.cookie ?? '').split(';').map(value => value.trim()).find(value => value.startsWith(`${sessionName}=`))?.slice(sessionName.length + 1);
      if (sessionSecret) {
        const session = await SessionModel.findOne({ secretHash: hashSecret(sessionSecret), transport: 'web', revokedAt: null, expiresAt: { $gt: new Date() } });
        if (session && await UserModel.exists({ _id: session.userId, emailVerifiedAt: { $ne: null } })) {
          const csrfToken = hashSecret(`csrf:${sessionSecret}`);
          const result = await SessionModel.updateOne({ _id: session._id, revokedAt: null, expiresAt: { $gt: new Date() } }, { $set: { csrfHash: hashSecret(csrfToken) } });
          if (result.matchedCount === 1) return res.json({ csrfToken, expiresAt: session.expiresAt.toISOString() });
        }
      }
      const cookie = (req.headers.cookie ?? '').split(';').map(value => value.trim()).find(value => value.startsWith(`${preloginName}=`))?.slice(preloginName.length + 1);
      let secret = cookie;
      let expiresAt = secret && /^[a-f0-9]{64}$/.test(secret)
        ? (await PreloginModel.findOne({ secretHash: hashSecret(secret), expiresAt: { $gt: new Date() } }))?.expiresAt
        : undefined;
      if (!expiresAt) {
        secret = randomBytes(32).toString('hex');
        expiresAt = new Date(Date.now() + 1800000);
        await PreloginModel.create({ secretHash: hashSecret(secret), expiresAt });
        res.cookie(preloginName, secret, { httpOnly: true, secure: production, sameSite: 'lax', path: '/', expires: expiresAt, maxAge: 1800000 });
      }
      return res.json({ csrfToken: hashSecret(`csrf:${secret}`), expiresAt: expiresAt.toISOString() });
    } catch { return fail(res, 503, 'SERVICE_UNAVAILABLE', 'Account service is unavailable.'); }
  });

  for (const transport of ['web', 'mobile']) {
    for (const action of ['register', 'resend-verification', 'verify-email']) {
      router.post(`/${transport}/${action}`, async (req, res) => {
        try {
          const ipRate = await limited('auth-ip', req.ip ?? 'unknown');
          if (ipRate.blocked) return fail(res.set('Retry-After', String(ipRate.retry)), 429, 'RATE_LIMITED', 'Try again later.');
          if (!req.is('application/json')) return fail(res, 415, 'UNSUPPORTED_MEDIA_TYPE', 'Use application/json.');
          const schema = action === 'register' ? registration : action === 'verify-email' ? tokenBody : emailBody;
          const parsed = schema.safeParse(req.body);
          if (!parsed.success) return fail(res, 422, 'VALIDATION_ERROR', 'Check the account fields.');
          const input = parsed.data;
          const identity = 'email' in input ? input.email : hashSecret(input.token);
          const accountRate = await limited('auth-identity', identity);
          if (accountRate.blocked) {
            if (action !== 'verify-email') return res.status(202).json(accepted);
            return fail(res.set('Retry-After', String(accountRate.retry)), 429, 'RATE_LIMITED', 'Try again later.');
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
        } catch { return fail(res, 503, 'SERVICE_UNAVAILABLE', 'Account service is unavailable.'); }
      });
    }
  }
  return router;
}
