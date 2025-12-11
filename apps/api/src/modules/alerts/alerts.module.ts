import { HttpModule } from "@nestjs/axios";
import { Module } from "@nestjs/common";
import { getQueueToken } from "@nestjs/bull-shared";
import { Queue, QueueEvents } from "bullmq";
import { DatabaseModule } from "../config/database.module";
import { EnvService } from "../config/config.service";
import { EmailModule } from "../email/email.module";
import { ALERTS_QUEUE, ALERTS_QUEUE_EVENTS, ALERTS_QUEUE_NAME, ALERT_METRIC_PROVIDERS } from "./alerts.constants";
import { AlertsService } from "./alerts.service";
import { AlertsProcessor } from "./alerts.processor";
import { ALERTS_PUBSUB, createAlertsPubSub } from "./alerts.pubsub";
import { EconomicDataMetricProvider } from "./providers/economic-data-metric.provider";
import { PipelineMetricProvider } from "./providers/pipeline-metric.provider";
import { CrawlMetricProvider } from "./providers/crawl-metric.provider";
import { SystemMetricProvider } from "./providers/system-metric.provider";
import { SystemEventMetricProvider } from "./providers/system-event-metric.provider";

@Module({
  imports: [
    DatabaseModule,
    EmailModule,
    HttpModule.registerAsync({
      inject: [EnvService],
      useFactory: (env: EnvService) => ({
        timeout: env.alertingConfig.webhookTimeoutMs
      })
    })
  ],
  providers: [
    AlertsService,
    AlertsProcessor,
    EconomicDataMetricProvider,
    PipelineMetricProvider,
    CrawlMetricProvider,
    SystemMetricProvider,
    SystemEventMetricProvider,
    {
      provide: ALERT_METRIC_PROVIDERS,
      inject: [
        EconomicDataMetricProvider,
        PipelineMetricProvider,
        CrawlMetricProvider,
        SystemMetricProvider,
        SystemEventMetricProvider
      ],
      useFactory: (
        economicDataProvider: EconomicDataMetricProvider,
        pipelineMetricProvider: PipelineMetricProvider,
        crawlMetricProvider: CrawlMetricProvider,
        systemMetricProvider: SystemMetricProvider,
        systemEventMetricProvider: SystemEventMetricProvider
      ) => [economicDataProvider, pipelineMetricProvider, crawlMetricProvider, systemMetricProvider, systemEventMetricProvider]
    },
    {
      provide: ALERTS_QUEUE,
      inject: [EnvService],
      useFactory: (env: EnvService) => {
        return new Queue(ALERTS_QUEUE_NAME, {
          connection: env.redisConfig
        });
      }
    },
    {
      provide: ALERTS_QUEUE_EVENTS,
      inject: [EnvService],
      useFactory: (env: EnvService) => {
        return new QueueEvents(ALERTS_QUEUE_NAME, {
          connection: env.redisConfig
        });
      }
    },
    {
      provide: ALERTS_PUBSUB,
      useFactory: () => createAlertsPubSub()
    },
    {
      provide: getQueueToken(ALERTS_QUEUE_NAME),
      useExisting: ALERTS_QUEUE
    }
  ],
  exports: [AlertsService, ALERTS_QUEUE, ALERTS_QUEUE_EVENTS, getQueueToken(ALERTS_QUEUE_NAME)]
})
export class AlertsModule {}
