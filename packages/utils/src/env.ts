import { config as loadDotenv } from "dotenv";
import { z } from "zod";

import { createLogger } from "./logger";

const optionalNonEmptyString = z.preprocess((value) => {
  if (typeof value !== "string") {
    return value;
  }
  const normalized = value.trim();
  return normalized === "" ? undefined : normalized;
}, z.string().min(1).optional());

const optionalPositiveIntFromEnv = z.preprocess((value) => {
  if (typeof value === "string" && value.trim() === "") {
    return undefined;
  }
  return value;
}, z.coerce.number().int().positive().optional());

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

const MYSQL_CONNECTION_ENV_KEYS = [
  "MYSQL_HOST",
  "MYSQL_PORT",
  "MYSQL_USER",
  "MYSQL_PASSWORD",
  "MYSQL_DB",
] as const;

export type MysqlConnectionEnvKey = (typeof MYSQL_CONNECTION_ENV_KEYS)[number];

export interface MysqlConnectionEnvLike {
  DATABASE_URL?: string | null;
  MYSQL_HOST?: string | null;
  MYSQL_PORT?: number | string | null;
  MYSQL_USER?: string | null;
  MYSQL_PASSWORD?: string | null;
  MYSQL_DB?: string | null;
}

function readOptionalEnvString(
  value: string | null | undefined,
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized === "" ? undefined : normalized;
}

export function getMissingMysqlConnectionEnvVars(
  env: MysqlConnectionEnvLike,
): MysqlConnectionEnvKey[] {
  if (readOptionalEnvString(env.DATABASE_URL)) {
    return [];
  }

  return MYSQL_CONNECTION_ENV_KEYS.filter((key) => {
    const value = env[key];
    if (key === "MYSQL_PORT") {
      if (typeof value === "number") {
        return !Number.isFinite(value);
      }
      return !readOptionalEnvString(
        typeof value === "string" ? value : undefined,
      );
    }

    return !readOptionalEnvString(
      typeof value === "string" ? value : undefined,
    );
  });
}

export function resolveMysqlConnectionString(
  env: MysqlConnectionEnvLike,
): string {
  const databaseUrl = readOptionalEnvString(env.DATABASE_URL);
  if (databaseUrl) {
    return databaseUrl;
  }

  const missingVars = getMissingMysqlConnectionEnvVars(env);
  if (missingVars.length > 0) {
    throw new Error(
      `Missing required MySQL env vars: ${missingVars.join(", ")}. Set DATABASE_URL or all MYSQL_* values.`,
    );
  }

  const host = readOptionalEnvString(env.MYSQL_HOST);
  const user = readOptionalEnvString(env.MYSQL_USER);
  const password = readOptionalEnvString(env.MYSQL_PASSWORD);
  const dbName = readOptionalEnvString(env.MYSQL_DB);
  const port =
    typeof env.MYSQL_PORT === "number"
      ? env.MYSQL_PORT
      : Number.parseInt(readOptionalEnvString(env.MYSQL_PORT) ?? "", 10);

  if (!host || !user || !password || !dbName || !Number.isFinite(port)) {
    throw new Error("Invalid MySQL environment configuration");
  }

  return `mysql://${user}:${encodeURIComponent(password)}@${host}:${port}/${dbName}`;
}

export const baseEnvSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  DATABASE_URL: optionalNonEmptyString,
  MYSQL_HOST: optionalNonEmptyString,
  MYSQL_PORT: optionalPositiveIntFromEnv,
  MYSQL_USER: optionalNonEmptyString,
  MYSQL_PASSWORD: optionalNonEmptyString,
  MYSQL_DB: optionalNonEmptyString,
  MONGO_URI: z
    .string()
    .url()
    .or(z.string().regex(/^mongodb/)),
  REDIS_HOST: z.string().min(1),
  REDIS_PORT: z.coerce.number().int().positive(),
  SMTP_HOST: z.string().min(1).default("smtp.163.com"),
  SMTP_PORT: z.coerce.number().int().positive().default(465),
  SMTP_SECURE: envBoolean.default(true),
  SMTP_USER: z.string().email(),
  SMTP_PASS: z.string().min(1),
  SMTP_FROM: z.string().min(1).optional(),
  SMTP_POOL: envBoolean.default(false),
  SMTP_MAX_CONNECTIONS: z.coerce.number().int().positive().default(5),
  SMTP_MAX_MESSAGES: z.coerce.number().int().positive().default(100),
  SMTP_RATE_DELTA_MS: z.coerce.number().int().positive().default(1_000),
  SMTP_RATE_LIMIT: z.coerce.number().int().positive().default(10),
  SMTP_CONNECTION_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(10_000),
  SMTP_GREETING_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  SMTP_SOCKET_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  SMTP_TLS_REJECT_UNAUTHORIZED: envBoolean.default(true),
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
  S3_FORCE_PATH_STYLE: envBoolean.optional(),
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
