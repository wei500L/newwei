import { HttpModule } from "@nestjs/axios";
import { getQueueToken } from "@nestjs/bull-shared";
import { Module, forwardRef } from "@nestjs/common";
import { Queue, QueueEvents } from "bullmq";

import { BULLMQ_FAILED_JOB_RETENTION } from "../../common/bullmq-retention";
import { withKeepAliveAgents } from "../../common/http/http-agent";
import { EnvService } from "../config/config.service";
import { toBullmqConnection } from "../config/redis-connection";
import { NewsPipelineModule } from "../news-pipeline/news-pipeline.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { ObservabilitySnapshotService } from "../observability/observability-snapshot.service";
import { StorageModule } from "../storage/storage.module";

import { CrawlActivityService } from "./crawl-activity.service";
import { CrawlAdaptiveConcurrencyService } from "./crawl-adaptive-concurrency.service";
import { CrawlCleanupOutboxService } from "./crawl-cleanup-outbox.service";
import { CrawlExecutionService } from "./crawl-execution.service";
import { CrawlFrontierLlmService } from "./crawl-frontier-llm.service";
import { CrawlFrontierController } from "./crawl-frontier.controller";
import { CrawlFrontierService } from "./crawl-frontier.service";
import { CrawlMediaAssetController } from "./crawl-media-asset.controller";
import { CrawlMediaAssetService } from "./crawl-media-asset.service";
import { CrawlMetadataService } from "./crawl-metadata.service";
import { CrawlQualityMetricsService } from "./crawl-quality-metrics.service";
import { CrawlQualityTaskSnapshotService } from "./crawl-quality-task-snapshot.service";
import { CrawlQualityStrategyService } from "./crawl-quality.strategy";
import { CrawlQueueCleanupService } from "./crawl-queue-cleanup.service";
import { CrawlQueueEventPublisher } from "./crawl-queue-event.publisher";
import { CrawlQueueService } from "./crawl-queue.service";
import { CrawlResultService } from "./crawl-result.service";
import { CrawlSettingsService } from "./crawl-settings.service";
import { CrawlSiteProfileService } from "./crawl-site-profile.service";
import { CrawlStrategyLayeredExecutorService } from "./crawl-strategy-layered-executor.service";
import { CrawlStrategyLegacyBridgeService } from "./crawl-strategy-legacy-bridge.service";
import { CrawlStrategyRootExecutorService } from "./crawl-strategy-root-executor.service";
import { CrawlStrategyRunRecorderService } from "./crawl-strategy-run-recorder.service";
import { CrawlStrategyRuntimeService } from "./crawl-strategy-runtime.service";
import { CrawlStrategyWorkflowService } from "./crawl-strategy-workflow.service";
import { CrawlStrategyController } from "./crawl-strategy.controller";
import { CrawlTaskJanitorService } from "./crawl-task-janitor.service";
import { CrawlTaskService } from "./crawl-task.service";
import { CrawlTemplateController } from "./crawl-template.controller";
import { CrawlTemplateService } from "./crawl-template.service";
import {
  CRAWL_QUEUE,
  CRAWL_QUEUE_EVENTS,
  CRAWL_QUEUE_EVENTS_LEGACY,
  CRAWL_QUEUE_EVENTS_HOT,
  CRAWL_QUEUE_EVENTS_NORMAL,
  CRAWL_QUEUE_HOT,
  CRAWL_QUEUE_HOT_NAME,
  CRAWL_QUEUE_LLM_JUDGE,
  CRAWL_QUEUE_LLM_JUDGE_NAME,
  CRAWL_QUEUE_LLM_LEARN,
  CRAWL_QUEUE_LLM_LEARN_NAME,
  CRAWL_QUEUE_LEGACY,
  CRAWL_QUEUE_NAME,
  CRAWL_QUEUE_NORMAL,
  CRAWL_QUEUE_NORMAL_NAME,
} from "./crawl.constants";
import { CrawlController } from "./crawl.controller";
import { CrawlQueueProcessor } from "./crawl.processor";
import type { CrawlJobData } from "./crawl.types";
import { Crawl4aiQualityController } from "./crawl4ai-quality.controller";
import { Crawl4aiQueueController } from "./crawl4ai-queue.controller";
import { Crawl4aiClient } from "./crawl4ai.client";
import { NewsSourceOpmlService } from "./news-source-opml.service";
import { NewsSourceOpsSnapshotService } from "./news-source-ops-snapshot.service";
import { NewsSourceController } from "./news-source.controller";
import { NewsSourceService } from "./news-source.service";
import { JsCodeAuditService } from "./services/js-code-audit.service";

@Module({
  imports: [
    NotificationsModule,
    StorageModule,
    forwardRef(() => NewsPipelineModule),
    HttpModule.registerAsync({
      inject: [EnvService],
      useFactory: (env: EnvService) => {
        const cfg = env.crawl4aiConfig;
        return withKeepAliveAgents(
          {
            baseURL: cfg.baseUrl ? cfg.baseUrl.replace(/\/$/, "") : undefined,
            timeout: cfg.timeoutMs,
            headers: cfg.apiKey
              ? {
                  "x-api-key": cfg.apiKey,
                }
              : undefined,
          },
          env.httpAgentConfig
        );
      },
    }),
  ],
  controllers: [
    CrawlController,
    CrawlMediaAssetController,
    NewsSourceController,
    CrawlTemplateController,
    CrawlFrontierController,
    CrawlStrategyController,
    Crawl4aiQueueController,
    Crawl4aiQualityController,
  ],
  providers: [
    CrawlSettingsService,
    CrawlActivityService,
    CrawlSiteProfileService,
    CrawlStrategyLegacyBridgeService,
    CrawlStrategyLayeredExecutorService,
    CrawlStrategyRootExecutorService,
    CrawlStrategyRunRecorderService,
    CrawlStrategyWorkflowService,
    CrawlStrategyRuntimeService,
    CrawlTaskService,
    CrawlTaskJanitorService,
    CrawlExecutionService,
    CrawlFrontierLlmService,
    CrawlFrontierService,
    CrawlQueueService,
    CrawlResultService,
    CrawlMediaAssetService,
    CrawlQualityMetricsService,
    CrawlQualityTaskSnapshotService,
    ObservabilitySnapshotService,
    CrawlQualityStrategyService,
    NewsSourceOpmlService,
    NewsSourceOpsSnapshotService,
    NewsSourceService,
    CrawlTemplateService,
    CrawlCleanupOutboxService,
    CrawlMetadataService,
    JsCodeAuditService,
    Crawl4aiClient,
    CrawlQueueProcessor,
    CrawlQueueEventPublisher,
    CrawlQueueCleanupService,
    CrawlAdaptiveConcurrencyService,
    {
      provide: CRAWL_QUEUE_LEGACY,
      inject: [EnvService, CrawlQueueCleanupService],
      useFactory: (env: EnvService, cleanup: CrawlQueueCleanupService) => {
        const queue = new Queue<CrawlJobData>(CRAWL_QUEUE_NAME, {
          connection: toBullmqConnection(env.redisConfig),
          defaultJobOptions: {
            attempts: env.crawl4aiConfig.maxRetries,
            removeOnComplete: true,
            removeOnFail: BULLMQ_FAILED_JOB_RETENTION,
            backoff: {
              type: "exponential",
              delay: env.crawl4aiConfig.retryBackoffMs,
            },
          },
        });
        cleanup.track(queue);
        return queue;
      },
    },
    {
      provide: CRAWL_QUEUE_HOT,
      inject: [EnvService, CrawlQueueCleanupService],
      useFactory: (env: EnvService, cleanup: CrawlQueueCleanupService) => {
        const queue = new Queue<CrawlJobData>(CRAWL_QUEUE_HOT_NAME, {
          connection: toBullmqConnection(env.redisConfig),
          defaultJobOptions: {
            attempts: env.crawl4aiConfig.maxRetries,
            removeOnComplete: true,
            removeOnFail: BULLMQ_FAILED_JOB_RETENTION,
            backoff: {
              type: "exponential",
              delay: env.crawl4aiConfig.retryBackoffMs,
            },
          },
        });
        cleanup.track(queue);
        return queue;
      },
    },
    {
      provide: CRAWL_QUEUE_NORMAL,
      inject: [EnvService, CrawlQueueCleanupService],
      useFactory: (env: EnvService, cleanup: CrawlQueueCleanupService) => {
        const queue = new Queue<CrawlJobData>(CRAWL_QUEUE_NORMAL_NAME, {
          connection: toBullmqConnection(env.redisConfig),
          defaultJobOptions: {
            attempts: env.crawl4aiConfig.maxRetries,
            removeOnComplete: true,
            removeOnFail: BULLMQ_FAILED_JOB_RETENTION,
            backoff: {
              type: "exponential",
              delay: env.crawl4aiConfig.retryBackoffMs,
            },
          },
        });
        cleanup.track(queue);
        return queue;
      },
    },
    {
      provide: CRAWL_QUEUE_LLM_JUDGE,
      inject: [EnvService, CrawlQueueCleanupService],
      useFactory: (env: EnvService, cleanup: CrawlQueueCleanupService) => {
        const queue = new Queue<CrawlJobData>(CRAWL_QUEUE_LLM_JUDGE_NAME, {
          connection: toBullmqConnection(env.redisConfig),
          defaultJobOptions: {
            attempts: 1,
            removeOnComplete: true,
            removeOnFail: BULLMQ_FAILED_JOB_RETENTION,
            backoff: {
              type: "exponential",
              delay: env.crawl4aiConfig.retryBackoffMs,
            },
          },
        });
        cleanup.track(queue);
        return queue;
      },
    },
    {
      provide: CRAWL_QUEUE_LLM_LEARN,
      inject: [EnvService, CrawlQueueCleanupService],
      useFactory: (env: EnvService, cleanup: CrawlQueueCleanupService) => {
        const queue = new Queue<CrawlJobData>(CRAWL_QUEUE_LLM_LEARN_NAME, {
          connection: toBullmqConnection(env.redisConfig),
          defaultJobOptions: {
            attempts: 1,
            removeOnComplete: true,
            removeOnFail: BULLMQ_FAILED_JOB_RETENTION,
            backoff: {
              type: "exponential",
              delay: env.crawl4aiConfig.retryBackoffMs,
            },
          },
        });
        cleanup.track(queue);
        return queue;
      },
    },
    {
      provide: CRAWL_QUEUE_EVENTS_HOT,
      inject: [EnvService, CrawlQueueCleanupService],
      useFactory: (env: EnvService, cleanup: CrawlQueueCleanupService) => {
        const events = new QueueEvents(CRAWL_QUEUE_HOT_NAME, {
          connection: toBullmqConnection(env.redisConfig),
        });
        cleanup.track(events);
        return events;
      },
    },
    {
      provide: CRAWL_QUEUE_EVENTS_NORMAL,
      inject: [EnvService, CrawlQueueCleanupService],
      useFactory: (env: EnvService, cleanup: CrawlQueueCleanupService) => {
        const events = new QueueEvents(CRAWL_QUEUE_NORMAL_NAME, {
          connection: toBullmqConnection(env.redisConfig),
        });
        cleanup.track(events);
        return events;
      },
    },
    {
      provide: CRAWL_QUEUE_EVENTS_LEGACY,
      inject: [EnvService, CrawlQueueCleanupService],
      useFactory: (env: EnvService, cleanup: CrawlQueueCleanupService) => {
        const events = new QueueEvents(CRAWL_QUEUE_NAME, {
          connection: toBullmqConnection(env.redisConfig),
        });
        cleanup.track(events);
        return events;
      },
    },
    {
      provide: getQueueToken(CRAWL_QUEUE_HOT_NAME),
      useExisting: CRAWL_QUEUE_HOT,
    },
    {
      provide: getQueueToken(CRAWL_QUEUE_NORMAL_NAME),
      useExisting: CRAWL_QUEUE_NORMAL,
    },
    {
      provide: getQueueToken(CRAWL_QUEUE_NAME),
      useExisting: CRAWL_QUEUE_LEGACY,
    },
    {
      provide: getQueueToken(CRAWL_QUEUE_LLM_JUDGE_NAME),
      useExisting: CRAWL_QUEUE_LLM_JUDGE,
    },
    {
      provide: getQueueToken(CRAWL_QUEUE_LLM_LEARN_NAME),
      useExisting: CRAWL_QUEUE_LLM_LEARN,
    },
  ],
  exports: [
    CrawlSettingsService,
    CrawlSiteProfileService,
    CrawlStrategyLegacyBridgeService,
    CrawlStrategyWorkflowService,
    CrawlStrategyRuntimeService,
    CrawlTaskService,
    CrawlExecutionService,
    CrawlFrontierLlmService,
    CrawlQueueService,
    CrawlResultService,
    CrawlMetadataService,
    Crawl4aiClient,
    NewsSourceOpsSnapshotService,
    CrawlQueueEventPublisher,
    CrawlAdaptiveConcurrencyService,
    CRAWL_QUEUE,
    CRAWL_QUEUE_EVENTS,
    CRAWL_QUEUE_LEGACY,
    CRAWL_QUEUE_EVENTS_LEGACY,
    CRAWL_QUEUE_HOT,
    CRAWL_QUEUE_NORMAL,
    CRAWL_QUEUE_LLM_JUDGE,
    CRAWL_QUEUE_LLM_LEARN,
    CRAWL_QUEUE_EVENTS_HOT,
    CRAWL_QUEUE_EVENTS_NORMAL,
    getQueueToken(CRAWL_QUEUE_HOT_NAME),
    getQueueToken(CRAWL_QUEUE_NORMAL_NAME),
    getQueueToken(CRAWL_QUEUE_NAME),
    getQueueToken(CRAWL_QUEUE_LLM_JUDGE_NAME),
    getQueueToken(CRAWL_QUEUE_LLM_LEARN_NAME),
  ],
})
export class CrawlModule {}
