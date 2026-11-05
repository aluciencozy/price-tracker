
import { Request, Response } from 'express';
import { randomBytes, createHash, scrypt } from 'node:crypto';
import { UserModel, AuthTokenModel } from '../models/account.js';
import { sendError } from '../helpers/response.js';

type SendVerificationEmail = (details: {
    email: string;
    name: string;
    token: string;
}) => Promise<void>;

// hashes the password for safe storage
const hashPassword = async (password: string): Promise<string> => {
    return new Promise((resolve, reject) => {
        const salt = randomBytes(16);

        scrypt(
            password,
            salt,
            64,
            { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
            (error, derivedKey) => {
                if (error) {
                    reject(error);
                    return;
                }

                resolve(
                    `scrypt$32768$8$1$${salt.toString('hex')}$${derivedKey.toString('hex')}`
                );
            }
        );
    });
};

// hashes the verification token
const hashToken = (token: string): string => {
    return createHash('sha256').update(token).digest('hex');
};

// generic response for registration
const registrationResponse = (res: Response) => {
    return res.status(202).json({
        message: 'If eligible, you will receive an email with next steps.'
    });
};

export const RegisterHandler = (
    sendVerificationEmail: SendVerificationEmail
) => {

    const registerUser = async (req: Request, res: Response) => {
        let createdUserId: unknown = null;

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

            const name = req.body.name;
            const email = req.body.email;
            const password = req.body.password;

            // rejects unexpected request properties
            const allowedFields = ['name', 'email', 'password'];

            if (
                Object.keys(req.body).some(
                    (key) => !allowedFields.includes(key)
                )
            ) {
                return sendError(
                    res,
                    422,
                    'VALIDATION_ERROR',
                    'Request contains an unknown field.'
                );
            }

            // validates required fields
            if (
                typeof email !== 'string' ||
                typeof password !== 'string' ||
                email.trim() === '' ||
                password === ''
            ) {
                return sendError(
                    res,
                    422,
                    'VALIDATION_ERROR',
                    'Email and password are required.'
                );
            }

            // validates optional name
            let normalName: string | null = null;

            if (name !== undefined) {
                if (
                    typeof name !== 'string' ||
                    name.trim() === ''
                ) {
                    return sendError(
                        res,
                        422,
                        'VALIDATION_ERROR',
                        'Name must be a non-empty string.'
                    );
                }

                normalName = name.trim();

                if (Array.from(normalName).length > 100) {
                    return sendError(
                        res,
                        422,
                        'VALIDATION_ERROR',
                        'Name must be 100 characters or fewer.'
                    );
                }
            }

            // normalises email
            const normalEmail = email.trim().toLowerCase();

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

            // validates password length
            const passwordLength = Array.from(password).length;

            if (passwordLength < 12 || passwordLength > 128) {
                return sendError(
                    res,
                    422,
                    'VALIDATION_ERROR',
                    'Password must be between 12 and 128 characters.'
                );
            }

            // checks for an existing account
            const existingUser = await UserModel.findOne({
                email: normalEmail
            }).exec();

            if (existingUser) {
                return registrationResponse(res);
            }

            // hashes password
            const hashedPassword = await hashPassword(password);

            // generates verification token
            const verificationToken = randomBytes(32).toString('hex');

            // creates unverified user
            const user = await UserModel.create({
                name: normalName,
                email: normalEmail,
                passwordHash: hashedPassword,
                emailVerifiedAt: null,
                role: 'user'
            });

            createdUserId = user._id;

            // stores hashed verification token
            await AuthTokenModel.create({
                userId: user._id,
                purpose: 'verify_email',
                tokenHash: hashToken(verificationToken),
                expiresAt: new Date(
                    Date.now() + 24 * 60 * 60 * 1000
                ),
                consumedAt: null
            });

            // sends verification email
            await sendVerificationEmail({
                email: user.email,
                name: normalName ?? '',
                token: verificationToken
            });

            // registration request accepted
            return registrationResponse(res);

        } catch (error: unknown) {

            // rolls back registration if email delivery or
            // another operation after user creation fails
            if (createdUserId !== null) {
                try {
                    await AuthTokenModel.deleteMany({
                        userId: createdUserId,
                        purpose: 'verify_email'
                    }).exec();

                    await UserModel.deleteOne({
                        _id: createdUserId,
                        emailVerifiedAt: null
                    }).exec();

                } catch {
                    console.error('Registration rollback failed');
                }
            }

            // handles duplicate email registration
            if (
                typeof error === 'object' &&
                error !== null &&
                'code' in error &&
                error.code === 11000
            ) {
                return registrationResponse(res);
            }

            // handles unexpected errors without exposing
            // email provider details or verification tokens
            console.error('Registration failed');

            return sendError(
                res,
                503,
                'SERVICE_UNAVAILABLE',
                'Registration could not be completed. Please try again later.'
            );
        }
    };

    return registerUser;
};
