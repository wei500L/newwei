import { ProcessedItemModel } from "@modular/mongo";
import { createLogger } from "@modular/utils";
import { Injectable } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { ProcessedArticleStatus, Prisma } from "@prisma/client";

import { settleWithConcurrency } from "../../common/multi-tenant-scheduler";
import { CacheService } from "../cache/cache.service";
import { PrismaService } from "../config/prisma.service";
import { buildNewsSignalFromProcessedArticle } from "../news-signals/news-signal";
import { MultiTenantSchedulerSettingsService } from "../system-settings/multi-tenant-scheduler-settings.service";

import {
  NewsEventsBertopicService,
  type NewsEventIngestionBatchEntry,
} from "./news-events-bertopic.service";
import { NewsEventsSettingsService } from "./news-events-settings.service";
import { NewsEventsService } from "./news-events.service";

const logger = createLogger({ name: "news-events-ingestion" });
const NEWS_EVENTS_INGESTION_ORG_LOCK_TTL_MS = 60_000;

type NewsEventsSchedulerOrgRunStatus = "completed" | "skipped";

@Injectable()
export class NewsEventsIngestionService {
  constructor(
    private readonly cache: CacheService,
    private readonly prisma: PrismaService,
    private readonly schedulerSettings: MultiTenantSchedulerSettingsService,
    private readonly settings: NewsEventsSettingsService,
    private readonly events: NewsEventsService,
    private readonly bertopic: NewsEventsBertopicService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async ingestRecentProcessedArticles() {
    const orgs = await this.prisma.org.findMany({
      where: { isActive: true },
      select: { id: true }
    });

    if (orgs.length === 0) {
      return;
    }

    const runtime = await this.schedulerSettings.getRuntimeSettings();
    const concurrency = runtime.newsEventsIngestionOrgConcurrency;
    logger.info(
      { orgCount: orgs.length, concurrency },
      "News event ingestion scheduler tick started",
    );

    const results = await settleWithConcurrency(orgs, concurrency, async (org) =>
      await this.ingestOrgWithLock(org.id),
    );

    let failedOrgs = 0;
    let skippedOrgs = 0;
    for (const result of results) {
      if (result.status === "rejected") {
        failedOrgs += 1;
        logger.warn(
          { err: result.reason, orgId: result.item.id },
          "News event ingestion failed",
        );
        continue;
      }

      if (result.value === "skipped") {
        skippedOrgs += 1;
      }
    }

    logger.info(
      { orgCount: orgs.length, concurrency, failedOrgs, skippedOrgs },
      "News event ingestion scheduler tick completed",
    );
  }

  private async ingestOrgWithLock(
    orgId: string,
  ): Promise<NewsEventsSchedulerOrgRunStatus> {
    const locked = await this.cache.withLock(
      `cron:news-events-ingestion:org:${orgId}`,
      NEWS_EVENTS_INGESTION_ORG_LOCK_TTL_MS,
      async () => {
        await this.ingestOrg(orgId);
        return "completed" as const;
      },
    );

    if (locked !== null) {
      return locked;
    }

    logger.info(
      { orgId },
      "Skipped news event ingestion because previous org run is still in progress",
    );
    return "skipped";
  }

  private async ingestOrg(orgId: string) {
    const settings = await this.settings.getSettings(orgId);
    if (!settings.enabled || !settings.ingestionEnabled) {
      return;
    }

    let state = await this.prisma.newsEventIngestionState.findUnique({ where: { orgId } });
    if (!state) {
      state = await this.prisma.newsEventIngestionState.create({ data: { orgId } });
    }

    const baselineStartAt =
      state.lastProcessedAt ?? new Date(Date.now() - settings.backfillDays * 24 * 60 * 60 * 1000);

    const where: Prisma.ProcessedArticleWhereInput = {
      status: ProcessedArticleStatus.completed,
      orgId,
      ...(state.lastProcessedAt
        ? {
            OR: [
              { processedAt: { gt: state.lastProcessedAt } },
              {
                processedAt: state.lastProcessedAt,
                articleId: { gt: state.lastProcessedArticleId ?? "" }
              }
            ]
          }
        : {
            processedAt: { gte: baselineStartAt }
          })
    };

    const batch = await this.prisma.processedArticle.findMany({
      where,
      select: {
        id: true,
        articleId: true,
        processedAt: true,
        publishedAt: true,
        language: true,
        title: true,
        summary: true,
        category: true,
        topics: true,
        entities: true,
        qualityScore: true,
        cleanedMarkdownRef: true,
        article: { select: { crawlAt: true } }
      },
      orderBy: [{ processedAt: "asc" }, { articleId: "asc" }],
      take: settings.maxBatchSize
    }) as NewsEventIngestionBatchEntry[];

    if (batch.length === 0) {
      return;
    }

    const processedItemIds = Array.from(
      new Set(
        batch
          .map((entry) =>
            typeof entry.cleanedMarkdownRef === "string"
              ? entry.cleanedMarkdownRef.trim()
              : "",
          )
          .filter((entry) => entry.length > 0),
      ),
    );

    const processedItemResultById = new Map<string, unknown>();
    if (processedItemIds.length > 0) {
      try {
        const docs = await ProcessedItemModel.find({
          _id: { $in: processedItemIds },
        })
          .select({ _id: 1, result: 1 })
          .lean()
          .exec();
        for (const doc of docs) {
          const id = String((doc as { _id?: unknown })._id ?? "");
          if (!id) {
            continue;
          }
          processedItemResultById.set(
            id,
            (doc as { result?: unknown }).result ?? null,
          );
        }
      } catch (error) {
        logger.warn(
          { err: error, orgId, ids: processedItemIds.length },
          "Failed to load processed item results for event classification context",
        );
      }
    }

    let processedArticles = 0;
    let assigned = 0;
    let queuedForManual = 0;

    if (settings.clusteringMode === "bertopic_primary") {
      const result = await this.bertopic.processBatch({
        orgId,
        batch,
        processedItemResultById,
        settings,
      });
      processedArticles = result.processedArticles;
      assigned = result.assigned;
      queuedForManual = result.queuedForManual;
      await this.updateStateToLastBatchEntry(orgId, batch);
      logger.info(
        { orgId, processedArticles, assigned, queuedForManual },
        "News event ingestion completed",
      );
      return;
    }

    for (const entry of batch) {
      const signal = buildNewsSignalFromProcessedArticle({
        processedArticle: {
          id: entry.id,
          articleId: entry.articleId,
          processedAt: entry.processedAt ?? null,
          publishedAt: entry.publishedAt ?? null,
          language: entry.language ?? null,
          title: entry.title ?? null,
          summary: entry.summary ?? null,
          category: entry.category ?? null,
          topics: entry.topics,
          entities: entry.entities,
          qualityScore: entry.qualityScore ?? null,
          cleanedMarkdownRef: entry.cleanedMarkdownRef ?? null
        },
        article: {
          crawlAt: entry.article?.crawlAt ?? null
        },
        processedItemResult:
          typeof entry.cleanedMarkdownRef === "string"
            ? processedItemResultById.get(entry.cleanedMarkdownRef.trim()) ??
              null
            : null,
      });

      const result = await this.events.assignNewsSignalToEvent(orgId, signal, settings);

      processedArticles += 1;
      if (result.created) {
        assigned += 1;
      }

      await this.prisma.newsEventIngestionState.update({
        where: { orgId },
        data: {
          lastProcessedAt: entry.processedAt,
          lastProcessedArticleId: entry.articleId
        }
      });
    }

    logger.info(
      { orgId, processedArticles, assigned, queuedForManual },
      "News event ingestion completed",
    );
  }

  private async updateStateToLastBatchEntry(
    orgId: string,
    batch: NewsEventIngestionBatchEntry[],
  ) {
    const last = batch[batch.length - 1];
    if (!last) {
      return;
    }
    await this.prisma.newsEventIngestionState.update({
      where: { orgId },
      data: {
        lastProcessedAt: last.processedAt,
        lastProcessedArticleId: last.articleId,
      },
    });
  }
}
