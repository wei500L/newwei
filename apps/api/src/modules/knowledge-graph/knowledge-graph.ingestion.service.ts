import { createLogger } from "@modular/utils";
import { Injectable } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import type { Prisma } from "@prisma/client";

import { PrismaService } from "../config/prisma.service";

import { KnowledgeGraphSettingsService } from "./knowledge-graph-settings.service";
import { KnowledgeGraphQualityService } from "./knowledge-graph-quality.service";
import { KnowledgeGraphService } from "./knowledge-graph.service";

const logger = createLogger({ name: "knowledge-graph-ingestion" });
const DEFAULT_BACKFILL_DAYS = 30;
const DEFAULT_MAX_ENTITIES_PER_ARTICLE = 20;
const DEFAULT_MIN_ENTITY_CONFIDENCE = 0.5;

@Injectable()
export class KnowledgeGraphIngestionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: KnowledgeGraphSettingsService,
    private readonly quality: KnowledgeGraphQualityService,
    private readonly graph: KnowledgeGraphService
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
        logger.warn({ err: error, orgId: org.id }, "Knowledge graph ingestion failed");
      }
    }
  }

  private async ingestOrg(orgId: string) {
    const settings = await this.settings.getSettings(orgId);
    if (!settings.enabled || !settings.ingestionEnabled) {
      return;
    }

    let state = await this.prisma.knowledgeGraphIngestionState.findUnique({ where: { orgId } });
    if (!state) {
      state = await this.prisma.knowledgeGraphIngestionState.create({ data: { orgId } });
    }

    const baselineStartAt =
      state.lastProcessedAt ?? new Date(Date.now() - DEFAULT_BACKFILL_DAYS * 24 * 60 * 60 * 1000);

    const where: Prisma.ProcessedArticleWhereInput = {
      status: "completed",
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
        articleId: true,
        processedAt: true,
        title: true,
        summary: true,
        language: true,
        entities: true,
        kgRelations: true,
        llmPromptVersion: true
      },
      orderBy: [{ processedAt: "asc" }, { articleId: "asc" }],
      take: settings.maxBatchSize
    });

    if (batch.length === 0) {
      return;
    }

    let processedArticles = 0;
    let upsertedEdges = 0;
    let validatedRelations = 0;
    let filteredRelations = 0;

    for (const entry of batch) {
      const prepared = await this.quality.prepareRelationsForIngestion({
        orgId,
        articleId: entry.articleId,
        title: entry.title,
        summary: entry.summary,
        language: entry.language,
        kgRelations: entry.kgRelations,
        settings,
        maxRelationsPerArticle: settings.maxRelationsPerArticle
      });

      const result = await this.graph.ingestProcessedArticle({
        orgId,
        articleId: entry.articleId,
        extractorVersion: entry.llmPromptVersion,
        kgRelations: prepared.relations,
        maxRelationsPerArticle: settings.maxRelationsPerArticle
      });

      try {
        const contextText = [entry.title, entry.summary].filter(Boolean).join("\n\n").trim();
        await this.graph.linkArticleEntities({
          orgId,
          articleId: entry.articleId,
          extractorVersion: entry.llmPromptVersion,
          entities: entry.entities,
          maxEntitiesPerArticle: DEFAULT_MAX_ENTITIES_PER_ARTICLE,
          minConfidence: DEFAULT_MIN_ENTITY_CONFIDENCE,
          createMissingEntities: true,
          disambiguationEnabled: settings.entityDisambiguationEnabled,
          disambiguationContextText: contextText.length > 0 ? contextText.slice(0, 4_000) : undefined,
          disambiguationMaxCandidates: settings.entityDisambiguationMaxCandidates
        });
      } catch (error) {
        logger.warn(
          { err: error, orgId, articleId: entry.articleId },
          "Knowledge graph entity linking failed"
        );
      }

      processedArticles += 1;
      upsertedEdges += result.edgesUpserted;
      validatedRelations += prepared.validatedRelations;
      filteredRelations += prepared.filteredRelations;

      await this.prisma.knowledgeGraphIngestionState.update({
        where: { orgId },
        data: {
          lastProcessedAt: entry.processedAt,
          lastProcessedArticleId: entry.articleId
        }
      });
    }

    logger.info(
      { orgId, processedArticles, upsertedEdges, validatedRelations, filteredRelations },
      "Knowledge graph ingestion completed"
    );
  }
}
