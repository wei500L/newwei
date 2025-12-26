import { config as loadDotenv } from "dotenv";
import { z } from "zod";

import { createLogger } from "./logger";

export const baseEnvSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  MYSQL_HOST: z.string().min(1),
  MYSQL_PORT: z.coerce.number().int().positive(),
  MYSQL_USER: z.string().min(1),
  MYSQL_PASSWORD: z.string().min(1),
  MYSQL_DB: z.string().min(1),
  MONGO_URI: z
    .string()
    .url()
    .or(z.string().regex(/^mongodb/)),
  REDIS_HOST: z.string().min(1),
  REDIS_PORT: z.coerce.number().int().positive(),
  SMTP_HOST: z.string().min(1).default("smtp.163.com"),
  SMTP_PORT: z.coerce.number().int().positive().default(465),
  SMTP_SECURE: z.coerce.boolean().default(true),
  SMTP_USER: z.string().email(),
  SMTP_PASS: z.string().min(1),
  SMTP_FROM: z.string().min(1).optional(),
  JWT_SECRET: z.string().min(16),
  NEXTAUTH_SECRET: z.string().min(16),
  NEXTAUTH_URL: z.string().url(),
  API_BASE_URL: z.string().url(),
  CRAWL4AI_BASE_URL: z.string().url(),
  CRAWL4AI_API_KEY: z.string().optional(),
  CRAWL4AI_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  CRAWL4AI_MAX_CONCURRENCY: z.coerce.number().int().positive().default(3),
  CRAWL4AI_MAX_RETRIES: z.coerce.number().int().positive().default(3),
  CRAWL_MEDIA_FETCH_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(15_000),
  CRAWL_MEDIA_MAX_BYTES: z.coerce.number().int().positive().default(2_097_152),
  CRAWL_MEDIA_MAX_PER_RESULT: z.coerce.number().int().positive().default(6),
  LITELLM_MODEL: z.string().min(1).default("openai/gpt-4o-mini"),
  LITELLM_API_BASE: z.string().url().default("http://localhost:4001"),
  LITELLM_API_KEY: z.string().optional(),
  LITELLM_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  LITELLM_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.2),
  LITELLM_TOP_P: z.coerce.number().min(0).max(1).default(0.9),
  LITELLM_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(1_200),
  LITELLM_MAX_RETRIES: z.coerce.number().int().positive().default(3),
  LITELLM_FALLBACK_MODELS: z.string().optional(),
  LITELLM_REQUESTS_PER_MINUTE: z.coerce.number().int().positive().default(60),
  AKSHARE_HTTP_BASE_URL: z.string().url().default("http://localhost:8081"),
  AKSHARE_HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(20000),
  AKSHARE_HTTP_MAX_RETRIES: z.coerce.number().int().positive().default(3),
  AKSHARE_QUEUE_CONCURRENCY: z.coerce.number().int().positive().default(2),
  NEWS_PIPELINE_CACHE_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(3_600),
  NEWS_PIPELINE_MAX_INPUT_CHARS: z.coerce
    .number()
    .int()
    .positive()
    .default(48_000),
  NEWS_PIPELINE_CONFIG_PATH: z
    .string()
    .default("config/news-pipeline.config.yaml"),
  SYSTEM_SETTINGS_ENCRYPTION_KEY: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_REGION: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  S3_ENDPOINT: z.string().url().optional(),
  S3_PUBLIC_BASE_URL: z.string().url().optional(),
  S3_FORCE_PATH_STYLE: z.coerce.boolean().optional(),
  S3_PRESIGNED_URL_TTL_SECONDS: z.coerce.number().int().positive().optional(),
});

export type BaseEnvSchema = typeof baseEnvSchema;
export type BaseEnv = z.infer<typeof baseEnvSchema>;

export interface LoadEnvOptions {
  dotenvPath?: string;
  overrideProcessEnv?: boolean;
}

export function loadAndValidateEnv<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  options: LoadEnvOptions = {},
): z.infer<TSchema> {
  const logger = createLogger({ name: "env" });

  if (options.dotenvPath) {
    loadDotenv({ path: options.dotenvPath });
  } else {
    loadDotenv();
  }

  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    logger.error(
      {
        errors: parsed.error.flatten().fieldErrors,
        dotenvPath: options.dotenvPath,
      },
      "Invalid environment variables",
    );
    throw new Error("Environment validation failed");
  }

  if (options.overrideProcessEnv) {
    Object.assign(process.env, parsed.data);
  }

  return parsed.data;
}
