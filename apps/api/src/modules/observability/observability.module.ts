import { getQueueToken } from "@nestjs/bull-shared";
import { Module } from "@nestjs/common";
import { Queue } from "bullmq";

import { AlertsModule } from "../alerts/alerts.module";
import { AnalysisModule } from "../analysis/analysis.module";
import { AssistantModule } from "../assistant/assistant.module";
import { AuthModule } from "../auth/auth.module";
import { EnvService } from "../config/config.service";
import { DatabaseModule } from "../config/database.module";
import { toBullmqConnection } from "../config/redis-connection";
import { CrawlModule } from "../crawl/crawl.module";
import { NewsPipelineModule } from "../news-pipeline/news-pipeline.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { QueueModule } from "../queue/queue.module";

import { AdminErrorsController } from "./admin-errors.controller";
import { AdminLogsController } from "./admin-logs.controller";
import { AdminLogsService } from "./admin-logs.service";
import { ClassificationQualityQueueCleanupService } from "./classification-quality-queue-cleanup.service";
import { ClassificationQualityAlertSchedulerService } from "./classification-quality-alert-scheduler.service";
import { ClassificationQualitySeedTriggerService } from "./classification-quality-seed-trigger.service";
import {
  CLASSIFICATION_QUALITY_QUEUE,
  CLASSIFICATION_QUALITY_QUEUE_NAME,
} from "./classification-quality.constants";
import { ClassificationQualityController } from "./classification-quality.controller";
import { ClassificationQualityProcessor } from "./classification-quality.processor";
import { ClassificationQualityService } from "./classification-quality.service";
import { ClientExceptionEventsController } from "./client-exception-events.controller";
import { ExceptionEventsService } from "./exception-events.service";
import { InternalExceptionEventsController } from "./internal-exception-events.controller";
import { MetricsController } from "./metrics.controller";
import { NewsSourceQualityController } from "./news-source-quality.controller";
import { NewsSourceQualityService } from "./news-source-quality.service";
import { ObservabilitySnapshotService } from "./observability-snapshot.service";
import { OpsGateway } from "./ops.gateway";
import { PipelineQualityController } from "./pipeline-quality.controller";
import { PipelineQualityService } from "./pipeline-quality.service";
import { PipelineRecoveryController } from "./pipeline-recovery.controller";
import { PipelineRecoveryService } from "./pipeline-recovery.service";
import { QualityOverviewController } from "./quality-overview.controller";
import { QualityOverviewService } from "./quality-overview.service";
import { QualityGateway } from "./quality.gateway";
import { TaskLogsController } from "./task-logs.controller";

@Module({
  imports: [
    DatabaseModule,
    QueueModule,
    CrawlModule,
    AnalysisModule,
    AssistantModule,
    AlertsModule,
    AuthModule,
    NewsPipelineModule,
    NotificationsModule,
  ],
  controllers: [
    AdminLogsController,
    AdminErrorsController,
    ClientExceptionEventsController,
    InternalExceptionEventsController,
    ClassificationQualityController,
    MetricsController,
    QualityOverviewController,
    PipelineQualityController,
    NewsSourceQualityController,
    PipelineRecoveryController,
    TaskLogsController,
  ],
  providers: [
    ExceptionEventsService,
    AdminLogsService,
    ObservabilitySnapshotService,
    ClassificationQualityService,
    ClassificationQualityAlertSchedulerService,
    ClassificationQualityProcessor,
    ClassificationQualityQueueCleanupService,
    ClassificationQualitySeedTriggerService,
    {
      provide: CLASSIFICATION_QUALITY_QUEUE,
      inject: [EnvService, ClassificationQualityQueueCleanupService],
      useFactory: (
        env: EnvService,
        cleanup: ClassificationQualityQueueCleanupService,
      ) => {
        const queue = new Queue(CLASSIFICATION_QUALITY_QUEUE_NAME, {
          connection: toBullmqConnection(env.redisConfig),
          defaultJobOptions: {
            removeOnComplete: true,
            removeOnFail: false,
            attempts: 3,
            backoff: {
              type: "exponential",
              delay: 2000,
            },
          },
        });
        cleanup.track(queue);
        return queue;
      },
    },
    {
      provide: getQueueToken(CLASSIFICATION_QUALITY_QUEUE_NAME),
      useExisting: CLASSIFICATION_QUALITY_QUEUE,
    },
    PipelineQualityService,
    NewsSourceQualityService,
    QualityOverviewService,
    PipelineRecoveryService,
    QualityGateway,
    OpsGateway,
  ],
  exports: [
    ExceptionEventsService,
    ObservabilitySnapshotService,
    ClassificationQualityService,
    PipelineQualityService,
    NewsSourceQualityService,
    PipelineRecoveryService,
  ],
})
export class ObservabilityModule {}
