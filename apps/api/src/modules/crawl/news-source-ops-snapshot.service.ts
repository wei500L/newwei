import { Injectable } from "@nestjs/common";
import { PipelineJobStatus, Prisma } from "@prisma/client";

import { toPrismaJsonValue } from "../../common/prisma-json";
import { CacheService } from "../cache/cache.service";
import { PrismaService } from "../config/prisma.service";

const NEWS_SOURCE_LIST_RUNTIME_TTL_SECONDS = 30 * 24 * 60 * 60;
const BACKPRESSURE_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const LEGACY_BACKPRESSURE_CACHE_PREFIX = "news-source:backpressure:";
const LEGACY_BACKPRESSURE_COUNT_CACHE_PREFIX =
  "news-source:backpressure-count:";
const LEGACY_RSS_ADAPTIVE_CACHE_PREFIX = "news-source:rss-adaptive:";
const RSS_ADAPTIVE_MAX_HISTORY_SIZE = 8;

export interface NewsSourceLatestJobSnapshot {
  id: string;
  status: PipelineJobStatus;
  url: string;
  createdAt: string;
  startedAt?: string | null;
  completedAt?: string | null;
  error?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface NewsSourceLatestCrawlTaskSnapshot {
  id: string;
  status: string;
  lastError?: string | null;
  lastRunAt?: string | null;
  lastSuccessAt?: string | null;
  lastResultAt?: string | null;
}

export interface NewsSourceLatestArticleSnapshot {
  id: string;
  url: string;
  crawlAt: string;
  titleGuess?: string | null;
}

export interface NewsSourceStats24hSnapshot {
  completed: number;
  failed: number;
  successRate?: number | null;
  avgDurationMs?: number | null;
}

export interface NewsSourceRssAdaptiveRuntimeState {
  outcomes: boolean[];
  consecutiveNoHit: number;
  updatedAt: string;
}

export interface NewsSourceListRuntimeState {
  crawlTaskQueuedCount: number;
  crawlTaskRunningCount: number;
  backpressureUntil: string | null;
  backpressurePendingJobs: number | null;
  backpressureThreshold: number | null;
  backpressureHitTimestamps: string[];
  rssAdaptiveState: NewsSourceRssAdaptiveRuntimeState | null;
}

export interface NewsSourceOpsSummary {
  latestJob: NewsSourceLatestJobSnapshot | null;
  latestCrawlTask: NewsSourceLatestCrawlTaskSnapshot | null;
  latestArticle: NewsSourceLatestArticleSnapshot | null;
  stats24h: NewsSourceStats24hSnapshot;
}

type NewsSourceOpsSnapshotRecord = {
  latestJob?: unknown;
  latestCrawlTask?: unknown;
  latestArticle?: unknown;
  stats24h?: unknown;
};

@Injectable()
export class NewsSourceOpsSnapshotService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  runtimeCacheKey(sourceId: string) {
    return `news-source:list-runtime:${sourceId}`;
  }

  async readRuntimeStates(
    sourceIds: string[],
  ): Promise<Map<string, NewsSourceListRuntimeState>> {
    if (sourceIds.length === 0) {
      return new Map();
    }

    const runtimeKeys = sourceIds.map((sourceId) =>
      this.runtimeCacheKey(sourceId),
    );
    const runtimeValues = await this.cache.getMany<unknown>(runtimeKeys);
    const runtimeBySourceId = new Map<string, NewsSourceListRuntimeState>();
    const missingSourceIds: string[] = [];

    for (const [index, sourceId] of sourceIds.entries()) {
      const value = runtimeValues[index];
      if (value === null) {
        missingSourceIds.push(sourceId);
        continue;
      }
      runtimeBySourceId.set(sourceId, this.normalizeRuntimeState(value));
    }

    if (missingSourceIds.length > 0) {
      const hydrated = await this.hydrateLegacyRuntimeStates(missingSourceIds);
      for (const [sourceId, state] of hydrated.entries()) {
        runtimeBySourceId.set(sourceId, state);
      }
    }

    for (const sourceId of sourceIds) {
      if (!runtimeBySourceId.has(sourceId)) {
        runtimeBySourceId.set(sourceId, this.createEmptyRuntimeState());
      }
    }

    return runtimeBySourceId;
  }

  async setBackpressureState(
    sourceId: string,
    state: {
      until: string;
      pendingJobs?: number | null;
      threshold?: number | null;
      observedAt?: Date;
    } | null,
  ) {
    const current = await this.readRuntimeState(sourceId);
    const next = state
      ? {
          ...current,
          backpressureUntil: state.until,
          backpressurePendingJobs:
            typeof state.pendingJobs === "number" &&
            Number.isFinite(state.pendingJobs)
              ? state.pendingJobs
              : null,
          backpressureThreshold:
            typeof state.threshold === "number" &&
            Number.isFinite(state.threshold)
              ? state.threshold
              : null,
          backpressureHitTimestamps: this.pruneBackpressureHitTimestamps([
            ...current.backpressureHitTimestamps,
            (state.observedAt ?? new Date()).toISOString(),
          ]),
        }
      : {
          ...current,
          backpressureUntil: null,
          backpressurePendingJobs: null,
          backpressureThreshold: null,
        };

    await this.writeRuntimeState(sourceId, next);
  }

  async setRssAdaptiveState(
    sourceId: string,
    state: NewsSourceRssAdaptiveRuntimeState | null,
  ) {
    const current = await this.readRuntimeState(sourceId);
    await this.writeRuntimeState(sourceId, {
      ...current,
      rssAdaptiveState: state ? this.normalizeRssAdaptiveState(state) : null,
    });
  }

  async syncQueueCounts(orgId: string, sourceId: string) {
    const rows = await this.prisma.crawlTask.groupBy({
      by: ["status"],
      where: {
        orgId,
        newsSourceId: sourceId,
        status: { in: ["queued", "running"] },
      },
      _count: { _all: true },
    });

    let queued = 0;
    let running = 0;
    for (const row of rows) {
      if (row.status === "queued") {
        queued = row._count._all;
      } else if (row.status === "running") {
        running = row._count._all;
      }
    }

    const current = await this.readRuntimeState(sourceId);
    await this.writeRuntimeState(sourceId, {
      ...current,
      crawlTaskQueuedCount: queued,
      crawlTaskRunningCount: running,
    });
  }

  async refreshSnapshotForSource(
    orgId: string,
    sourceId: string,
  ): Promise<NewsSourceOpsSummary> {
    const latestJob = await this.prisma.pipelineJob.findFirst({
      where: { orgId, sourceId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        status: true,
        url: true,
        createdAt: true,
        startedAt: true,
        completedAt: true,
        error: true,
        metadata: true,
      },
    });

    const latestArticle = await this.prisma.article.findFirst({
      where: { orgId, sourceId },
      orderBy: [{ crawlAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        url: true,
        crawlAt: true,
        titleGuess: true,
      },
    });

    const latestCrawlTaskId = this.extractCrawlTaskId(latestJob?.metadata);
    const latestCrawlTask = latestCrawlTaskId
      ? await this.prisma.crawlTask.findFirst({
          where: { id: latestCrawlTaskId, orgId },
          select: {
            id: true,
            status: true,
            lastError: true,
            lastRunAt: true,
            lastSuccessAt: true,
            lastResultAt: true,
          },
        })
      : await this.prisma.crawlTask.findFirst({
          where: { orgId, newsSourceId: sourceId },
          orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
          select: {
            id: true,
            status: true,
            lastError: true,
            lastRunAt: true,
            lastSuccessAt: true,
            lastResultAt: true,
          },
        });

    const since = new Date(Date.now() - BACKPRESSURE_LOOKBACK_MS);
    const recentJobs = await this.prisma.pipelineJob.findMany({
      where: {
        orgId,
        sourceId,
        createdAt: { gte: since },
      },
      select: {
        status: true,
        startedAt: true,
        completedAt: true,
      },
    });

    const stats24h = this.buildStats24h(recentJobs);
    const summary: NewsSourceOpsSummary = {
      latestJob: latestJob
        ? {
            id: latestJob.id,
            status: latestJob.status,
            url: latestJob.url,
            createdAt: latestJob.createdAt.toISOString(),
            startedAt: latestJob.startedAt?.toISOString() ?? null,
            completedAt: latestJob.completedAt?.toISOString() ?? null,
            error: latestJob.error ?? null,
            metadata: this.normalizePlainRecord(latestJob.metadata),
          }
        : null,
      latestCrawlTask: latestCrawlTask
        ? {
            id: latestCrawlTask.id,
            status: latestCrawlTask.status,
            lastError: latestCrawlTask.lastError ?? null,
            lastRunAt: latestCrawlTask.lastRunAt?.toISOString() ?? null,
            lastSuccessAt: latestCrawlTask.lastSuccessAt?.toISOString() ?? null,
            lastResultAt: latestCrawlTask.lastResultAt?.toISOString() ?? null,
          }
        : null,
      latestArticle: latestArticle
        ? {
            id: latestArticle.id,
            url: latestArticle.url,
            crawlAt: latestArticle.crawlAt.toISOString(),
            titleGuess: latestArticle.titleGuess ?? null,
          }
        : null,
      stats24h,
    };

    await this.prisma.newsSourceOpsSnapshot.upsert({
      where: { sourceId },
      create: {
        orgId,
        sourceId,
        latestJob: summary.latestJob
          ? toPrismaJsonValue(summary.latestJob)
          : Prisma.DbNull,
        latestCrawlTask: summary.latestCrawlTask
          ? toPrismaJsonValue(summary.latestCrawlTask)
          : Prisma.DbNull,
        latestArticle: summary.latestArticle
          ? toPrismaJsonValue(summary.latestArticle)
          : Prisma.DbNull,
        stats24h: toPrismaJsonValue(summary.stats24h),
      },
      update: {
        orgId,
        latestJob: summary.latestJob
          ? toPrismaJsonValue(summary.latestJob)
          : Prisma.DbNull,
        latestCrawlTask: summary.latestCrawlTask
          ? toPrismaJsonValue(summary.latestCrawlTask)
          : Prisma.DbNull,
        latestArticle: summary.latestArticle
          ? toPrismaJsonValue(summary.latestArticle)
          : Prisma.DbNull,
        stats24h: toPrismaJsonValue(summary.stats24h),
      },
    });

    return summary;
  }

  async refreshSnapshotsForSources(orgId: string, sourceIds: string[]) {
    const uniqueSourceIds = Array.from(
      new Set(
        sourceIds.filter(
          (sourceId): sourceId is string =>
            typeof sourceId === "string" && sourceId.trim().length > 0,
        ),
      ),
    );

    for (const sourceId of uniqueSourceIds) {
      await this.refreshSnapshotForSource(orgId, sourceId);
    }
  }

  normalizeSnapshotRecord(
    record: NewsSourceOpsSnapshotRecord | null | undefined,
  ): NewsSourceOpsSummary {
    return {
      latestJob: this.normalizeLatestJob(record?.latestJob),
      latestCrawlTask: this.normalizeLatestCrawlTask(record?.latestCrawlTask),
      latestArticle: this.normalizeLatestArticle(record?.latestArticle),
      stats24h: this.normalizeStats24h(record?.stats24h),
    };
  }

  private async hydrateLegacyRuntimeStates(sourceIds: string[]) {
    const backpressureKeys = sourceIds.map(
      (sourceId) => `${LEGACY_BACKPRESSURE_CACHE_PREFIX}${sourceId}`,
    );
    const rssAdaptiveKeys = sourceIds.map(
      (sourceId) => `${LEGACY_RSS_ADAPTIVE_CACHE_PREFIX}${sourceId}`,
    );
    const backpressureCountKeys = sourceIds.map(
      (sourceId) => `${LEGACY_BACKPRESSURE_COUNT_CACHE_PREFIX}${sourceId}`,
    );

    const [backpressureValues, rssAdaptiveValues, backpressureCounts] =
      await Promise.all([
        this.cache.getMany<unknown>(backpressureKeys),
        this.cache.getMany<unknown>(rssAdaptiveKeys),
        this.cache.getMany<number>(backpressureCountKeys),
      ]);

    const hydrated = new Map<string, NewsSourceListRuntimeState>();
    const writes: Promise<unknown>[] = [];

    for (const [index, sourceId] of sourceIds.entries()) {
      const base = this.createEmptyRuntimeState();
      const backpressureValue = backpressureValues[index];
      if (
        backpressureValue &&
        typeof backpressureValue === "object" &&
        !Array.isArray(backpressureValue)
      ) {
        const backpressureRecord = backpressureValue as Record<string, unknown>;
        base.backpressureUntil =
          typeof backpressureRecord.until === "string" &&
          backpressureRecord.until.length > 0
            ? backpressureRecord.until
            : null;
        base.backpressurePendingJobs =
          typeof backpressureRecord.pendingJobs === "number" &&
          Number.isFinite(backpressureRecord.pendingJobs)
            ? backpressureRecord.pendingJobs
            : null;
        base.backpressureThreshold =
          typeof backpressureRecord.threshold === "number" &&
          Number.isFinite(backpressureRecord.threshold)
            ? backpressureRecord.threshold
            : null;
      }

      base.rssAdaptiveState = this.normalizeRssAdaptiveState(
        rssAdaptiveValues[index],
      );

      const legacyCount = backpressureCounts[index];
      if (typeof legacyCount === "number" && legacyCount > 0) {
        base.backpressureHitTimestamps = Array.from(
          { length: Math.max(0, Math.floor(legacyCount)) },
          () => new Date().toISOString(),
        );
      }

      if (
        base.backpressureUntil ||
        base.backpressureHitTimestamps.length > 0 ||
        base.rssAdaptiveState
      ) {
        hydrated.set(sourceId, base);
        writes.push(this.writeRuntimeState(sourceId, base));
      }
    }

    await Promise.allSettled(writes);
    return hydrated;
  }

  private async readRuntimeState(sourceId: string) {
    const value = await this.cache.get<unknown>(this.runtimeCacheKey(sourceId));
    return this.normalizeRuntimeState(value);
  }

  private async writeRuntimeState(
    sourceId: string,
    state: NewsSourceListRuntimeState,
  ) {
    await this.cache.set(
      this.runtimeCacheKey(sourceId),
      {
        ...state,
        backpressureHitTimestamps: this.pruneBackpressureHitTimestamps(
          state.backpressureHitTimestamps,
        ),
      },
      NEWS_SOURCE_LIST_RUNTIME_TTL_SECONDS,
    );
  }

  private createEmptyRuntimeState(): NewsSourceListRuntimeState {
    return {
      crawlTaskQueuedCount: 0,
      crawlTaskRunningCount: 0,
      backpressureUntil: null,
      backpressurePendingJobs: null,
      backpressureThreshold: null,
      backpressureHitTimestamps: [],
      rssAdaptiveState: null,
    };
  }

  private normalizeRuntimeState(value: unknown): NewsSourceListRuntimeState {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return this.createEmptyRuntimeState();
    }

    const record = value as Record<string, unknown>;
    return {
      crawlTaskQueuedCount:
        typeof record.crawlTaskQueuedCount === "number" &&
        Number.isFinite(record.crawlTaskQueuedCount)
          ? Math.max(0, Math.floor(record.crawlTaskQueuedCount))
          : 0,
      crawlTaskRunningCount:
        typeof record.crawlTaskRunningCount === "number" &&
        Number.isFinite(record.crawlTaskRunningCount)
          ? Math.max(0, Math.floor(record.crawlTaskRunningCount))
          : 0,
      backpressureUntil:
        typeof record.backpressureUntil === "string" &&
        record.backpressureUntil.length > 0
          ? record.backpressureUntil
          : null,
      backpressurePendingJobs:
        typeof record.backpressurePendingJobs === "number" &&
        Number.isFinite(record.backpressurePendingJobs)
          ? record.backpressurePendingJobs
          : null,
      backpressureThreshold:
        typeof record.backpressureThreshold === "number" &&
        Number.isFinite(record.backpressureThreshold)
          ? record.backpressureThreshold
          : null,
      backpressureHitTimestamps: this.pruneBackpressureHitTimestamps(
        Array.isArray(record.backpressureHitTimestamps)
          ? record.backpressureHitTimestamps
          : [],
      ),
      rssAdaptiveState: this.normalizeRssAdaptiveState(record.rssAdaptiveState),
    };
  }

  private normalizeLatestJob(
    value: unknown,
  ): NewsSourceLatestJobSnapshot | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    const record = value as Record<string, unknown>;
    if (
      typeof record.id !== "string" ||
      typeof record.status !== "string" ||
      typeof record.url !== "string" ||
      typeof record.createdAt !== "string"
    ) {
      return null;
    }
    return {
      id: record.id,
      status: record.status as PipelineJobStatus,
      url: record.url,
      createdAt: record.createdAt,
      startedAt: typeof record.startedAt === "string" ? record.startedAt : null,
      completedAt:
        typeof record.completedAt === "string" ? record.completedAt : null,
      error: typeof record.error === "string" ? record.error : null,
      metadata: this.normalizePlainRecord(record.metadata),
    };
  }

  private normalizeLatestCrawlTask(
    value: unknown,
  ): NewsSourceLatestCrawlTaskSnapshot | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.id !== "string" || typeof record.status !== "string") {
      return null;
    }
    return {
      id: record.id,
      status: record.status,
      lastError: typeof record.lastError === "string" ? record.lastError : null,
      lastRunAt: typeof record.lastRunAt === "string" ? record.lastRunAt : null,
      lastSuccessAt:
        typeof record.lastSuccessAt === "string" ? record.lastSuccessAt : null,
      lastResultAt:
        typeof record.lastResultAt === "string" ? record.lastResultAt : null,
    };
  }

  private normalizeLatestArticle(
    value: unknown,
  ): NewsSourceLatestArticleSnapshot | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    const record = value as Record<string, unknown>;
    if (
      typeof record.id !== "string" ||
      typeof record.url !== "string" ||
      typeof record.crawlAt !== "string"
    ) {
      return null;
    }
    return {
      id: record.id,
      url: record.url,
      crawlAt: record.crawlAt,
      titleGuess:
        typeof record.titleGuess === "string" ? record.titleGuess : null,
    };
  }

  private normalizeStats24h(value: unknown): NewsSourceStats24hSnapshot {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return {
        completed: 0,
        failed: 0,
        successRate: null,
        avgDurationMs: null,
      };
    }

    const record = value as Record<string, unknown>;
    return {
      completed:
        typeof record.completed === "number" &&
        Number.isFinite(record.completed)
          ? Math.max(0, Math.floor(record.completed))
          : 0,
      failed:
        typeof record.failed === "number" && Number.isFinite(record.failed)
          ? Math.max(0, Math.floor(record.failed))
          : 0,
      successRate:
        typeof record.successRate === "number" &&
        Number.isFinite(record.successRate)
          ? record.successRate
          : null,
      avgDurationMs:
        typeof record.avgDurationMs === "number" &&
        Number.isFinite(record.avgDurationMs)
          ? record.avgDurationMs
          : null,
    };
  }

  private normalizeRssAdaptiveState(
    value: unknown,
  ): NewsSourceRssAdaptiveRuntimeState | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }

    const record = value as Record<string, unknown>;
    const outcomes = Array.isArray(record.outcomes)
      ? record.outcomes
          .filter((entry): entry is boolean => typeof entry === "boolean")
          .slice(-RSS_ADAPTIVE_MAX_HISTORY_SIZE)
      : [];
    const consecutiveNoHit =
      typeof record.consecutiveNoHit === "number" &&
      Number.isFinite(record.consecutiveNoHit)
        ? Math.max(0, Math.floor(record.consecutiveNoHit))
        : 0;
    const updatedAt =
      typeof record.updatedAt === "string" && record.updatedAt.length > 0
        ? record.updatedAt
        : new Date(0).toISOString();

    if (
      outcomes.length === 0 &&
      consecutiveNoHit <= 0 &&
      updatedAt === new Date(0).toISOString()
    ) {
      return null;
    }

    return {
      outcomes,
      consecutiveNoHit,
      updatedAt,
    };
  }

  private pruneBackpressureHitTimestamps(values: unknown[]) {
    const cutoff = Date.now() - BACKPRESSURE_LOOKBACK_MS;
    return values
      .filter((value): value is string => typeof value === "string")
      .filter((value) => {
        const timestamp = Date.parse(value);
        return Number.isFinite(timestamp) && timestamp >= cutoff;
      });
  }

  private normalizePlainRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }

  private extractCrawlTaskId(metadata: unknown) {
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      return null;
    }
    const crawlTaskId = (metadata as Record<string, unknown>).crawlTaskId;
    return typeof crawlTaskId === "string" && crawlTaskId.length > 0
      ? crawlTaskId
      : null;
  }

  private buildStats24h(
    jobs: Array<{
      status: PipelineJobStatus;
      startedAt: Date | null;
      completedAt: Date | null;
    }>,
  ): NewsSourceStats24hSnapshot {
    let completed = 0;
    let failed = 0;
    let durationSumMs = 0;
    let durationCount = 0;

    for (const job of jobs) {
      if (job.status === PipelineJobStatus.completed) {
        completed += 1;
      } else if (job.status === PipelineJobStatus.failed) {
        failed += 1;
      }

      if (job.startedAt && job.completedAt) {
        durationSumMs += job.completedAt.getTime() - job.startedAt.getTime();
        durationCount += 1;
      }
    }

    const totalFinished = completed + failed;
    return {
      completed,
      failed,
      successRate: totalFinished > 0 ? completed / totalFinished : null,
      avgDurationMs: durationCount > 0 ? durationSumMs / durationCount : null,
    };
  }
}
