import { getQueueToken } from "@nestjs/bull-shared";
import { Module, forwardRef } from "@nestjs/common";
import { Queue, QueueEvents } from "bullmq";

import {
  BULLMQ_DLQ_JOB_RETENTION,
  BULLMQ_FAILED_JOB_RETENTION,
} from "../../common/bullmq-retention";
import { AuthModule } from "../auth/auth.module";
import { CacheModule } from "../cache/cache.module";
import { EnvService } from "../config/config.service";
import { toBullmqConnection } from "../config/redis-connection";
import { CrawlModule } from "../crawl/crawl.module";
import { NewsPipelineModule } from "../news-pipeline/news-pipeline.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { SystemSettingsModule } from "../system-settings/system-settings.module";

import { NewsSourceDispatchController } from "./news-source-dispatch.controller";
import { NewsSourceOpsController } from "./news-source-ops.controller";
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
  imports: [
    CacheModule,
    CrawlModule,
    NewsPipelineModule,
    NotificationsModule,
    AuthModule,
    forwardRef(() => SystemSettingsModule),
  ],
  controllers: [NewsSourceDispatchController, NewsSourceOpsController],
  providers: [
    {
      provide: PIPELINE_QUEUE,
      inject: [EnvService, QueueCleanupService],
      useFactory: (env: EnvService, cleanup: QueueCleanupService) => {
        const config = env.bullmqConfig;
        const queue = new Queue(ITEM_PIPELINE_QUEUE_NAME, {
          connection: toBullmqConnection(config.connection),
          defaultJobOptions: {
            removeOnComplete: {
              age: 3600,
              count: 1000,
            },
            removeOnFail: BULLMQ_FAILED_JOB_RETENTION,
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
          connection: toBullmqConnection(config.connection),
          defaultJobOptions: {
            removeOnComplete: {
              age: 3600 * 24 * 7,
              count: 10_000,
            },
            removeOnFail: BULLMQ_DLQ_JOB_RETENTION,
            attempts: 1,
          },
        });
        cleanup.track(queue, {
          failedRetention: BULLMQ_DLQ_JOB_RETENTION,
          waitingRetention: BULLMQ_DLQ_JOB_RETENTION,
        });
        return queue;
      },
    },
    {
      provide: PIPELINE_QUEUE_EVENTS,
      inject: [EnvService, QueueCleanupService],
      useFactory: (env: EnvService, cleanup: QueueCleanupService) => {
        const config = env.bullmqConfig;
        const events = new QueueEvents(ITEM_PIPELINE_QUEUE_NAME, {
          connection: toBullmqConnection(config.connection)
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
    NewsSourceSchedulerService,
    PIPELINE_QUEUE,
    PIPELINE_DLQ_QUEUE,
    PIPELINE_QUEUE_EVENTS,
    getQueueToken(ITEM_PIPELINE_QUEUE_NAME),
    getQueueToken(ITEM_PIPELINE_DLQ_QUEUE_NAME),
  ],
})
export class QueueModule {}
