import { Global, Module } from "@nestjs/common";
import Redis from "ioredis";
import { EnvService } from "../config/config.service";
import { CacheService } from "./cache.service";
import { RateLimiterService } from "./rate-limiter.service";

export const REDIS_CLIENT = Symbol("REDIS_CLIENT");

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [EnvService],
      useFactory: (env: EnvService) => {
        const redisConfig = env.redisConfig;
        return new Redis({
          host: redisConfig.host,
          port: redisConfig.port,
          username: redisConfig.username,
          db: redisConfig.db
        });
      }
    },
    CacheService,
    RateLimiterService
  ],
  exports: [CacheService, RateLimiterService, REDIS_CLIENT]
})
export class CacheModule {}
