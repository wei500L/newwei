import { RawItemModel } from "@modular/mongo";
import { createLogger } from "@modular/utils";
import { Injectable } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { PipelineJobStatus, Prisma } from "@prisma/client";

import { ItemStatus } from "../../common/pipeline-status";
import { CacheService } from "../cache/cache.service";
import { EnvService } from "../config/config.service";
import { PrismaService } from "../config/prisma.service";
import { CrawlMetadataService } from "../crawl/crawl-metadata.service";

import { ITEM_PIPELINE_QUEUE_NAME } from "./queue.constants";
import { QueueService } from "./queue.service";

const logger = createLogger({ name: "news-source-scheduler" });
const ACTIVE_PIPELINE_JOB_STATUSES: PipelineJobStatus[] = [
  PipelineJobStatus.pending,
  PipelineJobStatus.queued,
  PipelineJobStatus.running,
  PipelineJobStatus.delayed,
];

type NewsSourceWithTemplate = Prisma.NewsSourceGetPayload<{
  include: { crawlTemplate: { select: { id: true; isActive: true; crawlOptions: true } } };
}>;

interface SeedConfig {
  enabled: boolean;
  domain?: string;
  pattern?: string;
  maxUrls: number;
  maxNewUrlsPerRun: number;
  queryTokens?: string[];
  scoreThreshold: number;
  dedupeWindowHours: number;
  cacheTtlSeconds: number;
}

@Injectable()
export class NewsSourceSchedulerService {
  private readonly sourcePriorityMin = -100;
  private readonly sourcePriorityMax = 100;

  constructor(
    private readonly prisma: PrismaService,
    private readonly metadataService: CrawlMetadataService,
    private readonly queueService: QueueService,
    private readonly cache: CacheService,
    private readonly env: EnvService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async scheduleCron() {
    const config = this.env.newsSourceSchedulerConfig;
    if (!config.enabled) {
      return;
    }

    await this.cache.withLock(
      "cron:news-source-scheduler",
      config.lockTtlMs,
      async () => this.scheduleDueSources(new Date(), config.batchSize),
    );
  }

  private normalizeStringList(value: unknown) {
    if (!Array.isArray(value)) {
      return [];
    }
    return value
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter((entry) => entry.length > 0);
  }

  private normalizeOptions(value: unknown): Record<string, unknown> | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }
    return value as Record<string, unknown>;
  }

  private mergeOptions(
    base: Record<string, unknown> | undefined,
    override: Record<string, unknown> | undefined
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

  private toBullmqPriority(priority: number) {
    const normalized = Number.isFinite(priority) ? Math.round(priority) : 0;
    const clamped = Math.max(this.sourcePriorityMin, Math.min(this.sourcePriorityMax, normalized));
    return this.sourcePriorityMax + 1 - clamped;
  }

  private buildPayload(
    source: NewsSourceWithTemplate,
    url: string,
    seed?: { mode: "single" | "sitemap"; parentUrl: string; relevanceScore?: number }
  ) {
    const config =
      source.config && typeof source.config === "object" && !Array.isArray(source.config)
        ? (source.config as Record<string, unknown>)
        : {};
    const metadata =
      config.metadata && typeof config.metadata === "object" && !Array.isArray(config.metadata)
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
                relevanceScore: seed.relevanceScore
              }
            }
          : {}),
        ...metadata,
      },
      crawlOptions: this.mergeOptions(
        source.crawlTemplate?.isActive
          ? this.normalizeOptions(source.crawlTemplate.crawlOptions)
          : undefined,
        this.normalizeOptions(config.crawlOptions)
      ),
      forceRefresh: Boolean(config.forceRefresh),
    };
  }

  private normalizeSeedConfig(source: NewsSourceWithTemplate) {
    const config =
      source.config && typeof source.config === "object" && !Array.isArray(source.config)
        ? (source.config as Record<string, unknown>)
        : null;
    const seed =
      config?.seed && typeof config.seed === "object" && !Array.isArray(config.seed)
        ? (config.seed as Record<string, unknown>)
        : null;
    if (!seed || seed.enabled !== true) {
      return null;
    }

    const keywords = this.normalizeStringList(config?.keywords);
    const query =
      typeof seed.query === "string" && seed.query.trim().length > 0
        ? seed.query.trim()
        : keywords.length > 0
          ? keywords.join(" ")
          : "";
    const queryTokens = query ? this.tokenizeQuery(query) : undefined;

    return {
      enabled: true,
      domain: this.normalizeSeedDomain(seed.domain, source.url),
      pattern: typeof seed.pattern === "string" && seed.pattern.trim().length > 0 ? seed.pattern.trim() : undefined,
      maxUrls: this.clampInt(seed.maxUrls, 1, 200, 20),
      maxNewUrlsPerRun: this.clampInt(seed.maxNewUrlsPerRun, 1, 50, 10),
      queryTokens,
      scoreThreshold: this.clampFloat(seed.scoreThreshold, 0, 1, 0),
      dedupeWindowHours: this.clampInt(seed.dedupeWindowHours, 0, 24 * 30, 24),
      cacheTtlSeconds: this.clampInt(seed.cacheTtlSeconds, 10, 3600, 600)
    } satisfies SeedConfig;
  }

  private normalizeSeedDomain(rawDomain: unknown, fallbackUrl: string) {
    const raw = typeof rawDomain === "string" ? rawDomain.trim() : "";
    const candidate = raw.length > 0 ? raw : fallbackUrl;
    const withProtocol = /^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`;
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

  private clampInt(value: unknown, min: number, max: number, fallback: number) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return fallback;
    }
    const rounded = Math.round(value);
    return Math.min(max, Math.max(min, rounded));
  }

  private clampFloat(value: unknown, min: number, max: number, fallback: number) {
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

  private async resolveSeedCandidates(source: NewsSourceWithTemplate, seed: SeedConfig) {
    if (!seed.domain) {
      return [];
    }

    const cacheKey = `news-source:sitemap:${source.id}`;
    const discovered = await this.cache.wrap<string[]>(
      cacheKey,
      seed.cacheTtlSeconds,
      async () =>
        this.metadataService.discoverSitemapUrls({
          domain: seed.domain,
          pattern: seed.pattern,
          maxUrls: seed.maxUrls
        }),
      { lockTtlMs: 15_000, maxWaitMs: 15_000, retryDelayMs: 100 }
    );

    const unique = Array.from(
      new Set(
        discovered
          .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
          .filter((entry) => entry.length > 0)
      )
    );

    const scored = unique
      .map((url) => ({
        url,
        relevanceScore: this.scoreUrl(url, seed.queryTokens)
      }))
      .filter((entry) =>
        seed.scoreThreshold > 0
          ? (entry.relevanceScore ?? 0) >= seed.scoreThreshold
          : true
      );

    if (seed.queryTokens && seed.queryTokens.length > 0) {
      scored.sort((a, b) => (b.relevanceScore ?? 0) - (a.relevanceScore ?? 0));
    }

    return scored.slice(0, seed.maxUrls);
  }

  private async findRecentArticleUrls(orgId: string, urls: string[], windowHours: number) {
    const hours = Math.max(0, Math.min(24 * 30, Math.floor(windowHours)));
    if (hours === 0 || urls.length === 0) {
      return new Set<string>();
    }
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);
    const records = await this.prisma.article.findMany({
      where: { orgId, url: { in: urls }, crawlAt: { gte: since } },
      select: { url: true }
    });
    return new Set(records.map((record) => record.url));
  }

  private async findActivePipelineUrls(sourceId: string, urls: string[], activeCutoff: Date) {
    if (urls.length === 0) {
      return new Set<string>();
    }
    const records = await this.prisma.pipelineJob.findMany({
      where: {
        sourceId,
        url: { in: urls },
        status: { in: ACTIVE_PIPELINE_JOB_STATUSES },
        createdAt: { gte: activeCutoff }
      },
      select: { url: true }
    });
    return new Set(records.map((record) => record.url));
  }

  private async scheduleDueSources(now: Date, batchSize: number) {
    const sources = await this.prisma.newsSource.findMany({
      where: {
        isActive: true,
        AND: [
          { OR: [{ nextRunAt: null }, { nextRunAt: { lte: now } }] },
          { OR: [{ circuitOpenUntil: null }, { circuitOpenUntil: { lte: now } }] },
        ],
      },
      include: {
        crawlTemplate: {
          select: { id: true, isActive: true, crawlOptions: true }
        }
      },
      orderBy: [{ nextRunAt: "asc" }, { priority: "desc" }, { updatedAt: "asc" }],
      take: batchSize,
    });

    for (const source of sources) {
      const activeCutoff = new Date(now.getTime() - this.env.newsSourceSchedulerConfig.inFlightLookbackMs);
      const seedConfig = this.normalizeSeedConfig(source);
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
      const remainingCapacity = seedConfig ? seedConfig.maxNewUrlsPerRun - inFlightCount : 0;
      const shouldBlock = seedConfig ? remainingCapacity <= 0 : inFlightCount > 0;

      if (shouldBlock) {
        const newest = inFlightJobs[0];
        const rescheduleAt = new Date(
          now.getTime() + this.env.newsSourceSchedulerConfig.inFlightRescheduleDelayMs,
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
      const nextRunAt = new Date(
        scheduledFor.getTime() + source.frequencySeconds * 1000,
      );

      const maxNewUrlsThisRun = seedConfig ? Math.max(0, remainingCapacity) : 1;
      try {
        const jobsToSchedule = seedConfig
          ? await this.resolveSeedCandidates(source, seedConfig)
          : [{ url: source.url, relevanceScore: undefined }];

        const candidateUrls = jobsToSchedule.map((job) => job.url);
        const [recentArticles, activeUrls] = await Promise.all([
          seedConfig
            ? this.findRecentArticleUrls(source.orgId, candidateUrls, seedConfig.dedupeWindowHours)
            : Promise.resolve(new Set<string>()),
          seedConfig
            ? this.findActivePipelineUrls(source.id, candidateUrls, activeCutoff)
            : Promise.resolve(new Set<string>())
        ]);

        const newJobs = seedConfig
          ? jobsToSchedule
              .filter((job) => !recentArticles.has(job.url))
              .filter((job) => !activeUrls.has(job.url))
              .slice(0, maxNewUrlsThisRun)
          : jobsToSchedule;

        await this.prisma.newsSource.update({
          where: { id: source.id },
          data: { lastRunAt: scheduledFor, nextRunAt }
        });

        if (newJobs.length === 0) {
          logger.info(
            { sourceId: source.id, orgId: source.orgId, mode: "seed", scheduledFor, nextRunAt },
            "News source run scheduled no new URLs",
          );
          continue;
        }

        const bullPriority = this.toBullmqPriority(source.priority);
        for (const job of newJobs) {
          const payload = this.buildPayload(
            source,
            job.url,
            seedConfig
              ? { mode: "sitemap", parentUrl: source.url, relevanceScore: job.relevanceScore }
              : undefined
          );

          const { pipelineJobId, itemMetaId, rawItemId } = await this.prisma.$transaction(async (tx) => {
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
                  seedMode: seedConfig ? "sitemap" : "single",
                  seedParentUrl: seedConfig ? source.url : undefined,
                  relevanceScore: seedConfig ? job.relevanceScore : undefined
                }
              }
            });

            const itemMeta = await tx.itemMeta.create({
              data: {
                orgId: source.orgId,
                externalId: pipelineJob.id,
                name: source.name ? `${source.name}: ${job.url}` : job.url,
                status: ItemStatus.Pending,
                mongoRef: ""
              }
            });

            const rawItem = await RawItemModel.create({
              itemMetaId: itemMeta.id,
              payload,
              source: "news-source"
            });

            await tx.itemMeta.update({
              where: { id: itemMeta.id },
              data: { mongoRef: rawItem.id }
            });

            await tx.pipelineJob.update({
              where: { id: pipelineJob.id },
              data: {
                metadata: {
                  ...(pipelineJob.metadata as Record<string, unknown> | null | undefined),
                  itemMetaId: itemMeta.id,
                  rawItemId: rawItem.id
                }
              }
            });

            return {
              pipelineJobId: pipelineJob.id,
              itemMetaId: itemMeta.id,
              rawItemId: rawItem.id
            };
          });

          try {
            await this.queueService.enqueueItem(
              source.orgId,
              itemMetaId,
              rawItemId,
              { priority: bullPriority },
              { pipelineJobId, sourceId: source.id },
            );
          } catch (queueError) {
            logger.error(
              { error: queueError, pipelineJobId, orgId: source.orgId, sourceId: source.id },
              "Failed to enqueue news source pipeline job",
            );
            await Promise.allSettled([
              this.prisma.pipelineJob.updateMany({
                where: { id: pipelineJobId },
                data: {
                  status: PipelineJobStatus.failed,
                  error: queueError instanceof Error ? queueError.message : String(queueError),
                  completedAt: new Date(),
                },
              }),
              this.prisma.itemMeta.updateMany({
                where: { id: itemMetaId },
                data: { status: ItemStatus.Failed },
              }),
            ]);
          }
        }
      } catch (error) {
        logger.error(
          { error, sourceId: source.id, orgId: source.orgId },
          "Failed to schedule news source pipeline job",
        );
      }
    }
  }
}
