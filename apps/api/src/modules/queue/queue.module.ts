import { Module } from "@nestjs/common";
import { Queue, QueueEvents, Worker } from "bullmq";
import { EnvService } from "../config/config.service";
import { QueueService } from "./queue.service";
import { QueueProcessor } from "./queue.processor";
import { CacheModule } from "../cache/cache.module";
import { NewsPipelineModule } from "../news-pipeline/news-pipeline.module";

export const PIPELINE_QUEUE = Symbol("PIPELINE_QUEUE");
export const PIPELINE_QUEUE_EVENTS = Symbol("PIPELINE_QUEUE_EVENTS");
export const ITEM_PIPELINE_QUEUE_NAME = "itemPipeline";

@Module({
  imports: [CacheModule, NewsPipelineModule],
  providers: [
    {
      provide: PIPELINE_QUEUE,
      inject: [EnvService],
      useFactory: (env: EnvService) => {
        const config = env.bullmqConfig;
        return new Queue(ITEM_PIPELINE_QUEUE_NAME, {
          connection: {
            host: config.connection.host,
            port: config.connection.port,
            username: config.connection.username,
            db: config.connection.db
          },
          defaultJobOptions: {
            removeOnComplete: true,
            removeOnFail: false,
            attempts: 5,
            backoff: {
              type: "exponential",
              delay: 1000
            }
          }
        });
      }
    },
    {
      provide: PIPELINE_QUEUE_EVENTS,
      inject: [EnvService],
      useFactory: (env: EnvService) => {
        const config = env.bullmqConfig;
        return new QueueEvents(ITEM_PIPELINE_QUEUE_NAME, {
          connection: {
            host: config.connection.host,
            port: config.connection.port,
            username: config.connection.username,
            db: config.connection.db
          }
        });
      }
    },
    QueueProcessor,
    QueueService
  ],
  exports: [QueueService, PIPELINE_QUEUE, PIPELINE_QUEUE_EVENTS]
})
export class QueueModule {}
