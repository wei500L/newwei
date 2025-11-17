import { Module } from "@nestjs/common";
import { Queue, QueueEvents } from "bullmq";
import { EnvService } from "../config/config.service";
import { AnalysisService } from "./analysis.service";
import { AnalysisProcessor } from "./analysis.processor";
import { ANALYSIS_QUEUE, ANALYSIS_QUEUE_EVENTS, ANALYSIS_QUEUE_NAME } from "./analysis.constants";
import { NewsPipelineModule } from "../news-pipeline/news-pipeline.module";
import { ANALYSIS_PUBSUB, createAnalysisPubSub } from "./analysis.pubsub";

@Module({
  imports: [NewsPipelineModule],
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
    }
  ],
  exports: [AnalysisService]
})
export class AnalysisModule {}
