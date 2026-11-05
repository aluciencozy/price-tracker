import { Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { UserModel, AuthTokenModel } from '../models/account.js';
import { sendError } from '../helpers/response.js';

// hashes the verification token
const hashToken = (token: string): string => {
    return createHash('sha256').update(token).digest('hex');
};

export const VerifyEmailHandler = () => {

    const verifyEmail = async (req: Request, res: Response) => {
        try {

            // validates the request body
            if (
                typeof req.body !== 'object' ||
                req.body === null ||
                Array.isArray(req.body)
            ) {
                return sendError(
                    res,
                    400,
                    'MALFORMED_REQUEST',
                    'Request body must be a valid object.'
                );
            }

            // gets the verification token
            const token = req.body.token;

            // rejects unknown fields
            const keys = Object.keys(req.body);

            if (keys.some((key) => key !== 'token')) {
                return sendError(
                    res,
                    422,
                    'VALIDATION_ERROR',
                    'Request contains an unknown field.'
                );
            }

            // validates the token format
            if (
                typeof token !== 'string' ||
                !/^[a-f0-9]{64}$/.test(token)
            ) {
                return sendError(
                    res,
                    400,
                    'TOKEN_INVALID',
                    'The verification link is invalid or has expired.'
                );
            }

            // hashes the given token
            const tokenHash = hashToken(token);

            // finds and consumes a valid unused token
            const authToken = await AuthTokenModel.findOneAndUpdate(
                {
                    tokenHash: tokenHash,
                    purpose: 'verify_email',
                    consumedAt: null,
                    expiresAt: { $gt: new Date() }
                },
                {
                    $set: {
                        consumedAt: new Date()
                    }
                },
                {
                    new: true
                }
            ).exec();

            // checks if the token is valid
            if (!authToken) {
                return sendError(
                    res,
                    400,
                    'TOKEN_INVALID',
                    'The verification link is invalid or has expired.'
                );
            }

            // marks the user's email as verified
            const user = await UserModel.updateOne(
                {
                    _id: authToken.userId,
                    emailVerifiedAt: null
                },
                {
                    $set: {
                        emailVerifiedAt: new Date()
                    }
                }
            ).exec();

            // checks if the user was updated
            if (user.matchedCount === 0) {
                return sendError(
                    res,
                    400,
                    'TOKEN_INVALID',
                    'The verification link is invalid or has expired.'
                );
            }

            return res.status(204).send();

        } catch (error: unknown) {

            // handles unexpected errors
            console.error('Email verification failed');

            return sendError(
                res,
                500,
                'INTERNAL_ERROR',
                'An unexpected error occurred.'
            );
        }
    };

    return verifyEmail;
};