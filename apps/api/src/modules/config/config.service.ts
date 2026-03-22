import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import { ApiEnv } from "./env.schema";

export interface LiteLlmEnvConfig {
  model: string;
  embeddingModel?: string;
  rerankModel?: string;
  rerankFallbackModels: string[];
  apiBase: string;
  apiKey?: string;
  timeoutMs: number;
  temperature: number;
  topP: number;
  maxOutputTokens: number;
  maxRetries: number;
  fallbackModels: string[];
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
  from: string;
  pool: boolean;
  maxConnections: number;
  maxMessages: number;
  rateDeltaMs: number;
  rateLimit: number;
  connectionTimeoutMs: number;
  greetingTimeoutMs: number;
  socketTimeoutMs: number;
  tlsRejectUnauthorized: boolean;
}

export interface AuthEmailCodeConfig {
  ttlSeconds: number;
  cooldownSeconds: number;
  maxAttempts: number;
}

export interface BullBoardConfig {
  username?: string;
  password?: string;
}

export interface CrawlTaskJanitorConfig {
  enabled: boolean;
  runningTimeoutMs: number;
  queuedTimeoutMs: number;
  batchSize: number;
  queueScanLimit: number;
  lockTtlMs: number;
}

export interface NewsSourceSchedulerConfig {
  enabled: boolean;
  batchSize: number;
  lockTtlMs: number;
  inFlightLookbackMs: number;
  inFlightRescheduleDelayMs: number;
  jitterMaxMs: number;
  maxEnqueuePerTick: number;
  backpressureMaxPendingJobs: number;
  backpressureDelayMs: number;
  failureRecoveryDelayMs: number;
  failureMaxDelayMs: number;
  circuitBreakerThreshold: number;
  circuitBreakerBaseDelayMs: number;
  circuitBreakerMaxDelayMs: number;
  autoDisableThreshold: number;
}

export interface WebSocketSecurityConfig {
  maxConnectionsPerUser: number;
  maxConnectionsPerIp: number;
  connectRateLimitPerIp: number;
  connectRateLimitPerUser: number;
  connectRateLimitWindowSeconds: number;
}

export interface WebSocketRedisAdapterConfig {
  enabled: boolean;
  key: string;
}

export interface StorageConfig {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  bucket: string;
  endpoint?: string;
  publicBaseUrl: string;
  forcePathStyle: boolean;
  presignedUrlTtlSeconds: number;
}

export interface VectorServiceConfig {
  enabled: boolean;
  fallbackToMongo: boolean;
  baseUrl?: string;
  token?: string;
  timeoutMs: number;
  maxRetries: number;
}

export interface ItemsSearchRankingConfig {
  rerankEnabled: boolean;
  recallMaxCandidates: number;
  rerankMaxCandidates: number;
  rerankTimeoutMs: number;
  recencyHalfLifeHours: number;
}

export interface ModelServiceConfig {
  enabled: boolean;
  baseUrl?: string;
  internalToken?: string;
  timeoutMs: number;
  maxRetries: number;
}

export interface SituationMonitorTranslationConfig {
  enabled: boolean;
  baseUrl: string;
  timeoutMs: number;
  maxRetries: number;
  fallbackEnabled: boolean;
  fallbackBaseUrl?: string;
}

export interface RealtimeSignalSourceEnvConfig {
  enabled: boolean;
  intervalSec: number;
}

export interface RealtimeSignalsEnvConfig {
  enabled: boolean;
  requestTimeoutMs: number;
  maxRetries: number;
  sources: {
    opensky: RealtimeSignalSourceEnvConfig;
    ais: RealtimeSignalSourceEnvConfig;
    unrest: RealtimeSignalSourceEnvConfig;
    outages: RealtimeSignalSourceEnvConfig;
    keywordSpike: RealtimeSignalSourceEnvConfig;
    pizzint: RealtimeSignalSourceEnvConfig;
    gdeltTension: RealtimeSignalSourceEnvConfig;
    polymarketLeads: RealtimeSignalSourceEnvConfig;
  };
  thresholds: {
    keywordSpikeMinCount: number;
    keywordSpikeMultiplier: number;
    predictionShiftThreshold: number;
    predictionNewsActivityThreshold: number;
  };
  ais: {
    baseUrl?: string;
    sharedSecret?: string;
  };
  opensky: {
    baseUrl?: string;
    tokenUrl?: string;
    clientId?: string;
    clientSecret?: string;
    dailyCreditBudget: number;
    dayIntervalSec: number;
    nightIntervalSec: number;
    dayStartHourHkt: number;
    nightStartHourHkt: number;
    warningRemainingPct: number;
    criticalRemainingPct: number;
  };
  credentials: {
    acledOauthUsername?: string;
    acledOauthPassword?: string;
    acledOauthClientId?: string;
    cloudflareApiToken?: string;
    wingbitsApiKey?: string;
  };
  polymarket: {
    proxyUrl?: string;
  };
}

@Injectable()
export class EnvService extends ConfigService<ApiEnv> {
  get port() {
    return this.get<number>("PORT", { infer: true }) ?? 4000;
  }

  get bullBoardConfig(): BullBoardConfig {
    return {
      username: this.get<string | undefined>("BULL_BOARD_USERNAME", {
        infer: true,
      }),
      password: this.get<string | undefined>("BULL_BOARD_PASSWORD", {
        infer: true,
      }),
    };
  }

  get redisConfig() {
    return {
      host: this.get<string>("REDIS_HOST", { infer: true }),
      port: this.get<number>("REDIS_PORT", { infer: true }),
      username: this.get<string | undefined>("REDIS_USERNAME", { infer: true }),
      password: this.get<string | undefined>("REDIS_PASSWORD", { infer: true }),
      db: this.get<number>("REDIS_DB", { infer: true }) ?? 0,
    };
  }

  get jwtConfig() {
    const secret = this.get<string>("JWT_SECRET", { infer: true });
    if (!secret) {
      throw new Error("JWT_SECRET is required");
    }

    const issuer = this.get<string>("JWT_ISSUER", { infer: true });
    if (!issuer) {
      throw new Error("JWT_ISSUER is required");
    }

    const audience = this.get<string>("JWT_AUDIENCE", { infer: true });
    if (!audience) {
      throw new Error("JWT_AUDIENCE is required");
    }

    const accessExpiresIn = this.get<string>("JWT_ACCESS_EXPIRES_IN", {
      infer: true,
    });
    if (!accessExpiresIn) {
      throw new Error("JWT_ACCESS_EXPIRES_IN is required");
    }

    const refreshExpiresIn = this.get<string>("JWT_REFRESH_EXPIRES_IN", {
      infer: true,
    });
    if (!refreshExpiresIn) {
      throw new Error("JWT_REFRESH_EXPIRES_IN is required");
    }

    return { secret, issuer, audience, accessExpiresIn, refreshExpiresIn };
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

  get observabilityClientExceptionRateLimit() {
    return {
      userLimit:
        this.get<number>("OBSERVABILITY_CLIENT_EXCEPTION_USER_RATE_LIMIT", {
          infer: true,
        }) ?? 30,
      ipLimit:
        this.get<number>("OBSERVABILITY_CLIENT_EXCEPTION_IP_RATE_LIMIT", {
          infer: true,
        }) ?? 120,
      windowSeconds:
        this.get<number>(
          "OBSERVABILITY_CLIENT_EXCEPTION_RATE_LIMIT_WINDOW_SECONDS",
          {
            infer: true,
          },
        ) ?? 60,
    };
  }

  get rateLimitSettingsCacheTtlSeconds() {
    return (
      this.get<number>("RATE_LIMIT_SETTINGS_CACHE_TTL_SECONDS", {
        infer: true,
      }) ?? 60
    );
  }

  get authProfileCacheTtlSeconds() {
    return (
      this.get<number>("AUTH_PROFILE_CACHE_TTL_SECONDS", { infer: true }) ?? 600
    );
  }

  get authProfileCacheLockTtlMs() {
    return (
      this.get<number>("AUTH_PROFILE_CACHE_LOCK_TTL_MS", { infer: true }) ??
      5_000
    );
  }

  get authProfileCacheMaxWaitMs() {
    return (
      this.get<number>("AUTH_PROFILE_CACHE_MAX_WAIT_MS", { infer: true }) ??
      5_000
    );
  }

  get authProfileCacheRetryDelayMs() {
    return (
      this.get<number>("AUTH_PROFILE_CACHE_RETRY_DELAY_MS", { infer: true }) ??
      50
    );
  }

  get authRefreshGraceSeconds() {
    return (
      this.get<number>("AUTH_REFRESH_GRACE_SECONDS", { infer: true }) ?? 10
    );
  }

  get authEmailCodeConfig(): AuthEmailCodeConfig {
    return {
      ttlSeconds:
        this.get<number>("AUTH_EMAIL_CODE_TTL_SECONDS", { infer: true }) ?? 300,
      cooldownSeconds:
        this.get<number>("AUTH_EMAIL_CODE_COOLDOWN_SECONDS", { infer: true }) ??
        90,
      maxAttempts:
        this.get<number>("AUTH_EMAIL_CODE_MAX_ATTEMPTS", { infer: true }) ?? 3,
    };
  }

  get auditLogRetentionDays() {
    return this.get<number>("AUDIT_LOG_RETENTION_DAYS", { infer: true }) ?? 90;
  }

  get taskLogRetentionDays() {
    return this.get<number>("TASK_LOG_RETENTION_DAYS", { infer: true }) ?? 14;
  }

  get graphqlConfig() {
    return {
      playground:
        this.get<boolean>("GRAPHQL_PLAYGROUND", { infer: true }) ?? false,
      introspection:
        this.get<boolean>("GRAPHQL_INTROSPECTION", { infer: true }) ?? false,
      subscriptionsEnabled:
        this.get<boolean>("GRAPHQL_SUBSCRIPTIONS_ENABLED", { infer: true }) ??
        true,
      depthLimit: this.get<number>("GRAPHQL_DEPTH_LIMIT", { infer: true }) ?? 8,
      complexityLimit:
        this.get<number>("GRAPHQL_COMPLEXITY_LIMIT", { infer: true }) ?? 2000,
      corsOrigin: this.get("CORS_ORIGIN", { infer: true }),
    };
  }

  get webSocketSecurity(): WebSocketSecurityConfig {
    return {
      maxConnectionsPerUser:
        this.get<number>("WS_MAX_CONNECTIONS_PER_USER", { infer: true }) ?? 5,
      maxConnectionsPerIp:
        this.get<number>("WS_MAX_CONNECTIONS_PER_IP", { infer: true }) ?? 50,
      connectRateLimitPerIp:
        this.get<number>("WS_CONNECT_RATE_LIMIT_PER_IP", { infer: true }) ?? 60,
      connectRateLimitPerUser:
        this.get<number>("WS_CONNECT_RATE_LIMIT_PER_USER", { infer: true }) ??
        30,
      connectRateLimitWindowSeconds:
        this.get<number>("WS_CONNECT_RATE_LIMIT_WINDOW_SECONDS", {
          infer: true,
        }) ?? 60,
    };
  }

  get webSocketRedisAdapter(): WebSocketRedisAdapterConfig {
    return {
      enabled:
        this.get<boolean>("WS_REDIS_ADAPTER_ENABLED", { infer: true }) ?? true,
      key:
        this.get<string>("WS_REDIS_ADAPTER_KEY", { infer: true }) ??
        "socket.io",
    };
  }

  get systemSettingsEncryptionKey(): string | undefined {
    return this.get<string | undefined>("SYSTEM_SETTINGS_ENCRYPTION_KEY", {
      infer: true,
    });
  }

  get storageConfig(): StorageConfig {
    return {
      accessKeyId: this.get<string>("S3_ACCESS_KEY_ID", { infer: true }) ?? "",
      secretAccessKey:
        this.get<string>("S3_SECRET_ACCESS_KEY", { infer: true }) ?? "",
      region: this.get<string>("S3_REGION", { infer: true }) ?? "us-east-1",
      bucket: this.get<string | undefined>("S3_BUCKET", { infer: true }) ?? "",
      endpoint: this.get<string | undefined>("S3_ENDPOINT", { infer: true }),
      publicBaseUrl:
        this.get<string | undefined>("S3_PUBLIC_BASE_URL", { infer: true }) ??
        "",
      forcePathStyle:
        this.get<boolean>("S3_FORCE_PATH_STYLE", { infer: true }) ?? false,
      presignedUrlTtlSeconds:
        this.get<number>("S3_PRESIGNED_URL_TTL_SECONDS", { infer: true }) ??
        300,
    };
  }

  get vectorServiceConfig(): VectorServiceConfig {
    return {
      enabled:
        this.get<boolean>("VECTOR_SERVICE_ENABLED", { infer: true }) ?? false,
      fallbackToMongo:
        this.get<boolean>("VECTOR_SERVICE_FALLBACK_TO_MONGO", {
          infer: true,
        }) ?? true,
      baseUrl: this.get<string | undefined>("VECTOR_SERVICE_BASE_URL", {
        infer: true,
      }),
      token: this.get<string | undefined>("VECTOR_INTERNAL_TOKEN", {
        infer: true,
      }),
      timeoutMs:
        this.get<number>("VECTOR_SERVICE_TIMEOUT_MS", { infer: true }) ?? 5_000,
      maxRetries:
        this.get<number>("VECTOR_SERVICE_MAX_RETRIES", { infer: true }) ?? 2,
    };
  }

  get modelServiceConfig(): ModelServiceConfig {
    return {
      enabled:
        this.get<boolean>("MODEL_SERVICE_ENABLED", { infer: true }) ?? false,
      baseUrl: this.get<string | undefined>("MODEL_SERVICE_BASE_URL", {
        infer: true,
      }),
      internalToken: this.get<string | undefined>(
        "MODEL_SERVICE_INTERNAL_TOKEN",
        { infer: true },
      ),
      timeoutMs:
        this.get<number>("MODEL_SERVICE_TIMEOUT_MS", { infer: true }) ?? 15_000,
      maxRetries:
        this.get<number>("MODEL_SERVICE_MAX_RETRIES", { infer: true }) ?? 2,
    };
  }

  get situationMonitorTranslationConfig(): SituationMonitorTranslationConfig {
    const rawBaseUrl =
      this.get<string>("SITUATION_MONITOR_TRANSLATION_API_BASE_URL", {
        infer: true,
      }) ?? "https://api.deeplx.org";
    const baseUrl = rawBaseUrl.trim().replace(/\/+$/, "");
    const rawFallbackBaseUrl = this.get<string | undefined>(
      "SITUATION_MONITOR_TRANSLATION_FALLBACK_API_BASE_URL",
    );
    const fallbackBaseUrl =
      typeof rawFallbackBaseUrl === "string"
        ? rawFallbackBaseUrl.trim().replace(/\/+$/, "")
        : undefined;

    return {
      enabled:
        this.get<boolean>("SITUATION_MONITOR_TRANSLATION_API_ENABLED", {
          infer: true,
        }) ?? true,
      baseUrl,
      timeoutMs:
        this.get<number>("SITUATION_MONITOR_TRANSLATION_TIMEOUT_MS", {
          infer: true,
        }) ?? 15_000,
      maxRetries:
        this.get<number>("SITUATION_MONITOR_TRANSLATION_MAX_RETRIES", {
          infer: true,
        }) ?? 2,
      fallbackEnabled:
        this.get<boolean>(
          "SITUATION_MONITOR_TRANSLATION_FALLBACK_API_ENABLED",
          { infer: true },
        ) ?? false,
      fallbackBaseUrl:
        fallbackBaseUrl && fallbackBaseUrl.length > 0
          ? fallbackBaseUrl
          : undefined,
    };
  }

  get realtimeSignalsConfig(): RealtimeSignalsEnvConfig {
    return {
      enabled:
        this.get<boolean>("REALTIME_SIGNALS_ENABLED", { infer: true }) ?? true,
      requestTimeoutMs:
        this.get<number>("REALTIME_SIGNALS_REQUEST_TIMEOUT_MS", {
          infer: true,
        }) ?? 12_000,
      maxRetries:
        this.get<number>("REALTIME_SIGNALS_MAX_RETRIES", { infer: true }) ?? 2,
      sources: {
        opensky: {
          enabled:
            this.get<boolean | undefined>("REALTIME_SIGNALS_OPENSKY_ENABLED", {
              infer: true,
            }) ??
            this.get<boolean | undefined>("REALTIME_SIGNALS_ADSB_ENABLED", {
              infer: true,
            }) ??
            true,
          intervalSec:
            this.get<number | undefined>(
              "REALTIME_SIGNALS_OPENSKY_INTERVAL_SEC",
              {
                infer: true,
              },
            ) ??
            this.get<number | undefined>("REALTIME_SIGNALS_ADSB_INTERVAL_SEC", {
              infer: true,
            }) ??
            900,
        },
        ais: {
          enabled:
            this.get<boolean>("REALTIME_SIGNALS_AIS_ENABLED", {
              infer: true,
            }) ?? true,
          intervalSec:
            this.get<number>("REALTIME_SIGNALS_AIS_INTERVAL_SEC", {
              infer: true,
            }) ?? 600,
        },
        unrest: {
          enabled:
            this.get<boolean>("REALTIME_SIGNALS_UNREST_ENABLED", {
              infer: true,
            }) ?? true,
          intervalSec:
            this.get<number>("REALTIME_SIGNALS_UNREST_INTERVAL_SEC", {
              infer: true,
            }) ?? 600,
        },
        outages: {
          enabled:
            this.get<boolean>("REALTIME_SIGNALS_OUTAGES_ENABLED", {
              infer: true,
            }) ?? true,
          intervalSec:
            this.get<number>("REALTIME_SIGNALS_OUTAGES_INTERVAL_SEC", {
              infer: true,
            }) ?? 600,
        },
        keywordSpike: {
          enabled:
            this.get<boolean>("REALTIME_SIGNALS_KEYWORD_SPIKE_ENABLED", {
              infer: true,
            }) ?? true,
          intervalSec:
            this.get<number>("REALTIME_SIGNALS_KEYWORD_SPIKE_INTERVAL_SEC", {
              infer: true,
            }) ?? 600,
        },
        pizzint: {
          enabled:
            this.get<boolean>("REALTIME_SIGNALS_PIZZINT_ENABLED", {
              infer: true,
            }) ?? true,
          intervalSec:
            this.get<number>("REALTIME_SIGNALS_PIZZINT_INTERVAL_SEC", {
              infer: true,
            }) ?? 600,
        },
        gdeltTension: {
          enabled:
            this.get<boolean>("REALTIME_SIGNALS_GDELT_TENSION_ENABLED", {
              infer: true,
            }) ?? true,
          intervalSec:
            this.get<number>("REALTIME_SIGNALS_GDELT_TENSION_INTERVAL_SEC", {
              infer: true,
            }) ?? 600,
        },
        polymarketLeads: {
          enabled:
            this.get<boolean>("REALTIME_SIGNALS_POLYMARKET_LEADS_ENABLED", {
              infer: true,
            }) ?? true,
          intervalSec:
            this.get<number>("REALTIME_SIGNALS_POLYMARKET_LEADS_INTERVAL_SEC", {
              infer: true,
            }) ?? 600,
        },
      },
      thresholds: {
        keywordSpikeMinCount:
          this.get<number>("REALTIME_SIGNALS_KEYWORD_SPIKE_MIN_COUNT", {
            infer: true,
          }) ?? 5,
        keywordSpikeMultiplier:
          this.get<number>("REALTIME_SIGNALS_KEYWORD_SPIKE_MULTIPLIER", {
            infer: true,
          }) ?? 3,
        predictionShiftThreshold:
          this.get<number>("REALTIME_SIGNALS_PREDICTION_SHIFT_THRESHOLD", {
            infer: true,
          }) ?? 5,
        predictionNewsActivityThreshold:
          this.get<number>(
            "REALTIME_SIGNALS_PREDICTION_NEWS_ACTIVITY_THRESHOLD",
            {
              infer: true,
            },
          ) ?? 3,
      },
      ais: {
        baseUrl:
          this.get<string | undefined>("REALTIME_SIGNALS_AIS_BASE_URL", {
            infer: true,
          }) ??
          this.get<string | undefined>("REALTIME_SIGNALS_RELAY_BASE_URL", {
            infer: true,
          }),
        sharedSecret:
          this.get<string | undefined>("REALTIME_SIGNALS_AIS_SHARED_SECRET", {
            infer: true,
          }) ??
          this.get<string | undefined>("AIS_RELAY_SHARED_SECRET", {
            infer: true,
          }) ??
          this.get<string | undefined>("REALTIME_SIGNALS_RELAY_SHARED_SECRET", {
            infer: true,
          }),
      },
      opensky: {
        baseUrl:
          this.get<string | undefined>("REALTIME_SIGNALS_OPENSKY_BASE_URL", {
            infer: true,
          }) ??
          this.get<string | undefined>("REALTIME_SIGNALS_ADSB_BASE_URL", {
            infer: true,
          }) ??
          "https://opensky-network.org/api",
        tokenUrl:
          this.get<string | undefined>("REALTIME_SIGNALS_OPENSKY_TOKEN_URL", {
            infer: true,
          }) ??
          "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token",
        clientId: this.get<string | undefined>(
          "REALTIME_SIGNALS_OPENSKY_CLIENT_ID",
          {
            infer: true,
          },
        ),
        clientSecret: this.get<string | undefined>(
          "REALTIME_SIGNALS_OPENSKY_CLIENT_SECRET",
          {
            infer: true,
          },
        ),
        dailyCreditBudget:
          this.get<number>("REALTIME_SIGNALS_OPENSKY_DAILY_CREDIT_BUDGET", {
            infer: true,
          }) ?? 4000,
        dayIntervalSec:
          this.get<number>("REALTIME_SIGNALS_OPENSKY_DAY_INTERVAL_SEC", {
            infer: true,
          }) ?? 600,
        nightIntervalSec:
          this.get<number>("REALTIME_SIGNALS_OPENSKY_NIGHT_INTERVAL_SEC", {
            infer: true,
          }) ?? 1800,
        dayStartHourHkt:
          this.get<number>("REALTIME_SIGNALS_OPENSKY_DAY_START_HKT", {
            infer: true,
          }) ?? 8,
        nightStartHourHkt:
          this.get<number>("REALTIME_SIGNALS_OPENSKY_NIGHT_START_HKT", {
            infer: true,
          }) ?? 22,
        warningRemainingPct:
          this.get<number>("REALTIME_SIGNALS_OPENSKY_WARNING_REMAINING_PCT", {
            infer: true,
          }) ?? 20,
        criticalRemainingPct:
          this.get<number>("REALTIME_SIGNALS_OPENSKY_CRITICAL_REMAINING_PCT", {
            infer: true,
          }) ?? 10,
      },
      credentials: {
        acledOauthUsername: this.get<string | undefined>(
          "REALTIME_SIGNALS_ACLED_USERNAME",
          { infer: true },
        ),
        acledOauthPassword: this.get<string | undefined>(
          "REALTIME_SIGNALS_ACLED_PASSWORD",
          { infer: true },
        ),
        acledOauthClientId: this.get<string | undefined>(
          "REALTIME_SIGNALS_ACLED_CLIENT_ID",
          { infer: true },
        ),
        cloudflareApiToken: this.get<string | undefined>(
          "REALTIME_SIGNALS_CLOUDFLARE_API_TOKEN",
          { infer: true },
        ),
        wingbitsApiKey: this.get<string | undefined>(
          "REALTIME_SIGNALS_WINGBITS_API_KEY",
          { infer: true },
        ),
      },
      polymarket: {
        proxyUrl: this.get<string | undefined>(
          "REALTIME_SIGNALS_POLYMARKET_PROXY_URL",
          { infer: true },
        ),
      },
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
        this.get<number>("CRAWL4AI_HEALTH_CHECK_TTL_MS", { infer: true }) ??
        60_000,
      retryBackoffMs:
        this.get<number>("CRAWL4AI_RETRY_BACKOFF_MS", { infer: true }) ?? 5_000,
      ssrfProxyUrl: this.get<string | undefined>("CRAWL4AI_SSRF_PROXY_URL", {
        infer: true,
      }),
      jsCodeEnabled:
        this.get<boolean>("CRAWL4AI_JSCODE_ENABLED", { infer: true }) ?? true,
      jsCodeAuditEnabled:
        this.get<boolean>("CRAWL4AI_JSCODE_AUDIT_ENABLED", { infer: true }) ??
        true,
      jsCodeAuditRetentionDays:
        this.get<number>("CRAWL4AI_JSCODE_AUDIT_RETENTION_DAYS", {
          infer: true,
        }) ?? 90,
      jsCodeMaxLength:
        this.get<number>("CRAWL4AI_JSCODE_MAX_LENGTH", { infer: true }) ?? 2000,
      jsCodeMaxScripts:
        this.get<number>("CRAWL4AI_JSCODE_MAX_SCRIPTS", { infer: true }) ?? 5,
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

  get crawlTaskJanitorConfig(): CrawlTaskJanitorConfig {
    return {
      enabled:
        this.get<boolean>("CRAWL_TASK_JANITOR_ENABLED", { infer: true }) ??
        true,
      runningTimeoutMs:
        this.get<number>("CRAWL_TASK_RUNNING_TIMEOUT_MS", { infer: true }) ??
        1_800_000,
      queuedTimeoutMs:
        this.get<number>("CRAWL_TASK_QUEUED_TIMEOUT_MS", { infer: true }) ??
        43_200_000,
      batchSize:
        this.get<number>("CRAWL_TASK_JANITOR_BATCH_SIZE", { infer: true }) ??
        50,
      queueScanLimit:
        this.get<number>("CRAWL_TASK_JANITOR_QUEUE_SCAN_LIMIT", {
          infer: true,
        }) ?? 5_000,
      lockTtlMs:
        this.get<number>("CRAWL_TASK_JANITOR_LOCK_TTL_MS", { infer: true }) ??
        120_000,
    };
  }

  get liteLlmConfig(): LiteLlmEnvConfig {
    const fallbackModels = (
      this.get<string>("LITELLM_FALLBACK_MODELS", { infer: true }) ?? ""
    )
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    // Rerank backup model routing is persisted in MySQL (LLM gateway profiles),
    // not sourced from environment variables.
    const rerankFallbackModels: string[] = [];
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
      embeddingModel: this.get<string | undefined>("LITELLM_EMBEDDING_MODEL", {
        infer: true,
      }),
      // Rerank model selection is managed by MySQL-backed gateway profiles.
      rerankModel: undefined,
      rerankFallbackModels,
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
    };
  }

  get itemsSearchRankingConfig(): ItemsSearchRankingConfig {
    const recallMaxCandidates =
      this.get<number>("ITEMS_SEARCH_RECALL_MAX_CANDIDATES", { infer: true }) ??
      120;
    const rerankMaxCandidates =
      this.get<number>("ITEMS_SEARCH_RERANK_MAX_CANDIDATES", { infer: true }) ??
      40;
    return {
      rerankEnabled:
        this.get<boolean>("ITEMS_SEARCH_RERANK_ENABLED", { infer: true }) ??
        true,
      recallMaxCandidates,
      rerankMaxCandidates: Math.min(recallMaxCandidates, rerankMaxCandidates),
      rerankTimeoutMs:
        this.get<number>("ITEMS_SEARCH_RERANK_TIMEOUT_MS", { infer: true }) ??
        300,
      recencyHalfLifeHours:
        this.get<number>("ITEMS_SEARCH_RECENCY_HALFLIFE_HOURS", {
          infer: true,
        }) ?? 48,
    };
  }

  get itemsReadModelEnabled(): boolean {
    return this.get<boolean>("ITEMS_READ_MODEL_ENABLED", { infer: true }) ?? false;
  }

  get itemsVectorHardFailEnabled(): boolean {
    return this.get<boolean>("ITEMS_VECTOR_HARD_FAIL_ENABLED", { infer: true }) ?? false;
  }

  get liteLlmConfigInternalToken(): string | undefined {
    return this.get<string | undefined>("LITELLM_CONFIG_INTERNAL_TOKEN", {
      infer: true,
    });
  }

  get liteLlmMasterKey(): string | undefined {
    return this.get<string | undefined>("LITELLM_MASTER_KEY", {
      infer: true,
    });
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

  get newsSourceSchedulerConfig(): NewsSourceSchedulerConfig {
    return {
      enabled:
        this.get<boolean>("NEWS_SOURCE_SCHEDULER_ENABLED", { infer: true }) ??
        true,
      batchSize:
        this.get<number>("NEWS_SOURCE_SCHEDULER_BATCH_SIZE", { infer: true }) ??
        20,
      lockTtlMs:
        this.get<number>("NEWS_SOURCE_SCHEDULER_LOCK_TTL_MS", {
          infer: true,
        }) ?? 120_000,
      inFlightLookbackMs:
        this.get<number>("NEWS_SOURCE_SCHEDULER_INFLIGHT_LOOKBACK_MS", {
          infer: true,
        }) ?? 21_600_000,
      inFlightRescheduleDelayMs:
        this.get<number>("NEWS_SOURCE_SCHEDULER_INFLIGHT_RESCHEDULE_DELAY_MS", {
          infer: true,
        }) ?? 300_000,
      jitterMaxMs:
        this.get<number>("NEWS_SOURCE_SCHEDULER_JITTER_MAX_MS", {
          infer: true,
        }) ?? 60_000,
      maxEnqueuePerTick:
        this.get<number>("NEWS_SOURCE_SCHEDULER_MAX_ENQUEUE_PER_TICK", {
          infer: true,
        }) ?? 100,
      backpressureMaxPendingJobs:
        this.get<number>(
          "NEWS_SOURCE_SCHEDULER_BACKPRESSURE_MAX_PENDING_JOBS",
          { infer: true },
        ) ?? 100,
      backpressureDelayMs:
        this.get<number>("NEWS_SOURCE_SCHEDULER_BACKPRESSURE_DELAY_MS", {
          infer: true,
        }) ?? 300_000,
      failureRecoveryDelayMs:
        this.get<number>("NEWS_SOURCE_SCHEDULER_FAILURE_RECOVERY_DELAY_MS", {
          infer: true,
        }) ?? 600_000,
      failureMaxDelayMs:
        this.get<number>("NEWS_SOURCE_SCHEDULER_FAILURE_MAX_DELAY_MS", {
          infer: true,
        }) ?? 21_600_000,
      circuitBreakerThreshold:
        this.get<number>("NEWS_SOURCE_SCHEDULER_CIRCUIT_BREAKER_THRESHOLD", {
          infer: true,
        }) ?? 3,
      circuitBreakerBaseDelayMs:
        this.get<number>(
          "NEWS_SOURCE_SCHEDULER_CIRCUIT_BREAKER_BASE_DELAY_MS",
          { infer: true },
        ) ?? 3_600_000,
      circuitBreakerMaxDelayMs:
        this.get<number>("NEWS_SOURCE_SCHEDULER_CIRCUIT_BREAKER_MAX_DELAY_MS", {
          infer: true,
        }) ?? 86_400_000,
      autoDisableThreshold:
        this.get<number>("NEWS_SOURCE_SCHEDULER_AUTO_DISABLE_THRESHOLD", {
          infer: true,
        }) ?? 0,
    };
  }

  get akshareConfig() {
    return {
      enabled: this.get<boolean>("AKSHARE_ENABLED", { infer: true }) ?? true,
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

  get akshareAdminToken() {
    return this.get<string | undefined>("AKSHARE_ADMIN_TOKEN", { infer: true });
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
      notifyGlobalPerSecond:
        this.get<number>("ALERT_NOTIFY_GLOBAL_PER_SECOND", { infer: true }) ??
        10,
      notifyEmailPerSecond:
        this.get<number>("ALERT_NOTIFY_EMAIL_PER_SECOND", { infer: true }) ?? 2,
      notifyWebhookPerSecond:
        this.get<number>("ALERT_NOTIFY_WEBHOOK_PER_SECOND", { infer: true }) ??
        10,
      notifyPerChannelPerSecond:
        this.get<number>("ALERT_NOTIFY_PER_CHANNEL_PER_SECOND", {
          infer: true,
        }) ?? 2,
      notifyLimiterTtlMs:
        this.get<number>("ALERT_NOTIFY_LIMITER_TTL_MS", { infer: true }) ??
        60_000,
    };
  }

  get assistantConfig() {
    const guardrails = (
      this.get<string>("ASSISTANT_GUARDRAILS", { infer: true }) ?? ""
    )
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    return {
      queueConcurrency:
        this.get<number>("ASSISTANT_QUEUE_CONCURRENCY", { infer: true }) ?? 2,
      maxRetries:
        this.get<number>("ASSISTANT_MAX_RETRIES", { infer: true }) ?? 3,
      llmTimeoutMs:
        this.get<number>("ASSISTANT_LLM_TIMEOUT_MS", { infer: true }) ??
        300_000,
      streamFlushChars:
        this.get<number>("ASSISTANT_STREAM_FLUSH_CHARS", { infer: true }) ?? 80,
      streamFlushMs:
        this.get<number>("ASSISTANT_STREAM_FLUSH_MS", { infer: true }) ?? 250,
      guardrailsEnabled:
        this.get<boolean>("ASSISTANT_GUARDRAILS_ENABLED", { infer: true }) ??
        true,
      guardrails,
    };
  }

  get analysisConfig() {
    return {
      queueConcurrency:
        this.get<number>("ANALYSIS_QUEUE_CONCURRENCY", { infer: true }) ?? 2,
      maxRetries:
        this.get<number>("ANALYSIS_MAX_RETRIES", { infer: true }) ?? 3,
      autoTriggerEnabled:
        this.get<boolean>("ANALYSIS_AUTOTRIGGER_ENABLED", { infer: true }) ??
        false,
      promptCorrelationSystem: this.get<string | undefined>(
        "ANALYSIS_PROMPT_CORRELATION_SYSTEM",
        {
          infer: true,
        },
      ),
      promptCorrelationUser: this.get<string | undefined>(
        "ANALYSIS_PROMPT_CORRELATION_USER",
        {
          infer: true,
        },
      ),
      promptAnomalySystem: this.get<string | undefined>(
        "ANALYSIS_PROMPT_ANOMALY_SYSTEM",
        {
          infer: true,
        },
      ),
      promptAnomalyUser: this.get<string | undefined>(
        "ANALYSIS_PROMPT_ANOMALY_USER",
        {
          infer: true,
        },
      ),
      promptGeoTransportSystem: this.get<string | undefined>(
        "ANALYSIS_PROMPT_GEO_TRANSPORT_SYSTEM",
        {
          infer: true,
        },
      ),
      promptGeoTransportUser: this.get<string | undefined>(
        "ANALYSIS_PROMPT_GEO_TRANSPORT_USER",
        {
          infer: true,
        },
      ),
      llmTimeoutMs:
        this.get<number>("ANALYSIS_LLM_TIMEOUT_MS", { infer: true }) ?? 300_000,
      streamFlushChars:
        this.get<number>("ANALYSIS_STREAM_FLUSH_CHARS", { infer: true }) ?? 80,
      streamFlushMs:
        this.get<number>("ANALYSIS_STREAM_FLUSH_MS", { infer: true }) ?? 250,
    };
  }

  get smtpConfig(): SmtpConfig {
    const host = this.getOrThrow<string>("SMTP_HOST", { infer: true });
    const port = this.getOrThrow<number>("SMTP_PORT", { infer: true });
    const secure = this.get<boolean>("SMTP_SECURE", { infer: true }) ?? true;
    const user = this.getOrThrow<string>("SMTP_USER", { infer: true });
    const pass = this.getOrThrow<string>("SMTP_PASS", { infer: true });
    const from = this.get<string | undefined>("SMTP_FROM", { infer: true });
    const pool = this.get<boolean>("SMTP_POOL", { infer: true }) ?? false;
    const maxConnections =
      this.get<number>("SMTP_MAX_CONNECTIONS", { infer: true }) ?? 5;
    const maxMessages =
      this.get<number>("SMTP_MAX_MESSAGES", { infer: true }) ?? 100;
    const rateDeltaMs =
      this.get<number>("SMTP_RATE_DELTA_MS", { infer: true }) ?? 1_000;
    const rateLimit =
      this.get<number>("SMTP_RATE_LIMIT", { infer: true }) ?? 10;
    const connectionTimeoutMs =
      this.get<number>("SMTP_CONNECTION_TIMEOUT_MS", { infer: true }) ?? 10_000;
    const greetingTimeoutMs =
      this.get<number>("SMTP_GREETING_TIMEOUT_MS", { infer: true }) ?? 10_000;
    const socketTimeoutMs =
      this.get<number>("SMTP_SOCKET_TIMEOUT_MS", { infer: true }) ?? 30_000;
    const tlsRejectUnauthorized =
      this.get<boolean>("SMTP_TLS_REJECT_UNAUTHORIZED", { infer: true }) ??
      true;
    return {
      host,
      port,
      secure,
      user,
      pass,
      from: from ?? user,
      pool,
      maxConnections,
      maxMessages,
      rateDeltaMs,
      rateLimit,
      connectionTimeoutMs,
      greetingTimeoutMs,
      socketTimeoutMs,
      tlsRejectUnauthorized,
    };
  }
}
