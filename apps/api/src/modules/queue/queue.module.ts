import { getQueueToken } from "@nestjs/bull-shared";
import { Module } from "@nestjs/common";
import { Queue, QueueEvents } from "bullmq";

import { AuthModule } from "../auth/auth.module";
import { CacheModule } from "../cache/cache.module";
import { EnvService } from "../config/config.service";
import { CrawlModule } from "../crawl/crawl.module";
import { NewsPipelineModule } from "../news-pipeline/news-pipeline.module";

import { NewsSourceSchedulerService } from "./news-source.scheduler.service";
import { QueueCleanupService } from "./queue-cleanup.service";
import { QueueEventPublisher } from "./queue-event.publisher";
import { QueueOrgStatsService } from "./queue-org-stats.service";
import { QueueOrgStatsTracker } from "./queue-org-stats.tracker";
import {
  ITEM_PIPELINE_DLQ_QUEUE_NAME,
  ITEM_PIPELINE_QUEUE_NAME,
  PIPELINE_DLQ_QUEUE,
  PIPELINE_QUEUE,
  PIPELINE_QUEUE_EVENTS,
} from "./queue.constants";
import { QueueGateway } from "./queue.gateway";
import { QueueProcessor } from "./queue.processor";
import { QueueService } from "./queue.service";

@Module({
  imports: [CacheModule, CrawlModule, NewsPipelineModule, AuthModule],
  providers: [
    {
      provide: PIPELINE_QUEUE,
      inject: [EnvService, QueueCleanupService],
      useFactory: (env: EnvService, cleanup: QueueCleanupService) => {
        const config = env.bullmqConfig;
        const queue = new Queue(ITEM_PIPELINE_QUEUE_NAME, {
          connection: {
            host: config.connection.host,
            port: config.connection.port,
            username: config.connection.username,
            db: config.connection.db,
          },
          defaultJobOptions: {
            removeOnComplete: {
              age: 3600,
              count: 1000,
            },
            removeOnFail: false,
            attempts: 5,
            backoff: {
              type: "exponential",
              delay: 1000,
            },
          },
        });
        cleanup.track(queue);
        return queue;
      }
    },
    {
      provide: PIPELINE_DLQ_QUEUE,
      inject: [EnvService, QueueCleanupService],
      useFactory: (env: EnvService, cleanup: QueueCleanupService) => {
        const config = env.bullmqConfig;
        const queue = new Queue(ITEM_PIPELINE_DLQ_QUEUE_NAME, {
          connection: {
            host: config.connection.host,
            port: config.connection.port,
            username: config.connection.username,
            db: config.connection.db,
          },
          defaultJobOptions: {
            removeOnComplete: {
              age: 3600 * 24 * 7,
              count: 10_000,
            },
            removeOnFail: false,
            attempts: 1,
          },
        });
        cleanup.track(queue);
        return queue;
      },
    },
    {
      provide: PIPELINE_QUEUE_EVENTS,
      inject: [EnvService, QueueCleanupService],
      useFactory: (env: EnvService, cleanup: QueueCleanupService) => {
        const config = env.bullmqConfig;
        const events = new QueueEvents(ITEM_PIPELINE_QUEUE_NAME, {
          connection: {
            host: config.connection.host,
            port: config.connection.port,
            username: config.connection.username,
            db: config.connection.db
          }
        });
        cleanup.track(events);
        return events;
      }
    },
    {
      provide: getQueueToken(ITEM_PIPELINE_QUEUE_NAME),
      useExisting: PIPELINE_QUEUE
    },
    {
      provide: getQueueToken(ITEM_PIPELINE_DLQ_QUEUE_NAME),
      useExisting: PIPELINE_DLQ_QUEUE,
    },
    QueueProcessor,
    QueueService,
    QueueEventPublisher,
    QueueCleanupService,
    QueueOrgStatsService,
    QueueOrgStatsTracker,
    QueueGateway,
    NewsSourceSchedulerService
  ],
  exports: [
    QueueService,
    QueueEventPublisher,
    PIPELINE_QUEUE,
    PIPELINE_DLQ_QUEUE,
    PIPELINE_QUEUE_EVENTS,
    getQueueToken(ITEM_PIPELINE_QUEUE_NAME),
    getQueueToken(ITEM_PIPELINE_DLQ_QUEUE_NAME),
  ],
})
export class QueueModule {}
