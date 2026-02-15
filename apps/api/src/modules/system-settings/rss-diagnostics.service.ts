import { ProcessedItemModel, RawItemModel } from "@modular/mongo";
import { createLogger } from "@modular/utils";
import { Injectable } from "@nestjs/common";
import { PipelineJobStatus, Prisma } from "@prisma/client";
import { Types } from "mongoose";

import { PipelineStageStatus } from "../../common/pipeline-status";
import { EnvService } from "../config/config.service";
import { PrismaService } from "../config/prisma.service";

const logger = createLogger({ name: "rss-diagnostics" });

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_WINDOW_DAYS = 7;
const DEFAULT_LOOKBACK_HOURS = 24;
const MAX_WINDOW_DAYS = 30;
const MAX_LOOKBACK_HOURS = 24 * 30;
const DEFAULT_BACKFILL_LIMIT = 500;
const MAX_BACKFILL_LIMIT = 5_000;
const UNRESOLVED_SAMPLE_LIMIT = 20;

interface RssSourceConfigRow {
  id: string;
  name: string;
  isActive: boolean;
  siteUrl: string;
  language?: string | null;
  seedEnabled: boolean;
  feedUrl: string | null;
  lastRunAt?: Date | null;
  lastSuccessAt?: Date | null;
  lastFailureAt?: Date | null;
  consecutiveFailures: number;
  circuitOpenUntil?: Date | null;
}

interface SourceWindowStats {
  itemCountWindow: number;
  latestItemAt: Date | null;
}

interface SourceLookbackPipelineStats {
  queued: number;
  running: number;
  completed: number;
  failed: number;
}

interface BackfillCandidate {
  processedItemId: string;
  rawItemId: string;
  itemMetaId: string;
  pipelineJobId?: string;
  rawSourceId?: string;
  rawPipelineJobId?: string;
  crawlResultId?: string;
  fallbackCrawlResultId?: string;
}

interface BackfillUnresolvedSample {
  processedItemId: string;
  itemMetaId: string;
  reason: string;
}

export interface RssDiagnosticsChainResponse {
  generatedAt: string;
  windowDays: number;
  lookbackHours: number;
  schedulerEnabled: boolean;
  sources: {
    rssTotal: number;
    rssActive: number;
    seedEnabled: number;
    missingFeedUrl: number;
  };
  visibility: {
    visibleByProcessed: number;
    visibleByArticleFallback: number;
    hiddenSources: number;
  };
  processedCoverage: {
    completedTotal: number;
    missingSourceId: number;
    missingRate: number;
  };
  articleCoverage: {
    total: number;
    missingSourceId: number;
    missingRate: number;
  };
  pipelineJobs: {
    total: number;
    queued: number;
    running: number;
    completed: number;
    failed: number;
    latestCreatedAt?: string | null;
  };
  crawlTasks: {
    total: number;
    queued: number;
    running: number;
    completed: number;
    failed: number;
    latestUpdatedAt?: string | null;
  };
  crawlResults: {
    total: number;
    missingMarkdownRef: number;
    latestFetchedAt?: string | null;
  };
  recommendations: string[];
}

export interface RssDiagnosticsSourceRow {
  sourceId: string;
  name: string;
  isActive: boolean;
  language?: string | null;
  siteUrl: string;
  feedUrl: string | null;
  seedEnabled: boolean;
  itemCountByProcessed: number;
  latestByProcessed?: string | null;
  itemCountByArticle: number;
  latestByArticle?: string | null;
  visibility: "processed" | "article_fallback" | "none";
  jobs24h: SourceLookbackPipelineStats;
  lastJobStatus?: string | null;
  lastJobCreatedAt?: string | null;
  lastFailureAt?: string | null;
  consecutiveFailures: number;
  circuitOpenUntil?: string | null;
  issues: string[];
}

export interface RssSourceIdBackfillResponse {
  dryRun: boolean;
  limit: number;
  scanned: number;
  matched: number;
  updated: number;
  unresolved: number;
  unresolvedSamples: BackfillUnresolvedSample[];
}

@Injectable()
export class RssDiagnosticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly env: EnvService
  ) {}

  async getChainSummary(
    orgId: string,
    options?: { windowDays?: number; lookbackHours?: number }
  ): Promise<RssDiagnosticsChainResponse> {
    const windowDays = this.clampInt(options?.windowDays, 1, MAX_WINDOW_DAYS, DEFAULT_WINDOW_DAYS);
    const lookbackHours = this.clampInt(
      options?.lookbackHours,
      1,
      MAX_LOOKBACK_HOURS,
      DEFAULT_LOOKBACK_HOURS
    );
    const now = new Date();
    const sinceWindow = new Date(now.getTime() - windowDays * DAY_MS);
    const sinceLookback = new Date(now.getTime() - lookbackHours * HOUR_MS);
    const schedulerEnabled = this.env.newsSourceSchedulerConfig.enabled;

    const rssSources = await this.loadRssSources(orgId);
    const sourceIds = rssSources.map((source) => source.id);

    const [
      processedStats,
      articleStats,
      processedCompletedTotal,
      processedMissingSourceId,
      articleTotal,
      articleMissingSourceId,
      pipelineStatusRows,
      latestPipelineJob,
      crawlTaskStatusRows,
      latestCrawlTask,
      crawlResultTotal,
      crawlResultMissingMarkdown,
      latestCrawlResult
    ] = await Promise.all([
      this.getProcessedStatsBySource(orgId, sourceIds, sinceWindow),
      this.getArticleStatsBySource(orgId, sourceIds, sinceWindow),
      ProcessedItemModel.countDocuments({
        orgId,
        status: PipelineStageStatus.Completed,
        createdAt: { $gte: sinceLookback }
      }),
      ProcessedItemModel.countDocuments({
        orgId,
        status: PipelineStageStatus.Completed,
        createdAt: { $gte: sinceLookback },
        $or: [{ sourceId: null }, { sourceId: "" }, { sourceId: { $exists: false } }]
      }),
      this.prisma.article.count({
        where: { orgId, crawlAt: { gte: sinceLookback } }
      }),
      this.prisma.article.count({
        where: {
          orgId,
          crawlAt: { gte: sinceLookback },
          sourceId: null
        }
      }),
      sourceIds.length > 0
        ? this.prisma.pipelineJob.groupBy({
            by: ["status"],
            where: {
              orgId,
              sourceId: { in: sourceIds },
              createdAt: { gte: sinceLookback }
            },
            _count: { _all: true }
          })
        : Promise.resolve([]),
      sourceIds.length > 0
        ? this.prisma.pipelineJob.findFirst({
            where: {
              orgId,
              sourceId: { in: sourceIds }
            },
            orderBy: { createdAt: "desc" },
            select: { createdAt: true }
          })
        : Promise.resolve(null),
      this.prisma.crawlTask.groupBy({
        by: ["status"],
        where: {
          orgId,
          displayName: { startsWith: "NewsSource:" },
          updatedAt: { gte: sinceLookback }
        },
        _count: { _all: true }
      }),
      this.prisma.crawlTask.findFirst({
        where: {
          orgId,
          displayName: { startsWith: "NewsSource:" }
        },
        orderBy: { updatedAt: "desc" },
        select: { updatedAt: true }
      }),
      this.prisma.crawlResult.count({
        where: {
          fetchedAt: { gte: sinceLookback },
          task: { orgId, displayName: { startsWith: "NewsSource:" } }
        }
      }),
      this.prisma.crawlResult.count({
        where: {
          fetchedAt: { gte: sinceLookback },
          task: { orgId, displayName: { startsWith: "NewsSource:" } },
          markdownRef: ""
        }
      }),
      this.prisma.crawlResult.findFirst({
        where: {
          task: { orgId, displayName: { startsWith: "NewsSource:" } }
        },
        orderBy: { fetchedAt: "desc" },
        select: { fetchedAt: true }
      })
    ]);

    const visibility = this.computeVisibility(rssSources, processedStats, articleStats);
    const pipelineCounts = this.pipelineCountsFromRows(pipelineStatusRows);
    const crawlTaskCounts = this.crawlTaskCountsFromRows(crawlTaskStatusRows);

    const processedMissingRate =
      processedCompletedTotal > 0 ? processedMissingSourceId / processedCompletedTotal : 0;
    const articleMissingRate = articleTotal > 0 ? articleMissingSourceId / articleTotal : 0;

    const recommendations: string[] = [];
    if (!schedulerEnabled) {
      recommendations.push("news_source_scheduler_disabled");
    }
    if (rssSources.length === 0) {
      recommendations.push("no_rss_sources_configured");
    }
    if (visibility.visibleByArticleFallback > 0) {
      recommendations.push("run_source_id_backfill_for_processed_items");
    }
    if (processedMissingRate >= 0.1) {
      recommendations.push("high_processed_item_missing_source_id_rate");
    }
    if (crawlResultMissingMarkdown > 0) {
      recommendations.push("crawl_results_missing_markdown_ref_detected");
    }

    return {
      generatedAt: now.toISOString(),
      windowDays,
      lookbackHours,
      schedulerEnabled,
      sources: {
        rssTotal: rssSources.length,
        rssActive: rssSources.filter((source) => source.isActive).length,
        seedEnabled: rssSources.filter((source) => source.seedEnabled).length,
        missingFeedUrl: rssSources.filter((source) => !source.feedUrl).length
      },
      visibility,
      processedCoverage: {
        completedTotal: processedCompletedTotal,
        missingSourceId: processedMissingSourceId,
        missingRate: processedMissingRate
      },
      articleCoverage: {
        total: articleTotal,
        missingSourceId: articleMissingSourceId,
        missingRate: articleMissingRate
      },
      pipelineJobs: {
        total: pipelineCounts.total,
        queued: pipelineCounts.queued,
        running: pipelineCounts.running,
        completed: pipelineCounts.completed,
        failed: pipelineCounts.failed,
        latestCreatedAt: latestPipelineJob?.createdAt?.toISOString() ?? null
      },
      crawlTasks: {
        total: crawlTaskCounts.total,
        queued: crawlTaskCounts.queued,
        running: crawlTaskCounts.running,
        completed: crawlTaskCounts.completed,
        failed: crawlTaskCounts.failed,
        latestUpdatedAt: latestCrawlTask?.updatedAt?.toISOString() ?? null
      },
      crawlResults: {
        total: crawlResultTotal,
        missingMarkdownRef: crawlResultMissingMarkdown,
        latestFetchedAt: latestCrawlResult?.fetchedAt?.toISOString() ?? null
      },
      recommendations
    };
  }

  async listSourceDetails(
    orgId: string,
    options?: { windowDays?: number; lookbackHours?: number }
  ): Promise<RssDiagnosticsSourceRow[]> {
    const windowDays = this.clampInt(options?.windowDays, 1, MAX_WINDOW_DAYS, DEFAULT_WINDOW_DAYS);
    const lookbackHours = this.clampInt(
      options?.lookbackHours,
      1,
      MAX_LOOKBACK_HOURS,
      DEFAULT_LOOKBACK_HOURS
    );
    const now = new Date();
    const sinceWindow = new Date(now.getTime() - windowDays * DAY_MS);
    const sinceLookback = new Date(now.getTime() - lookbackHours * HOUR_MS);

    const rssSources = await this.loadRssSources(orgId);
    if (rssSources.length === 0) {
      return [];
    }

    const sourceIds = rssSources.map((source) => source.id);
    const [processedStats, articleStats, pipelineRows, latestJobs] = await Promise.all([
      this.getProcessedStatsBySource(orgId, sourceIds, sinceWindow),
      this.getArticleStatsBySource(orgId, sourceIds, sinceWindow),
      this.prisma.pipelineJob.groupBy({
        by: ["sourceId", "status"],
        where: {
          orgId,
          sourceId: { in: sourceIds },
          createdAt: { gte: sinceLookback }
        },
        _count: { _all: true }
      }),
      this.prisma.pipelineJob.findMany({
        where: {
          orgId,
          sourceId: { in: sourceIds }
        },
        orderBy: { createdAt: "desc" },
        select: { sourceId: true, status: true, createdAt: true },
        take: Math.max(200, sourceIds.length * 3)
      })
    ]);

    const jobsBySource = new Map<string, SourceLookbackPipelineStats>();
    for (const row of pipelineRows) {
      const sourceId = typeof row.sourceId === "string" ? row.sourceId.trim() : "";
      if (!sourceId) {
        continue;
      }
      const current = jobsBySource.get(sourceId) ?? {
        queued: 0,
        running: 0,
        completed: 0,
        failed: 0
      };
      const value = Math.max(0, Number(row._count?._all ?? 0));
      if (row.status === PipelineJobStatus.queued || row.status === PipelineJobStatus.pending) {
        current.queued += value;
      } else if (row.status === PipelineJobStatus.running || row.status === PipelineJobStatus.delayed) {
        current.running += value;
      } else if (row.status === PipelineJobStatus.completed) {
        current.completed += value;
      } else if (row.status === PipelineJobStatus.failed) {
        current.failed += value;
      }
      jobsBySource.set(sourceId, current);
    }

    const latestJobBySource = new Map<string, { status: string; createdAt: Date }>();
    for (const row of latestJobs) {
      const sourceId = typeof row.sourceId === "string" ? row.sourceId.trim() : "";
      if (!sourceId || latestJobBySource.has(sourceId)) {
        continue;
      }
      latestJobBySource.set(sourceId, {
        status: row.status,
        createdAt: row.createdAt
      });
    }

    return rssSources
      .map<RssDiagnosticsSourceRow>((source) => {
        const processed = processedStats.get(source.id) ?? { itemCountWindow: 0, latestItemAt: null };
        const article = articleStats.get(source.id) ?? { itemCountWindow: 0, latestItemAt: null };
        const jobs24h = jobsBySource.get(source.id) ?? {
          queued: 0,
          running: 0,
          completed: 0,
          failed: 0
        };
        const latestJob = latestJobBySource.get(source.id);

        const visibility: RssDiagnosticsSourceRow["visibility"] =
          processed.itemCountWindow > 0
            ? "processed"
            : article.itemCountWindow > 0
              ? "article_fallback"
              : "none";

        const issues: string[] = [];
        if (!source.seedEnabled) {
          issues.push("seed_disabled");
        }
        if (!source.feedUrl) {
          issues.push("feed_url_missing");
        }
        if (visibility === "none") {
          issues.push("no_recent_items");
        } else if (visibility === "article_fallback") {
          issues.push("processed_source_link_missing");
        }
        if ((source.consecutiveFailures ?? 0) > 0) {
          issues.push("source_has_failures");
        }

        return {
          sourceId: source.id,
          name: source.name,
          isActive: source.isActive,
          language: source.language,
          siteUrl: source.siteUrl,
          feedUrl: source.feedUrl,
          seedEnabled: source.seedEnabled,
          itemCountByProcessed: processed.itemCountWindow,
          latestByProcessed: processed.latestItemAt ? processed.latestItemAt.toISOString() : null,
          itemCountByArticle: article.itemCountWindow,
          latestByArticle: article.latestItemAt ? article.latestItemAt.toISOString() : null,
          visibility,
          jobs24h,
          lastJobStatus: latestJob?.status ?? null,
          lastJobCreatedAt: latestJob?.createdAt?.toISOString() ?? null,
          lastFailureAt: source.lastFailureAt?.toISOString() ?? null,
          consecutiveFailures: source.consecutiveFailures,
          circuitOpenUntil: source.circuitOpenUntil?.toISOString() ?? null,
          issues
        };
      })
      .sort((left, right) => {
        if (right.itemCountByProcessed !== left.itemCountByProcessed) {
          return right.itemCountByProcessed - left.itemCountByProcessed;
        }
        if (right.itemCountByArticle !== left.itemCountByArticle) {
          return right.itemCountByArticle - left.itemCountByArticle;
        }
        return left.name.localeCompare(right.name);
      });
  }

  async backfillProcessedItemSourceId(
    orgId: string,
    options?: { dryRun?: boolean; limit?: number }
  ): Promise<RssSourceIdBackfillResponse> {
    const dryRun = options?.dryRun !== false;
    const limit = this.clampInt(options?.limit, 1, MAX_BACKFILL_LIMIT, DEFAULT_BACKFILL_LIMIT);

    const processedRows = await ProcessedItemModel.find(
      {
        orgId,
        status: PipelineStageStatus.Completed,
        $or: [{ sourceId: null }, { sourceId: "" }, { sourceId: { $exists: false } }]
      },
      {
        _id: 1,
        rawItemId: 1,
        itemMetaId: 1,
        pipelineJobId: 1
      }
    )
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    const normalizedCandidates = processedRows
      .map((row) => this.toBackfillCandidate(row))
      .filter((row): row is BackfillCandidate => Boolean(row));
    if (normalizedCandidates.length === 0) {
      return {
        dryRun,
        limit,
        scanned: 0,
        matched: 0,
        updated: 0,
        unresolved: 0,
        unresolvedSamples: []
      };
    }

    const rawObjectIds = normalizedCandidates
      .map((row) => row.rawItemId)
      .filter((id) => Types.ObjectId.isValid(id))
      .map((id) => new Types.ObjectId(id));

    const rawRows =
      rawObjectIds.length > 0
        ? await RawItemModel.find(
            { _id: { $in: rawObjectIds } },
            { payload: 1 }
          ).lean()
        : [];
    const rawById = new Map<
      string,
      {
        sourceId?: string;
        pipelineJobId?: string;
        crawlResultId?: string;
      }
    >();
    for (const row of rawRows) {
      const id = this.normalizeObjectIdLike((row as { _id?: unknown })._id);
      if (!id) {
        continue;
      }
      const payload = this.asRecord((row as { payload?: unknown }).payload);
      const metadata = this.asRecord(payload?.metadata);
      rawById.set(id, {
        sourceId: this.normalizeString(metadata?.sourceId),
        pipelineJobId: this.normalizeString(metadata?.pipelineJobId),
        crawlResultId: this.normalizeString(metadata?.crawlResultId)
      });
    }

    const itemMetaIds = Array.from(new Set(normalizedCandidates.map((row) => row.itemMetaId)));
    const itemMetas =
      itemMetaIds.length > 0
        ? await this.prisma.itemMeta.findMany({
            where: {
              orgId,
              id: { in: itemMetaIds }
            },
            select: { id: true, externalId: true }
          })
        : [];
    const fallbackCrawlResultIdByItemMetaId = new Map<string, string>();
    for (const row of itemMetas) {
      const crawlResultId = this.extractCrawlResultIdFromExternalId(row.externalId);
      if (crawlResultId) {
        fallbackCrawlResultIdByItemMetaId.set(row.id, crawlResultId);
      }
    }

    for (const candidate of normalizedCandidates) {
      const raw = rawById.get(candidate.rawItemId);
      if (raw?.sourceId) {
        candidate.rawSourceId = raw.sourceId;
      }
      if (raw?.pipelineJobId) {
        candidate.rawPipelineJobId = raw.pipelineJobId;
      }
      if (raw?.crawlResultId) {
        candidate.crawlResultId = raw.crawlResultId;
      } else {
        candidate.fallbackCrawlResultId = fallbackCrawlResultIdByItemMetaId.get(candidate.itemMetaId);
      }
    }

    const pipelineJobIds = Array.from(
      new Set(
        normalizedCandidates
          .flatMap((row) => [row.pipelineJobId, row.rawPipelineJobId])
          .filter((id): id is string => Boolean(id && id.trim().length > 0))
      )
    );
    const pipelineJobs =
      pipelineJobIds.length > 0
        ? await this.prisma.pipelineJob.findMany({
            where: {
              orgId,
              id: { in: pipelineJobIds }
            },
            select: {
              id: true,
              sourceId: true
            }
          })
        : [];
    const sourceIdByPipelineJobId = new Map<string, string>();
    for (const row of pipelineJobs) {
      const sourceId = this.normalizeString(row.sourceId);
      if (!sourceId) {
        continue;
      }
      sourceIdByPipelineJobId.set(row.id, sourceId);
    }

    const crawlResultIds = Array.from(
      new Set(
        normalizedCandidates
          .flatMap((row) => [row.crawlResultId, row.fallbackCrawlResultId])
          .filter((id): id is string => Boolean(id && id.trim().length > 0))
      )
    );
    const crawlResults =
      crawlResultIds.length > 0
        ? await this.prisma.crawlResult.findMany({
            where: {
              id: { in: crawlResultIds },
              task: { orgId }
            },
            select: {
              id: true,
              task: { select: { config: true } }
            }
          })
        : [];
    const sourceIdByCrawlResultId = new Map<string, string>();
    for (const row of crawlResults) {
      const sourceId = this.extractSourceIdFromTaskConfig(row.task.config);
      if (!sourceId) {
        continue;
      }
      sourceIdByCrawlResultId.set(row.id, sourceId);
    }

    const candidateSourceIds = Array.from(
      new Set(
        normalizedCandidates
          .flatMap((row) => [
            row.rawSourceId,
            row.pipelineJobId ? sourceIdByPipelineJobId.get(row.pipelineJobId) : undefined,
            row.rawPipelineJobId ? sourceIdByPipelineJobId.get(row.rawPipelineJobId) : undefined,
            row.crawlResultId ? sourceIdByCrawlResultId.get(row.crawlResultId) : undefined,
            row.fallbackCrawlResultId
              ? sourceIdByCrawlResultId.get(row.fallbackCrawlResultId)
              : undefined
          ])
          .filter((id): id is string => Boolean(id && id.trim().length > 0))
      )
    );
    const validSources =
      candidateSourceIds.length > 0
        ? await this.prisma.newsSource.findMany({
            where: { orgId, id: { in: candidateSourceIds } },
            select: { id: true }
          })
        : [];
    const validSourceIdSet = new Set(validSources.map((row) => row.id));

    const unresolvedSamples: BackfillUnresolvedSample[] = [];
    const updateOperations: {
      updateOne: {
        filter: Record<string, unknown>;
        update: { $set: Record<string, unknown> };
      };
    }[] = [];
    for (const candidate of normalizedCandidates) {
      const fromPipelineJob = candidate.pipelineJobId
        ? sourceIdByPipelineJobId.get(candidate.pipelineJobId)
        : undefined;
      const fromRawPipelineJob = candidate.rawPipelineJobId
        ? sourceIdByPipelineJobId.get(candidate.rawPipelineJobId)
        : undefined;
      const fromCrawlResult = candidate.crawlResultId
        ? sourceIdByCrawlResultId.get(candidate.crawlResultId)
        : undefined;
      const fromFallbackCrawlResult = candidate.fallbackCrawlResultId
        ? sourceIdByCrawlResultId.get(candidate.fallbackCrawlResultId)
        : undefined;

      const resolvedSourceId =
        this.normalizeString(fromPipelineJob) ??
        this.normalizeString(candidate.rawSourceId) ??
        this.normalizeString(fromRawPipelineJob) ??
        this.normalizeString(fromCrawlResult) ??
        this.normalizeString(fromFallbackCrawlResult);

      if (!resolvedSourceId) {
        if (unresolvedSamples.length < UNRESOLVED_SAMPLE_LIMIT) {
          unresolvedSamples.push({
            processedItemId: candidate.processedItemId,
            itemMetaId: candidate.itemMetaId,
            reason: "source_not_resolved"
          });
        }
        continue;
      }
      if (!validSourceIdSet.has(resolvedSourceId)) {
        if (unresolvedSamples.length < UNRESOLVED_SAMPLE_LIMIT) {
          unresolvedSamples.push({
            processedItemId: candidate.processedItemId,
            itemMetaId: candidate.itemMetaId,
            reason: "resolved_source_not_in_org"
          });
        }
        continue;
      }

      const pipelineJobId = this.normalizeString(candidate.pipelineJobId) ?? this.normalizeString(candidate.rawPipelineJobId);
      const updateSet: Record<string, unknown> = {
        sourceId: resolvedSourceId,
        updatedAt: new Date()
      };
      if (pipelineJobId) {
        updateSet.pipelineJobId = pipelineJobId;
      }
      updateOperations.push({
        updateOne: {
          filter: {
            _id: new Types.ObjectId(candidate.processedItemId),
            orgId,
            $or: [{ sourceId: null }, { sourceId: "" }, { sourceId: { $exists: false } }]
          },
          update: { $set: updateSet }
        }
      });
    }

    let updated = 0;
    if (!dryRun && updateOperations.length > 0) {
      try {
        const bulkResult = await ProcessedItemModel.bulkWrite(updateOperations, {
          ordered: false
        });
        updated = Number((bulkResult as { modifiedCount?: number }).modifiedCount ?? 0);
      } catch (error) {
        logger.error({ error, orgId }, "Failed to run RSS sourceId backfill");
        throw error;
      }
    }

    const matched = updateOperations.length;
    return {
      dryRun,
      limit,
      scanned: normalizedCandidates.length,
      matched,
      updated: dryRun ? 0 : updated,
      unresolved: Math.max(0, normalizedCandidates.length - matched),
      unresolvedSamples
    };
  }

  private async loadRssSources(orgId: string): Promise<RssSourceConfigRow[]> {
    const sources = await this.prisma.newsSource.findMany({
      where: { orgId },
      select: {
        id: true,
        name: true,
        isActive: true,
        url: true,
        language: true,
        config: true,
        lastRunAt: true,
        lastSuccessAt: true,
        lastFailureAt: true,
        consecutiveFailures: true,
        circuitOpenUntil: true
      },
      orderBy: [{ priority: "desc" }, { updatedAt: "desc" }, { createdAt: "desc" }]
    });

    const rows: RssSourceConfigRow[] = [];
    for (const source of sources) {
      const seed = this.extractSeed(source.config);
      if (!seed || seed.mode !== "rss") {
        continue;
      }
      const siteUrl = source.url.trim();
      const feedUrl = this.normalizeString(seed.feedUrl) ?? (siteUrl ? siteUrl : null);
      rows.push({
        id: source.id,
        name: source.name,
        isActive: source.isActive,
        siteUrl,
        language: source.language ?? null,
        seedEnabled: seed.enabled,
        feedUrl,
        lastRunAt: source.lastRunAt,
        lastSuccessAt: source.lastSuccessAt,
        lastFailureAt: source.lastFailureAt,
        consecutiveFailures: Math.max(0, source.consecutiveFailures ?? 0),
        circuitOpenUntil: source.circuitOpenUntil
      });
    }
    return rows;
  }

  private async getProcessedStatsBySource(
    orgId: string,
    sourceIds: string[],
    since: Date
  ): Promise<Map<string, SourceWindowStats>> {
    if (sourceIds.length === 0) {
      return new Map();
    }

    const rows = await ProcessedItemModel.aggregate<{
      _id: string;
      itemCountWindow: number;
      latestItemAt: Date | null;
    }>([
      {
        $match: {
          orgId,
          status: PipelineStageStatus.Completed,
          sourceId: { $in: sourceIds },
          createdAt: { $gte: since }
        }
      },
      {
        $group: {
          _id: "$sourceId",
          itemCountWindow: { $sum: 1 },
          latestItemAt: { $max: "$createdAt" }
        }
      }
    ]);

    const mapped = new Map<string, SourceWindowStats>();
    for (const row of rows) {
      const sourceId = this.normalizeString(row._id);
      if (!sourceId) {
        continue;
      }
      mapped.set(sourceId, {
        itemCountWindow: Math.max(0, Number(row.itemCountWindow ?? 0)),
        latestItemAt: row.latestItemAt ?? null
      });
    }
    return mapped;
  }

  private async getArticleStatsBySource(
    orgId: string,
    sourceIds: string[],
    since: Date
  ): Promise<Map<string, SourceWindowStats>> {
    if (sourceIds.length === 0) {
      return new Map();
    }

    const rows = await this.prisma.article.groupBy({
      by: ["sourceId"],
      where: {
        orgId,
        sourceId: { in: sourceIds },
        crawlAt: { gte: since }
      },
      _count: { _all: true },
      _max: { crawlAt: true }
    });

    const mapped = new Map<string, SourceWindowStats>();
    for (const row of rows) {
      const sourceId = this.normalizeString(row.sourceId);
      if (!sourceId) {
        continue;
      }
      mapped.set(sourceId, {
        itemCountWindow: Math.max(0, Number(row._count?._all ?? 0)),
        latestItemAt: row._max?.crawlAt ?? null
      });
    }
    return mapped;
  }

  private computeVisibility(
    rssSources: RssSourceConfigRow[],
    processedStats: Map<string, SourceWindowStats>,
    articleStats: Map<string, SourceWindowStats>
  ) {
    let visibleByProcessed = 0;
    let visibleByArticleFallback = 0;
    let hiddenSources = 0;

    for (const source of rssSources) {
      const processedCount = processedStats.get(source.id)?.itemCountWindow ?? 0;
      const articleCount = articleStats.get(source.id)?.itemCountWindow ?? 0;
      if (processedCount > 0) {
        visibleByProcessed += 1;
      } else if (articleCount > 0) {
        visibleByArticleFallback += 1;
      } else {
        hiddenSources += 1;
      }
    }

    return {
      visibleByProcessed,
      visibleByArticleFallback,
      hiddenSources
    };
  }

  private pipelineCountsFromRows(
    rows: { status: PipelineJobStatus; _count: { _all: number } }[]
  ) {
    let queued = 0;
    let running = 0;
    let completed = 0;
    let failed = 0;
    for (const row of rows) {
      const value = Math.max(0, Number(row._count?._all ?? 0));
      if (row.status === PipelineJobStatus.queued || row.status === PipelineJobStatus.pending) {
        queued += value;
      } else if (row.status === PipelineJobStatus.running || row.status === PipelineJobStatus.delayed) {
        running += value;
      } else if (row.status === PipelineJobStatus.completed) {
        completed += value;
      } else if (row.status === PipelineJobStatus.failed) {
        failed += value;
      }
    }
    return {
      total: queued + running + completed + failed,
      queued,
      running,
      completed,
      failed
    };
  }

  private crawlTaskCountsFromRows(rows: { status: string; _count: { _all: number } }[]) {
    let queued = 0;
    let running = 0;
    let completed = 0;
    let failed = 0;
    for (const row of rows) {
      const value = Math.max(0, Number(row._count?._all ?? 0));
      if (row.status === "queued") {
        queued += value;
      } else if (row.status === "running") {
        running += value;
      } else if (row.status === "completed") {
        completed += value;
      } else if (row.status === "failed") {
        failed += value;
      }
    }
    return {
      total: queued + running + completed + failed,
      queued,
      running,
      completed,
      failed
    };
  }

  private toBackfillCandidate(raw: unknown): BackfillCandidate | null {
    const row = this.asRecord(raw);
    const processedItemId = this.normalizeObjectIdLike(row?._id);
    const rawItemId = this.normalizeObjectIdLike(row?.rawItemId);
    const itemMetaId = this.normalizeString(row?.itemMetaId);
    if (
      !processedItemId ||
      !rawItemId ||
      !itemMetaId ||
      !Types.ObjectId.isValid(processedItemId) ||
      !Types.ObjectId.isValid(rawItemId)
    ) {
      return null;
    }
    return {
      processedItemId,
      rawItemId,
      itemMetaId,
      pipelineJobId: this.normalizeString(row?.pipelineJobId)
    };
  }

  private extractSourceIdFromTaskConfig(config: unknown): string | undefined {
    const record = this.asRecord(config);
    if (!record) {
      return undefined;
    }
    const direct = this.normalizeString(record.sourceId);
    if (direct) {
      return direct;
    }
    const itemPayload = this.asRecord(record.itemPayload);
    const metadata = this.asRecord(itemPayload?.metadata);
    return this.normalizeString(metadata?.sourceId);
  }

  private extractCrawlResultIdFromExternalId(externalId: string): string | undefined {
    const raw = externalId.trim();
    if (!raw) {
      return undefined;
    }
    const prefixes = ["crawlResult:", "crawl:"];
    for (const prefix of prefixes) {
      if (raw.startsWith(prefix)) {
        const candidate = raw.slice(prefix.length).trim();
        if (candidate) {
          return candidate;
        }
      }
    }
    return undefined;
  }

  private extractSeed(config: Prisma.JsonValue | null | undefined) {
    const record = this.asRecord(config);
    const seed = this.asRecord(record?.seed);
    if (!seed) {
      return null;
    }
    const modeRaw = this.normalizeString(seed.mode)?.toLowerCase();
    const mode = modeRaw === "rss" || modeRaw === "list" || modeRaw === "deep" ? modeRaw : "sitemap";
    return {
      enabled: seed.enabled === true,
      mode,
      feedUrl: this.normalizeString(seed.feedUrl)
    };
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return null;
  }

  private normalizeString(value: unknown): string | undefined {
    if (typeof value !== "string") {
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private normalizeObjectIdLike(value: unknown): string | undefined {
    if (typeof value === "string") {
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    }
    if (value instanceof Types.ObjectId) {
      return value.toHexString();
    }
    if (value && typeof value === "object" && "toString" in value) {
      const text = String((value as { toString: () => string }).toString()).trim();
      return text.length > 0 ? text : undefined;
    }
    return undefined;
  }

  private clampInt(
    value: number | undefined,
    min: number,
    max: number,
    fallback: number
  ): number {
    if (!Number.isFinite(value)) {
      return fallback;
    }
    const normalized = Math.trunc(Number(value));
    return Math.min(max, Math.max(min, normalized));
  }
}
