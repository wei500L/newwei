import { Module } from "@nestjs/common";
import { HttpModule } from "@nestjs/axios";
import { TerminusModule } from "@nestjs/terminus";

import { CacheModule } from "../cache/cache.module";
import { DatabaseModule } from "../config/database.module";
import { EnvService } from "../config/config.service";
import { HealthController } from "./health.controller";
import { Crawl4aiHealthIndicator } from "./crawl4ai.health";
import { MongoHealthIndicator } from "./mongo.health";
import { RedisHealthIndicator } from "./redis.health";

@Module({
  imports: [
    DatabaseModule,
    CacheModule,
    TerminusModule,
    HttpModule.registerAsync({
      inject: [EnvService],
      useFactory: (env: EnvService) => {
        const cfg = env.crawl4aiConfig;
        return {
          baseURL: cfg.baseUrl.replace(/\/$/, ""),
          timeout: Math.min(1500, cfg.timeoutMs),
          headers: cfg.apiKey
            ? {
                "x-api-key": cfg.apiKey
              }
            : undefined
        };
      }
    })
  ],
  controllers: [HealthController],
  providers: [RedisHealthIndicator, Crawl4aiHealthIndicator, MongoHealthIndicator]
})
export class HealthModule {}
