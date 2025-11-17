import { baseEnvSchema } from "@modular/utils";
import { z } from "zod";

export const apiEnvSchema = baseEnvSchema.extend({
  PORT: z.coerce.number().int().positive().default(4000),
  JWT_ACCESS_EXPIRES_IN: z.string().default("15m"),
  JWT_REFRESH_EXPIRES_IN: z.string().default("7d"),
  JWT_ISSUER: z.string().default("modular-monolith"),
  JWT_AUDIENCE: z.string().default("modular-monolith-clients"),
  REDIS_DB: z.coerce.number().int().nonnegative().default(0),
  REDIS_USERNAME: z.string().optional(),
  BULLMQ_NAMESPACE: z.string().default("modular"),
  RATE_LIMIT_LOGIN: z.coerce.number().int().positive().default(5),
  RATE_LIMIT_LOGIN_WINDOW: z.coerce.number().int().positive().default(60),
  GRAPHQL_PLAYGROUND: z.coerce
    .boolean()
    .default(process.env.NODE_ENV === "production" ? false : true),
  GRAPHQL_INTROSPECTION: z.coerce
    .boolean()
    .default(process.env.NODE_ENV === "production" ? false : true),
  GRAPHQL_DEPTH_LIMIT: z.coerce.number().int().positive().default(8),
  GRAPHQL_COMPLEXITY_LIMIT: z.coerce.number().int().positive().default(2000),
  CORS_ORIGIN: z.string().optional(),
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
  LITELLM_API_URL: z.string().url().optional(),
  LITELLM_API_BASE: z.string().url().default("http://localhost:4001"),
  LITELLM_API_KEY: z.string().optional(),
  LITELLM_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  LITELLM_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.2),
  LITELLM_TOP_P: z.coerce.number().min(0).max(1).default(0.9),
  LITELLM_MAX_TOKENS: z.coerce.number().int().positive().default(2_048),
  LITELLM_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(1_200),
  LITELLM_RETRY_ATTEMPTS: z.coerce.number().int().positive().default(3),
  LITELLM_MAX_RETRIES: z.coerce.number().int().positive().default(3),
  LITELLM_FALLBACK_MODELS: z.string().optional(),
  LITELLM_REQUESTS_PER_MINUTE: z.coerce.number().int().positive().default(60),
  AKSHARE_HTTP_BASE_URL: z.string().url().default("http://localhost:8081"),
  AKSHARE_HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
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
  NEWS_CRAWL_QUEUE_CONCURRENCY: z.coerce.number().int().positive().default(4),
  NEWS_PROCESS_QUEUE_CONCURRENCY: z.coerce.number().int().positive().default(8),
  NEWS_CRAWL_QUEUE_RATE_LIMIT: z.coerce.number().int().positive().default(5),
  NEWS_PROCESS_QUEUE_RATE_LIMIT: z.coerce.number().int().positive().default(12),
  ALERT_QUEUE_CONCURRENCY: z.coerce.number().int().positive().default(4),
  ALERT_WEBHOOK_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  ALERT_MAX_RETRIES: z.coerce.number().int().positive().default(3),
  ALERT_SCAN_INTERVAL_MS: z.coerce.number().int().positive().default(300_000),
  ANALYSIS_QUEUE_CONCURRENCY: z.coerce.number().int().positive().default(2),
  ANALYSIS_MAX_RETRIES: z.coerce.number().int().positive().default(3),
  ANALYSIS_AUTOTRIGGER_ENABLED: z.coerce.boolean().default(false),
});

export type ApiEnv = z.infer<typeof apiEnvSchema>;
