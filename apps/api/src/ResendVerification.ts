
import { Request, Response } from 'express';
import { randomBytes, createHash } from 'node:crypto';
import { UserModel, AuthTokenModel } from '../models/account.js';
import { sendError } from '../helpers/response.js';

// pending issue #7
type SendVerificationEmail = (details: {
    email: string;
    name: string;
    token: string;
}) => Promise<void>;

// hashes the verification token
const hashToken = (token: string): string => {
    return createHash('sha256').update(token).digest('hex');
};

// generic response for resend requests
const resendResponse = (res: Response) => {
    return res.status(202).json({
        message: 'If eligible, you will receive an email with next steps.'
    });
};

export const ResendVerificationHandler = (
    sendVerificationEmail: SendVerificationEmail
) => {

    const resendVerification = async (req: Request, res: Response) => {
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

            // normalizes the email
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

            // sets the verification email cooldown to 60 seconds
            const now = new Date();
            const cooldown = new Date(now.getTime() - 60 * 1000);

            // finds an unverified account and reserves a resend slot
            // the update is atomic, preventing simultaneous resend requests
            const user = await UserModel.findOneAndUpdate(
                {
                    email: normalEmail,
                    emailVerifiedAt: null,
                    $or: [
                        { verificationEmailSentAt: null },
                        { verificationEmailSentAt: { $lte: cooldown } }
                    ]
                },
                {
                    $set: {
                        verificationEmailSentAt: now
                    }
                },
                {
                    new: true
                }
            ).exec();

            // does not reveal whether the account exists,
            // is already verified, or is currently rate-limited
            if (!user) {
                return resendResponse(res);
            }

            // generates a new random verification token
            const verificationToken = randomBytes(32).toString('hex');

            // stores the hashed token and invalidates the previous token
            await AuthTokenModel.findOneAndUpdate(
                {
                    userId: user._id,
                    purpose: 'verify_email'
                },
                {
                    $set: {
                        tokenHash: hashToken(verificationToken),
                        expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
                        consumedAt: null
                    }
                },
                {
                    upsert: true,
                    new: true,
                    runValidators: true
                }
            ).exec();

            // sends the new verification email
            try {
                await sendVerificationEmail({
                    email: user.email,
                    name: user.name ?? '',
                    token: verificationToken
                });
            } catch {
                // does not expose email provider errors or verification tokens
                console.error('Verification email delivery failed');

                return resendResponse(res);
            }

            return resendResponse(res);

        } catch (error: unknown) {

            // handles unexpected errors
            console.error('Resending verification email failed');

            return sendError(
                res,
                500,
                'INTERNAL_ERROR',
                'An unexpected error occurred.'
            );
        }
    };

    return resendVerification;
};
