import { Module } from "@nestjs/common";
import { HttpModule } from "@nestjs/axios";
import { Queue, QueueEvents } from "bullmq";
import { EnvService } from "../config/config.service";
import { CrawlController } from "./crawl.controller";
import { CrawlMetadataService } from "./crawl-metadata.service";
import { Crawl4aiClient } from "./crawl4ai.client";
import { CRAWL_QUEUE, CRAWL_QUEUE_EVENTS, CRAWL_QUEUE_NAME } from "./crawl.constants";
import { CrawlQueueProcessor } from "./crawl.processor";
import type { CrawlJobData } from "./crawl.types";
import { CrawlQueueService } from "./crawl-queue.service";
import { CrawlExecutionService } from "./crawl-execution.service";
import { CrawlTaskService } from "./crawl-task.service";
import { CrawlResultService } from "./crawl-result.service";

@Module({
  imports: [
    HttpModule.registerAsync({
      inject: [EnvService],
      useFactory: (env: EnvService) => {
        const cfg = env.crawl4aiConfig;
        return {
          baseURL: cfg.baseUrl.replace(/\/$/, ""),
          timeout: cfg.timeoutMs,
          headers: cfg.apiKey
            ? {
                "x-api-key": cfg.apiKey
              }
            : undefined
        };
      }
    })
  ],
  controllers: [CrawlController],
  providers: [
    CrawlTaskService,
    CrawlExecutionService,
    CrawlQueueService,
    CrawlResultService,
    CrawlMetadataService,
    Crawl4aiClient,
    CrawlQueueProcessor,
    {
      provide: CRAWL_QUEUE,
      inject: [EnvService],
      useFactory: (env: EnvService) => {
        const redis = env.redisConfig;
        return new Queue<CrawlJobData>(CRAWL_QUEUE_NAME, {
          connection: redis,
          defaultJobOptions: {
            attempts: env.crawl4aiConfig.maxRetries,
            removeOnComplete: true,
            removeOnFail: false,
            backoff: {
              type: "exponential",
              delay: 5_000
            }
          }
        });
      }
    },
    {
      provide: CRAWL_QUEUE_EVENTS,
      inject: [EnvService],
      useFactory: (env: EnvService) => {
        const redis = env.redisConfig;
        return new QueueEvents(CRAWL_QUEUE_NAME, {
          connection: redis
        });
      }
    }
  ],
  exports: [CrawlTaskService, CrawlExecutionService, CrawlResultService, CrawlMetadataService, Crawl4aiClient]
})
export class CrawlModule {}
