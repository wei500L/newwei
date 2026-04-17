import { getQueueToken } from "@nestjs/bull-shared";
import { Module } from "@nestjs/common";
import { Queue } from "bullmq";

import { EnvService } from "../config/config.service";
import { toBullmqConnection } from "../config/redis-connection";
import { ModelServiceModule } from "../model-service/model-service.module";
import { NewsPipelineModule } from "../news-pipeline/news-pipeline.module";

import { NewsEventClusteringAdminController } from "./news-event-clustering-admin.controller";
import { NewsEventClusteringFailureService } from "./news-event-clustering-failure.service";
import { NewsEventClusteringRecoveryProcessor } from "./news-event-clustering-recovery.processor";
import { NewsEventClusteringRecoveryQueueCleanupService } from "./news-event-clustering-recovery-queue-cleanup.service";
import {
  NEWS_EVENT_CLUSTERING_RECOVERY_QUEUE,
  NEWS_EVENT_CLUSTERING_RECOVERY_QUEUE_NAME,
  type NewsEventClusteringRecoveryJobPayload,
} from "./news-event-clustering-recovery.constants";
import { NewsEventClusteringRecoveryService } from "./news-event-clustering-recovery.service";
import { NewsEventBriefService } from "./news-event-brief.service";
import { NewsEventSourcePolicyService } from "./news-event-source-policy.service";
import { NewsEventsBertopicService } from "./news-events-bertopic.service";
import { NewsEventsIngestionService } from "./news-events-ingestion.service";
import { NewsEventsSettingsService } from "./news-events-settings.service";
import { NewsEventsTimelineService } from "./news-events-timeline.service";
import { NewsEventsService } from "./news-events.service";

@Module({
  imports: [NewsPipelineModule, ModelServiceModule],
  controllers: [NewsEventClusteringAdminController],
  providers: [
    NewsEventsSettingsService,
    NewsEventSourcePolicyService,
    NewsEventsService,
    NewsEventClusteringFailureService,
    NewsEventClusteringRecoveryService,
    NewsEventClusteringRecoveryProcessor,
    NewsEventClusteringRecoveryQueueCleanupService,
    NewsEventsBertopicService,
    NewsEventBriefService,
    NewsEventsIngestionService,
    NewsEventsTimelineService,
    {
      provide: NEWS_EVENT_CLUSTERING_RECOVERY_QUEUE,
      inject: [EnvService, NewsEventClusteringRecoveryQueueCleanupService],
      useFactory: (
        env: EnvService,
        cleanup: NewsEventClusteringRecoveryQueueCleanupService,
      ) => {
        const queue = new Queue<NewsEventClusteringRecoveryJobPayload>(
          NEWS_EVENT_CLUSTERING_RECOVERY_QUEUE_NAME,
          {
            connection: toBullmqConnection(env.redisConfig),
          },
        );
        cleanup.track(queue);
        return queue;
      },
    },
    {
      provide: getQueueToken(NEWS_EVENT_CLUSTERING_RECOVERY_QUEUE_NAME),
      useExisting: NEWS_EVENT_CLUSTERING_RECOVERY_QUEUE,
    },
  ],
  exports: [
    NewsEventsSettingsService,
    NewsEventSourcePolicyService,
    NewsEventsService,
    NewsEventClusteringFailureService,
    NewsEventClusteringRecoveryService,
    NewsEventBriefService,
  ],
})
export class NewsEventsModule {}
