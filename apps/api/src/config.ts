import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  HOST: z.string().min(1).default('127.0.0.1'),
  WEB_ORIGINS: z
    .string()
    .default('http://localhost:5173,http://127.0.0.1:5173')
    .transform((value) => value.split(',').map((origin) => origin.trim()))
    .pipe(
      z.array(
        z.url().refine((value) => {
          if (!URL.canParse(value)) {
            return false;
          }

          const url = new URL(value);

          // Reject paths and wildcards: CORS entries must be complete origins.
          return ['http:', 'https:'].includes(url.protocol) && url.origin === value;
        }, 'Expected an exact HTTP(S) origin'),
      ).min(1),
    ),
  MONGODB_URI: z.string().regex(/^mongodb(?:\+srv)?:\/\//).optional(),
  // Stable server-side key: never generate a new key at process startup.
  AUTH_JWT_SECRET: z.string().min(32).optional(),
  // Credentials never enable background work by themselves.
  PRICE_TRACKING_ENABLED: z.enum(['true', 'false']).default('false').transform(value => value === 'true'),
  PRICE_SCHEDULER_ENABLED: z.enum(['true', 'false']).default('false').transform(value => value === 'true'),
  PRICE_RETRY_WORKER_ENABLED: z.enum(['true', 'false']).default('false').transform(value => value === 'true'),
  ACCOUNT_MAIL_ENABLED: z.enum(['true', 'false']).default('false').transform(value => value === 'true'),
  PRICE_EMAIL_ENABLED: z.enum(['true', 'false']).default('false').transform(value => value === 'true'),
  PRICE_PUSH_ENABLED: z.enum(['true', 'false']).default('false').transform(value => value === 'true'),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(1000).max(300000).default(5000),
  PRICE_RETRY_INTERVAL_MS: z.coerce.number().int().min(60000).max(3600000).default(60000),
  RESEND_SEND_API_KEY: z.string().trim().min(1).optional(),
  EMAIL_FROM: z.string().trim().min(1).optional(),
  TEMPLATE_PASSWORD_RESET_ID: z.string().trim().min(1).optional(),
  TEMPLATE_PRICE_ALERT_ID: z.string().trim().min(1).optional(),
  FIREBASE_PROJECT_ID: z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/).optional(),
  TRACKING_CURSOR_SECRET: z.string().min(32).optional(),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = schema.safeParse(env);

  if (!result.success) {
    // Report keys only: validation errors can otherwise expose connection strings.
    const keys = [...new Set(result.error.issues.map((issue) => issue.path.join('.')))];

    throw new Error(`Invalid environment: ${keys.join(', ')}`);
  }

  if (result.data.NODE_ENV === 'production' && result.data.WEB_ORIGINS.some(origin => !origin.startsWith('https://'))) {
    throw new Error('Production WEB_ORIGINS must use HTTPS');
  }
  if (result.data.NODE_ENV === 'production' && !result.data.AUTH_JWT_SECRET) {
    throw new Error('Production AUTH_JWT_SECRET is required');
  }
  if (result.data.PRICE_TRACKING_ENABLED && !result.data.TRACKING_CURSOR_SECRET) {
    throw new Error('TRACKING_CURSOR_SECRET is required when tracking is enabled');
  }
  if (result.data.PRICE_SCHEDULER_ENABLED && !result.data.PRICE_TRACKING_ENABLED) {
    throw new Error('Scheduled checks require explicitly enabled tracking');
  }
  const config = result.data;
  if (config.PRICE_RETRY_WORKER_ENABLED && !config.PRICE_TRACKING_ENABLED) {
    throw new Error('Price retry worker requires explicitly enabled tracking');
  }
  if ((config.PRICE_EMAIL_ENABLED || config.PRICE_PUSH_ENABLED) && !config.PRICE_TRACKING_ENABLED) {
    throw new Error('Price delivery requires explicitly enabled tracking');
  }
  if ((config.PRICE_SCHEDULER_ENABLED || config.PRICE_RETRY_WORKER_ENABLED || config.ACCOUNT_MAIL_ENABLED ||
       config.PRICE_EMAIL_ENABLED || config.PRICE_PUSH_ENABLED) && !config.MONGODB_URI) {
    throw new Error('Enabled background workers require MONGODB_URI');
  }
  if (config.ACCOUNT_MAIL_ENABLED || config.PRICE_EMAIL_ENABLED) {
    if (!config.RESEND_SEND_API_KEY || !config.EMAIL_FROM) throw new Error('Enabled mail requires RESEND_SEND_API_KEY and explicit EMAIL_FROM');
    if (config.ACCOUNT_MAIL_ENABLED && (!config.WEB_ORIGINS[0]?.startsWith('https://') || !config.TEMPLATE_PASSWORD_RESET_ID)) {
      throw new Error('Account mail requires an HTTPS first WEB_ORIGINS entry and TEMPLATE_PASSWORD_RESET_ID');
    }
    if (config.PRICE_EMAIL_ENABLED && !config.TEMPLATE_PRICE_ALERT_ID) throw new Error('Price email requires TEMPLATE_PRICE_ALERT_ID');
  }
  if (config.PRICE_PUSH_ENABLED && (!config.FIREBASE_PROJECT_ID || !config.AUTH_JWT_SECRET)) {
    throw new Error('Price push requires FIREBASE_PROJECT_ID and AUTH_JWT_SECRET; configure deployment-managed ADC separately');
  }
  if (result.data.NODE_ENV !== 'production' && result.data.WEB_ORIGINS.some(origin => {
    const url = new URL(origin);
    return url.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(url.hostname);
  })) throw new Error('HTTP WEB_ORIGINS must use exact loopback hosts');
  return result.data;
}
