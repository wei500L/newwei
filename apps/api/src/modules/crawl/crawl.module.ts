import { HttpModule } from "@nestjs/axios";
import { getQueueToken } from "@nestjs/bull-shared";
import { Module } from "@nestjs/common";
import { Queue, QueueEvents } from "bullmq";

import { EnvService } from "../config/config.service";
import { NotificationsModule } from "../notifications/notifications.module";

import { CrawlCleanupOutboxService } from "./crawl-cleanup-outbox.service";
import { CrawlExecutionService } from "./crawl-execution.service";
import { CrawlMetadataService } from "./crawl-metadata.service";
import { CrawlQueueService } from "./crawl-queue.service";
import { CrawlResultService } from "./crawl-result.service";
import { CrawlSettingsService } from "./crawl-settings.service";
import { CrawlTaskJanitorService } from "./crawl-task-janitor.service";
import { CrawlTaskService } from "./crawl-task.service";
import { CrawlTemplateController } from "./crawl-template.controller";
import { CrawlTemplateService } from "./crawl-template.service";
import { CRAWL_QUEUE, CRAWL_QUEUE_EVENTS, CRAWL_QUEUE_NAME } from "./crawl.constants";
import { CrawlController } from "./crawl.controller";
import { CrawlQueueProcessor } from "./crawl.processor";
import type { CrawlJobData } from "./crawl.types";
import { Crawl4aiClient } from "./crawl4ai.client";
import { NewsSourceController } from "./news-source.controller";
import { NewsSourceService } from "./news-source.service";
import { JsCodeAuditService } from "./services/js-code-audit.service";


@Module({
  imports: [
    NotificationsModule,
    HttpModule.registerAsync({
      inject: [EnvService],
      useFactory: (env: EnvService) => {
        const cfg = env.crawl4aiConfig;
        return {
          baseURL: cfg.baseUrl ? cfg.baseUrl.replace(/\/$/, "") : undefined,
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
  controllers: [CrawlController, NewsSourceController, CrawlTemplateController],
  providers: [
    CrawlSettingsService,
    CrawlTaskService,
    CrawlTaskJanitorService,
    CrawlExecutionService,
    CrawlQueueService,
    CrawlResultService,
    NewsSourceService,
    CrawlTemplateService,
    CrawlCleanupOutboxService,
    CrawlMetadataService,
    JsCodeAuditService,
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
              delay: env.crawl4aiConfig.retryBackoffMs
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
    },
    {
      provide: getQueueToken(CRAWL_QUEUE_NAME),
      useExisting: CRAWL_QUEUE
    }
  ],
  exports: [
    CrawlSettingsService,
    CrawlTaskService,
    CrawlExecutionService,
    CrawlResultService,
    CrawlMetadataService,
    Crawl4aiClient,
    CRAWL_QUEUE,
    CRAWL_QUEUE_EVENTS,
    getQueueToken(CRAWL_QUEUE_NAME)
  ]
})
export class CrawlModule {}
