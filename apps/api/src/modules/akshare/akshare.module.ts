import { HttpModule } from "@nestjs/axios";
import { Module } from "@nestjs/common";
import { getQueueToken } from "@nestjs/bull-shared";
import { Queue, QueueEvents } from "bullmq";
import { EnvService } from "../config/config.service";
import { AKSHARE_QUEUE, AKSHARE_QUEUE_EVENTS, AKSHARE_QUEUE_NAME } from "./akshare.constants";
import { AkshareService } from "./akshare.service";
import { AkshareQueueProcessor } from "./akshare.processor";
import { DatabaseModule } from "../config/database.module";
import { AdminAkshareController } from "./admin-akshare.controller";

@Module({
  imports: [
    DatabaseModule,
    HttpModule.registerAsync({
      inject: [EnvService],
      useFactory: (env: EnvService) => {
        const cfg = env.akshareConfig;
        return {
          timeout: cfg.timeoutMs
        };
      }
    })
  ],
  controllers: [AdminAkshareController],
  providers: [
    AkshareService,
    AkshareQueueProcessor,
    {
      provide: AKSHARE_QUEUE,
      inject: [EnvService],
      useFactory: (env: EnvService) => {
        const redis = env.redisConfig;
        return new Queue<unknown>(AKSHARE_QUEUE_NAME, {
          connection: redis
        });
      }
    },
    {
      provide: AKSHARE_QUEUE_EVENTS,
      inject: [EnvService],
      useFactory: (env: EnvService) => {
        const redis = env.redisConfig;
        return new QueueEvents(AKSHARE_QUEUE_NAME, {
          connection: redis
        });
      }
    },
    {
      provide: getQueueToken(AKSHARE_QUEUE_NAME),
      useExisting: AKSHARE_QUEUE
    }
  ],
  exports: [AkshareService, AKSHARE_QUEUE, AKSHARE_QUEUE_EVENTS, getQueueToken(AKSHARE_QUEUE_NAME)]
})
export class AkshareModule {}
