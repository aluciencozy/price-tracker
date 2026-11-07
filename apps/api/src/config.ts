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
  // Live price requests remain explicit opt-ins; email activation has no switch yet.
  PRICE_TRACKING_ENABLED: z.enum(['true', 'false']).default('false').transform(value => value === 'true'),
  PRICE_SCHEDULER_ENABLED: z.enum(['true', 'false']).default('false').transform(value => value === 'true'),
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
  if (result.data.NODE_ENV !== 'production' && result.data.WEB_ORIGINS.some(origin => {
    const url = new URL(origin);
    return url.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(url.hostname);
  })) throw new Error('HTTP WEB_ORIGINS must use exact loopback hosts');
  return result.data;
}
