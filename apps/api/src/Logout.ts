
import { Request, Response } from 'express';
import { createHash } from 'node:crypto';

import { AuthTokenModel } from './models/account.js';

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

// hashes refresh token
const hashToken = (token: string): string => {
    return createHash('sha256').update(token).digest('hex');
};

export const LogoutHandler = () => {

    const logoutUser = async (req: Request, res: Response) => {

        try {

            // retrieves refresh token from cookie
            const refreshToken = req.cookies?.refreshToken;

            // clears cookie regardless of token validity
            res.clearCookie('refreshToken', {
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production',
                sameSite: 'strict',
                path: '/auth'
            });

            // no refresh token means there is nothing to revoke
            if (
                typeof refreshToken !== 'string' ||
                !/^[a-f0-9]{64}$/.test(refreshToken)
            ) {
                return res.status(204).send();
            }

            // revokes refresh token
            await AuthTokenModel.updateOne(
                {
                    tokenHash: hashToken(refreshToken),
                    purpose: 'refresh_token',
                    consumedAt: null
                },
                {
                    $set: {
                        consumedAt: new Date()
                    }
                }
            ).exec();

            return res.status(204).send();

        } catch {

            console.error('Logout failed');

            return sendError(
                res,
                500,
                'INTERNAL_ERROR',
                'An unexpected error occurred.'
            );
        }
    };

    return logoutUser;
};
