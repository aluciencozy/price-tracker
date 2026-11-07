import type { Request } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { jwtVerify } from 'jose';
import mongoose from 'mongoose';
import type { Config } from './config.js';
import { PreloginModel, SessionModel, UserModel } from './models/account.js';
import { DeviceModel } from './models/device.js';
import { hashSecret } from './registration.js';

const allCookieNames = [
  '__Host-price_tracker_session', '__Host-price_tracker_prelogin',
  'price_tracker_session_dev', 'price_tracker_prelogin_dev',
] as const;

export function cookiePolicy(config: Config) {
  const secure = config.NODE_ENV === 'production' || config.WEB_ORIGINS.every(origin => new URL(origin).protocol === 'https:');
  return {
    secure,
    sessionName: secure ? '__Host-price_tracker_session' : 'price_tracker_session_dev',
    preloginName: secure ? '__Host-price_tracker_prelogin' : 'price_tracker_prelogin_dev',
    options: { httpOnly: true, secure, sameSite: 'lax' as const, path: '/' as const },
  };
}

function cookies(req: Request): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    if (!allCookieNames.includes(name as typeof allCookieNames[number])) continue;
    const values = result.get(name) ?? [];
    values.push(part.slice(separator + 1).trim());
    result.set(name, values);
  }
  return result;
}

export function hasWebAuthCookie(req: Request): boolean {
  return [...cookies(req).keys()].length > 0;
}

export function webSessionSecret(req: Request, config: Config): string | null {
  const { sessionName } = cookiePolicy(config);
  const values = cookies(req).get(sessionName);
  return values?.length === 1 && /^[A-Za-z0-9_-]{43}$/.test(values[0]!) ? values[0]! : null;
}

export function webPreloginSecret(req: Request, config: Config): string | null {
  const { preloginName } = cookiePolicy(config);
  const values = cookies(req).get(preloginName);
  return values?.length === 1 && /^[A-Za-z0-9_-]{43}$/.test(values[0]!) ? values[0]! : null;
}

export const csrfForSecret = (secret: string) => hashSecret(`csrf:${secret}`);

async function revokeSessionAndDevices(sessionId: mongoose.Types.ObjectId) {
  await SessionModel.updateOne({ _id: sessionId, revokedAt: null }, { $set: { revokedAt: new Date() } }).exec();
  await DeviceModel.updateMany({ sessionId, active: true }, { $set: { active: false } }).exec();
}

function equalSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function activeWebSession(secret: string) {
  const now = new Date();
  const session = await SessionModel.findOne({ secretHash: hashSecret(secret), transport: 'web' }).exec();
  if (!session) return null;
  if (session.revokedAt || session.expiresAt <= now) {
    await revokeSessionAndDevices(session._id);
    return null;
  }
  const version = session.sessionVersion ?? 0;
  const versionFilter = version === 0 ? { $or: [{ sessionVersion: 0 }, { sessionVersion: { $exists: false } }] } : { sessionVersion: version };
  const user = await UserModel.findOne({ _id: session.userId, emailVerifiedAt: { $ne: null }, ...versionFilter }).exec();
  if (!user) {
    await revokeSessionAndDevices(session._id);
    return null;
  }
  return { session, user };
}

export async function validWebMutationCsrf(req: Request, config: Config, allowPrelogin: boolean): Promise<boolean> {
  const candidate = req.get('X-CSRF-Token') ?? '';
  if (!/^[a-f0-9]{64}$/.test(candidate)) return false;

  const sessionSecret = webSessionSecret(req, config);
  if (sessionSecret) {
    const current = await activeWebSession(sessionSecret);
    if (current && equalSecret(candidate, csrfForSecret(sessionSecret)) && await SessionModel.exists({
      _id: current.session._id, revokedAt: null, expiresAt: { $gt: new Date() }, csrfHash: hashSecret(candidate),
    })) return true;
  }

  if (!allowPrelogin) return false;
  const secret = webPreloginSecret(req, config);
  if (!secret || !equalSecret(candidate, csrfForSecret(secret))) return false;
  return !!await PreloginModel.exists({ secretHash: hashSecret(secret), expiresAt: { $gt: new Date() } });
}

export async function activeMobileSession(token: string, sessionId: string, userId: string, sessionVersion: number) {
  const session = await SessionModel.findOne({ _id: sessionId, userId, transport: 'mobile', secretHash: hashSecret(token) }).exec();
  if (!session || session.revokedAt || session.expiresAt <= new Date() || (session.sessionVersion ?? 0) !== sessionVersion) {
    // The signed session ID is trustworthy even after TTL cleanup removed its row.
    if (session) await revokeSessionAndDevices(session._id);
    else await DeviceModel.updateMany({ sessionId, userId, active: true }, { $set: { active: false } }).exec();
    return null;
  }
  const version = sessionVersion === 0
    ? { $or: [{ sessionVersion: 0 }, { sessionVersion: { $exists: false } }] }
    : { sessionVersion };
  const user = await UserModel.findOne({ _id: userId, emailVerifiedAt: { $ne: null }, ...version }).exec();
  if (!user) {
    await revokeSessionAndDevices(session._id);
    return null;
  }
  return { session, user };
}

export async function activeMobileToken(config: Config, token: string) {
  if (!config.AUTH_JWT_SECRET) return null;
  let payload;
  try {
    ({ payload } = await jwtVerify(token, new TextEncoder().encode(config.AUTH_JWT_SECRET), {
      algorithms: ['HS256'], issuer: 'price-tracker-api', audience: 'price-tracker-mobile',
      requiredClaims: ['sub', 'sid', 'ver', 'iat', 'exp'], maxTokenAge: '7d',
    }));
  } catch { return null; }
  if (typeof payload.sub !== 'string' || !/^[a-f\d]{24}$/i.test(payload.sub) ||
      typeof payload.sid !== 'string' || !/^[a-f\d]{24}$/i.test(payload.sid) ||
      !Number.isSafeInteger(payload.ver) || (payload.ver as number) < 0) return null;
  return activeMobileSession(token, payload.sid, payload.sub, payload.ver as number);
}

export function allowedOrigin(req: Request, config: Config, required: boolean): boolean {
  const origin = req.get('Origin');
  if (origin === undefined) return !required;
  return config.WEB_ORIGINS.includes(origin);
}
