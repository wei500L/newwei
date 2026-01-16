import { HttpModule } from "@nestjs/axios";
import { getQueueToken } from "@nestjs/bull-shared";
import { Module } from "@nestjs/common";
import { Queue, QueueEvents } from "bullmq";

import { EnvService } from "../config/config.service";
import { DatabaseModule } from "../config/database.module";
import { EmailModule } from "../email/email.module";
import { KnowledgeGraphModule } from "../knowledge-graph/knowledge-graph.module";
import { ModelServiceModule } from "../model-service/model-service.module";
import { NotificationsModule } from "../notifications/notifications.module";

import { AlertsNotificationThrottleService } from "./alerts-notification-throttle.service";
import { ALERTS_QUEUE, ALERTS_QUEUE_EVENTS, ALERTS_QUEUE_NAME, ALERT_METRIC_PROVIDERS } from "./alerts.constants";
import { AlertsProcessor } from "./alerts.processor";
import { ALERTS_PUBSUB, createAlertsPubSub } from "./alerts.pubsub";
import { AlertsService } from "./alerts.service";
import { CrawlMetricProvider } from "./providers/crawl-metric.provider";
import { EconomicAnomalyMetricProvider } from "./providers/economic-anomaly-metric.provider";
import { EconomicDataMetricProvider } from "./providers/economic-data-metric.provider";
import { EntityAssociationMetricProvider } from "./providers/entity-association-metric.provider";
import { EntitySentimentMetricProvider } from "./providers/entity-sentiment-metric.provider";
import { PipelineMetricProvider } from "./providers/pipeline-metric.provider";
import { SystemEventMetricProvider } from "./providers/system-event-metric.provider";
import { SystemMetricProvider } from "./providers/system-metric.provider";

@Module({
  imports: [
    DatabaseModule,
    EmailModule,
    NotificationsModule,
    ModelServiceModule,
    KnowledgeGraphModule,
    HttpModule.registerAsync({
      inject: [EnvService],
      useFactory: (env: EnvService) => ({
        timeout: env.alertingConfig.webhookTimeoutMs
      })
    })
  ],
  providers: [
    AlertsService,
    AlertsNotificationThrottleService,
    AlertsProcessor,
    EconomicDataMetricProvider,
    EconomicAnomalyMetricProvider,
    PipelineMetricProvider,
    CrawlMetricProvider,
    SystemMetricProvider,
    SystemEventMetricProvider,
    EntitySentimentMetricProvider,
    EntityAssociationMetricProvider,
    {
      provide: ALERT_METRIC_PROVIDERS,
      inject: [
        EconomicDataMetricProvider,
        EconomicAnomalyMetricProvider,
        PipelineMetricProvider,
        CrawlMetricProvider,
        SystemMetricProvider,
        SystemEventMetricProvider,
        EntitySentimentMetricProvider,
        EntityAssociationMetricProvider
      ],
      useFactory: (
        economicDataProvider: EconomicDataMetricProvider,
        economicAnomalyProvider: EconomicAnomalyMetricProvider,
        pipelineMetricProvider: PipelineMetricProvider,
        crawlMetricProvider: CrawlMetricProvider,
        systemMetricProvider: SystemMetricProvider,
        systemEventMetricProvider: SystemEventMetricProvider,
        entitySentimentProvider: EntitySentimentMetricProvider,
        entityAssociationProvider: EntityAssociationMetricProvider
      ) => [
        economicDataProvider,
        economicAnomalyProvider,
        pipelineMetricProvider,
        crawlMetricProvider,
        systemMetricProvider,
        systemEventMetricProvider,
        entitySentimentProvider,
        entityAssociationProvider
      ]
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
  exports: [AlertsService, ALERTS_QUEUE, ALERTS_QUEUE_EVENTS, ALERTS_PUBSUB, getQueueToken(ALERTS_QUEUE_NAME)]
})
export class AlertsModule {}
