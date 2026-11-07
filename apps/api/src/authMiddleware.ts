import type { RequestHandler, Response } from 'express';
import mongoose from 'mongoose';
import type { Config } from './config.js';
import { accountError } from './accountError.js';
import { allowedOrigin, activeMobileToken, activeWebSession, hasWebAuthCookie, validWebMutationCsrf, webSessionSecret } from './sessionSecurity.js';

export type AuthPrincipal = {
  userId: string;
  sessionId: string;
  transport: 'web' | 'mobile';
  role: 'user' | 'admin';
};

function unavailable(res: Response) {
  return accountError(res, 503, 'SERVICE_UNAVAILABLE', 'Account service is unavailable.');
}

/** Authenticate either approved transport; private routes must use this before reading data. */
export function requireVerifiedUser(config: Config, expectedTransport?: 'web' | 'mobile'): RequestHandler {
  return async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (req.method.toUpperCase() === 'OPTIONS') return next();
    const authorization = req.headers.authorization;
    const hasCookie = hasWebAuthCookie(req);
    if ((authorization !== undefined && hasCookie) ||
        (expectedTransport === 'web' && authorization !== undefined) ||
        (expectedTransport === 'mobile' && hasCookie)) {
      return accountError(res, 400, 'AUTH_AMBIGUOUS', 'Use one authentication transport.');
    }
    if (!allowedOrigin(req, config, false)) return accountError(res, 403, 'ORIGIN_DENIED', 'Origin is not allowed.');

    const isMutation = !['GET', 'HEAD', 'OPTIONS'].includes(req.method.toUpperCase());
    let principal: AuthPrincipal;
    try {
      if (mongoose.connection.readyState !== 1) return unavailable(res);
      if (authorization !== undefined) {
        const match = authorization.match(/^Bearer ([A-Za-z0-9._-]{1,8192})$/);
        if (!match || !config.AUTH_JWT_SECRET || (expectedTransport === 'web')) {
          return accountError(res, 401, 'AUTH_REQUIRED', 'Sign in to continue.');
        }
        const active = await activeMobileToken(config, match[1]!);
        if (!active) return accountError(res, 401, 'SESSION_REVOKED', 'Sign in to continue.');
        principal = {
          userId: String(active.user._id), sessionId: String(active.session._id),
          transport: 'mobile', role: active.user.role as AuthPrincipal['role'],
        };
      } else {
        if (expectedTransport === 'mobile') return accountError(res, 401, 'AUTH_REQUIRED', 'Sign in to continue.');
        const secret = webSessionSecret(req, config);
        if (!secret) return accountError(res, 401, 'AUTH_REQUIRED', 'Sign in to continue.');
        const active = await activeWebSession(secret);
        if (!active) return accountError(res, 401, 'SESSION_EXPIRED', 'Sign in to continue.');
        principal = {
          userId: String(active.user._id), sessionId: String(active.session._id),
          transport: 'web', role: active.user.role as AuthPrincipal['role'],
        };
      }

      if (principal.transport === 'web' && isMutation) {
        if (!allowedOrigin(req, config, true)) return accountError(res, 403, 'ORIGIN_DENIED', 'Origin is not allowed.');
        if (!await validWebMutationCsrf(req, config, false)) return accountError(res, 403, 'CSRF_INVALID', 'Obtain a valid CSRF token first.');
      }
      res.locals.principal = principal;
      return next();
    } catch {
      return unavailable(res);
    }
  };
}

/** Must follow requireVerifiedUser; reads the role freshly loaded from MongoDB. */
export const requireAdmin: RequestHandler = (_req, res, next) => {
  const principal = res.locals.principal as AuthPrincipal | undefined;
  if (!principal || principal.role !== 'admin') return accountError(res, 403, 'ADMIN_REQUIRED', 'Administrator access is required.');
  return next();
};
