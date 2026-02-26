import { createLogger } from "@modular/utils";
import { Injectable, NotFoundException } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { NotificationType, PipelineJobStatus, Prisma } from "@prisma/client";
import { parseExpression } from "cron-parser";
import { createHash } from "node:crypto";

import { toPrismaJsonValue } from "../../common/prisma-json";
import { CacheService } from "../cache/cache.service";
import { EnvService } from "../config/config.service";
import { PrismaService } from "../config/prisma.service";
import { CrawlMetadataService } from "../crawl/crawl-metadata.service";
import { CrawlQueueService } from "../crawl/crawl-queue.service";
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
import { NotificationsService } from "../notifications/notifications.service";
import { NewsSourceSchedulerSettingsService } from "../system-settings/news-source-scheduler-settings.service";

import { ITEM_PIPELINE_QUEUE_NAME } from "./queue.constants";

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

type NewsSourceWithTemplate = Prisma.NewsSourceGetPayload<{
  include: {
    crawlTemplate: { select: { id: true; isActive: true; crawlOptions: true } };
  };
}>;

interface SeedConfig {
  enabled: boolean;
  mode: "sitemap" | "rss" | "list" | "deep";
  domain?: string;
  pattern?: string;
  feedUrl?: string;
  maxUrls: number;
  maxNewUrlsPerRun: number;
  listMaxPages: number;
  listPageConcurrency: number;
  followPagination: boolean;
  queryTokens?: string[];
  scoreThreshold: number;
  dedupeWindowHours: number;
  cacheTtlSeconds: number;
  cacheTtlPolicy: "global_forced" | "source_override" | "mode_default";
  deep?: DeepSeedConfig;
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
}

const DEFAULT_SEED_RUNTIME_SETTINGS: SeedRuntimeSettings = {
  seedFreshnessWindowDays: DEFAULT_SEED_FRESHNESS_WINDOW_DAYS,
  seedCacheTtlSecondsSitemapRss: DEFAULT_SEED_CACHE_TTL_SECONDS_SITEMAP_RSS,
  seedCacheTtlSecondsListDeep: DEFAULT_SEED_CACHE_TTL_SECONDS_LIST_DEEP,
  seedCacheTtlForceGlobal: DEFAULT_SEED_CACHE_TTL_FORCE_GLOBAL,
};

@Injectable()
export class NewsSourceSchedulerService {
  private readonly sourcePriorityMin = -100;
  private readonly sourcePriorityMax = 100;
  private readonly crawlHotPriorityThreshold = CRAWL_HOT_PRIORITY_THRESHOLD;
  private readonly crawlActorByOrgId = new Map<string, string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly metadataService: CrawlMetadataService,
    private readonly crawlQueue: CrawlQueueService,
    private readonly cache: CacheService,
    private readonly env: EnvService,
    private readonly crawlTaskService: CrawlTaskService,
    private readonly notifications: NotificationsService,
    private readonly schedulerSettings: NewsSourceSchedulerSettingsService,
  ) {}

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

  @Cron(CronExpression.EVERY_MINUTE)
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

        const dedupe = this.computeMinuteDispatchDedupeKey(source.id, now);
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

          const activeCutoff = new Date(
            now.getTime() - schedulerConfig.inFlightLookbackMs,
          );
          seedConfig = this.normalizeSeedConfig(source);
          let runtimeSettings = DEFAULT_SEED_RUNTIME_SETTINGS;
          if (seedConfig) {
            runtimeSettings = await this.resolveSeedRuntimeSettings();
            const normalizedSeedConfig = this.normalizeSeedConfig(
              source,
              runtimeSettings,
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
              )
            : [{ url: source.url, relevanceScore: undefined }];
          if (seedConfig?.mode === "deep") {
            await this.clearDeepDiscoveryFailureState(source.id);
          }

          const candidateUrls = jobsToSchedule.map((job) => job.url);
          const [recentArticles, activeUrls] = await Promise.all([
            seedConfig
              ? this.findRecentArticleUrls(
                  source.orgId,
                  candidateUrls,
                  seedConfig.dedupeWindowHours,
                )
              : Promise.resolve(new Set<string>()),
            seedConfig
              ? this.findActivePipelineUrls(
                  source.id,
                  candidateUrls,
                  activeCutoff,
                )
              : Promise.resolve(new Set<string>()),
          ]);

          const newJobs = seedConfig
            ? jobsToSchedule
                .filter((job) => !recentArticles.has(job.url))
                .filter((job) => !activeUrls.has(job.url))
                .slice(0, maxNewUrlsThisRun)
            : jobsToSchedule;
          const skippedCount = Math.max(
            0,
            jobsToSchedule.length - newJobs.length,
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

          for (const job of newJobs) {
            const payload = this.buildPayload(
              source,
              job.url,
              seedConfig
                ? {
                    mode: seedConfig.mode,
                    parentUrl: seedParentUrl ?? source.url,
                    relevanceScore: job.relevanceScore,
                  }
                : undefined,
            );

            const displayNamePrefix = `NewsSource:${source.id}:`;
            const displayName =
              `${displayNamePrefix}${source.name ?? ""}`.slice(0, 80);

            const itemPayloadConfig: Record<string, unknown> = {
              sourceId: source.id,
              sourceType: source.siteType,
              crawlTemplateId: source.crawlTemplateId ?? undefined,
              ...(seedConfig
                ? {
                    newsSourceSeed: {
                      mode: seedConfig.mode,
                      parentUrl: seedParentUrl ?? source.url,
                      relevanceScore: job.relevanceScore,
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
                      triggeredById,
                    },
                  },
                });

                crawlTaskConfig.pipelineJobId = pipelineJob.id;
                const crawlTaskConfigForStorage = crawlTaskConfig;

                const existingTask = await tx.crawlTask.findFirst({
                  where: {
                    orgId: source.orgId,
                    targetUrl: job.url,
                    displayName: { startsWith: displayNamePrefix },
                  },
                  select: { id: true },
                });

                let taskId: string;
                if (existingTask) {
                  const updatedTask = await tx.crawlTask.update({
                    where: { id: existingTask.id },
                    data: {
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
                },
              );
              await this.prisma.crawlTask.updateMany({
                where: { id: crawlTaskId },
                data: { status: "queued" },
              });
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
            }
          }

          return {
            sourceId: source.id,
            mode: seedConfig ? seedConfig.mode : "single",
            scheduledFor: scheduledFor.toISOString(),
            nextRunAt: nextRunAt.toISOString(),
            scheduledCount: newJobs.length,
            skippedCount,
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
      select: { id: true, orgId: true },
    });
    if (!source || source.orgId !== orgId) {
      throw new NotFoundException("News source not found");
    }

    const prefix = `NewsSource:${source.id}:`;
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
        displayName: { startsWith: prefix },
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
      select: { id: true, orgId: true },
    });
    if (!source || source.orgId !== orgId) {
      throw new NotFoundException("News source not found");
    }

    const latestJob = await this.prisma.pipelineJob.findFirst({
      where: { orgId, sourceId: source.id },
      orderBy: { createdAt: "desc" },
      select: { metadata: true },
    });

    const isRecord = (value: unknown): value is Record<string, unknown> =>
      Boolean(value) && typeof value === "object" && !Array.isArray(value);
    const crawlTaskId = isRecord(latestJob?.metadata)
      ? latestJob?.metadata.crawlTaskId
      : null;
    if (typeof crawlTaskId !== "string" || crawlTaskId.length === 0) {
      throw new NotFoundException("No crawl task found for latest job");
    }

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
    return {
      sourceId: source.id,
      crawlTaskId,
      status: retried.status,
      retried: true,
    };
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
    const normalized = Number.isFinite(priority) ? Math.round(priority) : 0;
    const clamped = Math.max(
      this.sourcePriorityMin,
      Math.min(this.sourcePriorityMax, normalized),
    );
    return this.sourcePriorityMax + 1 - clamped;
  }

  private toCrawlPriorityClass(priority: number): CrawlPriorityClass {
    const normalized = Number.isFinite(priority) ? Math.round(priority) : 0;
    return normalized >= this.crawlHotPriorityThreshold ? "hot" : "normal";
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
      source.frequencySeconds,
      scheduledFor,
      now,
    );
  }

  private computeMinuteDispatchDedupeKey(sourceId: string, now: Date) {
    const bucketStart = new Date(now.getTime());
    bucketStart.setSeconds(0, 0);
    const bucketEnd = new Date(bucketStart.getTime() + 60_000);
    const ttlSeconds = Math.max(
      1,
      Math.ceil((bucketEnd.getTime() - now.getTime()) / 1000) + 5,
    );
    return {
      key: `news-source:dispatch-minute:${sourceId}:${bucketStart.toISOString()}`,
      until: bucketEnd.toISOString(),
      ttlSeconds,
    };
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
    },
  ) {
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
        crawlTemplateId: source.crawlTemplateId ?? undefined,
        ...(seed
          ? {
              newsSourceSeed: {
                mode: seed.mode,
                parentUrl: seed.parentUrl,
                relevanceScore: seed.relevanceScore,
              },
            }
          : {}),
        ...metadata,
      },
      crawlOptions: this.withAutoCrawlQualityDefaults(
        this.mergeOptions(
          source.crawlTemplate?.isActive
            ? this.normalizeOptions(source.crawlTemplate.crawlOptions)
            : undefined,
          this.normalizeOptions(config.crawlOptions),
        ),
        seed?.mode && seed.mode !== "single" ? seed.mode : undefined,
      ),
      forceRefresh: Boolean(config.forceRefresh),
    };
  }

  private normalizeSeedConfig(
    source: NewsSourceWithTemplate,
    runtimeSettings: SeedRuntimeSettings = DEFAULT_SEED_RUNTIME_SETTINGS,
  ) {
    const config =
      source.config &&
      typeof source.config === "object" &&
      !Array.isArray(source.config)
        ? (source.config as Record<string, unknown>)
        : null;
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

    return {
      enabled: true,
      mode,
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
      maxUrls: this.clampInt(seed.maxUrls, 1, 2_000, 200),
      maxNewUrlsPerRun: this.clampInt(seed.maxNewUrlsPerRun, 1, 500, 80),
      listMaxPages: this.clampInt(seed.listMaxPages, 1, 20, 6),
      listPageConcurrency: this.clampInt(seed.listPageConcurrency, 1, 5, 2),
      followPagination: seed.followPagination !== false,
      queryTokens,
      scoreThreshold: this.clampFloat(seed.scoreThreshold, 0, 1, 0),
      dedupeWindowHours: this.clampInt(seed.dedupeWindowHours, 0, 24 * 30, 24),
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
  ) {
    if (seed.mode === "sitemap" && !seed.domain) {
      return [];
    }

    const cacheKey = this.buildSeedDiscoveryCacheKey(source.id, source.url, seed);
    const discovered = await this.cache.wrap<string[]>(
      cacheKey,
      seed.cacheTtlSeconds,
      async () => {
        if (seed.mode === "rss") {
          return this.metadataService.discoverRssUrls({
            feedUrl: seed.feedUrl ?? source.url,
            maxUrls: seed.maxUrls,
          });
        }
        if (seed.mode === "list") {
          const config =
            source.config &&
            typeof source.config === "object" &&
            !Array.isArray(source.config)
              ? (source.config as Record<string, unknown>)
              : {};
          const crawlOptions = this.mergeOptions(
            source.crawlTemplate?.isActive
              ? this.normalizeOptions(source.crawlTemplate.crawlOptions)
              : undefined,
            this.normalizeOptions(config.crawlOptions),
          );
          const crawlOptionsWithDefaults = this.withAutoCrawlQualityDefaults(
            crawlOptions,
            "list",
          );
          return this.metadataService.discoverListUrls({
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
        if (seed.mode === "deep") {
          const config =
            source.config &&
            typeof source.config === "object" &&
            !Array.isArray(source.config)
              ? (source.config as Record<string, unknown>)
              : {};
          const crawlOptions = this.mergeOptions(
            source.crawlTemplate?.isActive
              ? this.normalizeOptions(source.crawlTemplate.crawlOptions)
              : undefined,
            this.normalizeOptions(config.crawlOptions),
          );
          const crawlOptionsWithDefaults = this.withAutoCrawlQualityDefaults(
            crawlOptions,
            "deep",
          );
          return this.metadataService.discoverDeepUrls({
            url: source.url,
            domain: seed.domain,
            pattern: seed.pattern,
            maxUrls: seed.maxUrls,
            deep: seed.deep,
            query: seed.queryTokens?.join(" "),
            crawlOptions: crawlOptionsWithDefaults,
          });
        }
        return this.metadataService.discoverSitemapUrls({
          domain: seed.domain,
          pattern: seed.pattern,
          maxUrls: seed.maxUrls,
        });
      },
      { lockTtlMs: 15_000, maxWaitMs: 15_000, retryDelayMs: 100 },
    );

    const unique = Array.from(
      new Set(
        discovered
          .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
          .filter((entry) => entry.length > 0),
      ),
    );

    const freshnessWindowDays = Math.max(
      1,
      Math.min(
        MAX_SEED_FRESHNESS_WINDOW_DAYS,
        Math.floor(seedFreshnessWindowDays),
      ),
    );
    const freshnessCutoffTs = Date.now() - freshnessWindowDays * 24 * 60 * 60 * 1000;

    const scored = unique
      .map((url) => ({
        url,
        relevanceScore: this.scoreUrl(url, seed.queryTokens),
        publishedAtTs: this.parsePublishedAtFromUrl(url),
      }))
      .filter((entry) =>
        seed.scoreThreshold > 0
          ? (entry.relevanceScore ?? 0) >= seed.scoreThreshold
          : true,
      )
      .filter((entry) =>
        typeof entry.publishedAtTs === "number" && Number.isFinite(entry.publishedAtTs)
          ? entry.publishedAtTs >= freshnessCutoffTs
          : true,
      );

    scored.sort((a, b) => {
      const aPublishedAtTs =
        typeof a.publishedAtTs === "number" && Number.isFinite(a.publishedAtTs)
          ? a.publishedAtTs
          : -1;
      const bPublishedAtTs =
        typeof b.publishedAtTs === "number" && Number.isFinite(b.publishedAtTs)
          ? b.publishedAtTs
          : -1;
      if (aPublishedAtTs !== bPublishedAtTs) {
        return bPublishedAtTs - aPublishedAtTs;
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

  private buildSeedDiscoveryCacheKey(
    sourceId: string,
    sourceUrl: string,
    seed: SeedConfig,
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
      cacheTtlSeconds: seed.cacheTtlSeconds,
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

  private async resolveSeedRuntimeSettings(): Promise<SeedRuntimeSettings> {
    const settings = await this.schedulerSettings.getSettings();
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
      if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
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
      return ts;
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

    const dashedDate = /(20\d{2})[-_/\.]([01]\d)[-_/\.]([0-3]\d)/.exec(path);
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

  private async findRecentArticleUrls(
    orgId: string,
    urls: string[],
    windowHours: number,
  ) {
    const hours = Math.max(0, Math.min(24 * 30, Math.floor(windowHours)));
    if (hours === 0 || urls.length === 0) {
      return new Set<string>();
    }
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);
    const records = await this.prisma.article.findMany({
      where: { orgId, url: { in: urls }, crawlAt: { gte: since } },
      select: { url: true },
    });
    return new Set(records.map((record) => record.url));
  }

  private async findActivePipelineUrls(
    sourceId: string,
    urls: string[],
    activeCutoff: Date,
  ) {
    if (urls.length === 0) {
      return new Set<string>();
    }
    const records = await this.prisma.pipelineJob.findMany({
      where: {
        sourceId,
        url: { in: urls },
        status: { in: ACTIVE_PIPELINE_JOB_STATUSES },
        createdAt: { gte: activeCutoff },
      },
      select: { url: true },
    });
    return new Set(records.map((record) => record.url));
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

      const dedupe = this.computeMinuteDispatchDedupeKey(source.id, now);
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

      const activeCutoff = new Date(
        now.getTime() - schedulerConfig.inFlightLookbackMs,
      );
      const seedConfig = this.normalizeSeedConfig(source, runtimeSettings);
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
      const nextRunAt = this.computeNextRunAt(source, scheduledFor, now);

      const maxNewUrlsThisRun = seedConfig ? Math.max(0, remainingCapacity) : 1;
      try {
        if (seedConfig) {
          logger.debug(
            {
              sourceId: source.id,
              orgId: source.orgId,
              mode: seedConfig.mode,
              seedFreshnessWindowDays,
              seedCacheTtlSeconds: seedConfig.cacheTtlSeconds,
              seedCacheTtlPolicy: seedConfig.cacheTtlPolicy,
            },
            "Resolved seed discovery runtime policy",
          );
        }
        const jobsToSchedule = seedConfig
          ? await this.resolveSeedCandidates(
              source,
              seedConfig,
              seedFreshnessWindowDays,
            )
          : [{ url: source.url, relevanceScore: undefined }];
        if (seedConfig?.mode === "deep") {
          await this.clearDeepDiscoveryFailureState(source.id);
        }

        const candidateUrls = jobsToSchedule.map((job) => job.url);
        const [recentArticles, activeUrls] = await Promise.all([
          seedConfig
            ? this.findRecentArticleUrls(
                source.orgId,
                candidateUrls,
                seedConfig.dedupeWindowHours,
              )
            : Promise.resolve(new Set<string>()),
          seedConfig
            ? this.findActivePipelineUrls(
                source.id,
                candidateUrls,
                activeCutoff,
              )
            : Promise.resolve(new Set<string>()),
        ]);

        const newJobs = seedConfig
          ? jobsToSchedule
              .filter((job) => !recentArticles.has(job.url))
              .filter((job) => !activeUrls.has(job.url))
              .slice(0, maxNewUrlsThisRun)
          : jobsToSchedule;

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

        for (const job of jobsToEnqueue) {
          const payload = this.buildPayload(
            source,
            job.url,
            seedConfig
              ? {
                  mode: seedConfig.mode,
                  parentUrl: seedParentUrl ?? source.url,
                  relevanceScore: job.relevanceScore,
                }
              : undefined,
          );

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
                  newsSourceSeed: {
                    mode: seedConfig.mode,
                    parentUrl: seedParentUrl ?? source.url,
                    relevanceScore: job.relevanceScore,
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
                  },
                },
              });

              crawlTaskConfig.pipelineJobId = pipelineJob.id;
              const crawlTaskConfigForStorage = crawlTaskConfig;

              const existingTask = await tx.crawlTask.findFirst({
                where: {
                  orgId: source.orgId,
                  targetUrl: job.url,
                  displayName: { startsWith: displayNamePrefix },
                },
                select: { id: true },
              });

              let taskId: string;
              if (existingTask) {
                const updatedTask = await tx.crawlTask.update({
                  where: { id: existingTask.id },
                  data: {
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
              },
            );
            await this.prisma.crawlTask.updateMany({
              where: { id: crawlTaskId },
              data: { status: "queued" },
            });
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
          }
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
