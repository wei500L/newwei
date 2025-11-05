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
}
