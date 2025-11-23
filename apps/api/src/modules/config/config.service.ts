import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import { ApiEnv } from "./env.schema";

export interface LiteLlmEnvConfig {
  model: string;
  apiBase: string;
  apiKey?: string;
  timeoutMs: number;
  temperature: number;
  topP: number;
  maxOutputTokens: number;
  maxRetries: number;
  fallbackModels: string[];
  requestsPerMinute: number;
}

export interface NewsPipelineEnvConfig {
  cacheTtlSeconds: number;
  maxInputChars: number;
  configPath: string;
  crawlQueueConcurrency: number;
  processQueueConcurrency: number;
  crawlQueueRateLimit: number;
  processQueueRateLimit: number;
}

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from?: string;
}

@Injectable()
export class EnvService extends ConfigService<ApiEnv> {
  get port() {
    return this.get<number>("PORT", { infer: true }) ?? 4000;
  }

  get redisConfig() {
    return {
      host: this.get<string>("REDIS_HOST", { infer: true }),
      port: this.get<number>("REDIS_PORT", { infer: true }),
      username: this.get<string | undefined>("REDIS_USERNAME", { infer: true }),
      password: undefined,
      db: this.get<number>("REDIS_DB", { infer: true }) ?? 0,
    };
  }

  get jwtConfig() {
    return {
      secret: this.get<string>("JWT_SECRET", { infer: true }),
      issuer: this.get<string>("JWT_ISSUER", { infer: true }),
      audience: this.get<string>("JWT_AUDIENCE", { infer: true }),
      accessExpiresIn: this.get<string>("JWT_ACCESS_EXPIRES_IN", {
        infer: true,
      }),
      refreshExpiresIn: this.get<string>("JWT_REFRESH_EXPIRES_IN", {
        infer: true,
      }),
    };
  }

  get bullmqConfig() {
    return {
      namespace: this.get<string>("BULLMQ_NAMESPACE", { infer: true }),
      connection: this.redisConfig,
    };
  }

  get rateLimit() {
    return {
      login: this.get<number>("RATE_LIMIT_LOGIN", { infer: true }) ?? 5,
      loginWindowSeconds:
        this.get<number>("RATE_LIMIT_LOGIN_WINDOW", { infer: true }) ?? 60,
      crawlTaskCreate:
        this.get<number>("RATE_LIMIT_CRAWL_TASK_CREATE", { infer: true }) ?? 10,
      crawlTaskCreateWindowSeconds:
        this.get<number>("RATE_LIMIT_CRAWL_TASK_CREATE_WINDOW", {
          infer: true,
        }) ?? 300,
      rbacWrite:
        this.get<number>("RATE_LIMIT_RBAC_WRITE", { infer: true }) ?? 20,
      rbacWriteWindowSeconds:
        this.get<number>("RATE_LIMIT_RBAC_WRITE_WINDOW", {
          infer: true,
        }) ?? 600,
    };
  }

  get auditLogRetentionDays() {
    return this.get<number>("AUDIT_LOG_RETENTION_DAYS", { infer: true }) ?? 90;
  }

  get graphqlConfig() {
    return {
      playground:
        this.get<boolean>("GRAPHQL_PLAYGROUND", { infer: true }) ?? false,
      introspection:
        this.get<boolean>("GRAPHQL_INTROSPECTION", { infer: true }) ?? false,
      depthLimit: this.get<number>("GRAPHQL_DEPTH_LIMIT", { infer: true }) ?? 8,
      complexityLimit:
        this.get<number>("GRAPHQL_COMPLEXITY_LIMIT", { infer: true }) ?? 2000,
      corsOrigin: this.get<string | undefined>("CORS_ORIGIN", { infer: true }),
    };
  }

  get crawl4aiConfig() {
    return {
      baseUrl: this.get<string>("CRAWL4AI_BASE_URL", { infer: true }),
      apiKey: this.get<string | undefined>("CRAWL4AI_API_KEY", { infer: true }),
      timeoutMs:
        this.get<number>("CRAWL4AI_TIMEOUT_MS", { infer: true }) ?? 120_000,
      maxConcurrency:
        this.get<number>("CRAWL4AI_MAX_CONCURRENCY", { infer: true }) ?? 3,
      maxRetries:
        this.get<number>("CRAWL4AI_MAX_RETRIES", { infer: true }) ?? 3,
      healthCheckTtlMs:
        this.get<number>("CRAWL4AI_HEALTH_CHECK_TTL_MS", { infer: true }) ?? 60_000,
      retryBackoffMs:
        this.get<number>("CRAWL4AI_RETRY_BACKOFF_MS", { infer: true }) ?? 5_000,
      media: {
        fetchTimeoutMs:
          this.get<number>("CRAWL_MEDIA_FETCH_TIMEOUT_MS", { infer: true }) ??
          15_000,
        maxBytes:
          this.get<number>("CRAWL_MEDIA_MAX_BYTES", { infer: true }) ??
          2_097_152,
        maxPerResult:
          this.get<number>("CRAWL_MEDIA_MAX_PER_RESULT", { infer: true }) ?? 6,
      },
    };
  }

  get liteLlmConfig(): LiteLlmEnvConfig {
    const fallbackModels = (
      this.get<string>("LITELLM_FALLBACK_MODELS", { infer: true }) ?? ""
    )
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    const apiBase =
      this.get<string>("LITELLM_API_URL", { infer: true }) ??
      this.get<string>("LITELLM_API_BASE", { infer: true }) ??
      "http://localhost:4001";
    const maxTokens =
      this.get<number>("LITELLM_MAX_TOKENS", { infer: true }) ??
      this.get<number>("LITELLM_MAX_OUTPUT_TOKENS", { infer: true }) ??
      1_200;
    const retryAttempts =
      this.get<number>("LITELLM_RETRY_ATTEMPTS", { infer: true }) ??
      this.get<number>("LITELLM_MAX_RETRIES", { infer: true }) ??
      3;
    return {
      model:
        this.get<string>("LITELLM_MODEL", { infer: true }) ??
        "openai/gpt-4o-mini",
      apiBase,
      apiKey: this.get<string | undefined>("LITELLM_API_KEY", { infer: true }),
      timeoutMs:
        this.get<number>("LITELLM_TIMEOUT_MS", { infer: true }) ?? 60_000,
      temperature:
        this.get<number>("LITELLM_TEMPERATURE", { infer: true }) ?? 0.2,
      topP: this.get<number>("LITELLM_TOP_P", { infer: true }) ?? 0.9,
      maxOutputTokens: maxTokens,
      maxRetries: retryAttempts,
      fallbackModels,
      requestsPerMinute:
        this.get<number>("LITELLM_REQUESTS_PER_MINUTE", { infer: true }) ?? 60,
    };
  }

  get newsPipelineEnv(): NewsPipelineEnvConfig {
    return {
      cacheTtlSeconds:
        this.get<number>("NEWS_PIPELINE_CACHE_TTL_SECONDS", { infer: true }) ??
        3_600,
      maxInputChars:
        this.get<number>("NEWS_PIPELINE_MAX_INPUT_CHARS", { infer: true }) ??
        48_000,
      configPath:
        this.get<string>("NEWS_PIPELINE_CONFIG_PATH", { infer: true }) ??
        "config/news-pipeline.config.yaml",
      crawlQueueConcurrency:
        this.get<number>("NEWS_CRAWL_QUEUE_CONCURRENCY", { infer: true }) ?? 4,
      processQueueConcurrency:
        this.get<number>("NEWS_PROCESS_QUEUE_CONCURRENCY", { infer: true }) ??
        8,
      crawlQueueRateLimit:
        this.get<number>("NEWS_CRAWL_QUEUE_RATE_LIMIT", { infer: true }) ?? 5,
      processQueueRateLimit:
        this.get<number>("NEWS_PROCESS_QUEUE_RATE_LIMIT", { infer: true }) ??
        12,
    };
  }

  get akshareConfig() {
    return {
      baseUrl:
        this.get<string>("AKSHARE_HTTP_BASE_URL", { infer: true }) ??
        "http://localhost:8081",
      timeoutMs:
        this.get<number>("AKSHARE_HTTP_TIMEOUT_MS", { infer: true }) ?? 20_000,
      maxRetries:
        this.get<number>("AKSHARE_HTTP_MAX_RETRIES", { infer: true }) ?? 3,
      queueConcurrency:
        this.get<number>("AKSHARE_QUEUE_CONCURRENCY", { infer: true }) ?? 2,
    };
  }

  get alertingConfig() {
    return {
      queueConcurrency:
        this.get<number>("ALERT_QUEUE_CONCURRENCY", { infer: true }) ?? 4,
      webhookTimeoutMs:
        this.get<number>("ALERT_WEBHOOK_TIMEOUT_MS", { infer: true }) ?? 5_000,
      maxRetries: this.get<number>("ALERT_MAX_RETRIES", { infer: true }) ?? 3,
      scanIntervalMs:
        this.get<number>("ALERT_SCAN_INTERVAL_MS", { infer: true }) ?? 300_000,
    };
  }

  get analysisConfig() {
    return {
      queueConcurrency:
        this.get<number>("ANALYSIS_QUEUE_CONCURRENCY", { infer: true }) ?? 2,
      maxRetries:
        this.get<number>("ANALYSIS_MAX_RETRIES", { infer: true }) ?? 3,
      autoTriggerEnabled:
        this.get<boolean>("ANALYSIS_AUTOTRIGGER_ENABLED", { infer: true }) ?? false,
    };
  }

  get smtpConfig(): SmtpConfig {
    const host = this.getOrThrow<string>("SMTP_HOST", { infer: true });
    const port = this.getOrThrow<number>("SMTP_PORT", { infer: true });
    const secure = this.get<boolean>("SMTP_SECURE", { infer: true }) ?? true;
    const user = this.getOrThrow<string>("SMTP_USER", { infer: true });
    const pass = this.getOrThrow<string>("SMTP_PASS", { infer: true });
    const from = this.get<string | undefined>("SMTP_FROM", { infer: true });
    return {
      host,
      port,
      secure,
      user,
      pass,
      from: from ?? user,
    };
  }
}
