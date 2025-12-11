import { Module } from "@nestjs/common";
import { getQueueToken } from "@nestjs/bull-shared";
import { Queue, QueueEvents } from "bullmq";
import { EnvService } from "../config/config.service";
import { AnalysisService } from "./analysis.service";
import { AnalysisProcessor } from "./analysis.processor";
import { ANALYSIS_QUEUE, ANALYSIS_QUEUE_EVENTS, ANALYSIS_QUEUE_NAME } from "./analysis.constants";
import { NewsPipelineModule } from "../news-pipeline/news-pipeline.module";
import { ANALYSIS_PUBSUB, createAnalysisPubSub } from "./analysis.pubsub";
import { NotificationsModule } from "../notifications/notifications.module";

@Module({
  imports: [NewsPipelineModule, NotificationsModule],
  providers: [
    AnalysisService,
    AnalysisProcessor,
    {
      provide: ANALYSIS_QUEUE,
      inject: [EnvService],
      useFactory: (env: EnvService) => new Queue(ANALYSIS_QUEUE_NAME, { connection: env.redisConfig })
    },
    {
      provide: ANALYSIS_QUEUE_EVENTS,
      inject: [EnvService],
      useFactory: (env: EnvService) => new QueueEvents(ANALYSIS_QUEUE_NAME, { connection: env.redisConfig })
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
  exports: [AnalysisService, ANALYSIS_QUEUE, ANALYSIS_QUEUE_EVENTS, getQueueToken(ANALYSIS_QUEUE_NAME)]
})
export class AnalysisModule {}
