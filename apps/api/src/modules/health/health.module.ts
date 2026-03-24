import { HttpModule } from "@nestjs/axios";
import { Module } from "@nestjs/common";
import { TerminusModule } from "@nestjs/terminus";

import { CacheModule } from "../cache/cache.module";
import { EnvService } from "../config/config.service";
import { DatabaseModule } from "../config/database.module";
import { CrawlSettingsService } from "../crawl/crawl-settings.service";

import { Crawl4aiHealthIndicator } from "./crawl4ai.health";
import { Crawl4aiSsrfProxyHealthIndicator } from "./crawl4ai-ssrf-proxy.health";
import { HealthController } from "./health.controller";
import { LlmGatewayHealthIndicator } from "./llm-gateway.health";
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
          baseURL: cfg.baseUrl ? cfg.baseUrl.replace(/\/$/, "") : undefined,
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
  providers: [
    RedisHealthIndicator,
    CrawlSettingsService,
    Crawl4aiHealthIndicator,
    Crawl4aiSsrfProxyHealthIndicator,
    MongoHealthIndicator,
    LlmGatewayHealthIndicator,
  ]
})
export class HealthModule {}
