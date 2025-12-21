import { getQueueToken } from "@nestjs/bull-shared";
import { Module } from "@nestjs/common";
import { Queue, QueueEvents } from "bullmq";

import { EnvService } from "../config/config.service";
import { NewsPipelineModule } from "../news-pipeline/news-pipeline.module";
import { NotificationsModule } from "../notifications/notifications.module";

import { AnalysisPromptService } from "./analysis-prompt.service";
import { ANALYSIS_QUEUE, ANALYSIS_QUEUE_EVENTS, ANALYSIS_QUEUE_NAME } from "./analysis.constants";
import { AnalysisProcessor } from "./analysis.processor";
import { ANALYSIS_PUBSUB, createAnalysisPubSub } from "./analysis.pubsub";
import { AnalysisService } from "./analysis.service";

@Module({
  imports: [NewsPipelineModule, NotificationsModule],
  providers: [
    AnalysisService,
    AnalysisPromptService,
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
  exports: [AnalysisService, ANALYSIS_QUEUE, ANALYSIS_QUEUE_EVENTS, ANALYSIS_PUBSUB, getQueueToken(ANALYSIS_QUEUE_NAME)]
})
export class AnalysisModule {}
