import { HttpModule } from "@nestjs/axios";
import { getQueueToken } from "@nestjs/bull-shared";
import { Module } from "@nestjs/common";
import { Queue, QueueEvents } from "bullmq";

import { BULLMQ_FAILED_JOB_RETENTION } from "../../common/bullmq-retention";
import { withKeepAliveAgents } from "../../common/http/http-agent";
import { CacheModule } from "../cache/cache.module";
import { BullmqConnectionService } from "../config/bullmq-connection.service";
import { EnvService } from "../config/config.service";
import { DatabaseModule } from "../config/database.module";
import { EmailModule } from "../email/email.module";
import { KnowledgeGraphModule } from "../knowledge-graph/knowledge-graph.module";
import { ModelServiceModule } from "../model-service/model-service.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { RealtimeSignalsModule } from "../realtime-signals/realtime-signals.module";

import { AlertsNotificationThrottleService } from "./alerts-notification-throttle.service";
import { AlertsQueueCleanupService } from "./alerts-queue-cleanup.service";
import { AlertsQueueEventPublisher } from "./alerts-queue-event.publisher";
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
import { RealtimeSignalMetricProvider } from "./providers/realtime-signal-metric.provider";
import { SystemEventMetricProvider } from "./providers/system-event-metric.provider";
import { SystemMetricProvider } from "./providers/system-metric.provider";

@Module({
  imports: [
    DatabaseModule,
    CacheModule,
    EmailModule,
    NotificationsModule,
    ModelServiceModule,
    KnowledgeGraphModule,
    RealtimeSignalsModule,
    HttpModule.registerAsync({
      inject: [EnvService],
      useFactory: (env: EnvService) =>
        withKeepAliveAgents(
          {
            timeout: env.alertingConfig.webhookTimeoutMs
          },
          env.httpAgentConfig
        )
    })
  ],
  providers: [
    AlertsService,
    AlertsNotificationThrottleService,
    AlertsQueueEventPublisher,
    AlertsProcessor,
    AlertsQueueCleanupService,
    EconomicDataMetricProvider,
    EconomicAnomalyMetricProvider,
    PipelineMetricProvider,
    CrawlMetricProvider,
    SystemMetricProvider,
    SystemEventMetricProvider,
    EntitySentimentMetricProvider,
    EntityAssociationMetricProvider,
    RealtimeSignalMetricProvider,
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
        EntityAssociationMetricProvider,
        RealtimeSignalMetricProvider
      ],
      useFactory: (
        economicDataProvider: EconomicDataMetricProvider,
        economicAnomalyProvider: EconomicAnomalyMetricProvider,
        pipelineMetricProvider: PipelineMetricProvider,
        crawlMetricProvider: CrawlMetricProvider,
        systemMetricProvider: SystemMetricProvider,
        systemEventMetricProvider: SystemEventMetricProvider,
        entitySentimentProvider: EntitySentimentMetricProvider,
        entityAssociationProvider: EntityAssociationMetricProvider,
        realtimeSignalProvider: RealtimeSignalMetricProvider
      ) => [
        economicDataProvider,
        economicAnomalyProvider,
        pipelineMetricProvider,
        crawlMetricProvider,
        systemMetricProvider,
        systemEventMetricProvider,
        entitySentimentProvider,
        entityAssociationProvider,
        realtimeSignalProvider
      ]
    },
    {
      provide: ALERTS_QUEUE,
      inject: [AlertsQueueCleanupService, BullmqConnectionService],
      useFactory: (
        cleanup: AlertsQueueCleanupService,
        bullmqConnections: BullmqConnectionService,
      ) => {
        const queue = new Queue(ALERTS_QUEUE_NAME, {
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
      provide: ALERTS_QUEUE_EVENTS,
      inject: [AlertsQueueCleanupService, BullmqConnectionService],
      useFactory: (
        cleanup: AlertsQueueCleanupService,
        bullmqConnections: BullmqConnectionService,
      ) => {
        const events = new QueueEvents(ALERTS_QUEUE_NAME, {
          connection: bullmqConnections.createDedicatedConnectionOptions(
            `events:${ALERTS_QUEUE_NAME}`,
          )
        });
        cleanup.track(events);
        return events;
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
  exports: [
    AlertsService,
    AlertsQueueEventPublisher,
    ALERTS_QUEUE,
    ALERTS_QUEUE_EVENTS,
    ALERTS_PUBSUB,
    getQueueToken(ALERTS_QUEUE_NAME)
  ]
})
export class AlertsModule {}
