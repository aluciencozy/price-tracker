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
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = schema.safeParse(env);

  if (!result.success) {
    // Report keys only: validation errors can otherwise expose connection strings.
    const keys = [...new Set(result.error.issues.map((issue) => issue.path.join('.')))];

    throw new Error(`Invalid environment: ${keys.join(', ')}`);
  }

  return result.data;
}
