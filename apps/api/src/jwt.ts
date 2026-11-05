import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { UserModel } from './models/account.js';

const JWT_SECRET = process.env.JWT_SECRET!;
const JWT_ISSUER = 'your-app-issuer';
const JWT_AUDIENCE = 'your-app-audience';

export interface AuthenticatedRequest extends Request {
    user?: {
        id: string;
        role: string;
    };
}

const sendError = (
    res: Response,
    status: number,
    code: string,
    message: string
) => {
    return res.status(status).json({
        error: {
            code,
            message
        }
    });
};

export const requireAuth = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return sendError(
                res,
                401,
                'UNAUTHORIZED',
                'Access token is missing or malformed.'
            );
        }

        const token = authHeader.split(' ')[1];

        let payload: any;
        try {
            payload = jwt.verify(token, JWT_SECRET, {
                algorithms: ['HS256'],
                issuer: JWT_ISSUER,
                audience: JWT_AUDIENCE
            });
        } catch (err) {
            return sendError(
                res,
                401,
                'INVALID_TOKEN',
                'Access token is invalid or expired.'
            );
        }

        // Fetch user from DB to verify server-side session validity / token version
        const user = await UserModel.findById(payload.sub).exec();
        if (!user || !user.emailVerifiedAt) {
            return sendError(
                res,
                401,
                'UNAUTHORIZED',
                'User account no longer exists or is unverified.'
            );
        }

        // Check server-side token version/session revocation
        if (payload.ver !== (user.tokenVersion || 0)) {
            return sendError(
                res,
                401,
                'SESSION_REVOKED',
                'Session has been revoked. Please log in again.'
            );
        }

        req.user = {
            id: user._id.toString(),
            role: user.role
        };

        next();
    } catch (error) {
        return sendError(
            res,
            500,
            'INTERNAL_ERROR',
            'An unexpected error occurred during authentication.'
        );
    }
};

export const requireAdmin = (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
) => {
    if (!req.user || req.user.role !== 'admin') {
        return sendError(
            res,
            403,
            'FORBIDDEN',
            'Admin privileges are required to access this resource.'
        );
    }
    next();
};