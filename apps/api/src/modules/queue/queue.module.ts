import { Module } from "@nestjs/common";
import { getQueueToken } from "@nestjs/bull-shared";
import { Queue, QueueEvents } from "bullmq";

import { AuthModule } from "../auth/auth.module";
import { CacheModule } from "../cache/cache.module";
import { EnvService } from "../config/config.service";
import { NewsPipelineModule } from "../news-pipeline/news-pipeline.module";

import { QueueEventPublisher } from "./queue-event.publisher";
import { QueueGateway } from "./queue.gateway";
import { QueueProcessor } from "./queue.processor";
import { QueueService } from "./queue.service";

export const PIPELINE_QUEUE = Symbol("PIPELINE_QUEUE");
export const PIPELINE_DLQ_QUEUE = Symbol("PIPELINE_DLQ_QUEUE");
export const PIPELINE_QUEUE_EVENTS = Symbol("PIPELINE_QUEUE_EVENTS");
export const ITEM_PIPELINE_QUEUE_NAME = "itemPipeline";
export const ITEM_PIPELINE_DLQ_QUEUE_NAME = "itemPipelineDlq";

@Module({
  imports: [CacheModule, NewsPipelineModule, AuthModule],
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
      }
    },
    {
      provide: PIPELINE_DLQ_QUEUE,
      inject: [EnvService],
      useFactory: (env: EnvService) => {
        const config = env.bullmqConfig;
        return new Queue(ITEM_PIPELINE_DLQ_QUEUE_NAME, {
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
      },
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
    QueueGateway
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
