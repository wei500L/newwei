import { getQueueToken } from "@nestjs/bull-shared";
import { Module } from "@nestjs/common";
import { Queue, QueueEvents } from "bullmq";

import { BULLMQ_FAILED_JOB_RETENTION } from "../../common/bullmq-retention";
import { BullmqConnectionService } from "../config/bullmq-connection.service";
import { NewsPipelineModule } from "../news-pipeline/news-pipeline.module";
import { NotificationsModule } from "../notifications/notifications.module";

import { AnalysisPromptService } from "./analysis-prompt.service";
import { AnalysisQueueCleanupService } from "./analysis-queue-cleanup.service";
import { AnalysisQueueEventPublisher } from "./analysis-queue-event.publisher";
import { ANALYSIS_QUEUE, ANALYSIS_QUEUE_EVENTS, ANALYSIS_QUEUE_NAME } from "./analysis.constants";
import { AnalysisProcessor } from "./analysis.processor";
import { ANALYSIS_PUBSUB, createAnalysisPubSub } from "./analysis.pubsub";
import { AnalysisService } from "./analysis.service";

@Module({
  imports: [NewsPipelineModule, NotificationsModule],
  providers: [
    AnalysisService,
    AnalysisPromptService,
    AnalysisQueueEventPublisher,
    AnalysisProcessor,
    AnalysisQueueCleanupService,
    {
      provide: ANALYSIS_QUEUE,
      inject: [AnalysisQueueCleanupService, BullmqConnectionService],
      useFactory: (
        cleanup: AnalysisQueueCleanupService,
        bullmqConnections: BullmqConnectionService,
      ) => {
        const queue = new Queue(ANALYSIS_QUEUE_NAME, {
          connection: bullmqConnections.getSharedConnection(),
          defaultJobOptions: {
            removeOnFail: BULLMQ_FAILED_JOB_RETENTION,
          },
        });
        cleanup.track(queue);
        return queue;
      }
    },
    {
      provide: ANALYSIS_QUEUE_EVENTS,
      inject: [AnalysisQueueCleanupService, BullmqConnectionService],
      useFactory: (
        cleanup: AnalysisQueueCleanupService,
        bullmqConnections: BullmqConnectionService,
      ) => {
        const events = new QueueEvents(ANALYSIS_QUEUE_NAME, {
          connection: bullmqConnections.createDedicatedConnectionOptions(
            `events:${ANALYSIS_QUEUE_NAME}`,
          ),
        });
        cleanup.track(events);
        return events;
      }
    },
    {
      provide: ANALYSIS_PUBSUB,
      useFactory: () => createAnalysisPubSub()
    },
    {
      provide: getQueueToken(ANALYSIS_QUEUE_NAME),
      useExisting: ANALYSIS_QUEUE
    }
  ],
  exports: [
    AnalysisService,
    AnalysisQueueEventPublisher,
    ANALYSIS_QUEUE,
    ANALYSIS_QUEUE_EVENTS,
    ANALYSIS_PUBSUB,
    getQueueToken(ANALYSIS_QUEUE_NAME)
  ]
})
export class AnalysisModule {}
