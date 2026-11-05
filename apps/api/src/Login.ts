
import { Request, Response } from 'express';
import {
    createHmac,
    timingSafeEqual,
    scrypt
} from 'node:crypto';
import { promisify } from 'node:util';
import jwt from 'jsonwebtoken';

import { UserModel } from './models/account.js';

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

const scryptAsync = promisify(scrypt);

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
    throw new Error('JWT_SECRET is not configured.');
}

// generic authentication response
const authenticationError = (res: Response) => {
    return sendError(
        res,
        401,
        'AUTHENTICATION_FAILED',
        'Invalid email or password.'
    );
};

// verifies a password against its stored hash
const verifyPassword = async (
    password: string,
    storedHash: string
): Promise<boolean> => {

    try {
        const parts = storedHash.split('$');

        if (
            parts.length !== 6 ||
            parts[0] !== 'scrypt' ||
            parts[1] !== '32768' ||
            parts[2] !== '8' ||
            parts[3] !== '1' ||
            !/^[a-f0-9]{32}$/.test(parts[4]) ||
            !/^[a-f0-9]{128}$/.test(parts[5])
        ) {
            return false;
        }

        const salt = Buffer.from(parts[4], 'hex');
        const storedKey = Buffer.from(parts[5], 'hex');

        const derivedKey = await scryptAsync(
            password,
            salt,
            64,
            {
                N: 32768,
                r: 8,
                p: 1,
                maxmem: 64 * 1024 * 1024
            }
        ) as Buffer;

        return timingSafeEqual(derivedKey, storedKey);

    } catch {
        return false;
    }
};

export const LoginHandler = () => {

    const loginUser = async (req: Request, res: Response) => {

        try {

            // validates request body
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

            const { email, password } = req.body;

            // rejects unexpected fields
            const allowedFields = ['email', 'password'];

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

            // normalises email
            const normalEmail = email.trim().toLowerCase();

            // validates email format
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

            if (
                normalEmail.length > 254 ||
                !emailRegex.test(normalEmail)
            ) {
                return authenticationError(res);
            }

            // validates password length
            const passwordLength = Array.from(password).length;

            if (passwordLength < 12 || passwordLength > 128) {
                return authenticationError(res);
            }

            // finds user
            const user = await UserModel.findOne({
                email: normalEmail
            }).exec();

            if (!user) {
                return authenticationError(res);
            }

            // rejects unverified accounts
            if (!user.emailVerifiedAt) {
                return sendError(
                    res,
                    403,
                    'EMAIL_NOT_VERIFIED',
                    'Please verify your email address before logging in.'
                );
            }

            // verifies password
            const passwordValid = await verifyPassword(
                password,
                user.passwordHash
            );

            if (!passwordValid) {
                return authenticationError(res);
            }

            // generates access token
            const accessToken = jwt.sign(
                {
                    sub: user._id.toString(),
                    role: user.role,
                    ver: user.tokenVersion || 0
                },
                JWT_SECRET,
                {
                    algorithm: 'HS256',
                    issuer: 'your-app-issuer',
                    audience: 'your-app-audience',
                    expiresIn: '15m'
                }
            );

            // returns successful authentication
            return res.status(200).json({
                message: 'Login successful.',
                accessToken,
                tokenType: 'Bearer',
                expiresIn: 900
            });

        } catch (error: unknown) {

            console.error('Login failed');

            return sendError(
                res,
                500,
                'INTERNAL_ERROR',
                'An unexpected error occurred.'
            );
        }
    };

    return loginUser;
};
