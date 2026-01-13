"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.baseEnvSchema = void 0;
exports.loadAndValidateEnv = loadAndValidateEnv;
const dotenv_1 = require("dotenv");
const zod_1 = require("zod");
const logger_1 = require("./logger");
exports.baseEnvSchema = zod_1.z.object({
    NODE_ENV: zod_1.z
        .enum(["development", "test", "production"])
        .default("development"),
    MYSQL_HOST: zod_1.z.string().min(1),
    MYSQL_PORT: zod_1.z.coerce.number().int().positive(),
    MYSQL_USER: zod_1.z.string().min(1),
    MYSQL_PASSWORD: zod_1.z.string().min(1),
    MYSQL_DB: zod_1.z.string().min(1),
    MONGO_URI: zod_1.z
        .string()
        .url()
        .or(zod_1.z.string().regex(/^mongodb/)),
    REDIS_HOST: zod_1.z.string().min(1),
    REDIS_PORT: zod_1.z.coerce.number().int().positive(),
    SMTP_HOST: zod_1.z.string().min(1).default("smtp.163.com"),
    SMTP_PORT: zod_1.z.coerce.number().int().positive().default(465),
    SMTP_SECURE: zod_1.z.coerce.boolean().default(true),
    SMTP_USER: zod_1.z.string().email(),
    SMTP_PASS: zod_1.z.string().min(1),
    SMTP_FROM: zod_1.z.string().min(1).optional(),
    JWT_SECRET: zod_1.z.string().min(16),
    NEXTAUTH_SECRET: zod_1.z.string().min(16),
    NEXTAUTH_URL: zod_1.z.string().url(),
    API_BASE_URL: zod_1.z.string().url(),
    CRAWL4AI_BASE_URL: zod_1.z.string().url(),
    CRAWL4AI_API_KEY: zod_1.z.string().optional(),
    CRAWL4AI_TIMEOUT_MS: zod_1.z.coerce.number().int().positive().default(120_000),
    CRAWL4AI_MAX_CONCURRENCY: zod_1.z.coerce.number().int().positive().default(3),
    CRAWL4AI_MAX_RETRIES: zod_1.z.coerce.number().int().positive().default(3),
    CRAWL_MEDIA_FETCH_TIMEOUT_MS: zod_1.z.coerce
        .number()
        .int()
        .positive()
        .default(15_000),
    CRAWL_MEDIA_MAX_BYTES: zod_1.z.coerce.number().int().positive().default(2_097_152),
    CRAWL_MEDIA_MAX_PER_RESULT: zod_1.z.coerce.number().int().positive().default(6),
    LITELLM_MODEL: zod_1.z.string().min(1).default("openai/gpt-4o-mini"),
    LITELLM_API_BASE: zod_1.z.string().url().default("http://localhost:4001"),
    LITELLM_API_KEY: zod_1.z.string().optional(),
    LITELLM_TIMEOUT_MS: zod_1.z.coerce.number().int().positive().default(60_000),
    LITELLM_TEMPERATURE: zod_1.z.coerce.number().min(0).max(2).default(0.2),
    LITELLM_TOP_P: zod_1.z.coerce.number().min(0).max(1).default(0.9),
    LITELLM_MAX_OUTPUT_TOKENS: zod_1.z.coerce.number().int().positive().default(1_200),
    LITELLM_MAX_RETRIES: zod_1.z.coerce.number().int().positive().default(3),
    LITELLM_FALLBACK_MODELS: zod_1.z.string().optional(),
    LITELLM_REQUESTS_PER_MINUTE: zod_1.z.coerce.number().int().positive().default(60),
    AKSHARE_HTTP_BASE_URL: zod_1.z.string().url().default("http://localhost:8081"),
    AKSHARE_HTTP_TIMEOUT_MS: zod_1.z.coerce.number().int().positive().default(20000),
    AKSHARE_HTTP_MAX_RETRIES: zod_1.z.coerce.number().int().positive().default(3),
    AKSHARE_QUEUE_CONCURRENCY: zod_1.z.coerce.number().int().positive().default(2),
    NEWS_PIPELINE_CACHE_TTL_SECONDS: zod_1.z.coerce
        .number()
        .int()
        .positive()
        .default(3_600),
    NEWS_PIPELINE_MAX_INPUT_CHARS: zod_1.z.coerce
        .number()
        .int()
        .positive()
        .default(48_000),
    NEWS_PIPELINE_CONFIG_PATH: zod_1.z
        .string()
        .default("config/news-pipeline.config.yaml"),
    SYSTEM_SETTINGS_ENCRYPTION_KEY: zod_1.z.string().optional(),
    S3_ACCESS_KEY_ID: zod_1.z.string().optional(),
    S3_SECRET_ACCESS_KEY: zod_1.z.string().optional(),
    S3_REGION: zod_1.z.string().optional(),
    S3_BUCKET: zod_1.z.string().optional(),
    S3_ENDPOINT: zod_1.z.preprocess((value) => (typeof value === "string" && value.trim() === "" ? undefined : value), zod_1.z.string().url().optional()),
    S3_PUBLIC_BASE_URL: zod_1.z.preprocess((value) => (typeof value === "string" && value.trim() === "" ? undefined : value), zod_1.z.string().url().optional()),
    S3_FORCE_PATH_STYLE: zod_1.z.coerce.boolean().optional(),
    S3_PRESIGNED_URL_TTL_SECONDS: zod_1.z.coerce.number().int().positive().optional(),
});
function loadAndValidateEnv(schema, options = {}) {
    const logger = (0, logger_1.createLogger)({ name: "env" });
    if (options.dotenvPath) {
        (0, dotenv_1.config)({ path: options.dotenvPath });
    }
    else {
        (0, dotenv_1.config)();
    }
    const parsed = schema.safeParse(process.env);
    if (!parsed.success) {
        logger.error({
            errors: parsed.error.flatten().fieldErrors,
            dotenvPath: options.dotenvPath,
        }, "Invalid environment variables");
        throw new Error("Environment validation failed");
    }
    if (options.overrideProcessEnv) {
        Object.assign(process.env, parsed.data);
    }
    return parsed.data;
}
//# sourceMappingURL=env.js.map
