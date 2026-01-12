import { baseEnvSchema } from "@modular/utils";
import { z } from "zod";

export const apiEnvSchema = baseEnvSchema.extend({
  PORT: z.coerce.number().int().positive().default(4000),
  BULL_BOARD_USERNAME: z.string().min(1).optional(),
  BULL_BOARD_PASSWORD: z.string().min(1).optional(),
  JWT_ACCESS_EXPIRES_IN: z.string().default("15m"),
  JWT_REFRESH_EXPIRES_IN: z.string().default("7d"),
  JWT_ISSUER: z.string().default("modular-monolith"),
  JWT_AUDIENCE: z.string().default("modular-monolith-clients"),
  REDIS_DB: z.coerce.number().int().nonnegative().default(0),
  REDIS_USERNAME: z.string().optional(),
  BULLMQ_NAMESPACE: z.string().default("modular"),
  RATE_LIMIT_LOGIN: z.coerce.number().int().positive().default(5),
  RATE_LIMIT_LOGIN_WINDOW: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_CRAWL_TASK_CREATE: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_CRAWL_TASK_CREATE_WINDOW: z.coerce.number().int().positive().default(300),
  RATE_LIMIT_RBAC_WRITE: z.coerce.number().int().positive().default(20),
  RATE_LIMIT_RBAC_WRITE_WINDOW: z.coerce.number().int().positive().default(600),
  RATE_LIMIT_SETTINGS_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(60),
  AUTH_PROFILE_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(600),
  AUTH_PROFILE_CACHE_LOCK_TTL_MS: z.coerce.number().int().positive().default(5_000),
  AUTH_PROFILE_CACHE_MAX_WAIT_MS: z.coerce.number().int().positive().default(5_000),
  AUTH_PROFILE_CACHE_RETRY_DELAY_MS: z.coerce.number().int().positive().default(50),
  AUTH_REFRESH_GRACE_SECONDS: z.coerce.number().int().positive().default(10),
  AUDIT_LOG_RETENTION_DAYS: z.coerce.number().int().positive().default(90),
  GRAPHQL_PLAYGROUND: z.coerce
    .boolean()
    .default(process.env.NODE_ENV === "production" ? false : true),
  GRAPHQL_INTROSPECTION: z.coerce
    .boolean()
    .default(process.env.NODE_ENV === "production" ? false : true),
  GRAPHQL_DEPTH_LIMIT: z.coerce.number().int().positive().default(8),
  GRAPHQL_COMPLEXITY_LIMIT: z.coerce.number().int().positive().default(2000),
  CORS_ORIGIN: z.string().optional(),
  WS_MAX_CONNECTIONS_PER_USER: z.coerce.number().int().positive().default(5),
  WS_MAX_CONNECTIONS_PER_IP: z.coerce.number().int().positive().default(50),
  WS_CONNECT_RATE_LIMIT_PER_IP: z.coerce.number().int().positive().default(60),
  WS_CONNECT_RATE_LIMIT_PER_USER: z.coerce.number().int().positive().default(30),
  WS_CONNECT_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  WS_REDIS_ADAPTER_ENABLED: z.coerce.boolean().default(true),
  WS_REDIS_ADAPTER_KEY: z.string().min(1).default("socket.io"),
  CRAWL4AI_BASE_URL: z.string().url(),
  CRAWL4AI_API_KEY: z.string().optional(),
  CRAWL4AI_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  CRAWL4AI_MAX_CONCURRENCY: z.coerce.number().int().positive().default(3),
  CRAWL4AI_MAX_RETRIES: z.coerce.number().int().positive().default(3),
  CRAWL4AI_HEALTH_CHECK_TTL_MS: z.coerce.number().int().positive().default(60_000),
  CRAWL4AI_RETRY_BACKOFF_MS: z.coerce.number().int().positive().default(5_000),
  CRAWL_TASK_CONFIG_ENCRYPTION_KEY: z.string().optional(),
  CRAWL_TASK_JANITOR_ENABLED: z.coerce.boolean().default(true),
  CRAWL_TASK_RUNNING_TIMEOUT_MS: z.coerce.number().int().positive().default(1_800_000),
  CRAWL_TASK_QUEUED_TIMEOUT_MS: z.coerce.number().int().positive().default(43_200_000),
  CRAWL_TASK_JANITOR_BATCH_SIZE: z.coerce.number().int().positive().default(50),
  CRAWL_TASK_JANITOR_QUEUE_SCAN_LIMIT: z.coerce.number().int().positive().default(5_000),
  CRAWL_TASK_JANITOR_LOCK_TTL_MS: z.coerce.number().int().positive().default(120_000),
  CRAWL_MEDIA_FETCH_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(15_000),
  CRAWL_MEDIA_MAX_BYTES: z.coerce.number().int().positive().default(2_097_152),
  CRAWL_MEDIA_MAX_PER_RESULT: z.coerce.number().int().positive().default(6),
  LITELLM_MODEL: z.string().min(1).default("openai/gpt-4o-mini"),
  LITELLM_EMBEDDING_MODEL: z.string().optional(),
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
  AKSHARE_ADMIN_TOKEN: z.string().optional(),
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
  NEWS_SOURCE_SCHEDULER_ENABLED: z.coerce.boolean().default(true),
  NEWS_SOURCE_SCHEDULER_BATCH_SIZE: z.coerce.number().int().positive().default(20),
  NEWS_SOURCE_SCHEDULER_LOCK_TTL_MS: z.coerce.number().int().positive().default(120_000),
  NEWS_SOURCE_SCHEDULER_INFLIGHT_LOOKBACK_MS: z.coerce.number().int().positive().default(21_600_000),
  NEWS_SOURCE_SCHEDULER_INFLIGHT_RESCHEDULE_DELAY_MS: z.coerce.number().int().positive().default(300_000),
  NEWS_SOURCE_SCHEDULER_FAILURE_RECOVERY_DELAY_MS: z.coerce.number().int().positive().default(600_000),
  NEWS_SOURCE_SCHEDULER_FAILURE_MAX_DELAY_MS: z.coerce.number().int().positive().default(21_600_000),
  NEWS_SOURCE_SCHEDULER_CIRCUIT_BREAKER_THRESHOLD: z.coerce.number().int().nonnegative().default(3),
  NEWS_SOURCE_SCHEDULER_CIRCUIT_BREAKER_BASE_DELAY_MS: z.coerce.number().int().positive().default(3_600_000),
  NEWS_SOURCE_SCHEDULER_CIRCUIT_BREAKER_MAX_DELAY_MS: z.coerce.number().int().positive().default(86_400_000),
  ALERT_QUEUE_CONCURRENCY: z.coerce.number().int().positive().default(4),
  ALERT_WEBHOOK_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  ALERT_MAX_RETRIES: z.coerce.number().int().positive().default(3),
  ALERT_SCAN_INTERVAL_MS: z.coerce.number().int().positive().default(300_000),
  ALERT_NOTIFY_GLOBAL_PER_SECOND: z.coerce.number().int().nonnegative().default(10),
  ALERT_NOTIFY_EMAIL_PER_SECOND: z.coerce.number().int().nonnegative().default(2),
  ALERT_NOTIFY_WEBHOOK_PER_SECOND: z.coerce.number().int().nonnegative().default(10),
  ALERT_NOTIFY_PER_CHANNEL_PER_SECOND: z.coerce.number().int().nonnegative().default(2),
  ALERT_NOTIFY_LIMITER_TTL_MS: z.coerce.number().int().positive().default(60_000),
  GEO_NOMINATIM_BASE_URL: z
    .string()
    .url()
    .default("https://nominatim.openstreetmap.org"),
  GEO_NOMINATIM_USER_AGENT: z.string().min(1).default("modular-api"),
  GEO_NOMINATIM_EMAIL: z.string().email().optional(),
  GEO_NOMINATIM_ACCEPT_LANGUAGE: z
    .string()
    .min(1)
    .default("zh-CN,zh;q=0.9,en;q=0.7"),
  GEO_GEOCODE_TIMEOUT_MS: z.coerce.number().int().positive().default(3_000),
  GEO_GEOCODE_CACHE_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(2_592_000),
  GEO_GEOCODE_NEGATIVE_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(86_400),
  GEO_GEOCODE_RATE_LIMIT_PER_SECOND: z.coerce.number().int().positive().default(1),
  ANALYSIS_QUEUE_CONCURRENCY: z.coerce.number().int().positive().default(2),
  ANALYSIS_MAX_RETRIES: z.coerce.number().int().positive().default(3),
  ANALYSIS_AUTOTRIGGER_ENABLED: z.coerce.boolean().default(false),
  SYSTEM_SETTINGS_ENCRYPTION_KEY: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_REGION: z.string().default("us-east-1"),
  S3_BUCKET: z.string().optional(),
  S3_ENDPOINT: z.string().url().optional(),
  S3_PUBLIC_BASE_URL: z.string().url().optional(),
  S3_FORCE_PATH_STYLE: z.coerce.boolean().default(false),
  S3_PRESIGNED_URL_TTL_SECONDS: z.coerce.number().int().positive().default(300),
});

export type ApiEnv = z.infer<typeof apiEnvSchema>;
