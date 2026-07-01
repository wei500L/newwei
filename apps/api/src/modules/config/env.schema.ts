import {
  baseEnvSchema,
  getMissingMysqlConnectionEnvVars,
} from "@modular/utils";
import { z } from "zod";

const envBoolean = z.preprocess((value) => {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "") return undefined;
    if (["true", "1", "yes", "y", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "n", "off"].includes(normalized)) return false;
  }
  return value;
}, z.boolean());

const optionalNonEmptyString = z.preprocess((value) => {
  if (typeof value === "string" && value.trim() === "") {
    return undefined;
  }
  return value;
}, z.string().min(1).optional());

export const apiEnvSchema = baseEnvSchema
  .extend({
    PORT: z.coerce.number().int().positive().default(4000),
    BULL_BOARD_ENABLED: envBoolean.default(true),
    BULL_BOARD_USERNAME: optionalNonEmptyString,
    BULL_BOARD_PASSWORD: optionalNonEmptyString,
    JWT_ACCESS_EXPIRES_IN: z.string().default("15m"),
    JWT_REFRESH_EXPIRES_IN: z.string().default("7d"),
    JWT_ISSUER: z.string().default("modular-monolith"),
    JWT_AUDIENCE: z.string().default("modular-monolith-clients"),
    REDIS_DB: z.coerce.number().int().nonnegative().default(0),
    REDIS_USERNAME: z.string().optional(),
    REDIS_PASSWORD: z.string().optional(),
    REDIS_ENABLE_AUTO_PIPELINING: envBoolean.default(true),
    REDIS_MAX_RETRIES_PER_REQUEST: z.coerce
      .number()
      .int()
      .nonnegative()
      .default(3),
    BULLMQ_NAMESPACE: z.string().default("modular"),
    PRISMA_CONNECTION_LIMIT: z.coerce.number().int().positive().default(10),
    PRISMA_POOL_TIMEOUT_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .default(10),
    PRISMA_TRANSACTION_MAX_WAIT_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(5_000),
    PRISMA_TRANSACTION_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(15_000),
    HTTP_KEEP_ALIVE_ENABLED: envBoolean.default(true),
    HTTP_AGENT_MAX_SOCKETS: z.coerce.number().int().positive().default(64),
    HTTP_AGENT_MAX_FREE_SOCKETS: z.coerce
      .number()
      .int()
      .positive()
      .default(16),
    HTTP_AGENT_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(60_000),
    RATE_LIMIT_LOGIN: z.coerce.number().int().positive().default(5),
    RATE_LIMIT_LOGIN_WINDOW: z.coerce.number().int().positive().default(60),
    RATE_LIMIT_CRAWL_TASK_CREATE: z.coerce
      .number()
      .int()
      .positive()
      .default(10),
    RATE_LIMIT_CRAWL_TASK_CREATE_WINDOW: z.coerce
      .number()
      .int()
      .positive()
      .default(300),
    RATE_LIMIT_RBAC_WRITE: z.coerce.number().int().positive().default(20),
    RATE_LIMIT_RBAC_WRITE_WINDOW: z.coerce
      .number()
      .int()
      .positive()
      .default(600),
    OBSERVABILITY_CLIENT_EXCEPTION_USER_RATE_LIMIT: z.coerce
      .number()
      .int()
      .positive()
      .default(30),
    OBSERVABILITY_CLIENT_EXCEPTION_IP_RATE_LIMIT: z.coerce
      .number()
      .int()
      .positive()
      .default(120),
    OBSERVABILITY_CLIENT_EXCEPTION_RATE_LIMIT_WINDOW_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .default(60),
    RATE_LIMIT_SETTINGS_CACHE_TTL_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .default(60),
    AUTH_PROFILE_CACHE_TTL_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .default(600),
    AUTH_PROFILE_CACHE_LOCK_TTL_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(5_000),
    AUTH_PROFILE_CACHE_MAX_WAIT_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(5_000),
    AUTH_PROFILE_CACHE_RETRY_DELAY_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(50),
    AUTH_REFRESH_GRACE_SECONDS: z.coerce.number().int().positive().default(10),
    AUTH_EMAIL_CODE_TTL_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .default(300),
    AUTH_EMAIL_CODE_COOLDOWN_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .default(90),
    AUTH_EMAIL_CODE_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),
    AUTH_MFA_CHALLENGE_MAX_ATTEMPTS: z.coerce
      .number()
      .int()
      .positive()
      .default(5),
    AUDIT_LOG_RETENTION_DAYS: z.coerce.number().int().positive().default(90),
    TASK_LOG_RETENTION_DAYS: z.coerce.number().int().positive().default(14),
    GRAPHQL_PLAYGROUND: envBoolean.default(
      process.env.NODE_ENV === "production" ? false : true,
    ),
    GRAPHQL_INTROSPECTION: envBoolean.default(
      process.env.NODE_ENV === "production" ? false : true,
    ),
    GRAPHQL_DEPTH_LIMIT: z.coerce.number().int().positive().default(8),
    GRAPHQL_COMPLEXITY_LIMIT: z.coerce.number().int().positive().default(2000),
    GRAPHQL_APQ_ENABLED: envBoolean.default(true),
    GRAPHQL_RESPONSE_CACHE_ENABLED: envBoolean.default(true),
    GRAPHQL_RESPONSE_CACHE_MAX_AGE_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .default(30),
    CORS_ORIGIN: z.string().optional(),
    WS_MAX_CONNECTIONS_PER_USER: z.coerce.number().int().positive().default(5),
    WS_MAX_CONNECTIONS_PER_IP: z.coerce.number().int().positive().default(50),
    WS_CONNECT_RATE_LIMIT_PER_IP: z.coerce
      .number()
      .int()
      .positive()
      .default(60),
    WS_CONNECT_RATE_LIMIT_PER_USER: z.coerce
      .number()
      .int()
      .positive()
      .default(30),
    WS_CONNECT_RATE_LIMIT_WINDOW_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .default(60),
    WS_REDIS_ADAPTER_ENABLED: envBoolean.default(true),
    WS_REDIS_ADAPTER_KEY: z.string().min(1).default("socket.io"),
    CRAWL4AI_BASE_URL: z.string().url(),
    CRAWL4AI_API_KEY: z.string().optional(),
    CRAWL4AI_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
    CRAWL4AI_MAX_CONCURRENCY: z.coerce.number().int().positive().default(3),
    CRAWL4AI_MAX_RETRIES: z.coerce.number().int().positive().default(3),
    CRAWL4AI_HEALTH_CHECK_TTL_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(60_000),
    CRAWL4AI_RETRY_BACKOFF_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(5_000),
    CRAWL4AI_SSRF_PROXY_URL: z.string().url().optional(),
    CRAWL4AI_JSCODE_ENABLED: envBoolean.default(true),
    CRAWL4AI_JSCODE_AUDIT_ENABLED: envBoolean.default(true),
    CRAWL4AI_JSCODE_AUDIT_RETENTION_DAYS: z.coerce
      .number()
      .int()
      .positive()
      .default(90),
    CRAWL4AI_JSCODE_MAX_LENGTH: z.coerce
      .number()
      .int()
      .positive()
      .default(2000),
    CRAWL4AI_JSCODE_MAX_SCRIPTS: z.coerce.number().int().positive().default(5),
    CRAWL_TASK_JANITOR_ENABLED: envBoolean.default(true),
    CRAWL_TASK_RUNNING_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(1_800_000),
    CRAWL_TASK_QUEUED_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(43_200_000),
    CRAWL_TASK_JANITOR_BATCH_SIZE: z.coerce
      .number()
      .int()
      .positive()
      .default(50),
    CRAWL_TASK_JANITOR_QUEUE_SCAN_LIMIT: z.coerce
      .number()
      .int()
      .positive()
      .default(5_000),
    CRAWL_TASK_JANITOR_LOCK_TTL_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(120_000),
    CRAWL_MEDIA_FETCH_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(15_000),
    CRAWL_MEDIA_MAX_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(2_097_152),
    CRAWL_MEDIA_MAX_PER_RESULT: z.coerce.number().int().positive().default(6),
    LITELLM_MODEL: z.string().min(1).default("openai/gpt-4o-mini"),
    LITELLM_EMBEDDING_MODEL: z.string().optional(),
    LITELLM_API_URL: z.string().url().optional(),
    LITELLM_API_BASE: z.string().url().default("http://localhost:4001"),
    LITELLM_API_KEY: z.preprocess(
      (value) =>
        typeof value === "string" && value.trim() === "" ? undefined : value,
      z.string().min(1).optional(),
    ),
    LITELLM_MASTER_KEY: z.preprocess(
      (value) =>
        typeof value === "string" && value.trim() === "" ? undefined : value,
      z.string().min(1).optional(),
    ),
    LITELLM_CONFIG_INTERNAL_TOKEN: z.preprocess(
      (value) =>
        typeof value === "string" && value.trim() === "" ? undefined : value,
      z.string().min(16).optional(),
    ),
    LITELLM_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
    LITELLM_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.2),
    LITELLM_TOP_P: z.coerce.number().min(0).max(1).default(0.9),
    LITELLM_MAX_TOKENS: z.coerce.number().int().positive().default(2_048),
    LITELLM_MAX_OUTPUT_TOKENS: z.coerce
      .number()
      .int()
      .positive()
      .default(1_200),
    LITELLM_RETRY_ATTEMPTS: z.coerce.number().int().positive().default(3),
    LITELLM_MAX_RETRIES: z.coerce.number().int().positive().default(3),
    LITELLM_FALLBACK_MODELS: z.string().optional(),
    ITEMS_SEARCH_RERANK_ENABLED: envBoolean.default(true),
    ITEMS_SEARCH_RECALL_MAX_CANDIDATES: z.coerce
      .number()
      .int()
      .positive()
      .default(120),
    ITEMS_SEARCH_RERANK_MAX_CANDIDATES: z.coerce
      .number()
      .int()
      .positive()
      .default(40),
    ITEMS_SEARCH_RERANK_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(300),
    ITEMS_READ_MODEL_ENABLED: envBoolean.default(false),
    ITEMS_VECTOR_HARD_FAIL_ENABLED: envBoolean.default(false),
    ITEMS_SEARCH_RECENCY_HALFLIFE_HOURS: z.coerce
      .number()
      .positive()
      .default(48),
    ELASTICSEARCH_ENABLED: envBoolean.default(false),
    ELASTICSEARCH_NODE: z.preprocess(
      (value) =>
        typeof value === "string" && value.trim() === "" ? undefined : value,
      z.string().url().optional(),
    ),
    ELASTICSEARCH_USERNAME: z.string().optional(),
    ELASTICSEARCH_PASSWORD: z.string().optional(),
    ELASTICSEARCH_API_KEY: z.string().optional(),
    ELASTICSEARCH_ITEMS_INDEX: z.string().min(1).default("items-v1"),
    ELASTICSEARCH_ITEMS_ALIAS: z.string().min(1).default("items-current"),
    ELASTICSEARCH_REQUEST_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(3_000),
    VECTOR_SERVICE_ENABLED: envBoolean.default(false),
    VECTOR_SERVICE_FALLBACK_TO_MONGO: envBoolean.default(true),
    VECTOR_SERVICE_BASE_URL: z.preprocess(
      (value) =>
        typeof value === "string" && value.trim() === "" ? undefined : value,
      z.string().url().optional(),
    ),
    VECTOR_INTERNAL_TOKEN: z.preprocess(
      (value) =>
        typeof value === "string" && value.trim() === "" ? undefined : value,
      z.string().min(1).optional(),
    ),
    VECTOR_SERVICE_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(5_000),
    VECTOR_SERVICE_MAX_RETRIES: z.coerce
      .number()
      .int()
      .nonnegative()
      .default(2),
    MODEL_SERVICE_ENABLED: envBoolean.default(false),
    MODEL_SERVICE_BASE_URL: z.preprocess(
      (value) =>
        typeof value === "string" && value.trim() === "" ? undefined : value,
      z.string().url().optional(),
    ),
    MODEL_SERVICE_INTERNAL_TOKEN: z.preprocess(
      (value) =>
        typeof value === "string" && value.trim() === "" ? undefined : value,
      z.string().min(1).optional(),
    ),
    MODEL_SERVICE_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(15_000),
    MODEL_SERVICE_MAX_RETRIES: z.coerce.number().int().nonnegative().default(2),
    AKSHARE_ENABLED: envBoolean.default(true),
    AKSHARE_HTTP_BASE_URL: z.string().url().default("http://localhost:8081"),
    AKSHARE_HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
    AKSHARE_HTTP_MAX_RETRIES: z.coerce.number().int().positive().default(3),
    AKSHARE_ADMIN_TOKEN: z.string().optional(),
    AKSHARE_QUEUE_CONCURRENCY: z.coerce.number().int().positive().default(2),
    AKSHARE_SCHEDULE_SMOOTHING_ENABLED: envBoolean.default(false),
    AKSHARE_SKIP_UNCHANGED_LATEST_POINTS: envBoolean.default(false),
    SITUATION_MONITOR_GDELT_ENABLED: envBoolean.default(true),
    SITUATION_MONITOR_TRANSLATION_API_ENABLED: envBoolean.default(true),
    SITUATION_MONITOR_TRANSLATION_API_BASE_URL: z
      .string()
      .url()
      .default("https://api.deeplx.org"),
    SITUATION_MONITOR_TRANSLATION_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(15_000),
    SITUATION_MONITOR_TRANSLATION_MAX_RETRIES: z.coerce
      .number()
      .int()
      .nonnegative()
      .default(2),
    SITUATION_MONITOR_TRANSLATION_FALLBACK_API_ENABLED:
      envBoolean.default(false),
    SITUATION_MONITOR_TRANSLATION_FALLBACK_API_BASE_URL: z.preprocess(
      (value) =>
        typeof value === "string" && value.trim() === "" ? undefined : value,
      z.string().url().optional(),
    ),
    REALTIME_SIGNALS_ENABLED: envBoolean.default(true),
    REALTIME_SIGNALS_REQUEST_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(12_000),
    REALTIME_SIGNALS_MAX_RETRIES: z.coerce
      .number()
      .int()
      .nonnegative()
      .default(2),
    REALTIME_SIGNALS_OPENSKY_ENABLED: envBoolean.default(true),
    REALTIME_SIGNALS_OPENSKY_INTERVAL_SEC: z.coerce
      .number()
      .int()
      .positive()
      .default(900),
    REALTIME_SIGNALS_OPENSKY_DAILY_CREDIT_BUDGET: z.coerce
      .number()
      .int()
      .positive()
      .default(4000),
    REALTIME_SIGNALS_OPENSKY_DAY_INTERVAL_SEC: z.coerce
      .number()
      .int()
      .positive()
      .default(600),
    REALTIME_SIGNALS_OPENSKY_NIGHT_INTERVAL_SEC: z.coerce
      .number()
      .int()
      .positive()
      .default(1800),
    REALTIME_SIGNALS_OPENSKY_DAY_START_HKT: z.coerce
      .number()
      .int()
      .min(0)
      .max(23)
      .default(8),
    REALTIME_SIGNALS_OPENSKY_NIGHT_START_HKT: z.coerce
      .number()
      .int()
      .min(0)
      .max(23)
      .default(22),
    REALTIME_SIGNALS_OPENSKY_WARNING_REMAINING_PCT: z.coerce
      .number()
      .int()
      .min(1)
      .max(99)
      .default(20),
    REALTIME_SIGNALS_OPENSKY_CRITICAL_REMAINING_PCT: z.coerce
      .number()
      .int()
      .min(0)
      .max(98)
      .default(10),
    REALTIME_SIGNALS_ADSB_ENABLED: envBoolean.optional(),
    REALTIME_SIGNALS_ADSB_INTERVAL_SEC: z.coerce
      .number()
      .int()
      .positive()
      .optional(),
    REALTIME_SIGNALS_AIS_ENABLED: envBoolean.default(true),
    REALTIME_SIGNALS_AIS_INTERVAL_SEC: z.coerce
      .number()
      .int()
      .positive()
      .default(600),
    REALTIME_SIGNALS_UNREST_ENABLED: envBoolean.default(true),
    REALTIME_SIGNALS_UNREST_INTERVAL_SEC: z.coerce
      .number()
      .int()
      .positive()
      .default(600),
    REALTIME_SIGNALS_OUTAGES_ENABLED: envBoolean.default(true),
    REALTIME_SIGNALS_OUTAGES_INTERVAL_SEC: z.coerce
      .number()
      .int()
      .positive()
      .default(600),
    REALTIME_SIGNALS_KEYWORD_SPIKE_ENABLED: envBoolean.default(true),
    REALTIME_SIGNALS_KEYWORD_SPIKE_INTERVAL_SEC: z.coerce
      .number()
      .int()
      .positive()
      .default(600),
    REALTIME_SIGNALS_PIZZINT_ENABLED: envBoolean.default(true),
    REALTIME_SIGNALS_PIZZINT_INTERVAL_SEC: z.coerce
      .number()
      .int()
      .positive()
      .default(600),
    REALTIME_SIGNALS_GDELT_TENSION_ENABLED: envBoolean.default(true),
    REALTIME_SIGNALS_GDELT_TENSION_INTERVAL_SEC: z.coerce
      .number()
      .int()
      .positive()
      .default(600),
    REALTIME_SIGNALS_POLYMARKET_LEADS_ENABLED: envBoolean.default(true),
    REALTIME_SIGNALS_POLYMARKET_LEADS_INTERVAL_SEC: z.coerce
      .number()
      .int()
      .positive()
      .default(600),
    REALTIME_SIGNALS_KEYWORD_SPIKE_MIN_COUNT: z.coerce
      .number()
      .int()
      .positive()
      .default(5),
    REALTIME_SIGNALS_KEYWORD_SPIKE_MULTIPLIER: z.coerce
      .number()
      .positive()
      .default(3),
    REALTIME_SIGNALS_PREDICTION_SHIFT_THRESHOLD: z.coerce
      .number()
      .positive()
      .default(5),
    REALTIME_SIGNALS_PREDICTION_NEWS_ACTIVITY_THRESHOLD: z.coerce
      .number()
      .int()
      .nonnegative()
      .default(3),
    REALTIME_SIGNALS_AIS_BASE_URL: z.preprocess(
      (value) =>
        typeof value === "string" && value.trim() === "" ? undefined : value,
      z.string().url().optional(),
    ),
    REALTIME_SIGNALS_AIS_SHARED_SECRET: z.preprocess(
      (value) =>
        typeof value === "string" && value.trim() === "" ? undefined : value,
      z.string().min(1).optional(),
    ),
    AIS_RELAY_SHARED_SECRET: z.preprocess(
      (value) =>
        typeof value === "string" && value.trim() === "" ? undefined : value,
      z.string().min(1).optional(),
    ),
    REALTIME_SIGNALS_RELAY_BASE_URL: z.preprocess(
      (value) =>
        typeof value === "string" && value.trim() === "" ? undefined : value,
      z.string().url().optional(),
    ),
    REALTIME_SIGNALS_RELAY_SHARED_SECRET: z.preprocess(
      (value) =>
        typeof value === "string" && value.trim() === "" ? undefined : value,
      z.string().min(1).optional(),
    ),
    REALTIME_SIGNALS_OPENSKY_BASE_URL: z.preprocess(
      (value) =>
        typeof value === "string" && value.trim() === "" ? undefined : value,
      z.string().url().default("https://opensky-network.org/api"),
    ),
    REALTIME_SIGNALS_OPENSKY_TOKEN_URL: z.preprocess(
      (value) =>
        typeof value === "string" && value.trim() === "" ? undefined : value,
      z
        .string()
        .url()
        .default(
          "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token",
        ),
    ),
    REALTIME_SIGNALS_OPENSKY_CLIENT_ID: z.preprocess(
      (value) =>
        typeof value === "string" && value.trim() === "" ? undefined : value,
      z.string().min(1).optional(),
    ),
    REALTIME_SIGNALS_OPENSKY_CLIENT_SECRET: z.preprocess(
      (value) =>
        typeof value === "string" && value.trim() === "" ? undefined : value,
      z.string().min(1).optional(),
    ),
    REALTIME_SIGNALS_ADSB_BASE_URL: z.preprocess(
      (value) =>
        typeof value === "string" && value.trim() === "" ? undefined : value,
      z.string().url().optional(),
    ),
    REALTIME_SIGNALS_ACLED_USERNAME: z.preprocess(
      (value) =>
        typeof value === "string" && value.trim() === "" ? undefined : value,
      z.string().min(1).optional(),
    ),
    REALTIME_SIGNALS_ACLED_PASSWORD: z.preprocess(
      (value) =>
        typeof value === "string" && value.trim() === "" ? undefined : value,
      z.string().min(1).optional(),
    ),
    REALTIME_SIGNALS_ACLED_CLIENT_ID: z.preprocess(
      (value) =>
        typeof value === "string" && value.trim() === "" ? undefined : value,
      z.string().min(1).optional(),
    ),
    REALTIME_SIGNALS_CLOUDFLARE_API_TOKEN: z.preprocess(
      (value) =>
        typeof value === "string" && value.trim() === "" ? undefined : value,
      z.string().min(1).optional(),
    ),
    REALTIME_SIGNALS_WINGBITS_API_KEY: z.preprocess(
      (value) =>
        typeof value === "string" && value.trim() === "" ? undefined : value,
      z.string().min(1).optional(),
    ),
    REALTIME_SIGNALS_POLYMARKET_PROXY_URL: z.preprocess(
      (value) =>
        typeof value === "string" && value.trim() === "" ? undefined : value,
      z.string().url().optional(),
    ),
    SITUATION_MONITOR_TELEGRAM_ENABLED: envBoolean.default(false),
    SITUATION_MONITOR_TELEGRAM_API_ID: z.string().optional(),
    SITUATION_MONITOR_TELEGRAM_API_HASH: z.string().optional(),
    SITUATION_MONITOR_TELEGRAM_SESSION: z.string().optional(),
    SITUATION_MONITOR_TELEGRAM_CHANNEL_SET: z.string().default("full"),
    SITUATION_MONITOR_TELEGRAM_MAX_FEED_ITEMS: z.coerce
      .number()
      .int()
      .positive()
      .default(200),
    SITUATION_MONITOR_TELEGRAM_MAX_TEXT_CHARS: z.coerce
      .number()
      .int()
      .positive()
      .default(800),
    SITUATION_MONITOR_TELEGRAM_CHANNEL_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(15_000),
    SITUATION_MONITOR_TELEGRAM_POLL_CYCLE_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(180_000),
    SITUATION_MONITOR_TELEGRAM_STARTUP_DELAY_MS: z.coerce
      .number()
      .int()
      .nonnegative()
      .default(60_000),
    SITUATION_MONITOR_TELEGRAM_RATE_LIMIT_MS: z.coerce
      .number()
      .int()
      .nonnegative()
      .default(800),
    SITUATION_MONITOR_TELEGRAM_POLL_INTERVAL_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(60_000),
    SITUATION_MONITOR_OREF_ENABLED: envBoolean.default(false),
    SITUATION_MONITOR_OREF_PROXY_AUTH: z.string().optional(),
    SITUATION_MONITOR_OREF_ALERTS_URL: z
      .string()
      .url()
      .default("https://www.oref.org.il/WarningMessages/alert/alerts.json"),
    SITUATION_MONITOR_OREF_HISTORY_URL: z
      .string()
      .url()
      .default(
        "https://www.oref.org.il/WarningMessages/alert/History/AlertsHistory.json",
      ),
    SITUATION_MONITOR_OREF_HISTORY_RETENTION_DAYS: z.coerce
      .number()
      .int()
      .positive()
      .default(7),
    SITUATION_MONITOR_OREF_HISTORY_MAX_WAVES: z.coerce
      .number()
      .int()
      .positive()
      .default(200),
    SITUATION_MONITOR_OREF_CURL_TIMEOUT_SEC: z.coerce
      .number()
      .int()
      .positive()
      .default(15),
    SITUATION_MONITOR_OREF_BOOTSTRAP_MAX_RETRIES: z.coerce
      .number()
      .int()
      .positive()
      .default(3),
    SITUATION_MONITOR_OREF_POLL_INTERVAL_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(300_000),
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
    NEWS_PROCESS_QUEUE_CONCURRENCY: z.coerce
      .number()
      .int()
      .positive()
      .default(8),
    NEWS_CRAWL_QUEUE_RATE_LIMIT: z.coerce.number().int().positive().default(5),
    NEWS_PROCESS_QUEUE_RATE_LIMIT: z.coerce
      .number()
      .int()
      .positive()
      .default(12),
    NEWS_SOURCE_SCHEDULER_ENABLED: envBoolean.default(true),
    NEWS_SOURCE_SCHEDULER_BATCH_SIZE: z.coerce
      .number()
      .int()
      .positive()
      .default(20),
    NEWS_SOURCE_SCHEDULER_LOCK_TTL_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(120_000),
    NEWS_SOURCE_SCHEDULER_INFLIGHT_LOOKBACK_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(21_600_000),
    NEWS_SOURCE_SCHEDULER_INFLIGHT_RESCHEDULE_DELAY_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(300_000),
    NEWS_SOURCE_SCHEDULER_JITTER_MAX_MS: z.coerce
      .number()
      .int()
      .nonnegative()
      .default(60_000),
    NEWS_SOURCE_SCHEDULER_MAX_ENQUEUE_PER_TICK: z.coerce
      .number()
      .int()
      .nonnegative()
      .default(100),
    NEWS_SOURCE_SCHEDULER_BACKPRESSURE_MAX_PENDING_JOBS: z.coerce
      .number()
      .int()
      .nonnegative()
      .default(100),
    NEWS_SOURCE_SCHEDULER_BACKPRESSURE_DELAY_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(300_000),
    NEWS_SOURCE_SCHEDULER_FAILURE_RECOVERY_DELAY_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(600_000),
    NEWS_SOURCE_SCHEDULER_FAILURE_MAX_DELAY_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(21_600_000),
    NEWS_SOURCE_SCHEDULER_CIRCUIT_BREAKER_THRESHOLD: z.coerce
      .number()
      .int()
      .nonnegative()
      .default(3),
    NEWS_SOURCE_SCHEDULER_CIRCUIT_BREAKER_BASE_DELAY_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(3_600_000),
    NEWS_SOURCE_SCHEDULER_CIRCUIT_BREAKER_MAX_DELAY_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(86_400_000),
    NEWS_SOURCE_SCHEDULER_AUTO_DISABLE_THRESHOLD: z.coerce
      .number()
      .int()
      .nonnegative()
      .default(0),
    NEWS_SOURCE_CRAWL_QUALITY_PROFILE: z
      .enum(["balanced", "quality_first", "speed_first"])
      .default("quality_first"),
    NEWS_SOURCE_CRAWL_AUTO_EXPAND_DETAILS: envBoolean.default(true),
    NEWS_SOURCE_CRAWL_DETAIL_MAX_URLS: z.coerce
      .number()
      .int()
      .positive()
      .default(12),
    NEWS_SOURCE_CRAWL_DETAIL_MIN_RELEVANCE_SCORE: z.coerce
      .number()
      .min(0)
      .max(1)
      .default(0.35),
    NEWS_SOURCE_CRAWL_DETAIL_REQUIRE_SAME_DOMAIN: envBoolean.default(true),
    ALERT_QUEUE_CONCURRENCY: z.coerce.number().int().positive().default(4),
    ALERT_WEBHOOK_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
    ALERT_MAX_RETRIES: z.coerce.number().int().positive().default(3),
    ALERT_SCAN_INTERVAL_MS: z.coerce.number().int().positive().default(300_000),
    ALERT_NOTIFY_GLOBAL_PER_SECOND: z.coerce
      .number()
      .int()
      .nonnegative()
      .default(10),
    ALERT_NOTIFY_EMAIL_PER_SECOND: z.coerce
      .number()
      .int()
      .nonnegative()
      .default(2),
    ALERT_NOTIFY_WEBHOOK_PER_SECOND: z.coerce
      .number()
      .int()
      .nonnegative()
      .default(10),
    ALERT_NOTIFY_PER_CHANNEL_PER_SECOND: z.coerce
      .number()
      .int()
      .nonnegative()
      .default(2),
    ALERT_NOTIFY_LIMITER_TTL_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(60_000),
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
    GEO_GEOCODE_RATE_LIMIT_PER_SECOND: z.coerce
      .number()
      .int()
      .positive()
      .default(1),
    ANALYSIS_QUEUE_CONCURRENCY: z.coerce.number().int().positive().default(2),
    ANALYSIS_MAX_RETRIES: z.coerce.number().int().positive().default(3),
    ANALYSIS_AUTOTRIGGER_ENABLED: envBoolean.default(false),
    ASSISTANT_QUEUE_CONCURRENCY: z.coerce.number().int().positive().default(2),
    ASSISTANT_MAX_RETRIES: z.coerce.number().int().positive().default(3),
    ASSISTANT_LLM_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(300_000),
    ASSISTANT_STREAM_FLUSH_CHARS: z.coerce
      .number()
      .int()
      .positive()
      .default(80),
    ASSISTANT_STREAM_FLUSH_MS: z.coerce
      .number()
      .int()
      .nonnegative()
      .default(250),
    ASSISTANT_GUARDRAILS_ENABLED: envBoolean.default(true),
    ASSISTANT_GUARDRAILS: z.preprocess(
      (value) =>
        typeof value === "string" && value.trim() === "" ? undefined : value,
      z.string().default("openai-moderation-pre"),
    ),
    OTEL_ENABLED: envBoolean.default(false),
    OTEL_SERVICE_NAME: z.string().min(1).default("modular-api"),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.preprocess(
      (value) =>
        typeof value === "string" && value.trim() === "" ? undefined : value,
      z.string().url().optional(),
    ),
    OTEL_TRACE_SAMPLE_RATE: z.coerce
      .number()
      .min(0)
      .max(1)
      .default(0.05),
    METRICS_DEFAULT_BUCKETS: z.string().optional(),
    SYSTEM_SETTINGS_ENCRYPTION_KEY: z.string().optional(),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),
    S3_REGION: z.string().default("us-east-1"),
    S3_BUCKET: z.string().optional(),
    S3_ENDPOINT: z.preprocess(
      (value) =>
        typeof value === "string" && value.trim() === "" ? undefined : value,
      z.string().url().optional(),
    ),
    S3_PUBLIC_BASE_URL: z.preprocess(
      (value) =>
        typeof value === "string" && value.trim() === "" ? undefined : value,
      z.string().url().optional(),
    ),
    S3_FORCE_PATH_STYLE: envBoolean.default(false),
    S3_PRESIGNED_URL_TTL_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .default(300),
  })
  .superRefine((value, ctx) => {
    for (const key of getMissingMysqlConnectionEnvVars(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `${key} is required when DATABASE_URL is not set`,
      });
    }
  });

export type ApiEnv = z.infer<typeof apiEnvSchema>;
