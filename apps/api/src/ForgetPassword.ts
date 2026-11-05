
import { Request, Response } from 'express';
import { randomBytes, createHash } from 'node:crypto';

import { UserModel, AuthTokenModel } from './models/account.js';
import type { DeliveryOutcome } from './emails.ts';

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

type SendPasswordResetEmail = (details: {
    email: string;
    name: string;
    token: string;
}) => Promise<DeliveryOutcome>;

// hashes the password reset token
const hashToken = (token: string): string => {
    return createHash('sha256').update(token).digest('hex');
};

// generic response for password reset requests
const forgotPasswordResponse = (res: Response) => {
    return res.status(202).json({
        message: 'If eligible, you will receive an email with next steps.'
    });
};

export const ForgotPasswordHandler = (
    sendPasswordResetEmail: SendPasswordResetEmail
) => {

    const forgotPassword = async (req: Request, res: Response) => {
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

            // gets the email from the request
            const email = req.body.email;

            // rejects unknown fields
            const keys = Object.keys(req.body);

            if (keys.some((key) => key !== 'email')) {
                return sendError(
                    res,
                    422,
                    'VALIDATION_ERROR',
                    'Request contains an unknown field.'
                );
            }

            // validates the email
            if (
                typeof email !== 'string' ||
                email.trim() === ''
            ) {
                return sendError(
                    res,
                    422,
                    'VALIDATION_ERROR',
                    'A valid email address is required.'
                );
            }

            // normalises the email
            const normalEmail = email.trim().toLowerCase();

            // checks that the email is valid
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

            if (
                normalEmail.length > 254 ||
                !emailRegex.test(normalEmail)
            ) {
                return sendError(
                    res,
                    422,
                    'VALIDATION_ERROR',
                    'Invalid email address.'
                );
            }

            // sets the password reset email cooldown to 60 seconds
            const now = new Date();
            const cooldown = new Date(now.getTime() - 60 * 1000);

            // finds a verified account and reserves a reset email slot
            // the update is atomic, preventing simultaneous reset requests
            const user = await UserModel.findOneAndUpdate(
                {
                    email: normalEmail,
                    emailVerifiedAt: { $ne: null },
                    $or: [
                        { passwordResetEmailSentAt: null },
                        { passwordResetEmailSentAt: { $lte: cooldown } }
                    ]
                },
                {
                    $set: {
                        passwordResetEmailSentAt: now
                    }
                },
                {
                    new: true
                }
            ).exec();

            // does not reveal whether the account exists,
            // is verified, or is currently rate-limited
            if (!user) {
                return forgotPasswordResponse(res);
            }

            // generates a new random password reset token
            const resetToken = randomBytes(32).toString('hex');

            // hashes the reset token
            const tokenHash = hashToken(resetToken);

            // stores the hashed token and invalidates the previous token
            await AuthTokenModel.findOneAndUpdate(
                {
                    userId: user._id,
                    purpose: 'reset_password'
                },
                {
                    $set: {
                        tokenHash,
                        expiresAt: new Date(
                            now.getTime() + 15 * 60 * 1000
                        ),
                        consumedAt: null
                    }
                },
                {
                    upsert: true,
                    new: true,
                    runValidators: true
                }
            ).exec();

            // sends the password reset email
            try {
                const delivery = await sendPasswordResetEmail({
                    email: user.email,
                    name: user.name ?? '',
                    token: resetToken
                });

                if (delivery.status !== 'success') {

                    // invalidates the newly generated token
                    await AuthTokenModel.deleteOne({
                        userId: user._id,
                        purpose: 'reset_password',
                        tokenHash
                    }).exec();

                    console.error(
                        'Password reset email delivery failed:',
                        delivery.status
                    );
                }

            } catch {

                // invalidates the newly generated token
                try {
                    await AuthTokenModel.deleteOne({
                        userId: user._id,
                        purpose: 'reset_password',
                        tokenHash
                    }).exec();
                } catch {
                    console.error(
                        'Failed to invalidate password reset token'
                    );
                }

                // does not expose email provider errors or reset tokens
                console.error('Password reset email delivery failed');
            }

            return forgotPasswordResponse(res);

        } catch {

            // handles unexpected errors
            console.error('Password reset request failed');

            return sendError(
                res,
                500,
                'INTERNAL_ERROR',
                'An unexpected error occurred.'
            );
        }
    };

    return forgotPassword;
};
