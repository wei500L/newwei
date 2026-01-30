import { HttpModule } from "@nestjs/axios";
import { getQueueToken } from "@nestjs/bull-shared";
import { Module } from "@nestjs/common";
import { Queue, QueueEvents } from "bullmq";

import { EnvService } from "../config/config.service";
import { DatabaseModule } from "../config/database.module";

import { AdminAkshareController } from "./admin-akshare.controller";
import { AkshareGatewayClient } from "./akshare-gateway.client";
import { AkshareParserService } from "./akshare-parser.service";
import { AkshareQueueCleanupService } from "./akshare-queue-cleanup.service";
import { AKSHARE_QUEUE, AKSHARE_QUEUE_EVENTS, AKSHARE_QUEUE_NAME } from "./akshare.constants";
import { AkshareQueueProcessor } from "./akshare.processor";
import { AkshareService } from "./akshare.service";

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
    AkshareParserService,
    AkshareGatewayClient,
    AkshareService,
    AkshareQueueProcessor,
    AkshareQueueCleanupService,
    {
      provide: AKSHARE_QUEUE,
      inject: [EnvService, AkshareQueueCleanupService],
      useFactory: (env: EnvService, cleanup: AkshareQueueCleanupService) => {
        const redis = env.redisConfig;
        const queue = new Queue<unknown>(AKSHARE_QUEUE_NAME, {
          connection: redis
        });
        cleanup.track(queue);
        return queue;
      }
    },
    {
      provide: AKSHARE_QUEUE_EVENTS,
      inject: [EnvService, AkshareQueueCleanupService],
      useFactory: (env: EnvService, cleanup: AkshareQueueCleanupService) => {
        const redis = env.redisConfig;
        const events = new QueueEvents(AKSHARE_QUEUE_NAME, {
          connection: redis
        });
        cleanup.track(events);
        return events;
      }
    },
    {
      provide: getQueueToken(AKSHARE_QUEUE_NAME),
      useExisting: AKSHARE_QUEUE
    }
  ],
  exports: [
    AkshareService,
    AkshareParserService,
    AkshareGatewayClient,
    AKSHARE_QUEUE,
    AKSHARE_QUEUE_EVENTS,
    getQueueToken(AKSHARE_QUEUE_NAME)
  ]
})
export class AkshareModule {}
