import { z } from 'zod';

export const vectorEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4010),
  VECTOR_INTERNAL_TOKEN: z.string().min(8).default('dev-token'),
  QDRANT_URL: z.string().url().default('http://localhost:6333'),
  QDRANT_API_KEY: z.string().min(1).optional(),
  VECTOR_COLLECTION_PREFIX: z.string().min(1).default('processed_item_summary'),
  VECTOR_QDRANT_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
});

export type VectorEnv = z.infer<typeof vectorEnvSchema>;

