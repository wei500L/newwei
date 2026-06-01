import { Module } from "@nestjs/common";
import { Queue, QueueEvents } from "bullmq";

import { BULLMQ_FAILED_JOB_RETENTION } from "../../common/bullmq-retention";
import { CacheModule } from "../cache/cache.module";
import { EnvService } from "../config/config.service";
import { toBullmqConnection } from "../config/redis-connection";
import { NewsEventsModule } from "../news-events/news-events.module";
import { NewsPipelineModule } from "../news-pipeline/news-pipeline.module";

import { ArchiveClassificationService } from "./archive-classification.service";
import { ArchivePreparationQueueCleanupService } from "./archive-preparation-queue-cleanup.service";
import { ArchivePreparationQueueService } from "./archive-preparation-queue.service";
import {
  ARCHIVE_PREPARATION_QUEUE,
  ARCHIVE_PREPARATION_QUEUE_EVENTS,
  ARCHIVE_PREPARATION_QUEUE_NAME,
} from "./archive-preparation.constants";
import { ArchivePreparationController } from "./archive-preparation.controller";
import { ArchivePreparationProcessor } from "./archive-preparation.processor";
import { ArchiveClassifier } from "./archive.classifier";
import { ArchiveService } from "./archive.service";

@Module({
  imports: [NewsPipelineModule, NewsEventsModule, CacheModule],
  controllers: [ArchivePreparationController],
  providers: [
    ArchiveClassifier,
    ArchiveClassificationService,
    ArchivePreparationQueueCleanupService,
    ArchivePreparationQueueService,
    ArchivePreparationProcessor,
    ArchiveService,
    {
      provide: ARCHIVE_PREPARATION_QUEUE,
      inject: [EnvService, ArchivePreparationQueueCleanupService],
      useFactory: (
        env: EnvService,
        cleanup: ArchivePreparationQueueCleanupService,
      ) => {
        const queue = new Queue(ARCHIVE_PREPARATION_QUEUE_NAME, {
          connection: toBullmqConnection(env.redisConfig),
          defaultJobOptions: {
            removeOnFail: BULLMQ_FAILED_JOB_RETENTION,
          },
        });
        cleanup.track(queue);
        return queue;
      },
    },
    {
      provide: ARCHIVE_PREPARATION_QUEUE_EVENTS,
      inject: [EnvService, ArchivePreparationQueueCleanupService],
      useFactory: (
        env: EnvService,
        cleanup: ArchivePreparationQueueCleanupService,
      ) => {
        const events = new QueueEvents(ARCHIVE_PREPARATION_QUEUE_NAME, {
          connection: toBullmqConnection(env.redisConfig),
        });
        cleanup.track(events);
        return events;
      },
    },
  ],
  exports: [ArchiveService],
})
export class ArchiveModule {}
