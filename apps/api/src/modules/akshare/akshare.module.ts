import { HttpModule } from "@nestjs/axios";
import { getQueueToken } from "@nestjs/bull-shared";
import { Module } from "@nestjs/common";
import { Queue, QueueEvents } from "bullmq";

import { BULLMQ_FAILED_JOB_RETENTION } from "../../common/bullmq-retention";
import { withKeepAliveAgents } from "../../common/http/http-agent";
import { BullmqConnectionService } from "../config/bullmq-connection.service";
import { EnvService } from "../config/config.service";
import { DatabaseModule } from "../config/database.module";

import { AdminAkshareController } from "./admin-akshare.controller";
import { AkshareGatewayClient } from "./akshare-gateway.client";
import { AkshareParserService } from "./akshare-parser.service";
import { AkshareQueueCleanupService } from "./akshare-queue-cleanup.service";
import { AKSHARE_QUEUE, AKSHARE_QUEUE_EVENTS, AKSHARE_QUEUE_NAME } from "./akshare.constants";
import { AkshareQueueProcessor } from "./akshare.processor";
import { AkshareService } from "./akshare.service";
import { AkshareFinancialDataProvider } from "./providers/akshare.provider";
import { FinancialDataProviderRegistry } from "./providers/financial-data-provider";
import { FinancialDataProviderRegistryInitializer } from "./providers/financial-data-provider-registry.initializer";
import { FinnhubFinancialDataProvider } from "./providers/finnhub.provider";
import { FredFinancialDataProvider } from "./providers/fred.provider";
import { YfinanceFinancialDataProvider } from "./providers/yfinance.provider";

@Module({
  imports: [
    DatabaseModule,
    HttpModule.registerAsync({
      inject: [EnvService],
      useFactory: (env: EnvService) => {
        const cfg = env.akshareConfig;
        return withKeepAliveAgents(
          {
            timeout: cfg.timeoutMs
          },
          env.httpAgentConfig
        );
      }
    })
  ],
  controllers: [AdminAkshareController],
  providers: [
    AkshareParserService,
    AkshareGatewayClient,
    AkshareService,
    FinancialDataProviderRegistry,
    FinancialDataProviderRegistryInitializer,
    AkshareFinancialDataProvider,
    FinnhubFinancialDataProvider,
    FredFinancialDataProvider,
    YfinanceFinancialDataProvider,
    AkshareQueueProcessor,
    AkshareQueueCleanupService,
    {
      provide: AKSHARE_QUEUE,
      inject: [AkshareQueueCleanupService, BullmqConnectionService],
      useFactory: (
        cleanup: AkshareQueueCleanupService,
        bullmqConnections: BullmqConnectionService,
      ) => {
        const queue = new Queue<unknown>(AKSHARE_QUEUE_NAME, {
          connection: bullmqConnections.getSharedConnection(),
          defaultJobOptions: {
            removeOnFail: BULLMQ_FAILED_JOB_RETENTION
          }
        });
        cleanup.track(queue);
        return queue;
      }
    },
    {
      provide: AKSHARE_QUEUE_EVENTS,
      inject: [AkshareQueueCleanupService, BullmqConnectionService],
      useFactory: (
        cleanup: AkshareQueueCleanupService,
        bullmqConnections: BullmqConnectionService,
      ) => {
        const events = new QueueEvents(AKSHARE_QUEUE_NAME, {
          connection: bullmqConnections.createDedicatedConnectionOptions(
            `events:${AKSHARE_QUEUE_NAME}`,
          )
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
