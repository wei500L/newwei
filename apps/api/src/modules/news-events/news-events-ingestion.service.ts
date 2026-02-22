import { createLogger } from "@modular/utils";
import { Injectable } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { ProcessedArticleStatus, Prisma } from "@prisma/client";
import { ProcessedItemModel } from "@modular/mongo";

import { PrismaService } from "../config/prisma.service";
import { buildNewsSignalFromProcessedArticle } from "../news-signals/news-signal";

import { NewsEventsSettingsService } from "./news-events-settings.service";
import { NewsEventsService } from "./news-events.service";

const logger = createLogger({ name: "news-events-ingestion" });

@Injectable()
export class NewsEventsIngestionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: NewsEventsSettingsService,
    private readonly events: NewsEventsService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async ingestRecentProcessedArticles() {
    const orgs = await this.prisma.org.findMany({
      where: { isActive: true },
      select: { id: true }
    });

    for (const org of orgs) {
      try {
        await this.ingestOrg(org.id);
      } catch (error) {
        logger.warn({ err: error, orgId: org.id }, "News event ingestion failed");
      }
    }
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
      article: { orgId },
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
    });

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

    logger.info({ orgId, processedArticles, assigned }, "News event ingestion completed");
  }
}
