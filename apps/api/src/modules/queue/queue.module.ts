import { Module } from "@nestjs/common";
import { Queue, QueueEvents, Worker } from "bullmq";
import { EnvService } from "../config/config.service";
import { QueueService } from "./queue.service";
import { QueueProcessor } from "./queue.processor";
import { CacheModule } from "../cache/cache.module";

export const PIPELINE_QUEUE = Symbol("PIPELINE_QUEUE");
export const PIPELINE_QUEUE_EVENTS = Symbol("PIPELINE_QUEUE_EVENTS");

@Module({
  imports: [CacheModule],
  providers: [
    {
      provide: PIPELINE_QUEUE,
      inject: [EnvService],
      useFactory: (env: EnvService) => {
        const config = env.bullmqConfig;
        return new Queue("itemPipeline", {
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
        return new QueueEvents("itemPipeline", {
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
  exports: [QueueService]
})
export class QueueModule {}
