import { RawItemModel } from "@modular/mongo";
import {
  createLogger,
  DEFAULT_URL_QUERY_PARAM_ALLOWLIST,
  NotificationPresentationKind,
} from "@modular/utils";
import {
  Injectable,
  NotFoundException,
  Optional,
  type OnModuleInit,
} from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { NotificationType, PipelineJobStatus, Prisma } from "@prisma/client";
import { parseExpression } from "cron-parser";
import { createHash } from "node:crypto";

import { ItemStatus } from "../../common/pipeline-status";
import { toPrismaJsonValue } from "../../common/prisma-json";
import { CacheService } from "../cache/cache.service";
import { EnvService } from "../config/config.service";
import { PrismaService } from "../config/prisma.service";
import {
  CrawlMetadataService,
  type CrawlDiscoveryCandidate,
  type CrawlDiscoveryPrefetchedArticle,
  type CrawlDiscoveryRssBodySourceStrategy,
  type CrawlDiscoveryRssFetchOptions,
  type CrawlDiscoveryRssNoBodyPolicy,
  type CrawlDiscoveryTimestampSource,
} from "../crawl/crawl-metadata.service";
import { CrawlQueueService } from "../crawl/crawl-queue.service";
import { NewsSourceOpsSnapshotService } from "../crawl/news-source-ops-snapshot.service";
import { CrawlStrategyWorkflowService } from "../crawl/crawl-strategy-workflow.service";
import { CrawlTaskService } from "../crawl/crawl-task.service";
import { CRAWL_HOT_PRIORITY_THRESHOLD } from "../crawl/crawl.constants";
import type { CrawlPriorityClass } from "../crawl/crawl.types";
import {
  DEEP_DISCOVERY_FAILURE_STATE_TTL_SECONDS,
  DEEP_DISCOVERY_FAILURE_STATS_TTL_SECONDS,
  deepDiscoveryFailureStateCacheKey,
  deepDiscoveryFailureStatsCacheKey,
  normalizeDeepDiscoveryError,
  parseDeepDiscoveryError,
  type DeepDiscoveryFailureState,
  type DeepDiscoveryFailureStats24h,
} from "../crawl/deep-discovery-failure";
import {
  buildCanonicalUrlFingerprint,
  resolveQueryParamAllowlist,
} from "../crawl/url-fingerprint";
import { NotificationsService } from "../notifications/notifications.service";
import { NewsSourceSchedulerSettingsService } from "../system-settings/news-source-scheduler-settings.service";

import { ITEM_PIPELINE_QUEUE_NAME } from "./queue.constants";
import { QueueService } from "./queue.service";

const logger = createLogger({ name: "news-source-scheduler" });
const ACTIVE_PIPELINE_JOB_STATUSES: PipelineJobStatus[] = [
  PipelineJobStatus.pending,
  PipelineJobStatus.queued,
  PipelineJobStatus.running,
  PipelineJobStatus.delayed,
];
const DEFAULT_SEED_FRESHNESS_WINDOW_DAYS = 365;
const MAX_SEED_FRESHNESS_WINDOW_DAYS = 3_650;
const DEFAULT_SEED_CACHE_TTL_SECONDS_SITEMAP_RSS = 60;
const DEFAULT_SEED_CACHE_TTL_SECONDS_LIST_DEEP = 180;
const DEFAULT_SEED_CACHE_TTL_FORCE_GLOBAL = false;
const DEFAULT_RSS_ADAPTIVE_HOT_HIT_RATE_PERCENT = 60;
const DEFAULT_RSS_ADAPTIVE_WARM_HIT_RATE_PERCENT = 25;
const DEFAULT_RSS_ADAPTIVE_COLD_CONSECUTIVE_NO_HIT_RUNS = 4;
const DEFAULT_RSS_ADAPTIVE_HOT_INTERVAL_SECONDS = 30;
const DEFAULT_RSS_ADAPTIVE_WARM_INTERVAL_DIVISOR = 2;
const DEFAULT_RSS_ADAPTIVE_WARM_MIN_INTERVAL_SECONDS = 30;
const DEFAULT_RSS_ADAPTIVE_COLD_INTERVAL_MULTIPLIER = 2;
const DEFAULT_RSS_ADAPTIVE_COLD_MAX_INTERVAL_SECONDS = 3_600;
const DEFAULT_RSS_ADAPTIVE_HOT_DISCOVERY_CACHE_TTL_CAP_SECONDS = 30;
const DEFAULT_RSS_ADAPTIVE_WARM_DISCOVERY_CACHE_TTL_CAP_SECONDS = 60;
const SCHEDULER_DISPATCH_DEDUPE_WINDOW_MS = 25_000;
const RSS_ADAPTIVE_STATE_TTL_SECONDS = 30 * 24 * 60 * 60;
const RSS_ADAPTIVE_HISTORY_SIZE = 8;
const LEGACY_RSS_SEED_CACHE_TTL_SECONDS = 600;
const RSS_SEED_CACHE_TTL_MIGRATION_LOCK_KEY =
  "migration:news-source:rss-seed-cache-ttl-600";
const RSS_SEED_CACHE_TTL_MIGRATION_DONE_KEY =
  "migration:news-source:rss-seed-cache-ttl-600:done";
const RSS_SEED_CACHE_TTL_MIGRATION_DONE_TTL_SECONDS = 365 * 24 * 60 * 60;
const RSS_SEED_CACHE_TTL_MIGRATION_MAX_RETRIES = 3;
const SOURCE_METRIC_WINDOW_TTL_SECONDS = 24 * 60 * 60;
const SOURCE_METRIC_ALERT_COOLDOWN_SECONDS = 60 * 60;
const RSS_NO_BODY_SKIP_ALERT_THRESHOLD = 20;
const PIPELINE_RETRY_ALERT_THRESHOLD = 10;

type NewsSourceWithTemplate = Prisma.NewsSourceGetPayload<{
  include: {
    crawlTemplate: { select: { id: true; isActive: true; crawlOptions: true } };
  };
}>;

interface SeedConfig {
  enabled: boolean;
  mode: "sitemap" | "rss" | "list" | "deep";
  rssAdaptiveEnabled: boolean;
  domain?: string;
  pattern?: string;
  feedUrl?: string;
  rssFetch?: ResolvedRssFetchConfig;
  maxUrls: number;
  maxNewUrlsPerRun: number;
  listMaxPages: number;
  listPageConcurrency: number;
  followPagination: boolean;
  queryTokens?: string[];
  scoreThreshold: number;
  dedupeWindowHours: number;
  queryParamAllowlist: string[];
  cacheTtlSeconds: number;
  cacheTtlPolicy: "global_forced" | "source_override" | "mode_default";
  deep?: DeepSeedConfig;
}

interface ResolvedRssFetchConfig extends CrawlDiscoveryRssFetchOptions {
  enabled: boolean;
  requestTimeoutMs: number;
  bodySourceStrategy: CrawlDiscoveryRssBodySourceStrategy;
  noBodyPolicy: CrawlDiscoveryRssNoBodyPolicy;
}

interface CanonicalSeedJob {
  url: string;
  urlFingerprint: string;
  relevanceScore?: number;
  publishedAtTs?: number;
  crawledAtTs?: number;
  effectiveTs?: number;
  timestampSource?: CrawlDiscoveryTimestampSource;
  prefetchedArticle?: CrawlDiscoveryPrefetchedArticle;
}

interface DeepSeedConfig {
  maxPages: number;
  maxDepth: number;
  timeBudgetSeconds: number;
  pageConcurrency: number;
  scoreThreshold: number;
  candidatePoolSize: number;
  headFetchTopK: number;
  preferPathDate: boolean;
  enableSecondaryHubs: boolean;
  ignoreRobotsTxt: boolean;
}

type RssAdaptiveTier = "hot" | "warm" | "normal" | "cold";

interface RssAdaptiveState {
  outcomes: boolean[];
  consecutiveNoHit: number;
  updatedAt: string;
}

interface CronWindowConfig {
  daysOfWeek?: number[];
  startHour?: number;
  endHour?: number;
}

interface CronScheduleConfig {
  expression: string;
  timezone?: string;
  window?: CronWindowConfig;
}

interface SeedRuntimeSettings {
  seedFreshnessWindowDays: number;
  seedCacheTtlSecondsSitemapRss: number;
  seedCacheTtlSecondsListDeep: number;
  seedCacheTtlForceGlobal: boolean;
  seedUrlQueryParamAllowlist: string[];
  rssAdaptiveHotHitRatePercent: number;
  rssAdaptiveWarmHitRatePercent: number;
  rssAdaptiveColdConsecutiveNoHitRuns: number;
  rssAdaptiveHotIntervalSeconds: number;
  rssAdaptiveWarmIntervalDivisor: number;
  rssAdaptiveWarmMinIntervalSeconds: number;
  rssAdaptiveColdIntervalMultiplier: number;
  rssAdaptiveColdMaxIntervalSeconds: number;
  rssAdaptiveHotDiscoveryCacheTtlCapSeconds: number;
  rssAdaptiveWarmDiscoveryCacheTtlCapSeconds: number;
}

const DEFAULT_SEED_RUNTIME_SETTINGS: SeedRuntimeSettings = {
  seedFreshnessWindowDays: DEFAULT_SEED_FRESHNESS_WINDOW_DAYS,
  seedCacheTtlSecondsSitemapRss: DEFAULT_SEED_CACHE_TTL_SECONDS_SITEMAP_RSS,
  seedCacheTtlSecondsListDeep: DEFAULT_SEED_CACHE_TTL_SECONDS_LIST_DEEP,
  seedCacheTtlForceGlobal: DEFAULT_SEED_CACHE_TTL_FORCE_GLOBAL,
  seedUrlQueryParamAllowlist: [...DEFAULT_URL_QUERY_PARAM_ALLOWLIST],
  rssAdaptiveHotHitRatePercent: DEFAULT_RSS_ADAPTIVE_HOT_HIT_RATE_PERCENT,
  rssAdaptiveWarmHitRatePercent: DEFAULT_RSS_ADAPTIVE_WARM_HIT_RATE_PERCENT,
  rssAdaptiveColdConsecutiveNoHitRuns:
    DEFAULT_RSS_ADAPTIVE_COLD_CONSECUTIVE_NO_HIT_RUNS,
  rssAdaptiveHotIntervalSeconds: DEFAULT_RSS_ADAPTIVE_HOT_INTERVAL_SECONDS,
  rssAdaptiveWarmIntervalDivisor: DEFAULT_RSS_ADAPTIVE_WARM_INTERVAL_DIVISOR,
  rssAdaptiveWarmMinIntervalSeconds:
    DEFAULT_RSS_ADAPTIVE_WARM_MIN_INTERVAL_SECONDS,
  rssAdaptiveColdIntervalMultiplier:
    DEFAULT_RSS_ADAPTIVE_COLD_INTERVAL_MULTIPLIER,
  rssAdaptiveColdMaxIntervalSeconds:
    DEFAULT_RSS_ADAPTIVE_COLD_MAX_INTERVAL_SECONDS,
  rssAdaptiveHotDiscoveryCacheTtlCapSeconds:
    DEFAULT_RSS_ADAPTIVE_HOT_DISCOVERY_CACHE_TTL_CAP_SECONDS,
  rssAdaptiveWarmDiscoveryCacheTtlCapSeconds:
    DEFAULT_RSS_ADAPTIVE_WARM_DISCOVERY_CACHE_TTL_CAP_SECONDS,
};

@Injectable()
export class NewsSourceSchedulerService implements OnModuleInit {
  private readonly sourcePriorityMin = -100;
  private readonly sourcePriorityMax = 100;
  private readonly crawlHotPriorityThreshold = CRAWL_HOT_PRIORITY_THRESHOLD;
  private readonly crawlActorByOrgId = new Map<string, string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly metadataService: CrawlMetadataService,
    private readonly crawlQueue: CrawlQueueService,
    private readonly workflows: CrawlStrategyWorkflowService,
    private readonly queueService: QueueService,
    private readonly cache: CacheService,
    private readonly env: EnvService,
    private readonly crawlTaskService: CrawlTaskService,
    private readonly notifications: NotificationsService,
    private readonly schedulerSettings: NewsSourceSchedulerSettingsService,
    @Optional()
    private readonly newsSourceOpsSnapshots?: NewsSourceOpsSnapshotService,
  ) {}

  async onModuleInit() {
    await this.ensureLegacyRssSeedCacheTtlMigrated();
  }

  private getEnvValue<T>(
    key: string,
    fallback: T,
    normalize?: (value: unknown) => T | undefined,
  ): T {
    if (typeof this.env.get === "function") {
      const value = this.env.get<unknown>(key, { infer: true });
      if (value !== undefined && value !== null) {
        const normalized = normalize ? normalize(value) : (value as T);
        if (normalized !== undefined) {
          return normalized;
        }
      }
    }

    return fallback;
  }

  @Cron("*/30 * * * * *")
  async scheduleCron() {
    const config = this.env.newsSourceSchedulerConfig;
    if (!config.enabled) {
      return;
    }

    try {
      await this.cache.withLock(
        "cron:news-source-scheduler",
        config.lockTtlMs,
        async () => this.scheduleDueSources(new Date(), config.batchSize),
      );
    } catch (error) {
      logger.error(
        { error, lockTtlMs: config.lockTtlMs, batchSize: config.batchSize },
        "News source scheduler cron tick failed",
      );
      throw error;
    }
  }

  async dispatchNow(orgId: string, sourceId: string, triggeredById: string) {
    const now = new Date();
    const schedulerConfig = this.env.newsSourceSchedulerConfig;
    return this.cache.withLock(
      `news-source-dispatch:${sourceId}`,
      60_000,
      async () => {
        const source = await this.prisma.newsSource.findUnique({
          where: { id: sourceId },
          include: {
            crawlTemplate: {
              select: { id: true, isActive: true, crawlOptions: true },
            },
          },
        });

        if (!source || source.orgId !== orgId) {
          throw new NotFoundException("News source not found");
        }

        const dedupe = this.computeManualDispatchDedupeKey(source.id, now);
        const dedupeAcquired = await this.cache.setIfAbsent(
          dedupe.key,
          { until: dedupe.until },
          dedupe.ttlSeconds,
        );
        if (!dedupeAcquired) {
          return {
            sourceId: source.id,
            mode: this.normalizeSeedConfig(source)?.mode ?? "single",
            scheduledFor: now.toISOString(),
            nextRunAt: (source.nextRunAt ?? now).toISOString(),
            scheduledCount: 0,
            skippedCount: 0,
            enqueueFailures: 0,
            pipelineJobIds: [] as string[],
            crawlTaskIds: [] as string[],
            inFlightCount: undefined,
            inFlightLimit: undefined,
            reason: "deduped" as const,
            dedupeUntil: dedupe.until,
          };
        }

        let seedConfig: SeedConfig | null = null;
        try {
          await this.cache
            .del(`news-source:backpressure:${source.id}`)
            .catch(() => undefined);
          await this.newsSourceOpsSnapshots?.setBackpressureState(
            source.id,
            null,
          );

          const activeCutoff = new Date(
            now.getTime() - schedulerConfig.inFlightLookbackMs,
          );
          const workflowOverlay = await this.workflows.compileNewsSourceOverlay(
            {
              orgId: source.orgId,
              workflowId: source.workflowId,
              workflowVersionId: source.workflowVersionId,
              workflowBindingMode: source.workflowBindingMode,
            },
          );
          seedConfig = this.normalizeSeedConfig(
            source,
            undefined,
            workflowOverlay,
          );
          let runtimeSettings = DEFAULT_SEED_RUNTIME_SETTINGS;
          if (seedConfig) {
            runtimeSettings = await this.resolveSeedRuntimeSettings();
            const normalizedSeedConfig = this.normalizeSeedConfig(
              source,
              runtimeSettings,
              workflowOverlay,
            );
            seedConfig = normalizedSeedConfig;
            if (normalizedSeedConfig) {
              logger.debug(
                {
                  sourceId: source.id,
                  orgId: source.orgId,
                  mode: normalizedSeedConfig.mode,
                  seedFreshnessWindowDays:
                    runtimeSettings.seedFreshnessWindowDays,
                  seedCacheTtlSeconds: normalizedSeedConfig.cacheTtlSeconds,
                  seedCacheTtlPolicy: normalizedSeedConfig.cacheTtlPolicy,
                },
                "Resolved seed discovery runtime policy for dispatchNow",
              );
            }
          }
          const inFlightLimit = seedConfig ? seedConfig.maxNewUrlsPerRun : 1;
          const inFlightJobs = await this.prisma.pipelineJob.findMany({
            where: {
              sourceId: source.id,
              status: { in: ACTIVE_PIPELINE_JOB_STATUSES },
              createdAt: { gte: activeCutoff },
            },
            orderBy: { createdAt: "desc" },
            select: { id: true, status: true, createdAt: true },
            take: inFlightLimit,
          });

          const inFlightCount = inFlightJobs.length;
          const remainingCapacity = seedConfig
            ? seedConfig.maxNewUrlsPerRun - inFlightCount
            : 0;
          const shouldBlock = seedConfig
            ? remainingCapacity <= 0
            : inFlightCount > 0;

          if (shouldBlock) {
            const rescheduleAt = new Date(
              now.getTime() + schedulerConfig.inFlightRescheduleDelayMs,
            );
            await this.prisma.newsSource.updateMany({
              where: { id: source.id, orgId },
              data: {
                isActive: true,
                circuitOpenUntil: null,
                nextRunAt: rescheduleAt,
              },
            });

            return {
              sourceId: source.id,
              mode: seedConfig ? seedConfig.mode : "single",
              scheduledFor: now.toISOString(),
              nextRunAt: rescheduleAt.toISOString(),
              scheduledCount: 0,
              skippedCount: 0,
              enqueueFailures: 0,
              pipelineJobIds: [] as string[],
              crawlTaskIds: [] as string[],
              inFlightCount,
              inFlightLimit,
              reason: "in_flight" as const,
            };
          }

          const scheduledFor = now;
          const nextRunAt = this.computeNextRunAt(source, scheduledFor, now);
          const maxNewUrlsThisRun = seedConfig
            ? Math.max(0, remainingCapacity)
            : 1;
          const seedFreshnessWindowDays = seedConfig
            ? runtimeSettings.seedFreshnessWindowDays
            : DEFAULT_SEED_FRESHNESS_WINDOW_DAYS;

          const jobsToSchedule = seedConfig
            ? await this.resolveSeedCandidates(
                source,
                seedConfig,
                seedFreshnessWindowDays,
                workflowOverlay,
              )
            : [{ url: source.url, relevanceScore: undefined }];
          if (seedConfig?.mode === "deep") {
            await this.clearDeepDiscoveryFailureState(source.id);
          }

          const canonicalJobs = seedConfig
            ? this.canonicalizeSeedJobs(
                jobsToSchedule,
                seedConfig.queryParamAllowlist,
              )
            : [];
          const [recentArticleFingerprints, activeFingerprints] =
            await Promise.all([
              seedConfig
                ? this.findRecentArticleFingerprints(
                    source.orgId,
                    canonicalJobs,
                    seedConfig.dedupeWindowHours,
                  )
                : Promise.resolve(new Set<string>()),
              seedConfig
                ? this.findActivePipelineFingerprints(
                    source.id,
                    canonicalJobs,
                    activeCutoff,
                  )
                : Promise.resolve(new Set<string>()),
            ]);

          const newJobs = seedConfig
            ? canonicalJobs
                .filter(
                  (job) => !recentArticleFingerprints.has(job.urlFingerprint),
                )
                .filter((job) => !activeFingerprints.has(job.urlFingerprint))
                .slice(0, maxNewUrlsThisRun)
            : jobsToSchedule;
          const skippedCount = Math.max(
            0,
            (seedConfig ? canonicalJobs.length : jobsToSchedule.length) -
              newJobs.length,
          );

          await this.prisma.newsSource.update({
            where: { id: source.id },
            data: {
              isActive: true,
              circuitOpenUntil: null,
              lastRunAt: scheduledFor,
              nextRunAt,
            },
          });

          if (newJobs.length === 0) {
            return {
              sourceId: source.id,
              mode: seedConfig ? seedConfig.mode : "single",
              scheduledFor: scheduledFor.toISOString(),
              nextRunAt: nextRunAt.toISOString(),
              scheduledCount: 0,
              skippedCount,
              enqueueFailures: 0,
              pipelineJobIds: [] as string[],
              crawlTaskIds: [] as string[],
              inFlightCount,
              inFlightLimit,
              reason: "no_new_urls" as const,
            };
          }

          const bullPriority = this.toBullmqPriority(source.priority);
          const crawlPriorityClass = this.toCrawlPriorityClass(source.priority);
          const seedParentUrl = seedConfig
            ? seedConfig.mode === "rss"
              ? (seedConfig.feedUrl ?? source.url)
              : source.url
            : undefined;

          const pipelineJobIds: string[] = [];
          const crawlTaskIds: string[] = [];
          let enqueueFailures = 0;
          let rssSkippedNoBodyCount = 0;

          for (const job of newJobs) {
            const publishedAtTs =
              "publishedAtTs" in job ? job.publishedAtTs : undefined;
            const crawledAtTs =
              "crawledAtTs" in job ? job.crawledAtTs : undefined;
            const effectiveTs =
              "effectiveTs" in job ? job.effectiveTs : undefined;
            const timestampSource =
              "timestampSource" in job
                ? (job.timestampSource as
                    | CrawlDiscoveryTimestampSource
                    | undefined)
                : undefined;
            const publishedAt = this.toIsoTimestamp(publishedAtTs);
            const crawledAt = this.toIsoTimestamp(crawledAtTs);
            const effectiveAt = this.toIsoTimestamp(effectiveTs);
            const payload = this.buildPayload(
              source,
              job.url,
              seedConfig
                ? {
                    mode: seedConfig.mode,
                    parentUrl: seedParentUrl ?? source.url,
                    relevanceScore: job.relevanceScore,
                    publishedAt,
                    crawledAt,
                    effectiveAt,
                    timestampSource,
                    dedupeWindowHours: seedConfig.dedupeWindowHours,
                    queryParamAllowlist: seedConfig.queryParamAllowlist,
                  }
                : undefined,
            );

            if (seedConfig?.mode === "rss") {
              const rssResult = await this.enqueueRssSeedPipelineJob({
                source,
                job,
                scheduledFor,
                payload: payload as Record<string, unknown>,
                seedConfig,
                seedParentUrl: seedParentUrl ?? source.url,
                actorId: triggeredById,
                bullPriority,
              });
              if (rssResult.skippedNoBody) {
                rssSkippedNoBodyCount += 1;
                continue;
              }
              if (rssResult.pipelineJobId) {
                pipelineJobIds.push(rssResult.pipelineJobId);
              }
              if (rssResult.enqueueFailed) {
                enqueueFailures += 1;
              }
              continue;
            }

            const displayNamePrefix = `NewsSource:${source.id}:`;
            const displayName =
              `${displayNamePrefix}${source.name ?? ""}`.slice(0, 80);

            const itemPayloadConfig: Record<string, unknown> = {
              sourceId: source.id,
              sourceType: source.siteType,
              crawlTemplateId: source.crawlTemplateId ?? undefined,
              ...(seedConfig
                ? {
                    urlQueryParamAllowlist: seedConfig.queryParamAllowlist,
                  }
                : {}),
              ...(seedConfig
                ? {
                    newsSourceSeed: {
                      mode: seedConfig.mode,
                      parentUrl: seedParentUrl ?? source.url,
                      relevanceScore: job.relevanceScore,
                      publishedAt,
                      crawledAt,
                      effectiveAt,
                      timestampSource,
                      dedupeWindowHours: seedConfig.dedupeWindowHours,
                    },
                  }
                : {}),
            };

            const crawlTaskConfig: Record<string, unknown> = {
              ...(payload.crawlOptions ?? {}),
              ingestToItems: true,
              pipelineJobId: "",
              pipelinePriority: bullPriority,
              crawlPriorityClass,
              sourcePriority: source.priority,
              ...(seedConfig
                ? {
                    orgContentDedupeWindowHours: seedConfig.dedupeWindowHours,
                    urlQueryParamAllowlist: seedConfig.queryParamAllowlist,
                  }
                : {}),
              itemPayload: {
                sourceName: payload.sourceName,
                language: payload.language,
                keywords: payload.keywords,
                tags: payload.tags,
                summaryHints: payload.summaryHints,
                metadata: {
                  ...itemPayloadConfig,
                  ...(payload.metadata ?? {}),
                },
                forceRefresh: payload.forceRefresh,
              },
            };

            const { pipelineJobId, crawlTaskId } =
              await this.prisma.$transaction(async (tx) => {
                const pipelineJob = await tx.pipelineJob.create({
                  data: {
                    orgId: source.orgId,
                    sourceId: source.id,
                    url: job.url,
                    urlFingerprint:
                      "urlFingerprint" in job ? job.urlFingerprint : null,
                    priority: source.priority,
                    status: PipelineJobStatus.queued,
                    queueName: ITEM_PIPELINE_QUEUE_NAME,
                    scheduledFor,
                    metadata: {
                      sourceName: source.name,
                      sourceType: source.siteType,
                      seedMode: seedConfig ? seedConfig.mode : "single",
                      seedParentUrl: seedConfig ? seedParentUrl : undefined,
                      relevanceScore: seedConfig
                        ? job.relevanceScore
                        : undefined,
                      publishedAt,
                      crawledAt,
                      effectiveAt,
                      timestampSource,
                      urlFingerprint:
                        "urlFingerprint" in job
                          ? job.urlFingerprint
                          : undefined,
                      triggeredById,
                    },
                  },
                });

                crawlTaskConfig.pipelineJobId = pipelineJob.id;
                const crawlTaskConfigForStorage = crawlTaskConfig;

                const existingTask = await tx.crawlTask.findFirst({
                  where: {
                    orgId: source.orgId,
                    newsSourceId: source.id,
                    targetUrl: job.url,
                  },
                  select: { id: true },
                });

                let taskId: string;
                if (existingTask) {
                  const updatedTask = await tx.crawlTask.update({
                    where: { id: existingTask.id },
                    data: {
                      newsSourceId: source.id,
                      displayName,
                      status: "pending",
                      concurrency: 1,
                      keywords: payload.keywords,
                      config: toPrismaJsonValue(crawlTaskConfigForStorage),
                      lastError: null,
                    },
                    select: { id: true },
                  });
                  taskId = updatedTask.id;
                } else {
                  const createdTask = await tx.crawlTask.create({
                    data: {
                      orgId: source.orgId,
                      createdById: triggeredById,
                      newsSourceId: source.id,
                      targetUrl: job.url,
                      displayName,
                      status: "pending",
                      concurrency: 1,
                      keywords: payload.keywords,
                      config: toPrismaJsonValue(crawlTaskConfigForStorage),
                    },
                    select: { id: true },
                  });
                  taskId = createdTask.id;
                }

                await tx.pipelineJob.update({
                  where: { id: pipelineJob.id },
                  data: {
                    metadata: {
                      ...(pipelineJob.metadata as
                        | Record<string, unknown>
                        | null
                        | undefined),
                      crawlTaskId: taskId,
                    },
                  },
                });

                return {
                  pipelineJobId: pipelineJob.id,
                  crawlTaskId: taskId,
                };
              });

            pipelineJobIds.push(pipelineJobId);
            crawlTaskIds.push(crawlTaskId);

            try {
              await this.crawlQueue.enqueueTask(
                crawlTaskId,
                source.orgId,
                triggeredById,
                {
                  priorityClass: crawlPriorityClass,
                  sourcePriority: source.priority,
                  sourceId: source.id,
                },
              );
              await this.prisma.crawlTask.updateMany({
                where: { id: crawlTaskId },
                data: { status: "queued" },
              });
              await this.newsSourceOpsSnapshots?.syncQueueCounts(
                source.orgId,
                source.id,
              );
              await this.newsSourceOpsSnapshots?.refreshSnapshotForSource(
                source.orgId,
                source.id,
              );
            } catch (queueError) {
              enqueueFailures += 1;
              logger.error(
                {
                  error: queueError,
                  pipelineJobId,
                  orgId: source.orgId,
                  sourceId: source.id,
                  crawlTaskId,
                },
                "Failed to enqueue news source crawl task",
              );
              await Promise.allSettled([
                this.prisma.pipelineJob.updateMany({
                  where: { id: pipelineJobId },
                  data: {
                    status: PipelineJobStatus.failed,
                    error:
                      queueError instanceof Error
                        ? queueError.message
                        : String(queueError),
                    completedAt: new Date(),
                  },
                }),
                this.prisma.crawlTask.updateMany({
                  where: { id: crawlTaskId },
                  data: {
                    status: "failed",
                    lastError:
                      queueError instanceof Error
                        ? queueError.message
                        : String(queueError),
                  },
                }),
              ]);
              await this.newsSourceOpsSnapshots?.syncQueueCounts(
                source.orgId,
                source.id,
              );
              await this.newsSourceOpsSnapshots?.refreshSnapshotForSource(
                source.orgId,
                source.id,
              );
            }
          }
          const totalSkippedCount = skippedCount + rssSkippedNoBodyCount;
          const scheduledCount = Math.max(
            0,
            newJobs.length - rssSkippedNoBodyCount,
          );
          if (rssSkippedNoBodyCount > 0) {
            await this.recordRssNoBodySkipMetric({
              orgId: source.orgId,
              sourceId: source.id,
              sourceName: source.name ?? undefined,
              skippedCount: rssSkippedNoBodyCount,
              context: "dispatch_now",
            });
          }

          return {
            sourceId: source.id,
            mode: seedConfig ? seedConfig.mode : "single",
            scheduledFor: scheduledFor.toISOString(),
            nextRunAt: nextRunAt.toISOString(),
            scheduledCount,
            skippedCount: totalSkippedCount,
            rssSkippedNoBodyCount:
              rssSkippedNoBodyCount > 0 ? rssSkippedNoBodyCount : undefined,
            enqueueFailures,
            pipelineJobIds,
            crawlTaskIds,
            inFlightCount,
            inFlightLimit,
            reason: "ok" as const,
          };
        } catch (error) {
          await this.cache.del(dedupe.key).catch(() => undefined);
          if (
            seedConfig?.mode === "deep" &&
            this.isDeepDiscoveryFailureError(error)
          ) {
            await this.markDeepDiscoveryFailureState(source, error, new Date());
          }
          throw error;
        }
      },
    );
  }

  async cancelQueuedCrawls(
    orgId: string,
    sourceId: string,
    triggeredById: string,
  ) {
    const source = await this.prisma.newsSource.findUnique({
      where: { id: sourceId },
      select: { id: true, orgId: true, name: true },
    });
    if (!source || source.orgId !== orgId) {
      throw new NotFoundException("News source not found");
    }

    const queuedTaskIds = await this.crawlQueue.listQueuedTaskIds();
    if (queuedTaskIds.size === 0) {
      return {
        sourceId: source.id,
        removedJobs: 0,
        scannedJobs: 0,
        canceledTaskIds: [] as string[],
      };
    }

    const matchingTasks = await this.prisma.crawlTask.findMany({
      where: {
        orgId,
        id: { in: Array.from(queuedTaskIds) },
        newsSourceId: source.id,
      },
      select: { id: true },
    });

    const taskIdsToCancel = new Set(matchingTasks.map((task) => task.id));
    const { scanned, removed, removedTaskIds } =
      await this.crawlQueue.removeQueuedJobsForTasks(taskIdsToCancel);

    if (removedTaskIds.length > 0) {
      await this.prisma.crawlTask.updateMany({
        where: { orgId, id: { in: removedTaskIds } },
        data: {
          status: "paused",
          lastError: `Canceled by ${triggeredById}`,
        },
      });
      await this.newsSourceOpsSnapshots?.syncQueueCounts(orgId, source.id);
      await this.newsSourceOpsSnapshots?.refreshSnapshotForSource(
        orgId,
        source.id,
      );
    }

    return {
      sourceId: source.id,
      removedJobs: removed,
      scannedJobs: scanned,
      canceledTaskIds: removedTaskIds,
    };
  }

  async clearInFlight(orgId: string, sourceId: string) {
    const source = await this.prisma.newsSource.findUnique({
      where: { id: sourceId },
      select: { id: true, orgId: true },
    });
    if (!source || source.orgId !== orgId) {
      throw new NotFoundException("News source not found");
    }

    const activeCutoff = new Date(
      Date.now() - this.env.newsSourceSchedulerConfig.inFlightLookbackMs,
    );

    const cleared = await this.prisma.pipelineJob.updateMany({
      where: {
        orgId,
        sourceId: source.id,
        status: { in: ACTIVE_PIPELINE_JOB_STATUSES },
        createdAt: { gte: activeCutoff },
      },
      data: {
        status: PipelineJobStatus.failed,
        error: "Cleared by admin",
        completedAt: new Date(),
      },
    });

    await this.newsSourceOpsSnapshots?.refreshSnapshotForSource(
      orgId,
      source.id,
    );

    return {
      sourceId: source.id,
      cutoff: activeCutoff.toISOString(),
      clearedJobs: cleared.count,
    };
  }

  async retryLatestFailedTask(
    orgId: string,
    sourceId: string,
    userId: string,
    ip?: string,
    actorPermissions?: string[],
  ) {
    const source = await this.prisma.newsSource.findUnique({
      where: { id: sourceId },
      select: { id: true, orgId: true, name: true },
    });
    if (!source || source.orgId !== orgId) {
      throw new NotFoundException("News source not found");
    }

    const latestJob = await this.prisma.pipelineJob.findFirst({
      where: { orgId, sourceId: source.id },
      orderBy: { createdAt: "desc" },
      select: { id: true, status: true, metadata: true },
    });
    if (!latestJob) {
      throw new NotFoundException("No pipeline job found for source");
    }

    const isRecord = (value: unknown): value is Record<string, unknown> =>
      Boolean(value) && typeof value === "object" && !Array.isArray(value);
    const metadata = isRecord(latestJob.metadata) ? latestJob.metadata : {};
    const crawlTaskId = metadata.crawlTaskId;
    if (typeof crawlTaskId === "string" && crawlTaskId.length > 0) {
      const task = await this.prisma.crawlTask.findFirst({
        where: { orgId, id: crawlTaskId },
        select: { status: true },
      });
      if (!task) {
        throw new NotFoundException("crawl task not found");
      }
      if (task.status !== "failed") {
        return {
          sourceId: source.id,
          retryType: "crawl" as const,
          crawlTaskId,
          status: task.status,
          retried: false,
        };
      }

      const retried = await this.crawlTaskService.retryTask(
        orgId,
        userId,
        crawlTaskId,
        ip,
        actorPermissions,
      );
      if (retried) {
        await this.newsSourceOpsSnapshots?.syncQueueCounts(orgId, source.id);
        await this.newsSourceOpsSnapshots?.refreshSnapshotForSource(
          orgId,
          source.id,
        );
      }
      return {
        sourceId: source.id,
        retryType: "crawl" as const,
        crawlTaskId,
        status: retried.status,
        retried: true,
      };
    }

    const itemMetaId = metadata.itemMetaId;
    const rawItemId = metadata.rawItemId;
    if (
      typeof itemMetaId !== "string" ||
      itemMetaId.length === 0 ||
      typeof rawItemId !== "string" ||
      rawItemId.length === 0
    ) {
      throw new NotFoundException("No retryable task found for latest job");
    }

    if (latestJob.status !== PipelineJobStatus.failed) {
      return {
        sourceId: source.id,
        retryType: "pipeline" as const,
        pipelineJobId: latestJob.id,
        status: latestJob.status,
        retried: false,
      };
    }

    await this.prisma.pipelineJob.updateMany({
      where: { id: latestJob.id },
      data: {
        status: PipelineJobStatus.queued,
        startedAt: null,
        completedAt: null,
        error: null,
      },
    });

    try {
      await this.queueService.enqueueItem(
        orgId,
        itemMetaId,
        rawItemId,
        {},
        {
          pipelineJobId: latestJob.id,
          sourceId: source.id,
        },
        { retryIfFailed: true },
      );
    } catch (error) {
      await this.prisma.pipelineJob.updateMany({
        where: { id: latestJob.id },
        data: {
          status: PipelineJobStatus.failed,
          error: error instanceof Error ? error.message : String(error),
          completedAt: new Date(),
        },
      });
      throw error;
    }
    await this.recordPipelineRetryMetric({
      orgId,
      sourceId: source.id,
      sourceName: source.name ?? undefined,
      pipelineJobId: latestJob.id,
    });
    await this.newsSourceOpsSnapshots?.refreshSnapshotForSource(
      orgId,
      source.id,
    );
    return {
      sourceId: source.id,
      retryType: "pipeline" as const,
      pipelineJobId: latestJob.id,
      status: PipelineJobStatus.queued,
      retried: true,
    };
  }

  private async recordRssNoBodySkipMetric(options: {
    orgId: string;
    sourceId: string;
    sourceName?: string;
    skippedCount: number;
    context: "dispatch_now" | "schedule";
  }) {
    const skippedCount = Math.max(0, Math.floor(options.skippedCount));
    if (skippedCount <= 0) {
      return;
    }
    const sourceKey = `news-source:metric:rss-no-body-skip:source:${options.sourceId}:24h`;
    const orgKey = `news-source:metric:rss-no-body-skip:org:${options.orgId}:24h`;

    try {
      const [sourceCount, orgCount] = await Promise.all([
        this.cache.hincrby(sourceKey, "count", skippedCount),
        this.cache.hincrby(orgKey, "count", skippedCount),
      ]);
      await Promise.allSettled([
        this.cache.expire(sourceKey, SOURCE_METRIC_WINDOW_TTL_SECONDS),
        this.cache.expire(orgKey, SOURCE_METRIC_WINDOW_TTL_SECONDS),
      ]);

      logger.warn(
        {
          orgId: options.orgId,
          sourceId: options.sourceId,
          skippedCount,
          sourceCount24h: sourceCount,
          orgCount24h: orgCount,
          context: options.context,
        },
        "Recorded RSS no-body skip metric",
      );

      if (sourceCount < RSS_NO_BODY_SKIP_ALERT_THRESHOLD) {
        return;
      }

      const notifyKey = `news-source:metric:rss-no-body-skip:alert:${options.sourceId}`;
      const shouldNotify = await this.cache.setIfAbsent(
        notifyKey,
        {
          at: new Date().toISOString(),
          sourceCount24h: sourceCount,
          orgCount24h: orgCount,
          context: options.context,
        },
        SOURCE_METRIC_ALERT_COOLDOWN_SECONDS,
      );
      if (!shouldNotify) {
        return;
      }

      const sourceName = options.sourceName?.trim().length
        ? options.sourceName.trim()
        : ((
            await this.prisma.newsSource.findUnique({
              where: { id: options.sourceId },
              select: { name: true },
            })
          )?.name ?? null);

      await this.notifications.notify({
        orgId: options.orgId,
        userId: null,
        type: NotificationType.system,
        title: "News source RSS body-missing spike",
        body: `Source ${sourceName ?? options.sourceId} skipped ${sourceCount} RSS item(s) without usable body in the last 24h.`,
        data: {
          sourceId: options.sourceId,
          ...(sourceName ? { sourceName } : {}),
          skippedCount,
          sourceCount24h: sourceCount,
          orgCount24h: orgCount,
          context: options.context,
          threshold: RSS_NO_BODY_SKIP_ALERT_THRESHOLD,
          presentation: {
            kind: NotificationPresentationKind.NewsSourceRssBodyMissingSpike,
            params: {
              sourceId: options.sourceId,
              ...(sourceName ? { sourceName } : {}),
              skippedCount,
              sourceCount24h: sourceCount,
              orgCount24h: orgCount,
              context: options.context,
              threshold: RSS_NO_BODY_SKIP_ALERT_THRESHOLD,
            },
          },
        },
      });
    } catch (error) {
      logger.warn(
        {
          error,
          orgId: options.orgId,
          sourceId: options.sourceId,
          skippedCount,
        },
        "Failed to record RSS no-body skip metric",
      );
    }
  }

  private async recordPipelineRetryMetric(options: {
    orgId: string;
    sourceId: string;
    sourceName?: string;
    pipelineJobId: string;
  }) {
    const sourceKey = `news-source:metric:pipeline-retry:source:${options.sourceId}:24h`;
    const orgKey = `news-source:metric:pipeline-retry:org:${options.orgId}:24h`;

    try {
      const [sourceCount, orgCount] = await Promise.all([
        this.cache.hincrby(sourceKey, "count", 1),
        this.cache.hincrby(orgKey, "count", 1),
      ]);
      await Promise.allSettled([
        this.cache.expire(sourceKey, SOURCE_METRIC_WINDOW_TTL_SECONDS),
        this.cache.expire(orgKey, SOURCE_METRIC_WINDOW_TTL_SECONDS),
      ]);

      logger.info(
        {
          orgId: options.orgId,
          sourceId: options.sourceId,
          pipelineJobId: options.pipelineJobId,
          retryType: "pipeline",
          sourceCount24h: sourceCount,
          orgCount24h: orgCount,
        },
        "Recorded pipeline retry metric",
      );

      if (sourceCount < PIPELINE_RETRY_ALERT_THRESHOLD) {
        return;
      }

      const notifyKey = `news-source:metric:pipeline-retry:alert:${options.sourceId}`;
      const shouldNotify = await this.cache.setIfAbsent(
        notifyKey,
        {
          at: new Date().toISOString(),
          sourceCount24h: sourceCount,
          orgCount24h: orgCount,
          pipelineJobId: options.pipelineJobId,
        },
        SOURCE_METRIC_ALERT_COOLDOWN_SECONDS,
      );
      if (!shouldNotify) {
        return;
      }

      const sourceName = options.sourceName?.trim().length
        ? options.sourceName.trim()
        : ((
            await this.prisma.newsSource.findUnique({
              where: { id: options.sourceId },
              select: { name: true },
            })
          )?.name ?? null);

      await this.notifications.notify({
        orgId: options.orgId,
        userId: null,
        type: NotificationType.system,
        title: "News source pipeline retry spike",
        body: `Source ${sourceName ?? options.sourceId} retried ${sourceCount} pipeline job(s) in the last 24h.`,
        data: {
          sourceId: options.sourceId,
          ...(sourceName ? { sourceName } : {}),
          pipelineJobId: options.pipelineJobId,
          retryType: "pipeline",
          sourceCount24h: sourceCount,
          orgCount24h: orgCount,
          threshold: PIPELINE_RETRY_ALERT_THRESHOLD,
          presentation: {
            kind: NotificationPresentationKind.NewsSourcePipelineRetrySpike,
            params: {
              sourceId: options.sourceId,
              ...(sourceName ? { sourceName } : {}),
              pipelineJobId: options.pipelineJobId,
              retryType: "pipeline",
              sourceCount24h: sourceCount,
              orgCount24h: orgCount,
              threshold: PIPELINE_RETRY_ALERT_THRESHOLD,
            },
          },
        },
      });
    } catch (error) {
      logger.warn(
        {
          error,
          orgId: options.orgId,
          sourceId: options.sourceId,
          pipelineJobId: options.pipelineJobId,
        },
        "Failed to record pipeline retry metric",
      );
    }
  }

  private normalizeStringList(value: unknown) {
    if (!Array.isArray(value)) {
      return [];
    }
    return value
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter((entry) => entry.length > 0);
  }

  private normalizeOptions(
    value: unknown,
  ): Record<string, unknown> | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }
    return value as Record<string, unknown>;
  }

  private mergeOptions(
    base: Record<string, unknown> | undefined,
    override: Record<string, unknown> | undefined,
  ) {
    if (!base && !override) {
      return undefined;
    }
    if (!base) {
      return override;
    }
    if (!override) {
      return base;
    }
    return { ...base, ...override };
  }

  private withAutoCrawlQualityDefaults(
    options: Record<string, unknown> | undefined,
    seedMode?: SeedConfig["mode"],
  ): Record<string, unknown> {
    const current = options ? { ...options } : {};

    if (typeof current.headless !== "boolean") {
      current.headless = false;
    }
    if (typeof current.enableUndetectedBrowser !== "boolean") {
      current.enableUndetectedBrowser = true;
    }
    if (typeof current.enableStealthMode !== "boolean") {
      current.enableStealthMode = true;
    }
    if (typeof current.simulateUser !== "boolean") {
      current.simulateUser = true;
    }
    if (typeof current.overrideNavigator !== "boolean") {
      current.overrideNavigator = true;
    }
    if (typeof current.userAgentMode !== "string") {
      current.userAgentMode = "random";
    }
    if (typeof current.waitUntil !== "string") {
      current.waitUntil = "networkidle";
    }
    if (
      typeof current.waitForTimeoutMs !== "number" ||
      !Number.isFinite(current.waitForTimeoutMs)
    ) {
      current.waitForTimeoutMs = 12_000;
    }
    if (
      typeof current.delayBeforeReturnHtmlMs !== "number" ||
      !Number.isFinite(current.delayBeforeReturnHtmlMs)
    ) {
      current.delayBeforeReturnHtmlMs = 2_000;
    }
    if (
      typeof current.meanDelayMs !== "number" ||
      !Number.isFinite(current.meanDelayMs)
    ) {
      current.meanDelayMs = 900;
    }
    if (
      typeof current.maxDelayRangeMs !== "number" ||
      !Number.isFinite(current.maxDelayRangeMs)
    ) {
      current.maxDelayRangeMs = 1_600;
    }

    const markdownOptions =
      current.markdownOptions &&
      typeof current.markdownOptions === "object" &&
      !Array.isArray(current.markdownOptions)
        ? ({ ...current.markdownOptions } as Record<string, unknown>)
        : {};
    if (typeof markdownOptions.contentSource !== "string") {
      markdownOptions.contentSource = "cleaned_html";
    }
    if (typeof markdownOptions.citations !== "boolean") {
      markdownOptions.citations = true;
    }
    current.markdownOptions = markdownOptions;

    const cleanMarkdown =
      current.cleanMarkdown &&
      typeof current.cleanMarkdown === "object" &&
      !Array.isArray(current.cleanMarkdown)
        ? ({ ...current.cleanMarkdown } as Record<string, unknown>)
        : {};
    if (typeof cleanMarkdown.removeOverlayElements !== "boolean") {
      cleanMarkdown.removeOverlayElements = true;
    }
    if (
      typeof cleanMarkdown.wordCountThreshold !== "number" ||
      !Number.isFinite(cleanMarkdown.wordCountThreshold)
    ) {
      cleanMarkdown.wordCountThreshold = 20;
    }
    const excludedTags = Array.isArray(cleanMarkdown.excludedTags)
      ? (cleanMarkdown.excludedTags as unknown[])
          .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
          .filter((entry) => entry.length > 0)
      : [];
    cleanMarkdown.excludedTags = Array.from(
      new Set([
        "nav",
        "footer",
        "aside",
        "script",
        "style",
        "noscript",
        "form",
        ...excludedTags,
      ]),
    ).slice(0, 12);
    if (!("cssSelector" in cleanMarkdown)) {
      cleanMarkdown.cssSelector = undefined;
    }
    current.cleanMarkdown = cleanMarkdown;

    if (typeof current.pageTypeHint !== "string") {
      current.pageTypeHint = "auto";
    }
    if (typeof current.autoExpandDetails !== "boolean") {
      current.autoExpandDetails = this.getEnvValue(
        "NEWS_SOURCE_CRAWL_AUTO_EXPAND_DETAILS",
        true,
        (value) => (typeof value === "boolean" ? value : undefined),
      );
    }
    if (typeof current.qualityProfile !== "string") {
      current.qualityProfile = this.getEnvValue(
        "NEWS_SOURCE_CRAWL_QUALITY_PROFILE",
        "quality_first",
        (value) => (typeof value === "string" ? value : undefined),
      );
    }

    const currentDetailExpansion =
      current.detailExpansion &&
      typeof current.detailExpansion === "object" &&
      !Array.isArray(current.detailExpansion)
        ? (current.detailExpansion as Record<string, unknown>)
        : {};
    current.detailExpansion = {
      maxDetailUrls:
        typeof currentDetailExpansion.maxDetailUrls === "number"
          ? currentDetailExpansion.maxDetailUrls
          : this.getEnvValue(
              "NEWS_SOURCE_CRAWL_DETAIL_MAX_URLS",
              12,
              (value) =>
                typeof value === "number" && Number.isFinite(value)
                  ? value
                  : undefined,
            ),
      minRelevanceScore:
        typeof currentDetailExpansion.minRelevanceScore === "number"
          ? currentDetailExpansion.minRelevanceScore
          : this.getEnvValue(
              "NEWS_SOURCE_CRAWL_DETAIL_MIN_RELEVANCE_SCORE",
              0.35,
              (value) =>
                typeof value === "number" && Number.isFinite(value)
                  ? value
                  : undefined,
            ),
      requireSameDomain:
        typeof currentDetailExpansion.requireSameDomain === "boolean"
          ? currentDetailExpansion.requireSameDomain
          : this.getEnvValue(
              "NEWS_SOURCE_CRAWL_DETAIL_REQUIRE_SAME_DOMAIN",
              true,
              (value) => (typeof value === "boolean" ? value : undefined),
            ),
      allowExternalLinks:
        typeof currentDetailExpansion.allowExternalLinks === "boolean"
          ? currentDetailExpansion.allowExternalLinks
          : true,
      includeUrlPatterns: Array.isArray(
        currentDetailExpansion.includeUrlPatterns,
      )
        ? currentDetailExpansion.includeUrlPatterns
            .filter((value): value is string => typeof value === "string")
            .map((value) => value.trim())
            .filter((value) => value.length > 0)
            .slice(0, 25)
        : undefined,
      excludeUrlPatterns: Array.isArray(
        currentDetailExpansion.excludeUrlPatterns,
      )
        ? currentDetailExpansion.excludeUrlPatterns
            .filter((value): value is string => typeof value === "string")
            .map((value) => value.trim())
            .filter((value) => value.length > 0)
            .slice(0, 25)
        : [
            "/tag/",
            "/tags/",
            "/topic/",
            "/topics/",
            "/archive/",
            "/category/",
            "/categories/",
            "/author/",
            "/authors/",
            "/section/",
            "/sections/",
            "/latest",
          ],
      minPublishTimeConfidence:
        typeof currentDetailExpansion.minPublishTimeConfidence === "number" &&
        Number.isFinite(currentDetailExpansion.minPublishTimeConfidence)
          ? Math.max(
              0,
              Math.min(
                1,
                Number(
                  currentDetailExpansion.minPublishTimeConfidence.toFixed(3),
                ),
              ),
            )
          : 0.55,
      preferFitMarkdownForQuality:
        typeof currentDetailExpansion.preferFitMarkdownForQuality === "boolean"
          ? currentDetailExpansion.preferFitMarkdownForQuality
          : true,
    };

    if (seedMode === "list" || seedMode === "deep") {
      if (typeof current.extractLinks !== "boolean") {
        current.extractLinks = true;
      }
      if (typeof current.prefetch !== "boolean") {
        current.prefetch = true;
      }
      if (typeof current.scanFullPage !== "boolean") {
        current.scanFullPage = false;
      }
      if (
        !current.virtualScroll ||
        typeof current.virtualScroll !== "object" ||
        Array.isArray(current.virtualScroll)
      ) {
        current.virtualScroll = {
          containerSelector: "body",
          scrollCount: 8,
          scrollBy: "page_height",
          waitAfterScrollMs: 700,
        };
      }
    }

    return current;
  }

  private toBullmqPriority(priority: number) {
    const clamped = this.normalizeSourcePriority(priority);
    return this.sourcePriorityMax + 1 - clamped;
  }

  private toCrawlPriorityClass(priority: number): CrawlPriorityClass {
    const normalized = this.normalizeSourcePriority(priority);
    return normalized >= this.crawlHotPriorityThreshold ? "hot" : "normal";
  }

  private normalizeSourcePriority(priority: number) {
    const normalized = Number.isFinite(priority) ? Math.round(priority) : 0;
    return Math.max(
      this.sourcePriorityMin,
      Math.min(this.sourcePriorityMax, normalized),
    );
  }

  private computeNextIntervalRunAt(
    frequencySeconds: number,
    scheduledFor: Date,
    now: Date,
  ) {
    const seconds = Number.isFinite(frequencySeconds)
      ? Math.max(0, Math.floor(frequencySeconds))
      : 0;
    const anchor = Math.max(scheduledFor.getTime(), now.getTime());
    const baseMs = anchor + seconds * 1000;

    const jitterMaxMsRaw = this.env.newsSourceSchedulerConfig.jitterMaxMs;
    const jitterMaxMs = Number.isFinite(jitterMaxMsRaw)
      ? Math.max(0, Math.floor(jitterMaxMsRaw))
      : 0;
    if (jitterMaxMs <= 0 || seconds === 0) {
      return new Date(baseMs);
    }

    const cappedJitterMaxMs = Math.min(jitterMaxMs, seconds * 1000);
    const jitterMs =
      cappedJitterMaxMs > 0
        ? Math.floor(Math.random() * (cappedJitterMaxMs + 1))
        : 0;
    return new Date(baseMs + jitterMs);
  }

  private normalizeCronSchedule(
    source: NewsSourceWithTemplate,
  ): CronScheduleConfig | null {
    const rawConfig =
      source.config &&
      typeof source.config === "object" &&
      !Array.isArray(source.config)
        ? (source.config as Record<string, unknown>)
        : null;

    const schedule =
      rawConfig?.schedule &&
      typeof rawConfig.schedule === "object" &&
      !Array.isArray(rawConfig.schedule)
        ? (rawConfig.schedule as Record<string, unknown>)
        : null;

    const modeRaw =
      typeof schedule?.mode === "string"
        ? schedule.mode.trim().toLowerCase()
        : "";
    if (modeRaw !== "cron") {
      return null;
    }

    const cron =
      schedule?.cron &&
      typeof schedule.cron === "object" &&
      !Array.isArray(schedule.cron)
        ? (schedule.cron as Record<string, unknown>)
        : null;

    const expression =
      typeof cron?.expression === "string" ? cron.expression.trim() : "";
    if (!expression) {
      return null;
    }

    const timezoneRaw =
      typeof cron?.timezone === "string" ? cron.timezone.trim() : "";
    const timezone = timezoneRaw.length > 0 ? timezoneRaw : undefined;

    const window =
      schedule?.window &&
      typeof schedule.window === "object" &&
      !Array.isArray(schedule.window)
        ? (schedule.window as Record<string, unknown>)
        : null;

    const daysOfWeekRaw = Array.isArray(window?.daysOfWeek)
      ? window?.daysOfWeek
      : [];
    const daysOfWeek = daysOfWeekRaw
      .filter(
        (entry): entry is number =>
          typeof entry === "number" && Number.isFinite(entry),
      )
      .map((value) => Math.floor(value))
      .filter((value) => value >= 0 && value <= 6);

    const startHourRaw = window?.startHour;
    const endHourRaw = window?.endHour;
    const startHour =
      typeof startHourRaw === "number" && Number.isFinite(startHourRaw)
        ? Math.max(0, Math.min(23, Math.floor(startHourRaw)))
        : undefined;
    const endHour =
      typeof endHourRaw === "number" && Number.isFinite(endHourRaw)
        ? Math.max(1, Math.min(24, Math.floor(endHourRaw)))
        : undefined;

    const cronWindow: CronWindowConfig | undefined =
      daysOfWeek.length > 0 || startHour !== undefined || endHour !== undefined
        ? {
            daysOfWeek:
              daysOfWeek.length > 0
                ? Array.from(new Set(daysOfWeek))
                : undefined,
            startHour,
            endHour,
          }
        : undefined;

    return {
      expression,
      timezone,
      window: cronWindow,
    };
  }

  private getZonedWeekdayAndHour(date: Date, timezone?: string) {
    const weekdayMap: Record<string, number> = {
      Sun: 0,
      Mon: 1,
      Tue: 2,
      Wed: 3,
      Thu: 4,
      Fri: 5,
      Sat: 6,
    };

    const tz = timezone ?? "UTC";
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        weekday: "short",
        hour: "2-digit",
        hourCycle: "h23",
      }).formatToParts(date);

      const weekdayLabel = parts.find((part) => part.type === "weekday")?.value;
      const hourLabel = parts.find((part) => part.type === "hour")?.value;

      const weekday =
        typeof weekdayLabel === "string" ? weekdayMap[weekdayLabel] : undefined;
      const hour =
        typeof hourLabel === "string" ? Number.parseInt(hourLabel, 10) : NaN;

      if (typeof weekday !== "number" || !Number.isFinite(hour)) {
        return { weekday: null as number | null, hour: null as number | null };
      }
      return { weekday, hour };
    } catch {
      return { weekday: null as number | null, hour: null as number | null };
    }
  }

  private isWithinCronWindow(
    date: Date,
    window: CronWindowConfig | undefined,
    timezone?: string,
  ) {
    if (!window) {
      return true;
    }

    const { weekday, hour } = this.getZonedWeekdayAndHour(date, timezone);
    if (weekday === null || hour === null) {
      return true;
    }

    const allowedDays = window.daysOfWeek;
    if (
      Array.isArray(allowedDays) &&
      allowedDays.length > 0 &&
      !allowedDays.includes(weekday)
    ) {
      return false;
    }

    const startHour = window.startHour;
    const endHour = window.endHour;
    if (
      typeof startHour === "number" &&
      typeof endHour === "number" &&
      Number.isFinite(startHour) &&
      Number.isFinite(endHour) &&
      startHour < endHour
    ) {
      if (hour < startHour || hour >= endHour) {
        return false;
      }
    }

    return true;
  }

  private computeNextRunAt(
    source: NewsSourceWithTemplate,
    scheduledFor: Date,
    now: Date,
    options?: { intervalSecondsOverride?: number },
  ) {
    const cron = this.normalizeCronSchedule(source);
    if (cron) {
      const base = new Date(Math.max(scheduledFor.getTime(), now.getTime()));
      const tz = cron.timezone ?? "UTC";
      try {
        const interval = parseExpression(cron.expression, {
          currentDate: base,
          tz,
        });
        for (let i = 0; i < 200; i += 1) {
          const next = interval.next().toDate();
          if (this.isWithinCronWindow(next, cron.window, tz)) {
            return next;
          }
        }
        return interval.next().toDate();
      } catch (error) {
        logger.warn(
          { sourceId: source.id, orgId: source.orgId, error },
          "Failed to compute cron nextRunAt; falling back to interval schedule",
        );
      }
    }

    return this.computeNextIntervalRunAt(
      options?.intervalSecondsOverride ?? source.frequencySeconds,
      scheduledFor,
      now,
    );
  }

  /**
   * Shared dispatch dedupe key used by BOTH the cron scheduler and manual dispatchNow.
   * Previously the two paths used disjoint namespaces (dispatch-minute vs dispatch-window),
   * so setIfAbsent in one never blocked the other and the same source could be scheduled
   * concurrently (C-2). Using one namespace + one aligned window (< the 30s cron interval,
   * so cron ticks never self-dedupe) makes the two paths mutually exclusive per window.
   */
  private computeSharedDispatchDedupeKey(sourceId: string, now: Date) {
    const windowMs = SCHEDULER_DISPATCH_DEDUPE_WINDOW_MS;
    const bucketStartMs = Math.floor(now.getTime() / windowMs) * windowMs;
    const bucketStart = new Date(bucketStartMs);
    const bucketEnd = new Date(bucketStartMs + windowMs);
    const ttlSeconds = Math.max(
      1,
      Math.ceil((bucketEnd.getTime() - now.getTime()) / 1000) + 2,
    );
    return {
      key: `news-source:dispatch:${sourceId}:${bucketStart.toISOString()}`,
      until: bucketEnd.toISOString(),
      ttlSeconds,
    };
  }

  private computeManualDispatchDedupeKey(sourceId: string, now: Date) {
    return this.computeSharedDispatchDedupeKey(sourceId, now);
  }

  private computeSchedulerDispatchDedupeKey(sourceId: string, now: Date) {
    return this.computeSharedDispatchDedupeKey(sourceId, now);
  }

  private isDeepDiscoveryFailureError(error: unknown) {
    return Boolean(parseDeepDiscoveryError(error));
  }

  private computeExponentialBackoffDelay(
    baseDelayMs: number,
    attempt: number,
    maxDelayMs: number,
  ) {
    const normalizedAttempt = Math.max(1, Math.floor(attempt));
    const normalizedBase = Math.max(1, Math.floor(baseDelayMs));
    const normalizedMax = Math.max(normalizedBase, Math.floor(maxDelayMs));
    const exponential =
      normalizedBase * 2 ** Math.max(0, normalizedAttempt - 1);
    const capped = Math.min(exponential, normalizedMax);
    const jitterFactor = 0.75 + Math.random() * 0.5;
    return Math.round(capped * jitterFactor);
  }

  private normalizeDeepFailureStats24h(
    value: unknown,
  ): DeepDiscoveryFailureStats24h {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return {
        total: 0,
        byCode: {},
        updatedAt: new Date(0).toISOString(),
      };
    }
    const record = value as Record<string, unknown>;
    const byCodeRecord =
      record.byCode &&
      typeof record.byCode === "object" &&
      !Array.isArray(record.byCode)
        ? (record.byCode as Record<string, unknown>)
        : {};
    const byCode: Record<string, number> = {};
    for (const [code, countRaw] of Object.entries(byCodeRecord)) {
      if (!code || !code.startsWith("SEED_DEEP_")) {
        continue;
      }
      if (typeof countRaw !== "number" || !Number.isFinite(countRaw)) {
        continue;
      }
      const count = Math.max(0, Math.floor(countRaw));
      if (count <= 0) {
        continue;
      }
      byCode[code] = count;
    }

    const totalRaw =
      typeof record.total === "number" && Number.isFinite(record.total)
        ? Math.max(0, Math.floor(record.total))
        : Object.values(byCode).reduce((sum, count) => sum + count, 0);
    const updatedAt =
      typeof record.updatedAt === "string" && record.updatedAt.length > 0
        ? record.updatedAt
        : new Date().toISOString();
    return {
      total: totalRaw,
      byCode,
      updatedAt,
    };
  }

  private async clearDeepDiscoveryFailureState(sourceId: string) {
    await this.cache
      .del(deepDiscoveryFailureStateCacheKey(sourceId))
      .catch(() => undefined);
  }

  private async markDeepDiscoveryFailureState(
    source: NewsSourceWithTemplate,
    error: unknown,
    failureAt: Date,
  ) {
    const normalizedError = normalizeDeepDiscoveryError(error);
    const cfg = this.env.newsSourceSchedulerConfig;
    const stateKey = deepDiscoveryFailureStateCacheKey(source.id);
    const statsKey = deepDiscoveryFailureStatsCacheKey(source.id);
    const existingState =
      await this.cache.get<DeepDiscoveryFailureState>(stateKey);
    const previousStreak =
      typeof existingState?.streak === "number" &&
      Number.isFinite(existingState.streak)
        ? Math.max(0, Math.floor(existingState.streak))
        : 0;
    const streak = previousStreak + 1;

    const retryDelayMs = this.computeExponentialBackoffDelay(
      cfg.failureRecoveryDelayMs,
      streak,
      cfg.failureMaxDelayMs,
    );
    const retryAt = new Date(failureAt.getTime() + retryDelayMs);

    const threshold = Math.max(0, Math.floor(cfg.circuitBreakerThreshold));
    let circuitOpenUntil: Date | null = null;
    if (threshold > 0 && streak >= threshold) {
      const circuitAttempt = streak - threshold + 1;
      const circuitDelayMs = this.computeExponentialBackoffDelay(
        cfg.circuitBreakerBaseDelayMs,
        circuitAttempt,
        cfg.circuitBreakerMaxDelayMs,
      );
      circuitOpenUntil = new Date(failureAt.getTime() + circuitDelayMs);
    }

    const nextRunAt =
      circuitOpenUntil && circuitOpenUntil.getTime() > retryAt.getTime()
        ? circuitOpenUntil
        : retryAt;

    await this.prisma.newsSource.updateMany({
      where: { id: source.id, isActive: true },
      data: {
        lastFailureAt: failureAt,
        nextRunAt,
        circuitOpenUntil,
      },
    });

    const statePayload: DeepDiscoveryFailureState = {
      streak,
      lastFailureAt: failureAt.toISOString(),
      lastCode: normalizedError.code,
      lastMessage: normalizedError.message,
      lastDetail: normalizedError.detail,
      retryAt: retryAt.toISOString(),
      nextRunAt: nextRunAt.toISOString(),
      circuitOpenUntil: circuitOpenUntil
        ? circuitOpenUntil.toISOString()
        : null,
    };
    await this.cache.set(
      stateKey,
      statePayload,
      DEEP_DISCOVERY_FAILURE_STATE_TTL_SECONDS,
    );

    const existingStatsRaw =
      await this.cache.get<DeepDiscoveryFailureStats24h>(statsKey);
    const existingStats = this.normalizeDeepFailureStats24h(existingStatsRaw);
    const nextByCode = { ...existingStats.byCode };
    nextByCode[normalizedError.code] =
      (nextByCode[normalizedError.code] ?? 0) + 1;
    const nextStats: DeepDiscoveryFailureStats24h = {
      total: existingStats.total + 1,
      byCode: nextByCode,
      updatedAt: failureAt.toISOString(),
    };
    await this.cache.set(
      statsKey,
      nextStats,
      DEEP_DISCOVERY_FAILURE_STATS_TTL_SECONDS,
    );

    logger.warn(
      {
        sourceId: source.id,
        orgId: source.orgId,
        code: normalizedError.code,
        streak,
        retryAt,
        circuitOpenUntil,
      },
      "Deep seed discovery failed; applied scheduler backoff",
    );
  }

  private async resolveCrawlActorId(orgId: string): Promise<string | null> {
    const cached = this.crawlActorByOrgId.get(orgId);
    if (cached) {
      return cached;
    }

    const membership = await this.prisma.membership.findFirst({
      where: { orgId },
      select: { userId: true },
      orderBy: { createdAt: "asc" },
    });

    const userId =
      typeof membership?.userId === "string" ? membership.userId : "";
    if (!userId) {
      return null;
    }

    this.crawlActorByOrgId.set(orgId, userId);
    return userId;
  }

  private buildPayload(
    source: NewsSourceWithTemplate,
    url: string,
    seed?: {
      mode: "single" | "sitemap" | "rss" | "list" | "deep";
      parentUrl: string;
      relevanceScore?: number;
      publishedAt?: string;
      crawledAt?: string;
      effectiveAt?: string;
      timestampSource?: CrawlDiscoveryTimestampSource;
      dedupeWindowHours?: number;
      queryParamAllowlist?: string[];
    },
  ) {
    const isRssSeed = seed?.mode === "rss";
    const config =
      source.config &&
      typeof source.config === "object" &&
      !Array.isArray(source.config)
        ? (source.config as Record<string, unknown>)
        : {};
    const metadata =
      config.metadata &&
      typeof config.metadata === "object" &&
      !Array.isArray(config.metadata)
        ? (config.metadata as Record<string, unknown>)
        : {};
    return {
      url,
      language: source.language ?? undefined,
      sourceName: source.name ?? undefined,
      keywords: this.normalizeStringList(config.keywords),
      tags: this.normalizeStringList(config.tags),
      summaryHints: this.normalizeStringList(config.summaryHints),
      metadata: {
        sourceId: source.id,
        sourceType: source.siteType,
        crawlTemplateId: isRssSeed
          ? undefined
          : (source.crawlTemplateId ?? undefined),
        ...(seed
          ? {
              newsSourceSeed: {
                mode: seed.mode,
                parentUrl: seed.parentUrl,
                relevanceScore: seed.relevanceScore,
                publishedAt: seed.publishedAt,
                crawledAt: seed.crawledAt,
                effectiveAt: seed.effectiveAt,
                timestampSource: seed.timestampSource,
                dedupeWindowHours: seed.dedupeWindowHours,
              },
              urlQueryParamAllowlist: seed.queryParamAllowlist,
            }
          : {}),
        ...metadata,
      },
      crawlOptions: isRssSeed
        ? undefined
        : this.withAutoCrawlQualityDefaults(
            this.mergeOptions(
              source.crawlTemplate?.isActive
                ? this.normalizeOptions(source.crawlTemplate.crawlOptions)
                : undefined,
              this.normalizeOptions(config.crawlOptions),
            ),
            seed?.mode && seed.mode !== "single" ? seed.mode : undefined,
          ),
      forceRefresh: isRssSeed ? false : Boolean(config.forceRefresh),
    };
  }

  private toItemMetaName(value: string) {
    const trimmed = value.trim();
    if (trimmed.length <= 191) {
      return trimmed;
    }
    return `${trimmed.slice(0, 190).trimEnd()}…`;
  }

  private buildRssPrefetchedPayload(input: {
    basePayload: Record<string, unknown>;
    prefetchedArticle: CrawlDiscoveryPrefetchedArticle;
  }) {
    const baseMetadata =
      input.basePayload.metadata &&
      typeof input.basePayload.metadata === "object" &&
      !Array.isArray(input.basePayload.metadata)
        ? (input.basePayload.metadata as Record<string, unknown>)
        : {};
    const prefetchedMetadata =
      input.prefetchedArticle.metadata &&
      typeof input.prefetchedArticle.metadata === "object" &&
      !Array.isArray(input.prefetchedArticle.metadata)
        ? (input.prefetchedArticle.metadata as Record<string, unknown>)
        : {};

    return {
      ...input.basePayload,
      metadata: {
        ...baseMetadata,
        prefetchedArticle: true,
      },
      prefetchedArticle: {
        title: input.prefetchedArticle.title,
        description: input.prefetchedArticle.description,
        author: input.prefetchedArticle.author,
        markdown: input.prefetchedArticle.markdown,
        publishedAt: input.prefetchedArticle.publishedAt,
        metadata: {
          source: "rss",
          ...prefetchedMetadata,
        },
      },
      // RSS seed bypasses Crawl4AI; force pipeline to use prefetched markdown.
      forceRefresh: false,
    } satisfies Record<string, unknown>;
  }

  private async enqueueRssSeedPipelineJob(options: {
    source: NewsSourceWithTemplate;
    job: {
      url: string;
      urlFingerprint?: string;
      relevanceScore?: number;
      publishedAtTs?: number;
      crawledAtTs?: number;
      effectiveTs?: number;
      timestampSource?: CrawlDiscoveryTimestampSource;
      prefetchedArticle?: CrawlDiscoveryPrefetchedArticle;
    };
    scheduledFor: Date;
    payload: Record<string, unknown>;
    seedConfig: SeedConfig;
    seedParentUrl: string;
    actorId: string;
    bullPriority: number;
  }) {
    const prefetchedArticle = this.normalizePrefetchedArticle(
      options.job.prefetchedArticle,
    );
    if (!prefetchedArticle?.markdown) {
      return {
        skippedNoBody: true,
        enqueueFailed: false,
      } as const;
    }

    const publishedAt = this.toIsoTimestamp(options.job.publishedAtTs);
    const crawledAt = this.toIsoTimestamp(options.job.crawledAtTs);
    const effectiveAt = this.toIsoTimestamp(options.job.effectiveTs);
    const itemPayload = this.buildRssPrefetchedPayload({
      basePayload: options.payload,
      prefetchedArticle,
    });
    const prefetchedMetadata =
      prefetchedArticle.metadata &&
      typeof prefetchedArticle.metadata === "object" &&
      !Array.isArray(prefetchedArticle.metadata)
        ? (prefetchedArticle.metadata as Record<string, unknown>)
        : {};
    const prefetchedMarkdownSourceRaw =
      typeof prefetchedMetadata.markdownSource === "string"
        ? prefetchedMetadata.markdownSource.trim().toLowerCase()
        : "";
    const prefetchedMarkdownSource =
      prefetchedMarkdownSourceRaw === "content" ||
      prefetchedMarkdownSourceRaw === "description" ||
      prefetchedMarkdownSourceRaw === "stub"
        ? prefetchedMarkdownSourceRaw
        : undefined;
    const itemNameBase =
      typeof options.payload.sourceName === "string" &&
      options.payload.sourceName.trim().length > 0
        ? `${options.payload.sourceName.trim()}: ${options.job.url}`
        : options.job.url;

    const created = await this.prisma.$transaction(async (tx) => {
      const pipelineJob = await tx.pipelineJob.create({
        data: {
          orgId: options.source.orgId,
          sourceId: options.source.id,
          url: options.job.url,
          urlFingerprint: options.job.urlFingerprint,
          priority: options.source.priority,
          status: PipelineJobStatus.queued,
          queueName: ITEM_PIPELINE_QUEUE_NAME,
          scheduledFor: options.scheduledFor,
          metadata: {
            sourceName: options.source.name,
            sourceType: options.source.siteType,
            seedMode: options.seedConfig.mode,
            seedParentUrl: options.seedParentUrl,
            relevanceScore: options.job.relevanceScore,
            publishedAt,
            crawledAt,
            effectiveAt,
            timestampSource: options.job.timestampSource,
            urlFingerprint: options.job.urlFingerprint,
            ingestPath: "rss_prefetched",
            ...(prefetchedMarkdownSource ? { prefetchedMarkdownSource } : {}),
          },
        },
      });

      const itemMeta = await tx.itemMeta.create({
        data: {
          orgId: options.source.orgId,
          externalId: `newsSourceRss:${pipelineJob.id}`,
          name: this.toItemMetaName(itemNameBase),
          status: ItemStatus.Pending,
          mongoRef: "",
        },
        select: { id: true },
      });

      const rawItem = await RawItemModel.create({
        itemMetaId: itemMeta.id,
        payload: itemPayload,
        source: "news-source-rss",
      });

      await tx.itemMeta.update({
        where: { id: itemMeta.id },
        data: { mongoRef: rawItem.id },
      });

      await tx.pipelineJob.update({
        where: { id: pipelineJob.id },
        data: {
          metadata: {
            ...(pipelineJob.metadata as
              | Record<string, unknown>
              | null
              | undefined),
            itemMetaId: itemMeta.id,
            rawItemId: rawItem.id,
          },
        },
      });

      return {
        pipelineJobId: pipelineJob.id,
        itemMetaId: itemMeta.id,
        rawItemId: rawItem.id,
      };
    });

    try {
      await this.queueService.enqueueItem(
        options.source.orgId,
        created.itemMetaId,
        created.rawItemId,
        { priority: options.bullPriority },
        {
          pipelineJobId: created.pipelineJobId,
          sourceId: options.source.id,
        },
      );
      return {
        skippedNoBody: false,
        enqueueFailed: false,
        pipelineJobId: created.pipelineJobId,
      } as const;
    } catch (queueError) {
      await Promise.allSettled([
        this.prisma.pipelineJob.updateMany({
          where: { id: created.pipelineJobId },
          data: {
            status: PipelineJobStatus.failed,
            error:
              queueError instanceof Error
                ? queueError.message
                : String(queueError),
            completedAt: new Date(),
          },
        }),
        this.prisma.itemMeta.updateMany({
          where: {
            id: created.itemMetaId,
            status: { not: ItemStatus.Duplicate },
          },
          data: { status: ItemStatus.Failed },
        }),
      ]);
      logger.error(
        {
          error: queueError,
          orgId: options.source.orgId,
          sourceId: options.source.id,
          pipelineJobId: created.pipelineJobId,
        },
        "Failed to enqueue RSS prefetched pipeline job",
      );
      return {
        skippedNoBody: false,
        enqueueFailed: true,
        pipelineJobId: created.pipelineJobId,
      } as const;
    }
  }

  private normalizeSeedConfig(
    source: NewsSourceWithTemplate,
    runtimeSettings: SeedRuntimeSettings = DEFAULT_SEED_RUNTIME_SETTINGS,
    workflowOverlay?: {
      crawlOptions?: Record<string, unknown>;
      seed?: Record<string, unknown>;
      keywords?: string[];
    } | null,
  ) {
    const config = this.mergeWorkflowSourceConfig(
      source.config &&
        typeof source.config === "object" &&
        !Array.isArray(source.config)
        ? (source.config as Record<string, unknown>)
        : null,
      workflowOverlay,
    );
    const seed =
      config?.seed &&
      typeof config.seed === "object" &&
      !Array.isArray(config.seed)
        ? (config.seed as Record<string, unknown>)
        : null;
    if (!seed || seed.enabled !== true) {
      return null;
    }

    const modeRaw =
      typeof seed.mode === "string" ? seed.mode.trim().toLowerCase() : "";
    const mode: SeedConfig["mode"] =
      modeRaw === "rss"
        ? "rss"
        : modeRaw === "list"
          ? "list"
          : modeRaw === "deep"
            ? "deep"
            : "sitemap";
    const deepConfig =
      mode === "deep" &&
      seed.deep &&
      typeof seed.deep === "object" &&
      !Array.isArray(seed.deep)
        ? (seed.deep as Record<string, unknown>)
        : null;

    const keywords = this.normalizeStringList(config?.keywords);
    const query =
      typeof seed.query === "string" && seed.query.trim().length > 0
        ? seed.query.trim()
        : keywords.length > 0
          ? keywords.join(" ")
          : "";
    const queryTokens = query ? this.tokenizeQuery(query) : undefined;
    const modeDefaultCacheTtlSeconds =
      mode === "list" || mode === "deep"
        ? runtimeSettings.seedCacheTtlSecondsListDeep
        : runtimeSettings.seedCacheTtlSecondsSitemapRss;
    const sourceCacheTtlSeconds = this.toOptionalSeedCacheTtlSeconds(
      seed.cacheTtlSeconds,
    );
    let cacheTtlPolicy: SeedConfig["cacheTtlPolicy"] = "mode_default";
    let cacheTtlSeconds = modeDefaultCacheTtlSeconds;
    if (runtimeSettings.seedCacheTtlForceGlobal) {
      cacheTtlPolicy = "global_forced";
    } else if (sourceCacheTtlSeconds !== null) {
      cacheTtlPolicy = "source_override";
      cacheTtlSeconds = sourceCacheTtlSeconds;
    }
    const sourceQueryParamAllowlist = this.normalizeSeedQueryParamAllowlist(
      seed.queryParamAllowlist,
    );
    const queryParamAllowlist =
      sourceQueryParamAllowlist.length > 0
        ? sourceQueryParamAllowlist
        : runtimeSettings.seedUrlQueryParamAllowlist;
    const rssFetch =
      mode === "rss"
        ? this.normalizeSeedRssFetchConfig(seed.rssFetch)
        : undefined;

    return {
      enabled: true,
      mode,
      rssAdaptiveEnabled:
        mode === "rss" &&
        Boolean(
          seed.rssAdaptive &&
            typeof seed.rssAdaptive === "object" &&
            !Array.isArray(seed.rssAdaptive) &&
            (seed.rssAdaptive as Record<string, unknown>).enabled === true,
        ),
      domain:
        mode === "sitemap" || mode === "list" || mode === "deep"
          ? this.normalizeSeedDomain(seed.domain, source.url)
          : undefined,
      pattern:
        (mode === "sitemap" || mode === "list" || mode === "deep") &&
        typeof seed.pattern === "string" &&
        seed.pattern.trim().length > 0
          ? seed.pattern.trim()
          : undefined,
      feedUrl:
        mode === "rss"
          ? this.normalizeSeedFeedUrl(seed.feedUrl, source.url)
          : undefined,
      rssFetch,
      maxUrls: this.clampInt(seed.maxUrls, 1, 2_000, 200),
      maxNewUrlsPerRun: this.clampInt(seed.maxNewUrlsPerRun, 1, 500, 80),
      listMaxPages: this.clampInt(seed.listMaxPages, 1, 20, 6),
      listPageConcurrency: this.clampInt(seed.listPageConcurrency, 1, 5, 2),
      followPagination: seed.followPagination !== false,
      queryTokens,
      scoreThreshold: this.clampFloat(seed.scoreThreshold, 0, 1, 0),
      dedupeWindowHours: this.clampInt(seed.dedupeWindowHours, 0, 24 * 30, 24),
      queryParamAllowlist,
      // Optional runtime policy can force global TTL defaults over per-source seed.cacheTtlSeconds.
      cacheTtlSeconds,
      cacheTtlPolicy,
      deep:
        mode === "deep"
          ? {
              maxPages: this.clampInt(deepConfig?.maxPages, 5, 300, 80),
              maxDepth: this.clampInt(deepConfig?.maxDepth, 1, 4, 2),
              timeBudgetSeconds: this.clampInt(
                deepConfig?.timeBudgetSeconds,
                10,
                180,
                60,
              ),
              pageConcurrency: this.clampInt(
                deepConfig?.pageConcurrency,
                1,
                6,
                2,
              ),
              scoreThreshold: this.clampFloat(
                deepConfig?.scoreThreshold,
                0,
                1,
                0.2,
              ),
              candidatePoolSize: this.clampInt(
                deepConfig?.candidatePoolSize,
                20,
                400,
                120,
              ),
              headFetchTopK: this.clampInt(
                deepConfig?.headFetchTopK,
                10,
                120,
                40,
              ),
              preferPathDate:
                typeof deepConfig?.preferPathDate === "boolean"
                  ? deepConfig.preferPathDate
                  : true,
              enableSecondaryHubs:
                typeof deepConfig?.enableSecondaryHubs === "boolean"
                  ? deepConfig.enableSecondaryHubs
                  : true,
              ignoreRobotsTxt: true,
            }
          : undefined,
    } satisfies SeedConfig;
  }

  private mergeWorkflowSourceConfig(
    config: Record<string, unknown> | null,
    overlay?: {
      crawlOptions?: Record<string, unknown>;
      seed?: Record<string, unknown>;
      keywords?: string[];
    } | null,
  ) {
    if (!overlay) {
      return config;
    }
    return {
      ...(config ?? {}),
      ...(overlay.keywords && overlay.keywords.length > 0
        ? { keywords: overlay.keywords }
        : {}),
      crawlOptions: {
        ...((config?.crawlOptions &&
        typeof config.crawlOptions === "object" &&
        !Array.isArray(config.crawlOptions)
          ? (config.crawlOptions as Record<string, unknown>)
          : {}) ?? {}),
        ...(overlay.crawlOptions ?? {}),
      },
      seed: {
        ...((config?.seed &&
        typeof config.seed === "object" &&
        !Array.isArray(config.seed)
          ? (config.seed as Record<string, unknown>)
          : {}) ?? {}),
        ...(overlay.seed ?? {}),
      },
    };
  }

  private normalizeSeedQueryParamAllowlist(value: unknown): string[] {
    return resolveQueryParamAllowlist(value, []);
  }

  private normalizeSeedDomain(rawDomain: unknown, fallbackUrl: string) {
    const raw = typeof rawDomain === "string" ? rawDomain.trim() : "";
    const candidate = raw.length > 0 ? raw : fallbackUrl;
    const withProtocol = /^https?:\/\//i.test(candidate)
      ? candidate
      : `https://${candidate}`;
    try {
      return new URL(withProtocol).origin.replace(/\/+$/, "");
    } catch {
      try {
        return new URL(fallbackUrl).origin.replace(/\/+$/, "");
      } catch {
        return undefined;
      }
    }
  }

  private normalizeSeedFeedUrl(rawFeedUrl: unknown, fallbackUrl: string) {
    const raw = typeof rawFeedUrl === "string" ? rawFeedUrl.trim() : "";
    const candidate = raw.length > 0 ? raw : fallbackUrl;
    const withProtocol = /^https?:\/\//i.test(candidate)
      ? candidate
      : `https://${candidate}`;
    try {
      return new URL(withProtocol).toString();
    } catch {
      try {
        return new URL(fallbackUrl).toString();
      } catch {
        return undefined;
      }
    }
  }

  private clampInt(value: unknown, min: number, max: number, fallback: number) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return fallback;
    }
    const rounded = Math.round(value);
    return Math.min(max, Math.max(min, rounded));
  }

  private toOptionalSeedCacheTtlSeconds(value: unknown): number | null {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return null;
    }
    const rounded = Math.round(value);
    if (rounded < 10 || rounded > 3600) {
      return null;
    }
    return rounded;
  }

  private clampFloat(
    value: unknown,
    min: number,
    max: number,
    fallback: number,
  ) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return fallback;
    }
    return Math.min(max, Math.max(min, value));
  }

  private tokenizeQuery(query: string) {
    return query
      .toLowerCase()
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length > 0);
  }

  private scoreUrl(url: string, tokens?: string[]) {
    if (!tokens || tokens.length === 0) {
      return undefined;
    }
    const haystack = url.toLowerCase();
    const hits = tokens.filter((token) => haystack.includes(token)).length;
    return Number((hits / tokens.length).toFixed(3));
  }

  private async resolveSeedCandidates(
    source: NewsSourceWithTemplate,
    seed: SeedConfig,
    seedFreshnessWindowDays: number,
    workflowOverlay?: {
      crawlOptions?: Record<string, unknown>;
      seed?: Record<string, unknown>;
      keywords?: string[];
    } | null,
    options?: { cacheTtlSecondsOverride?: number },
  ) {
    if (seed.mode === "sitemap" && !seed.domain) {
      return [];
    }

    const cacheTtlSeconds =
      options?.cacheTtlSecondsOverride ?? seed.cacheTtlSeconds;
    const cacheKey = this.buildSeedDiscoveryCacheKey(
      source.id,
      source.url,
      seed,
      cacheTtlSeconds,
    );
    const freshnessWindowDays = Math.max(
      1,
      Math.min(
        MAX_SEED_FRESHNESS_WINDOW_DAYS,
        Math.floor(seedFreshnessWindowDays),
      ),
    );
    const freshnessCutoffTs =
      Date.now() - freshnessWindowDays * 24 * 60 * 60 * 1000;

    const discovered = await this.cache.wrap<unknown[]>(
      cacheKey,
      cacheTtlSeconds,
      async () =>
        this.discoverSeedCandidates(
          source,
          seed,
          freshnessCutoffTs,
          workflowOverlay,
        ),
      { lockTtlMs: 15_000, maxWaitMs: 15_000, retryDelayMs: 100 },
    );

    const normalized = new Map<string, CrawlDiscoveryCandidate>();
    for (const entry of discovered) {
      const incoming = this.normalizeCachedSeedDiscoveryCandidate(entry);
      if (!incoming) {
        continue;
      }
      const existing = normalized.get(incoming.url);
      normalized.set(
        incoming.url,
        this.mergeSeedDiscoveryCandidate(existing, incoming),
      );
    }

    const scored = Array.from(normalized.values())
      .map((entry) => {
        const relevanceScore =
          entry.relevanceScore ?? this.scoreUrl(entry.url, seed.queryTokens);
        const publishedAtTs = this.resolveTimestamp(entry.publishedAtTs);
        const crawledAtTs = this.resolveTimestamp(entry.crawledAtTs);
        const effectiveTs = this.resolveEffectiveSeedTimestamp({
          publishedAtTs,
          crawledAtTs,
        });
        const timestampSource = this.resolveSeedTimestampSource({
          publishedAtTs,
          crawledAtTs,
        });
        return {
          url: entry.url,
          relevanceScore,
          publishedAtTs,
          crawledAtTs,
          effectiveTs,
          timestampSource,
          prefetchedArticle: this.normalizePrefetchedArticle(
            entry.prefetchedArticle,
          ),
        };
      })
      .filter((entry) =>
        seed.scoreThreshold > 0
          ? (entry.relevanceScore ?? 0) >= seed.scoreThreshold
          : true,
      )
      .filter((entry) =>
        typeof entry.effectiveTs === "number" &&
        Number.isFinite(entry.effectiveTs)
          ? entry.effectiveTs >= freshnessCutoffTs
          : true,
      );

    scored.sort((a, b) => {
      const aEffectiveTs =
        typeof a.effectiveTs === "number" && Number.isFinite(a.effectiveTs)
          ? a.effectiveTs
          : -1;
      const bEffectiveTs =
        typeof b.effectiveTs === "number" && Number.isFinite(b.effectiveTs)
          ? b.effectiveTs
          : -1;
      if (aEffectiveTs !== bEffectiveTs) {
        return bEffectiveTs - aEffectiveTs;
      }
      const aScore = a.relevanceScore ?? 0;
      const bScore = b.relevanceScore ?? 0;
      if (aScore !== bScore) {
        return bScore - aScore;
      }
      return a.url.localeCompare(b.url);
    });

    return scored.slice(0, seed.maxUrls);
  }

  private normalizeCachedSeedDiscoveryCandidate(
    value: unknown,
  ): CrawlDiscoveryCandidate | undefined {
    if (typeof value === "string") {
      const url = value.trim();
      if (!url) {
        return undefined;
      }
      return {
        url,
        publishedAtTs: this.parsePublishedAtFromUrl(url),
      };
    }

    if (!value || typeof value !== "object") {
      return undefined;
    }

    const entry = value as Record<string, unknown>;
    const url = typeof entry.url === "string" ? entry.url.trim() : "";
    if (!url) {
      return undefined;
    }
    const fallbackPathPublishedAtTs = this.parsePublishedAtFromUrl(url);
    return {
      url,
      relevanceScore:
        typeof entry.relevanceScore === "number" &&
        Number.isFinite(entry.relevanceScore)
          ? entry.relevanceScore
          : undefined,
      publishedAtTs:
        this.resolveTimestamp(entry.publishedAtTs) ?? fallbackPathPublishedAtTs,
      crawledAtTs: this.resolveTimestamp(entry.crawledAtTs),
      prefetchedArticle: this.normalizePrefetchedArticle(
        entry.prefetchedArticle,
      ),
    };
  }

  private async discoverSeedCandidates(
    source: NewsSourceWithTemplate,
    seed: SeedConfig,
    freshnessCutoffTs: number,
    workflowOverlay?: {
      crawlOptions?: Record<string, unknown>;
      seed?: Record<string, unknown>;
      keywords?: string[];
    } | null,
  ): Promise<CrawlDiscoveryCandidate[]> {
    const metadataService = this.metadataService as CrawlMetadataService & {
      discoverRssCandidates?: (input: {
        feedUrl?: string;
        maxUrls?: number;
      }) => Promise<CrawlDiscoveryCandidate[]>;
      discoverListCandidates?: (input: {
        url?: string;
        domain?: string;
        pattern?: string;
        maxUrls?: number;
        listMaxPages?: number;
        listPageConcurrency?: number;
        followPagination?: boolean;
        crawlOptions?: Record<string, unknown>;
      }) => Promise<CrawlDiscoveryCandidate[]>;
      discoverDeepCandidates?: (input: {
        url?: string;
        domain?: string;
        pattern?: string;
        maxUrls?: number;
        deep?: SeedConfig["deep"];
        query?: string;
        crawlOptions?: Record<string, unknown>;
      }) => Promise<CrawlDiscoveryCandidate[]>;
      discoverSitemapCandidates?: (input: {
        domain?: string;
        pattern?: string;
        maxUrls?: number;
        freshnessCutoffTs?: number;
      }) => Promise<CrawlDiscoveryCandidate[]>;
    };

    const toCandidatesFromUrls = (
      urls: string[],
    ): CrawlDiscoveryCandidate[] => {
      const crawledAtTs = Date.now();
      return urls.map((url) => ({
        url,
        publishedAtTs: this.parsePublishedAtFromUrl(url),
        crawledAtTs,
      }));
    };

    if (seed.mode === "rss") {
      if (typeof metadataService.discoverRssCandidates === "function") {
        return metadataService.discoverRssCandidates({
          feedUrl: seed.feedUrl ?? source.url,
          maxUrls: seed.maxUrls,
          rssFetch: seed.rssFetch,
        });
      }
      const urls = await this.metadataService.discoverRssUrls({
        feedUrl: seed.feedUrl ?? source.url,
        maxUrls: seed.maxUrls,
      });
      return toCandidatesFromUrls(urls);
    }

    const config =
      this.mergeWorkflowSourceConfig(
        source.config &&
          typeof source.config === "object" &&
          !Array.isArray(source.config)
          ? (source.config as Record<string, unknown>)
          : {},
        workflowOverlay,
      ) ?? {};
    const crawlOptions = this.mergeOptions(
      source.crawlTemplate?.isActive
        ? this.normalizeOptions(source.crawlTemplate.crawlOptions)
        : undefined,
      this.normalizeOptions(config.crawlOptions),
    );

    if (seed.mode === "list") {
      const crawlOptionsWithDefaults = this.withAutoCrawlQualityDefaults(
        crawlOptions,
        "list",
      );
      if (typeof metadataService.discoverListCandidates === "function") {
        return metadataService.discoverListCandidates({
          url: source.url,
          domain: seed.domain,
          pattern: seed.pattern,
          maxUrls: seed.maxUrls,
          listMaxPages: seed.listMaxPages,
          listPageConcurrency: seed.listPageConcurrency,
          followPagination: seed.followPagination,
          crawlOptions: crawlOptionsWithDefaults,
        });
      }
      const urls = await this.metadataService.discoverListUrls({
        url: source.url,
        domain: seed.domain,
        pattern: seed.pattern,
        maxUrls: seed.maxUrls,
        listMaxPages: seed.listMaxPages,
        listPageConcurrency: seed.listPageConcurrency,
        followPagination: seed.followPagination,
        crawlOptions: crawlOptionsWithDefaults,
      });
      return toCandidatesFromUrls(urls);
    }

    if (seed.mode === "deep") {
      const crawlOptionsWithDefaults = this.withAutoCrawlQualityDefaults(
        crawlOptions,
        "deep",
      );
      if (typeof metadataService.discoverDeepCandidates === "function") {
        return metadataService.discoverDeepCandidates({
          url: source.url,
          domain: seed.domain,
          pattern: seed.pattern,
          maxUrls: seed.maxUrls,
          deep: seed.deep,
          query: seed.queryTokens?.join(" "),
          crawlOptions: crawlOptionsWithDefaults,
        });
      }
      const urls = await this.metadataService.discoverDeepUrls({
        url: source.url,
        domain: seed.domain,
        pattern: seed.pattern,
        maxUrls: seed.maxUrls,
        deep: seed.deep,
        query: seed.queryTokens?.join(" "),
        crawlOptions: crawlOptionsWithDefaults,
      });
      return toCandidatesFromUrls(urls);
    }

    if (typeof metadataService.discoverSitemapCandidates === "function") {
      return metadataService.discoverSitemapCandidates({
        domain: seed.domain,
        pattern: seed.pattern,
        maxUrls: seed.maxUrls,
        freshnessCutoffTs,
      });
    }
    const urls = await this.metadataService.discoverSitemapUrls({
      domain: seed.domain,
      pattern: seed.pattern,
      maxUrls: seed.maxUrls,
    });
    return urls.map((url) => ({
      url,
      publishedAtTs: this.parsePublishedAtFromUrl(url),
    }));
  }

  private mergeSeedDiscoveryCandidate(
    existing: CrawlDiscoveryCandidate | undefined,
    incoming: CrawlDiscoveryCandidate,
  ): CrawlDiscoveryCandidate {
    if (!existing) {
      return incoming;
    }
    const maxRelevanceScore = Math.max(
      existing.relevanceScore ?? Number.NEGATIVE_INFINITY,
      incoming.relevanceScore ?? Number.NEGATIVE_INFINITY,
    );
    return {
      url: incoming.url,
      relevanceScore:
        maxRelevanceScore === Number.NEGATIVE_INFINITY
          ? undefined
          : maxRelevanceScore,
      publishedAtTs: this.resolveTimestampMax(
        existing.publishedAtTs,
        incoming.publishedAtTs,
      ),
      crawledAtTs: this.resolveTimestampMax(
        existing.crawledAtTs,
        incoming.crawledAtTs,
      ),
      prefetchedArticle: this.mergePrefetchedArticle(
        existing.prefetchedArticle,
        incoming.prefetchedArticle,
      ),
    };
  }

  private resolveTimestamp(value: unknown) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      return undefined;
    }
    const normalized = Math.floor(value);
    const now = Date.now();
    return normalized > now ? now : normalized;
  }

  private resolveTimestampMax(first?: number, second?: number) {
    const left = this.resolveTimestamp(first);
    const right = this.resolveTimestamp(second);
    if (left === undefined) {
      return right;
    }
    if (right === undefined) {
      return left;
    }
    return Math.max(left, right);
  }

  private normalizePrefetchedArticle(
    value: unknown,
  ): CrawlDiscoveryPrefetchedArticle | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }
    const record = value as Record<string, unknown>;
    const markdown =
      typeof record.markdown === "string" ? record.markdown.trim() : "";
    if (!markdown) {
      return undefined;
    }
    const title =
      typeof record.title === "string" ? record.title.trim() : undefined;
    const description =
      typeof record.description === "string"
        ? record.description.trim()
        : undefined;
    const author =
      typeof record.author === "string" ? record.author.trim() : undefined;
    const publishedAt =
      typeof record.publishedAt === "string" ? record.publishedAt.trim() : "";
    const metadata =
      record.metadata &&
      typeof record.metadata === "object" &&
      !Array.isArray(record.metadata)
        ? ({ ...(record.metadata as Record<string, unknown>) } as Record<
            string,
            unknown
          >)
        : undefined;
    return {
      title: title && title.length > 0 ? title : undefined,
      description:
        description && description.length > 0 ? description : undefined,
      author: author && author.length > 0 ? author : undefined,
      markdown,
      publishedAt: publishedAt.length > 0 ? publishedAt : undefined,
      metadata,
    };
  }

  private mergePrefetchedArticle(
    existing: CrawlDiscoveryPrefetchedArticle | undefined,
    incoming: CrawlDiscoveryPrefetchedArticle | undefined,
  ): CrawlDiscoveryPrefetchedArticle | undefined {
    if (!existing) {
      return incoming;
    }
    if (!incoming) {
      return existing;
    }
    const existingLen = existing.markdown?.length ?? 0;
    const incomingLen = incoming.markdown?.length ?? 0;
    const primary = incomingLen > existingLen ? incoming : existing;
    const secondary = primary === incoming ? existing : incoming;
    const primaryMetadata =
      primary.metadata &&
      typeof primary.metadata === "object" &&
      !Array.isArray(primary.metadata)
        ? primary.metadata
        : undefined;
    const secondaryMetadata =
      secondary.metadata &&
      typeof secondary.metadata === "object" &&
      !Array.isArray(secondary.metadata)
        ? secondary.metadata
        : undefined;
    return {
      title: primary.title ?? secondary.title,
      description: primary.description ?? secondary.description,
      author: primary.author ?? secondary.author,
      markdown: primary.markdown ?? secondary.markdown,
      publishedAt: primary.publishedAt ?? secondary.publishedAt,
      metadata:
        primaryMetadata || secondaryMetadata
          ? { ...(secondaryMetadata ?? {}), ...(primaryMetadata ?? {}) }
          : undefined,
    };
  }

  private normalizeSeedRssFetchConfig(value: unknown): ResolvedRssFetchConfig {
    const record =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
    const hasCustomFields =
      Boolean(record) &&
      (Object.prototype.hasOwnProperty.call(record, "requestTimeoutMs") ||
        Object.prototype.hasOwnProperty.call(record, "bodySourceStrategy") ||
        Object.prototype.hasOwnProperty.call(record, "noBodyPolicy"));
    const enabled =
      record?.enabled === true ||
      (record?.enabled !== false && hasCustomFields);
    if (!enabled) {
      return {
        enabled: false,
        requestTimeoutMs: 15_000,
        bodySourceStrategy: "content_first",
        noBodyPolicy: "skip",
      };
    }
    const bodySourceStrategyRaw =
      typeof record?.bodySourceStrategy === "string"
        ? record.bodySourceStrategy.trim().toLowerCase()
        : "";
    const bodySourceStrategy: CrawlDiscoveryRssBodySourceStrategy =
      bodySourceStrategyRaw === "content_only" ||
      bodySourceStrategyRaw === "summary_only"
        ? (bodySourceStrategyRaw as CrawlDiscoveryRssBodySourceStrategy)
        : "content_first";
    const noBodyPolicyRaw =
      typeof record?.noBodyPolicy === "string"
        ? record.noBodyPolicy.trim().toLowerCase()
        : "";
    const noBodyPolicy: CrawlDiscoveryRssNoBodyPolicy =
      noBodyPolicyRaw === "title_description_stub"
        ? "title_description_stub"
        : "skip";

    return {
      enabled,
      requestTimeoutMs: this.clampInt(
        record?.requestTimeoutMs,
        1_000,
        120_000,
        15_000,
      ),
      bodySourceStrategy,
      noBodyPolicy,
    };
  }

  private resolveEffectiveSeedTimestamp(input: {
    publishedAtTs?: number;
    crawledAtTs?: number;
  }) {
    const publishedAtTs = this.resolveTimestamp(input.publishedAtTs);
    if (typeof publishedAtTs === "number") {
      return publishedAtTs;
    }
    const crawledAtTs = this.resolveTimestamp(input.crawledAtTs);
    if (typeof crawledAtTs === "number") {
      return crawledAtTs;
    }
    return undefined;
  }

  private resolveSeedTimestampSource(input: {
    publishedAtTs?: number;
    crawledAtTs?: number;
  }): CrawlDiscoveryTimestampSource {
    if (typeof this.resolveTimestamp(input.publishedAtTs) === "number") {
      return "published";
    }
    if (typeof this.resolveTimestamp(input.crawledAtTs) === "number") {
      return "crawled";
    }
    return "none";
  }

  private toIsoTimestamp(ts?: number) {
    const resolved = this.resolveTimestamp(ts);
    if (typeof resolved !== "number") {
      return undefined;
    }
    return new Date(resolved).toISOString();
  }

  private buildSeedDiscoveryCacheKey(
    sourceId: string,
    sourceUrl: string,
    seed: SeedConfig,
    cacheTtlSeconds = seed.cacheTtlSeconds,
  ) {
    const fingerprintInput = {
      mode: seed.mode,
      sourceUrl,
      domain: seed.domain ?? null,
      pattern: seed.pattern ?? null,
      feedUrl: seed.feedUrl ?? null,
      maxUrls: seed.maxUrls,
      listMaxPages: seed.listMaxPages,
      listPageConcurrency: seed.listPageConcurrency,
      followPagination: seed.followPagination,
      queryTokens: seed.queryTokens ?? [],
      scoreThreshold: seed.scoreThreshold,
      cacheTtlSeconds,
      cacheTtlPolicy: seed.cacheTtlPolicy,
      deep: seed.deep
        ? {
            maxPages: seed.deep.maxPages,
            maxDepth: seed.deep.maxDepth,
            timeBudgetSeconds: seed.deep.timeBudgetSeconds,
            pageConcurrency: seed.deep.pageConcurrency,
            scoreThreshold: seed.deep.scoreThreshold,
            candidatePoolSize: seed.deep.candidatePoolSize,
            headFetchTopK: seed.deep.headFetchTopK,
            preferPathDate: seed.deep.preferPathDate,
            enableSecondaryHubs: seed.deep.enableSecondaryHubs,
          }
        : null,
    };
    const digest = createHash("sha1")
      .update(JSON.stringify(fingerprintInput))
      .digest("hex");
    return `news-source:${seed.mode}:${sourceId}:${digest}`;
  }

  private rssAdaptiveStateCacheKey(sourceId: string) {
    return `news-source:rss-adaptive:${sourceId}`;
  }

  private normalizeRssAdaptiveState(value: unknown): RssAdaptiveState {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return {
        outcomes: [],
        consecutiveNoHit: 0,
        updatedAt: new Date(0).toISOString(),
      };
    }

    const record = value as Record<string, unknown>;
    const outcomes = Array.isArray(record.outcomes)
      ? record.outcomes
          .filter((entry): entry is boolean => typeof entry === "boolean")
          .slice(-RSS_ADAPTIVE_HISTORY_SIZE)
      : [];
    const consecutiveNoHitRaw = record.consecutiveNoHit;
    const consecutiveNoHit =
      typeof consecutiveNoHitRaw === "number" &&
      Number.isFinite(consecutiveNoHitRaw)
        ? Math.max(0, Math.floor(consecutiveNoHitRaw))
        : 0;
    const updatedAt =
      typeof record.updatedAt === "string" && record.updatedAt.length > 0
        ? record.updatedAt
        : new Date(0).toISOString();

    return {
      outcomes,
      consecutiveNoHit,
      updatedAt,
    };
  }

  private async readRssAdaptiveState(sourceId: string) {
    const state = await this.cache.get<RssAdaptiveState>(
      this.rssAdaptiveStateCacheKey(sourceId),
    );
    return this.normalizeRssAdaptiveState(state);
  }

  private async writeRssAdaptiveState(
    sourceId: string,
    state: RssAdaptiveState,
  ) {
    await this.cache.set(
      this.rssAdaptiveStateCacheKey(sourceId),
      state,
      RSS_ADAPTIVE_STATE_TTL_SECONDS,
    );
    await this.newsSourceOpsSnapshots?.setRssAdaptiveState(sourceId, {
      outcomes: state.outcomes,
      consecutiveNoHit: state.consecutiveNoHit,
      updatedAt: state.updatedAt,
    });
  }

  private shouldUseRssAdaptive(
    source: NewsSourceWithTemplate,
    seedConfig: SeedConfig | null,
  ) {
    if (
      !seedConfig ||
      seedConfig.mode !== "rss" ||
      !seedConfig.rssAdaptiveEnabled
    ) {
      return false;
    }
    return this.normalizeCronSchedule(source) === null;
  }

  private resolveRssAdaptiveTier(
    state: RssAdaptiveState,
    sourcePriority: number,
    runtimeSettings: SeedRuntimeSettings,
  ): RssAdaptiveTier {
    const normalizedState = this.normalizeRssAdaptiveState(state);
    if (
      normalizedState.consecutiveNoHit >=
      runtimeSettings.rssAdaptiveColdConsecutiveNoHitRuns
    ) {
      return "cold";
    }
    const total = normalizedState.outcomes.length;
    if (total < 3) {
      return this.resolveRssAdaptiveTierWithPriority("normal", sourcePriority);
    }
    const hits = normalizedState.outcomes.filter(Boolean).length;
    const hitRate = hits / total;
    let tier: RssAdaptiveTier = "normal";
    if (hitRate >= runtimeSettings.rssAdaptiveHotHitRatePercent / 100) {
      tier = "hot";
    } else if (hitRate >= runtimeSettings.rssAdaptiveWarmHitRatePercent / 100) {
      tier = "warm";
    }
    return this.resolveRssAdaptiveTierWithPriority(tier, sourcePriority);
  }

  private resolveRssAdaptiveTierWithPriority(
    tier: RssAdaptiveTier,
    sourcePriority: number,
  ): RssAdaptiveTier {
    const normalizedPriority = this.normalizeSourcePriority(sourcePriority);
    if (normalizedPriority >= this.crawlHotPriorityThreshold) {
      if (tier === "normal") {
        return "warm";
      }
      if (tier === "warm") {
        return "hot";
      }
      return tier;
    }
    if (normalizedPriority <= -this.crawlHotPriorityThreshold) {
      if (tier === "hot") {
        return "warm";
      }
      if (tier === "warm") {
        return "normal";
      }
      if (tier === "normal") {
        return "cold";
      }
    }
    return tier;
  }

  private resolveRssAdaptiveIntervalSeconds(
    frequencySeconds: number,
    tier: RssAdaptiveTier,
    runtimeSettings: SeedRuntimeSettings,
  ) {
    const base = Math.max(1, Math.floor(frequencySeconds));
    if (tier === "hot") {
      return runtimeSettings.rssAdaptiveHotIntervalSeconds;
    }
    if (tier === "warm") {
      return Math.max(
        runtimeSettings.rssAdaptiveWarmMinIntervalSeconds,
        Math.floor(base / runtimeSettings.rssAdaptiveWarmIntervalDivisor),
      );
    }
    if (tier === "cold") {
      return Math.min(
        base * runtimeSettings.rssAdaptiveColdIntervalMultiplier,
        Math.max(base, runtimeSettings.rssAdaptiveColdMaxIntervalSeconds),
      );
    }
    return base;
  }

  private resolveRssAdaptiveCacheTtlSeconds(
    cacheTtlSeconds: number,
    tier: RssAdaptiveTier,
    runtimeSettings: SeedRuntimeSettings,
  ) {
    const base = Math.max(10, Math.min(3600, Math.floor(cacheTtlSeconds)));
    if (tier === "hot") {
      return Math.max(
        10,
        Math.min(
          base,
          runtimeSettings.rssAdaptiveHotDiscoveryCacheTtlCapSeconds,
        ),
      );
    }
    if (tier === "warm") {
      return Math.max(
        10,
        Math.min(
          base,
          runtimeSettings.rssAdaptiveWarmDiscoveryCacheTtlCapSeconds,
        ),
      );
    }
    return base;
  }

  private buildNextRssAdaptiveState(
    previous: RssAdaptiveState,
    hasScheduledUrls: boolean,
  ): RssAdaptiveState {
    const normalized = this.normalizeRssAdaptiveState(previous);
    const outcomes = [...normalized.outcomes, hasScheduledUrls].slice(
      -RSS_ADAPTIVE_HISTORY_SIZE,
    );
    const consecutiveNoHit = hasScheduledUrls
      ? 0
      : normalized.consecutiveNoHit + 1;
    return {
      outcomes,
      consecutiveNoHit,
      updatedAt: new Date().toISOString(),
    };
  }

  private async ensureLegacyRssSeedCacheTtlMigrated() {
    try {
      const marker = await this.cache.get<{ completedAt?: string }>(
        RSS_SEED_CACHE_TTL_MIGRATION_DONE_KEY,
      );
      if (marker) {
        return;
      }

      const result = await this.cache.withLock(
        RSS_SEED_CACHE_TTL_MIGRATION_LOCK_KEY,
        120_000,
        async () => {
          const latestMarker = await this.cache.get<{ completedAt?: string }>(
            RSS_SEED_CACHE_TTL_MIGRATION_DONE_KEY,
          );
          if (latestMarker) {
            return null;
          }

          const migrationResult =
            await this.migrateLegacyRssSeedCacheTtlToModeDefault();
          if (migrationResult.updatedCount > 0) {
            await this.cache.delByPrefix("news-source:rss:");
          }
          await this.cache.set(
            RSS_SEED_CACHE_TTL_MIGRATION_DONE_KEY,
            {
              completedAt: new Date().toISOString(),
              ...migrationResult,
            },
            RSS_SEED_CACHE_TTL_MIGRATION_DONE_TTL_SECONDS,
          );
          return migrationResult;
        },
      );

      if (result) {
        logger.info(
          {
            scannedCount: result.scannedCount,
            matchedCount: result.matchedCount,
            updatedCount: result.updatedCount,
          },
          "Migrated legacy RSS seed cache TTL overrides",
        );
      }
    } catch (error) {
      logger.warn(
        { error },
        "Failed to migrate legacy RSS seed cache TTL overrides",
      );
    }
  }

  private async migrateLegacyRssSeedCacheTtlToModeDefault() {
    const rows = await this.prisma.newsSource.findMany({
      select: { id: true, config: true },
    });
    let matchedCount = 0;
    let updatedCount = 0;

    for (const row of rows) {
      const migrated = this.removeLegacyRssSeedCacheTtlOverride(row.config);
      if (!migrated) {
        continue;
      }
      matchedCount += 1;
      const wasUpdated =
        await this.updateLegacyRssSeedCacheTtlOverrideWithRetry(
          row.id,
          row.config,
        );
      if (wasUpdated) {
        updatedCount += 1;
      }
    }

    return {
      scannedCount: rows.length,
      matchedCount,
      updatedCount,
    };
  }

  private async updateLegacyRssSeedCacheTtlOverrideWithRetry(
    sourceId: string,
    initialConfig: unknown,
  ) {
    let currentConfig = initialConfig;

    for (
      let attempt = 0;
      attempt < RSS_SEED_CACHE_TTL_MIGRATION_MAX_RETRIES;
      attempt += 1
    ) {
      const migrated = this.removeLegacyRssSeedCacheTtlOverride(currentConfig);
      if (!migrated) {
        return false;
      }

      const updateResult = await this.prisma.newsSource.updateMany({
        where: {
          id: sourceId,
          config: { equals: toPrismaJsonValue(currentConfig) },
        },
        data: {
          config: toPrismaJsonValue(migrated),
        },
      });
      if (updateResult.count > 0) {
        return true;
      }

      const latest = await this.prisma.newsSource.findUnique({
        where: { id: sourceId },
        select: { config: true },
      });
      if (!latest) {
        return false;
      }
      currentConfig = latest.config;
    }

    return false;
  }

  private removeLegacyRssSeedCacheTtlOverride(configRaw: unknown) {
    if (
      !configRaw ||
      typeof configRaw !== "object" ||
      Array.isArray(configRaw)
    ) {
      return null;
    }
    const config = configRaw as Record<string, unknown>;
    const seedRaw =
      config.seed &&
      typeof config.seed === "object" &&
      !Array.isArray(config.seed)
        ? (config.seed as Record<string, unknown>)
        : null;
    if (!seedRaw) {
      return null;
    }

    const modeRaw =
      typeof seedRaw.mode === "string" ? seedRaw.mode.trim().toLowerCase() : "";
    if (modeRaw !== "rss") {
      return null;
    }

    const rawTtl = seedRaw.cacheTtlSeconds;
    const ttl =
      typeof rawTtl === "number"
        ? rawTtl
        : typeof rawTtl === "string" && rawTtl.trim().length > 0
          ? Number(rawTtl)
          : NaN;
    if (
      !Number.isFinite(ttl) ||
      Math.round(ttl) !== LEGACY_RSS_SEED_CACHE_TTL_SECONDS
    ) {
      return null;
    }

    const nextSeed = { ...seedRaw };
    delete nextSeed.cacheTtlSeconds;
    return {
      ...config,
      seed: nextSeed,
    };
  }

  private async resolveSeedRuntimeSettings(): Promise<SeedRuntimeSettings> {
    const settings = await this.schedulerSettings.getSettings();
    const rssAdaptiveHotHitRatePercent = this.clampInt(
      settings.rssAdaptiveHotHitRatePercent,
      0,
      100,
      DEFAULT_RSS_ADAPTIVE_HOT_HIT_RATE_PERCENT,
    );
    const rssAdaptiveWarmHitRatePercent = this.clampInt(
      settings.rssAdaptiveWarmHitRatePercent,
      0,
      100,
      DEFAULT_RSS_ADAPTIVE_WARM_HIT_RATE_PERCENT,
    );
    const rssAdaptiveWarmMinIntervalSeconds = this.clampInt(
      settings.rssAdaptiveWarmMinIntervalSeconds,
      10,
      21_600,
      DEFAULT_RSS_ADAPTIVE_WARM_MIN_INTERVAL_SECONDS,
    );
    const rssAdaptiveColdMaxIntervalSeconds = this.clampInt(
      settings.rssAdaptiveColdMaxIntervalSeconds,
      10,
      21_600,
      DEFAULT_RSS_ADAPTIVE_COLD_MAX_INTERVAL_SECONDS,
    );
    const rssAdaptiveHotDiscoveryCacheTtlCapSeconds = this.clampInt(
      settings.rssAdaptiveHotDiscoveryCacheTtlCapSeconds,
      10,
      3600,
      DEFAULT_RSS_ADAPTIVE_HOT_DISCOVERY_CACHE_TTL_CAP_SECONDS,
    );
    const rssAdaptiveWarmDiscoveryCacheTtlCapSeconds = this.clampInt(
      settings.rssAdaptiveWarmDiscoveryCacheTtlCapSeconds,
      10,
      3600,
      DEFAULT_RSS_ADAPTIVE_WARM_DISCOVERY_CACHE_TTL_CAP_SECONDS,
    );
    return {
      seedFreshnessWindowDays: this.clampInt(
        settings.seedFreshnessWindowDays,
        1,
        MAX_SEED_FRESHNESS_WINDOW_DAYS,
        DEFAULT_SEED_FRESHNESS_WINDOW_DAYS,
      ),
      seedCacheTtlSecondsSitemapRss: this.clampInt(
        settings.seedCacheTtlSecondsSitemapRss,
        10,
        3600,
        DEFAULT_SEED_CACHE_TTL_SECONDS_SITEMAP_RSS,
      ),
      seedCacheTtlSecondsListDeep: this.clampInt(
        settings.seedCacheTtlSecondsListDeep,
        10,
        3600,
        DEFAULT_SEED_CACHE_TTL_SECONDS_LIST_DEEP,
      ),
      seedCacheTtlForceGlobal:
        typeof settings.seedCacheTtlForceGlobal === "boolean"
          ? settings.seedCacheTtlForceGlobal
          : DEFAULT_SEED_CACHE_TTL_FORCE_GLOBAL,
      seedUrlQueryParamAllowlist: resolveQueryParamAllowlist(
        settings.seedUrlQueryParamAllowlist,
        DEFAULT_SEED_RUNTIME_SETTINGS.seedUrlQueryParamAllowlist,
      ),
      rssAdaptiveHotHitRatePercent,
      rssAdaptiveWarmHitRatePercent: Math.min(
        rssAdaptiveWarmHitRatePercent,
        rssAdaptiveHotHitRatePercent,
      ),
      rssAdaptiveColdConsecutiveNoHitRuns: this.clampInt(
        settings.rssAdaptiveColdConsecutiveNoHitRuns,
        1,
        24,
        DEFAULT_RSS_ADAPTIVE_COLD_CONSECUTIVE_NO_HIT_RUNS,
      ),
      rssAdaptiveHotIntervalSeconds: this.clampInt(
        settings.rssAdaptiveHotIntervalSeconds,
        10,
        21_600,
        DEFAULT_RSS_ADAPTIVE_HOT_INTERVAL_SECONDS,
      ),
      rssAdaptiveWarmIntervalDivisor: this.clampInt(
        settings.rssAdaptiveWarmIntervalDivisor,
        1,
        8,
        DEFAULT_RSS_ADAPTIVE_WARM_INTERVAL_DIVISOR,
      ),
      rssAdaptiveWarmMinIntervalSeconds,
      rssAdaptiveColdIntervalMultiplier: this.clampInt(
        settings.rssAdaptiveColdIntervalMultiplier,
        1,
        8,
        DEFAULT_RSS_ADAPTIVE_COLD_INTERVAL_MULTIPLIER,
      ),
      rssAdaptiveColdMaxIntervalSeconds: Math.max(
        rssAdaptiveWarmMinIntervalSeconds,
        rssAdaptiveColdMaxIntervalSeconds,
      ),
      rssAdaptiveHotDiscoveryCacheTtlCapSeconds: Math.min(
        rssAdaptiveHotDiscoveryCacheTtlCapSeconds,
        rssAdaptiveWarmDiscoveryCacheTtlCapSeconds,
      ),
      rssAdaptiveWarmDiscoveryCacheTtlCapSeconds: Math.max(
        rssAdaptiveWarmDiscoveryCacheTtlCapSeconds,
        rssAdaptiveHotDiscoveryCacheTtlCapSeconds,
      ),
    };
  }

  private parsePublishedAtFromUrl(url: string) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return undefined;
    }
    const path = parsed.pathname;

    const toUtcTimestamp = (year: number, month: number, day: number) => {
      if (
        !Number.isFinite(year) ||
        !Number.isFinite(month) ||
        !Number.isFinite(day)
      ) {
        return undefined;
      }
      if (month < 1 || month > 12) {
        return undefined;
      }
      if (day < 1 || day > 31) {
        return undefined;
      }
      const ts = Date.UTC(year, month - 1, day);
      if (!Number.isFinite(ts)) {
        return undefined;
      }
      const check = new Date(ts);
      if (
        check.getUTCFullYear() !== year ||
        check.getUTCMonth() !== month - 1 ||
        check.getUTCDate() !== day
      ) {
        return undefined;
      }
      return this.resolveTimestamp(ts);
    };

    const slashDate = /\/(20\d{2})\/([01]\d)\/([0-3]\d)(?:\/|$)/.exec(path);
    if (slashDate) {
      const year = Number(slashDate[1]);
      const month = Number(slashDate[2]);
      const day = Number(slashDate[3]);
      const ts = toUtcTimestamp(year, month, day);
      if (ts) {
        return ts;
      }
    }

    const dashedDate = /(20\d{2})[-_/.]([01]\d)[-_/.]([0-3]\d)/.exec(path);
    if (dashedDate) {
      const year = Number(dashedDate[1]);
      const month = Number(dashedDate[2]);
      const day = Number(dashedDate[3]);
      const ts = toUtcTimestamp(year, month, day);
      if (ts) {
        return ts;
      }
    }

    return undefined;
  }

  private canonicalizeSeedJobs(
    jobs: {
      url: string;
      relevanceScore?: number;
      publishedAtTs?: number;
      crawledAtTs?: number;
      effectiveTs?: number;
      timestampSource?: CrawlDiscoveryTimestampSource;
      prefetchedArticle?: CrawlDiscoveryPrefetchedArticle;
    }[],
    queryParamAllowlist: string[],
  ): CanonicalSeedJob[] {
    const byFingerprint = new Map<string, CanonicalSeedJob>();
    for (const job of jobs) {
      const rawUrl = typeof job.url === "string" ? job.url.trim() : "";
      if (!rawUrl) {
        continue;
      }
      const normalized = buildCanonicalUrlFingerprint(
        rawUrl,
        queryParamAllowlist,
      );
      if (!normalized) {
        continue;
      }
      const existing = byFingerprint.get(normalized.fingerprint);
      if (!existing) {
        byFingerprint.set(normalized.fingerprint, {
          url: normalized.canonicalUrl,
          urlFingerprint: normalized.fingerprint,
          relevanceScore: job.relevanceScore,
          publishedAtTs: this.resolveTimestamp(job.publishedAtTs),
          crawledAtTs: this.resolveTimestamp(job.crawledAtTs),
          effectiveTs: this.resolveTimestamp(job.effectiveTs),
          timestampSource: job.timestampSource,
          prefetchedArticle: this.normalizePrefetchedArticle(
            job.prefetchedArticle,
          ),
        });
        continue;
      }
      const existingEffectiveTs =
        typeof existing.effectiveTs === "number" &&
        Number.isFinite(existing.effectiveTs)
          ? existing.effectiveTs
          : -1;
      const nextEffectiveTs = this.resolveTimestamp(job.effectiveTs) ?? -1;
      const existingScore = existing.relevanceScore ?? Number.NEGATIVE_INFINITY;
      const nextScore = job.relevanceScore ?? Number.NEGATIVE_INFINITY;
      const shouldReplace =
        nextEffectiveTs > existingEffectiveTs ||
        (nextEffectiveTs === existingEffectiveTs && nextScore > existingScore);
      if (shouldReplace) {
        byFingerprint.set(normalized.fingerprint, {
          url: normalized.canonicalUrl,
          urlFingerprint: normalized.fingerprint,
          relevanceScore: job.relevanceScore,
          publishedAtTs: this.resolveTimestamp(job.publishedAtTs),
          crawledAtTs: this.resolveTimestamp(job.crawledAtTs),
          effectiveTs: this.resolveTimestamp(job.effectiveTs),
          timestampSource: job.timestampSource,
          prefetchedArticle: this.normalizePrefetchedArticle(
            job.prefetchedArticle,
          ),
        });
      } else {
        byFingerprint.set(normalized.fingerprint, {
          ...existing,
          prefetchedArticle: this.mergePrefetchedArticle(
            existing.prefetchedArticle,
            this.normalizePrefetchedArticle(job.prefetchedArticle),
          ),
        });
      }
    }
    return Array.from(byFingerprint.values());
  }

  private async findRecentArticleFingerprints(
    orgId: string,
    candidates: CanonicalSeedJob[],
    windowHours: number,
  ) {
    const hours = Math.max(0, Math.min(24 * 30, Math.floor(windowHours)));
    if (hours === 0 || candidates.length === 0) {
      return new Set<string>();
    }

    const since = new Date(Date.now() - hours * 60 * 60 * 1000);
    const fingerprints = Array.from(
      new Set(candidates.map((candidate) => candidate.urlFingerprint)),
    );
    const urls = Array.from(
      new Set(candidates.map((candidate) => candidate.url)),
    );
    const fingerprintByUrl = new Map(
      candidates.map((candidate) => [candidate.url, candidate.urlFingerprint]),
    );

    const records = await this.prisma.article.findMany({
      where: {
        orgId,
        crawlAt: { gte: since },
        OR: [{ urlFingerprint: { in: fingerprints } }, { url: { in: urls } }],
      },
      select: { urlFingerprint: true, url: true },
    });

    const matched = new Set<string>();
    for (const record of records) {
      if (
        typeof record.urlFingerprint === "string" &&
        record.urlFingerprint.length > 0
      ) {
        matched.add(record.urlFingerprint);
        continue;
      }
      const fallback = fingerprintByUrl.get(record.url);
      if (fallback) {
        matched.add(fallback);
      }
    }
    return matched;
  }

  private async findActivePipelineFingerprints(
    sourceId: string,
    candidates: CanonicalSeedJob[],
    activeCutoff: Date,
  ) {
    if (candidates.length === 0) {
      return new Set<string>();
    }

    const fingerprints = Array.from(
      new Set(candidates.map((candidate) => candidate.urlFingerprint)),
    );
    const urls = Array.from(
      new Set(candidates.map((candidate) => candidate.url)),
    );
    const fingerprintByUrl = new Map(
      candidates.map((candidate) => [candidate.url, candidate.urlFingerprint]),
    );
    const records = await this.prisma.pipelineJob.findMany({
      where: {
        sourceId,
        status: { in: ACTIVE_PIPELINE_JOB_STATUSES },
        createdAt: { gte: activeCutoff },
        OR: [{ urlFingerprint: { in: fingerprints } }, { url: { in: urls } }],
      },
      select: { urlFingerprint: true, url: true },
    });

    const matched = new Set<string>();
    for (const record of records) {
      if (
        typeof record.urlFingerprint === "string" &&
        record.urlFingerprint.length > 0
      ) {
        matched.add(record.urlFingerprint);
        continue;
      }
      const fallback = fingerprintByUrl.get(record.url);
      if (fallback) {
        matched.add(fallback);
      }
    }
    return matched;
  }

  private async scheduleDueSources(now: Date, batchSize: number) {
    const schedulerConfig = this.env.newsSourceSchedulerConfig;
    const maxPending = schedulerConfig.backpressureMaxPendingJobs;
    if (maxPending > 0) {
      try {
        const pendingJobs = await this.crawlQueue.getPendingJobCount();
        if (pendingJobs > maxPending) {
          const sourcesToDelay = await this.prisma.newsSource.findMany({
            where: {
              isActive: true,
              AND: [
                { OR: [{ nextRunAt: null }, { nextRunAt: { lte: now } }] },
                {
                  OR: [
                    { circuitOpenUntil: null },
                    { circuitOpenUntil: { lte: now } },
                  ],
                },
              ],
            },
            orderBy: [
              { nextRunAt: "asc" },
              { priority: "desc" },
              { updatedAt: "asc" },
            ],
            take: batchSize,
          });

          if (sourcesToDelay.length > 0) {
            const rescheduleAt = new Date(
              now.getTime() + schedulerConfig.backpressureDelayMs,
            );
            await this.prisma.newsSource.updateMany({
              where: {
                id: { in: sourcesToDelay.map((source) => source.id) },
                OR: [{ nextRunAt: null }, { nextRunAt: { lte: now } }],
              },
              data: { nextRunAt: rescheduleAt },
            });

            const ttlSeconds = Math.max(
              1,
              Math.ceil(schedulerConfig.backpressureDelayMs / 1000),
            );
            await Promise.allSettled(
              sourcesToDelay.map((source) =>
                this.cache.set(
                  `news-source:backpressure:${source.id}`,
                  {
                    until: rescheduleAt.toISOString(),
                    pendingJobs,
                    threshold: maxPending,
                  },
                  ttlSeconds,
                ),
              ),
            );
            await Promise.allSettled(
              sourcesToDelay.map(
                (source) =>
                  this.newsSourceOpsSnapshots?.setBackpressureState(source.id, {
                    until: rescheduleAt.toISOString(),
                    pendingJobs,
                    threshold: maxPending,
                    observedAt: now,
                  }) ?? Promise.resolve(),
              ),
            );

            const countTtlSeconds = 24 * 60 * 60;
            await Promise.allSettled(
              sourcesToDelay.map((source) =>
                this.cache.incr(
                  `news-source:backpressure-count:${source.id}`,
                  countTtlSeconds,
                ),
              ),
            );

            const sourcesByOrgId = new Map<string, number>();
            for (const source of sourcesToDelay) {
              sourcesByOrgId.set(
                source.orgId,
                (sourcesByOrgId.get(source.orgId) ?? 0) + 1,
              );
            }

            await Promise.allSettled(
              Array.from(sourcesByOrgId.entries()).map(
                async ([orgId, delayedCount]) => {
                  const notifyKey = `news-source:backpressure-notify:${orgId}`;
                  const shouldNotify = await this.cache.setIfAbsent(
                    notifyKey,
                    {
                      until: rescheduleAt.toISOString(),
                      pendingJobs,
                      threshold: maxPending,
                    },
                    30 * 60,
                  );
                  if (!shouldNotify) {
                    return;
                  }

                  await this.notifications.notify({
                    orgId,
                    userId: null,
                    type: NotificationType.system,
                    title: "News source scheduler backpressure",
                    body: `Delayed ${delayedCount} source(s) until ${rescheduleAt.toISOString()} (pending ${pendingJobs} > threshold ${maxPending}).`,
                    data: {
                      pendingJobs,
                      threshold: maxPending,
                      delayedCount,
                      rescheduleAt: rescheduleAt.toISOString(),
                      presentation: {
                        kind: NotificationPresentationKind.NewsSourceSchedulerBackpressure,
                        params: {
                          pendingJobs,
                          threshold: maxPending,
                          delayedCount,
                          rescheduleAt: rescheduleAt.toISOString(),
                        },
                      },
                    },
                  });
                },
              ),
            );

            logger.warn(
              {
                pendingJobs,
                threshold: maxPending,
                delayedCount: sourcesToDelay.length,
                rescheduleAt,
              },
              "Backpressure: delayed news source scheduling due to crawl queue backlog",
            );
          }
          return;
        }
      } catch (error) {
        logger.warn(
          { error, threshold: maxPending },
          "Failed to evaluate crawl queue backlog for news source backpressure",
        );
      }
    }

    const sources = await this.prisma.newsSource.findMany({
      where: {
        isActive: true,
        AND: [
          { OR: [{ nextRunAt: null }, { nextRunAt: { lte: now } }] },
          {
            OR: [
              { circuitOpenUntil: null },
              { circuitOpenUntil: { lte: now } },
            ],
          },
        ],
      },
      include: {
        crawlTemplate: {
          select: { id: true, isActive: true, crawlOptions: true },
        },
      },
      orderBy: [
        { nextRunAt: "asc" },
        { priority: "desc" },
        { updatedAt: "asc" },
      ],
      take: batchSize,
    });
    if (sources.length === 0) {
      return;
    }

    const maxEnqueuePerTick = Math.max(
      0,
      Math.floor(schedulerConfig.maxEnqueuePerTick),
    );
    const runtimeSettings = await this.resolveSeedRuntimeSettings();
    const seedFreshnessWindowDays = runtimeSettings.seedFreshnessWindowDays;
    let enqueuedThisTick = 0;

    for (const source of sources) {
      if (maxEnqueuePerTick > 0 && enqueuedThisTick >= maxEnqueuePerTick) {
        logger.info(
          { enqueuedThisTick, maxEnqueuePerTick },
          "Reached max enqueue per tick; stopping news source scheduling for this run",
        );
        break;
      }

      const dedupe = this.computeSchedulerDispatchDedupeKey(source.id, now);
      const dedupeAcquired = await this.cache.setIfAbsent(
        dedupe.key,
        { until: dedupe.until },
        dedupe.ttlSeconds,
      );
      if (!dedupeAcquired) {
        continue;
      }

      void this.cache
        .del(`news-source:backpressure:${source.id}`)
        .catch(() => undefined);
      void this.newsSourceOpsSnapshots
        ?.setBackpressureState(source.id, null)
        .catch(() => undefined);

      const activeCutoff = new Date(
        now.getTime() - schedulerConfig.inFlightLookbackMs,
      );
      const workflowOverlay = await this.workflows.compileNewsSourceOverlay({
        orgId: source.orgId,
        workflowId: source.workflowId,
        workflowVersionId: source.workflowVersionId,
        workflowBindingMode: source.workflowBindingMode,
      });
      const seedConfig = this.normalizeSeedConfig(
        source,
        runtimeSettings,
        workflowOverlay,
      );
      const inFlightLimit = seedConfig ? seedConfig.maxNewUrlsPerRun : 1;
      const inFlightJobs = await this.prisma.pipelineJob.findMany({
        where: {
          sourceId: source.id,
          status: { in: ACTIVE_PIPELINE_JOB_STATUSES },
          createdAt: { gte: activeCutoff },
        },
        orderBy: { createdAt: "desc" },
        select: { id: true, status: true, createdAt: true },
        take: inFlightLimit,
      });

      const inFlightCount = inFlightJobs.length;
      const remainingCapacity = seedConfig
        ? seedConfig.maxNewUrlsPerRun - inFlightCount
        : 0;
      const shouldBlock = seedConfig
        ? remainingCapacity <= 0
        : inFlightCount > 0;

      if (shouldBlock) {
        const newest = inFlightJobs[0];
        const rescheduleAt = new Date(
          now.getTime() + schedulerConfig.inFlightRescheduleDelayMs,
        );
        try {
          await this.prisma.newsSource.updateMany({
            where: {
              id: source.id,
              OR: [{ nextRunAt: null }, { nextRunAt: { lte: now } }],
            },
            data: { nextRunAt: rescheduleAt },
          });
        } catch (error) {
          logger.warn(
            { error, sourceId: source.id, orgId: source.orgId },
            "Failed to reschedule news source with in-flight pipeline job",
          );
        }

        logger.info(
          {
            sourceId: source.id,
            orgId: source.orgId,
            inFlightCount,
            inFlightLimit,
            newestJobId: newest?.id,
            newestJobStatus: newest?.status,
            newestJobCreatedAt: newest?.createdAt,
            rescheduleAt,
          },
          seedConfig
            ? "Skipped scheduling: seed run at capacity due to in-flight pipeline jobs"
            : "Skipped scheduling due to in-flight pipeline job",
        );
        continue;
      }

      const scheduledFor = source.nextRunAt ?? now;

      const maxNewUrlsThisRun = seedConfig ? Math.max(0, remainingCapacity) : 1;
      try {
        const rssAdaptiveEnabled = this.shouldUseRssAdaptive(
          source,
          seedConfig,
        );
        const rssAdaptiveState = rssAdaptiveEnabled
          ? await this.readRssAdaptiveState(source.id)
          : null;
        const rssAdaptiveTierBefore =
          rssAdaptiveEnabled && rssAdaptiveState
            ? this.resolveRssAdaptiveTier(
                rssAdaptiveState,
                source.priority,
                runtimeSettings,
              )
            : null;
        const rssAdaptiveDiscoveryCacheTtlSeconds =
          seedConfig && rssAdaptiveTierBefore
            ? this.resolveRssAdaptiveCacheTtlSeconds(
                seedConfig.cacheTtlSeconds,
                rssAdaptiveTierBefore,
                runtimeSettings,
              )
            : undefined;

        if (seedConfig) {
          logger.debug(
            {
              sourceId: source.id,
              orgId: source.orgId,
              mode: seedConfig.mode,
              seedFreshnessWindowDays,
              seedCacheTtlSeconds: seedConfig.cacheTtlSeconds,
              seedCacheTtlPolicy: seedConfig.cacheTtlPolicy,
              rssAdaptiveEnabled: seedConfig.rssAdaptiveEnabled,
              rssAdaptiveTier: rssAdaptiveTierBefore,
              rssAdaptiveDiscoveryCacheTtlSeconds:
                rssAdaptiveDiscoveryCacheTtlSeconds ?? null,
            },
            "Resolved seed discovery runtime policy",
          );
        }
        const jobsToSchedule = seedConfig
          ? await this.resolveSeedCandidates(
              source,
              seedConfig,
              seedFreshnessWindowDays,
              workflowOverlay,
              {
                cacheTtlSecondsOverride: rssAdaptiveDiscoveryCacheTtlSeconds,
              },
            )
          : [{ url: source.url, relevanceScore: undefined }];
        if (seedConfig?.mode === "deep") {
          await this.clearDeepDiscoveryFailureState(source.id);
        }

        const canonicalJobs = seedConfig
          ? this.canonicalizeSeedJobs(
              jobsToSchedule,
              seedConfig.queryParamAllowlist,
            )
          : [];
        const [recentArticleFingerprints, activeFingerprints] =
          await Promise.all([
            seedConfig
              ? this.findRecentArticleFingerprints(
                  source.orgId,
                  canonicalJobs,
                  seedConfig.dedupeWindowHours,
                )
              : Promise.resolve(new Set<string>()),
            seedConfig
              ? this.findActivePipelineFingerprints(
                  source.id,
                  canonicalJobs,
                  activeCutoff,
                )
              : Promise.resolve(new Set<string>()),
          ]);

        const newJobs = seedConfig
          ? canonicalJobs
              .filter(
                (job) => !recentArticleFingerprints.has(job.urlFingerprint),
              )
              .filter((job) => !activeFingerprints.has(job.urlFingerprint))
              .slice(0, maxNewUrlsThisRun)
          : jobsToSchedule;

        let nextRunAt = this.computeNextRunAt(source, scheduledFor, now);
        let rssAdaptiveTierAfter: RssAdaptiveTier | null = null;
        let rssAdaptiveIntervalSeconds: number | null = null;
        if (rssAdaptiveEnabled && rssAdaptiveState) {
          const nextAdaptiveState = this.buildNextRssAdaptiveState(
            rssAdaptiveState,
            newJobs.length > 0,
          );
          await this.writeRssAdaptiveState(source.id, nextAdaptiveState);
          rssAdaptiveTierAfter = this.resolveRssAdaptiveTier(
            nextAdaptiveState,
            source.priority,
            runtimeSettings,
          );
          rssAdaptiveIntervalSeconds = this.resolveRssAdaptiveIntervalSeconds(
            source.frequencySeconds,
            rssAdaptiveTierAfter,
            runtimeSettings,
          );
          nextRunAt = this.computeNextRunAt(source, scheduledFor, now, {
            intervalSecondsOverride: rssAdaptiveIntervalSeconds,
          });
        }

        await this.prisma.newsSource.update({
          where: { id: source.id },
          data: {
            lastRunAt: scheduledFor,
            nextRunAt,
            ...(seedConfig?.mode === "deep" ? { circuitOpenUntil: null } : {}),
          },
        });

        if (newJobs.length === 0) {
          logger.info(
            {
              sourceId: source.id,
              orgId: source.orgId,
              mode: "seed",
              seedMode: seedConfig?.mode,
              seedFreshnessWindowDays,
              seedCacheTtlSeconds: seedConfig?.cacheTtlSeconds,
              seedCacheTtlPolicy: seedConfig?.cacheTtlPolicy,
              rssAdaptiveEnabled: seedConfig?.rssAdaptiveEnabled ?? false,
              rssAdaptiveTierBefore,
              rssAdaptiveTierAfter,
              rssAdaptiveIntervalSeconds,
              rssAdaptiveDiscoveryCacheTtlSeconds:
                rssAdaptiveDiscoveryCacheTtlSeconds ?? null,
              scheduledFor,
              nextRunAt,
            },
            "News source run scheduled no new URLs",
          );
          continue;
        }

        const remainingEnqueueCapacity =
          maxEnqueuePerTick > 0
            ? Math.max(0, maxEnqueuePerTick - enqueuedThisTick)
            : newJobs.length;
        const jobsToEnqueue = newJobs.slice(0, remainingEnqueueCapacity);
        if (jobsToEnqueue.length === 0) {
          logger.info(
            {
              sourceId: source.id,
              orgId: source.orgId,
              enqueuedThisTick,
              maxEnqueuePerTick,
            },
            "Skipped scheduling due to global enqueue limit",
          );
          break;
        }
        if (jobsToEnqueue.length < newJobs.length) {
          logger.info(
            {
              sourceId: source.id,
              orgId: source.orgId,
              limited: jobsToEnqueue.length,
              original: newJobs.length,
              enqueuedThisTick,
              maxEnqueuePerTick,
            },
            "Limited news source scheduling due to global enqueue cap",
          );
        }

        const bullPriority = this.toBullmqPriority(source.priority);
        const crawlPriorityClass = this.toCrawlPriorityClass(source.priority);
        const crawlActorId = await this.resolveCrawlActorId(source.orgId);
        if (!crawlActorId) {
          logger.warn(
            { sourceId: source.id, orgId: source.orgId },
            "News source scheduler cannot resolve crawl task actor; skipping scheduling",
          );
          continue;
        }
        const seedParentUrl = seedConfig
          ? seedConfig.mode === "rss"
            ? (seedConfig.feedUrl ?? source.url)
            : source.url
          : undefined;
        let rssSkippedNoBodyCount = 0;

        for (const job of jobsToEnqueue) {
          const publishedAtTs =
            "publishedAtTs" in job ? job.publishedAtTs : undefined;
          const crawledAtTs =
            "crawledAtTs" in job ? job.crawledAtTs : undefined;
          const effectiveTs =
            "effectiveTs" in job ? job.effectiveTs : undefined;
          const timestampSource =
            "timestampSource" in job
              ? (job.timestampSource as
                  | CrawlDiscoveryTimestampSource
                  | undefined)
              : undefined;
          const publishedAt = this.toIsoTimestamp(publishedAtTs);
          const crawledAt = this.toIsoTimestamp(crawledAtTs);
          const effectiveAt = this.toIsoTimestamp(effectiveTs);
          const payload = this.buildPayload(
            source,
            job.url,
            seedConfig
              ? {
                  mode: seedConfig.mode,
                  parentUrl: seedParentUrl ?? source.url,
                  relevanceScore: job.relevanceScore,
                  publishedAt,
                  crawledAt,
                  effectiveAt,
                  timestampSource,
                  dedupeWindowHours: seedConfig.dedupeWindowHours,
                  queryParamAllowlist: seedConfig.queryParamAllowlist,
                }
              : undefined,
          );

          if (seedConfig?.mode === "rss") {
            const rssResult = await this.enqueueRssSeedPipelineJob({
              source,
              job,
              scheduledFor,
              payload: payload as Record<string, unknown>,
              seedConfig,
              seedParentUrl: seedParentUrl ?? source.url,
              actorId: crawlActorId,
              bullPriority,
            });
            if (rssResult.skippedNoBody) {
              rssSkippedNoBodyCount += 1;
              continue;
            }
            if (!rssResult.enqueueFailed) {
              enqueuedThisTick += 1;
            }
            continue;
          }

          const displayNamePrefix = `NewsSource:${source.id}:`;
          const displayName = `${displayNamePrefix}${source.name ?? ""}`.slice(
            0,
            80,
          );

          const itemPayloadConfig: Record<string, unknown> = {
            sourceId: source.id,
            sourceType: source.siteType,
            crawlTemplateId: source.crawlTemplateId ?? undefined,
            ...(seedConfig
              ? {
                  urlQueryParamAllowlist: seedConfig.queryParamAllowlist,
                }
              : {}),
            ...(seedConfig
              ? {
                  newsSourceSeed: {
                    mode: seedConfig.mode,
                    parentUrl: seedParentUrl ?? source.url,
                    relevanceScore: job.relevanceScore,
                    publishedAt,
                    crawledAt,
                    effectiveAt,
                    timestampSource,
                    dedupeWindowHours: seedConfig.dedupeWindowHours,
                  },
                }
              : {}),
          };

          const crawlTaskConfig: Record<string, unknown> = {
            ...(payload.crawlOptions ?? {}),
            ingestToItems: true,
            pipelineJobId: "",
            pipelinePriority: bullPriority,
            crawlPriorityClass,
            sourcePriority: source.priority,
            ...(seedConfig
              ? {
                  orgContentDedupeWindowHours: seedConfig.dedupeWindowHours,
                  urlQueryParamAllowlist: seedConfig.queryParamAllowlist,
                }
              : {}),
            itemPayload: {
              sourceName: payload.sourceName,
              language: payload.language,
              keywords: payload.keywords,
              tags: payload.tags,
              summaryHints: payload.summaryHints,
              metadata: {
                ...itemPayloadConfig,
                ...(payload.metadata ?? {}),
              },
              forceRefresh: payload.forceRefresh,
            },
          };

          const { pipelineJobId, crawlTaskId } = await this.prisma.$transaction(
            async (tx) => {
              const pipelineJob = await tx.pipelineJob.create({
                data: {
                  orgId: source.orgId,
                  sourceId: source.id,
                  url: job.url,
                  urlFingerprint:
                    "urlFingerprint" in job ? job.urlFingerprint : null,
                  priority: source.priority,
                  status: PipelineJobStatus.queued,
                  queueName: ITEM_PIPELINE_QUEUE_NAME,
                  scheduledFor,
                  metadata: {
                    sourceName: source.name,
                    sourceType: source.siteType,
                    seedMode: seedConfig ? seedConfig.mode : "single",
                    seedParentUrl: seedConfig ? seedParentUrl : undefined,
                    relevanceScore: seedConfig ? job.relevanceScore : undefined,
                    publishedAt,
                    crawledAt,
                    effectiveAt,
                    timestampSource,
                    urlFingerprint:
                      "urlFingerprint" in job ? job.urlFingerprint : undefined,
                  },
                },
              });

              crawlTaskConfig.pipelineJobId = pipelineJob.id;
              const crawlTaskConfigForStorage = crawlTaskConfig;

              const existingTask = await tx.crawlTask.findFirst({
                where: {
                  orgId: source.orgId,
                  newsSourceId: source.id,
                  targetUrl: job.url,
                },
                select: { id: true },
              });

              let taskId: string;
              if (existingTask) {
                const updatedTask = await tx.crawlTask.update({
                  where: { id: existingTask.id },
                  data: {
                    newsSourceId: source.id,
                    displayName,
                    status: "pending",
                    concurrency: 1,
                    keywords: payload.keywords,
                    config: toPrismaJsonValue(crawlTaskConfigForStorage),
                    lastError: null,
                  },
                  select: { id: true },
                });
                taskId = updatedTask.id;
              } else {
                const createdTask = await tx.crawlTask.create({
                  data: {
                    orgId: source.orgId,
                    createdById: crawlActorId,
                    newsSourceId: source.id,
                    targetUrl: job.url,
                    displayName,
                    status: "pending",
                    concurrency: 1,
                    keywords: payload.keywords,
                    config: toPrismaJsonValue(crawlTaskConfigForStorage),
                  },
                  select: { id: true },
                });
                taskId = createdTask.id;
              }

              await tx.pipelineJob.update({
                where: { id: pipelineJob.id },
                data: {
                  metadata: {
                    ...(pipelineJob.metadata as
                      | Record<string, unknown>
                      | null
                      | undefined),
                    crawlTaskId: taskId,
                  },
                },
              });

              return {
                pipelineJobId: pipelineJob.id,
                crawlTaskId: taskId,
              };
            },
          );

          try {
            await this.crawlQueue.enqueueTask(
              crawlTaskId,
              source.orgId,
              crawlActorId,
              {
                priorityClass: crawlPriorityClass,
                sourcePriority: source.priority,
                sourceId: source.id,
              },
            );
            await this.prisma.crawlTask.updateMany({
              where: { id: crawlTaskId },
              data: { status: "queued" },
            });
            await this.newsSourceOpsSnapshots?.syncQueueCounts(
              source.orgId,
              source.id,
            );
            await this.newsSourceOpsSnapshots?.refreshSnapshotForSource(
              source.orgId,
              source.id,
            );
            enqueuedThisTick += 1;
          } catch (queueError) {
            logger.error(
              {
                error: queueError,
                pipelineJobId,
                orgId: source.orgId,
                sourceId: source.id,
                crawlTaskId,
              },
              "Failed to enqueue news source crawl task",
            );
            await Promise.allSettled([
              this.prisma.pipelineJob.updateMany({
                where: { id: pipelineJobId },
                data: {
                  status: PipelineJobStatus.failed,
                  error:
                    queueError instanceof Error
                      ? queueError.message
                      : String(queueError),
                  completedAt: new Date(),
                },
              }),
              this.prisma.crawlTask.updateMany({
                where: { id: crawlTaskId },
                data: {
                  status: "failed",
                  lastError:
                    queueError instanceof Error
                      ? queueError.message
                      : String(queueError),
                },
              }),
            ]);
            await this.newsSourceOpsSnapshots?.syncQueueCounts(
              source.orgId,
              source.id,
            );
            await this.newsSourceOpsSnapshots?.refreshSnapshotForSource(
              source.orgId,
              source.id,
            );
          }
        }
        if (rssSkippedNoBodyCount > 0) {
          await this.recordRssNoBodySkipMetric({
            orgId: source.orgId,
            sourceId: source.id,
            sourceName: source.name ?? undefined,
            skippedCount: rssSkippedNoBodyCount,
            context: "schedule",
          });
          logger.info(
            {
              sourceId: source.id,
              orgId: source.orgId,
              mode: seedConfig?.mode ?? "single",
              rssSkippedNoBodyCount,
            },
            "Skipped RSS candidates without prefetched body markdown",
          );
        }

        if (maxEnqueuePerTick > 0 && enqueuedThisTick >= maxEnqueuePerTick) {
          logger.info(
            { enqueuedThisTick, maxEnqueuePerTick },
            "Reached max enqueue per tick; stopping news source scheduling for this run",
          );
          break;
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        if (
          seedConfig?.mode === "deep" &&
          this.isDeepDiscoveryFailureError(error)
        ) {
          await this.markDeepDiscoveryFailureState(source, error, new Date());
        }
        logger.error(
          { error, errorMessage, sourceId: source.id, orgId: source.orgId },
          "Failed to schedule news source pipeline job",
        );
      }
    }
  }
}
