import { z } from 'zod';

const optionalNonEmptyString = z.preprocess(
  (value) => {
    if (typeof value !== 'string') {
      return value;
    }
    const trimmed = value.trim();
    return trimmed.length === 0 ? undefined : trimmed;
  },
  z.string().min(1).optional(),
);

export const vectorEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4010),
  // NEVER ship a default in production: this token guards arbitrary
  // upsert/search on the vector store. A hardcoded default means a misconfigured
  // deployment silently runs with a publicly-known credential.
  VECTOR_INTERNAL_TOKEN: z
    .string()
    .min(8)
    .refine((value) => {
      const isProd = process.env.NODE_ENV === 'production';
      const isDefault = value === 'dev-token';
      return !(isProd && isDefault);
    }, 'VECTOR_INTERNAL_TOKEN must be explicitly configured in production (dev-token is not allowed)'),
  QDRANT_URL: z.string().url().default('http://localhost:6333'),
  QDRANT_API_KEY: optionalNonEmptyString,
  VECTOR_COLLECTION_PREFIX: z.string().min(1).default('processed_item_summary'),
  VECTOR_QDRANT_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
});

export type VectorEnv = z.infer<typeof vectorEnvSchema>;
