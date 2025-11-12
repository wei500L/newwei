import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ApiEnv } from "./env.schema";

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
      db: this.get<number>("REDIS_DB", { infer: true }) ?? 0
    };
  }

  get jwtConfig() {
    return {
      secret: this.get<string>("JWT_SECRET", { infer: true }),
      issuer: this.get<string>("JWT_ISSUER", { infer: true }),
      audience: this.get<string>("JWT_AUDIENCE", { infer: true }),
      accessExpiresIn: this.get<string>("JWT_ACCESS_EXPIRES_IN", { infer: true }),
      refreshExpiresIn: this.get<string>("JWT_REFRESH_EXPIRES_IN", { infer: true })
    };
  }

  get bullmqConfig() {
    return {
      namespace: this.get<string>("BULLMQ_NAMESPACE", { infer: true }),
      connection: this.redisConfig
    };
  }

  get rateLimit() {
    return {
      login: this.get<number>("RATE_LIMIT_LOGIN", { infer: true }) ?? 5,
      loginWindowSeconds: this.get<number>("RATE_LIMIT_LOGIN_WINDOW", { infer: true }) ?? 60
    };
  }

  get graphqlConfig() {
    return {
      playground: this.get<boolean>("GRAPHQL_PLAYGROUND", { infer: true }) ?? false,
      introspection: this.get<boolean>("GRAPHQL_INTROSPECTION", { infer: true }) ?? false,
      depthLimit: this.get<number>("GRAPHQL_DEPTH_LIMIT", { infer: true }) ?? 8,
      complexityLimit: this.get<number>("GRAPHQL_COMPLEXITY_LIMIT", { infer: true }) ?? 2000,
      corsOrigin: this.get<string | undefined>("CORS_ORIGIN", { infer: true })
    };
  }

  get crawl4aiConfig() {
    return {
      baseUrl: this.get<string>("CRAWL4AI_BASE_URL", { infer: true }),
      apiKey: this.get<string | undefined>("CRAWL4AI_API_KEY", { infer: true }),
      timeoutMs: this.get<number>("CRAWL4AI_TIMEOUT_MS", { infer: true }) ?? 120_000,
      maxConcurrency: this.get<number>("CRAWL4AI_MAX_CONCURRENCY", { infer: true }) ?? 3,
      maxRetries: this.get<number>("CRAWL4AI_MAX_RETRIES", { infer: true }) ?? 3,
      media: {
        fetchTimeoutMs: this.get<number>("CRAWL_MEDIA_FETCH_TIMEOUT_MS", { infer: true }) ?? 15_000,
        maxBytes: this.get<number>("CRAWL_MEDIA_MAX_BYTES", { infer: true }) ?? 2_097_152,
        maxPerResult: this.get<number>("CRAWL_MEDIA_MAX_PER_RESULT", { infer: true }) ?? 6
      }
    };
  }
}
