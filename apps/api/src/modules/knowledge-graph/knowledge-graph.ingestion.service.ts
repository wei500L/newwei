import { createLogger } from "@modular/utils";
import { Injectable } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import type { Prisma } from "@prisma/client";

import {
  claimSchedulerTick,
  settleWithConcurrency,
} from "../../common/multi-tenant-scheduler";
import { CacheService } from "../cache/cache.service";
import { PrismaService } from "../config/prisma.service";
import { ActiveOrgRegistryService } from "../org/active-org-registry.service";
import { MultiTenantSchedulerSettingsService } from "../system-settings/multi-tenant-scheduler-settings.service";

import { KnowledgeGraphQualityService } from "./knowledge-graph-quality.service";
import { KnowledgeGraphSettingsService } from "./knowledge-graph-settings.service";
import { KnowledgeGraphService } from "./knowledge-graph.service";

const logger = createLogger({ name: "knowledge-graph-ingestion" });
const DEFAULT_BACKFILL_DAYS = 30;
const DEFAULT_MAX_ENTITIES_PER_ARTICLE = 20;
const DEFAULT_MIN_ENTITY_CONFIDENCE = 0.5;
const KNOWLEDGE_GRAPH_INGESTION_TICK_GATE_TTL_MS = 4 * 60_000 + 45_000;
const KNOWLEDGE_GRAPH_INGESTION_ORG_LOCK_TTL_MS = 60_000;

type KnowledgeGraphSchedulerOrgRunStatus = "completed" | "skipped";

@Injectable()
export class KnowledgeGraphIngestionService {
  constructor(
    private readonly cache: CacheService,
    private readonly prisma: PrismaService,
    private readonly activeOrgRegistry: ActiveOrgRegistryService,
    private readonly schedulerSettings: MultiTenantSchedulerSettingsService,
    private readonly settings: KnowledgeGraphSettingsService,
    private readonly quality: KnowledgeGraphQualityService,
    private readonly graph: KnowledgeGraphService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async ingestRecentProcessedArticles() {
    const claimed = await claimSchedulerTick(
      this.cache,
      "cron:knowledge-graph-ingestion:tick-gate",
      KNOWLEDGE_GRAPH_INGESTION_TICK_GATE_TTL_MS,
    );
    if (!claimed) {
      logger.info(
        "Skipped knowledge graph ingestion scheduler tick because another instance already claimed this interval",
      );
      return;
    }

    const orgs = await this.activeOrgRegistry.listActiveOrgs();

    if (orgs.length === 0) {
      return;
    }

    const runtime = await this.schedulerSettings.getRuntimeSettings();
    const concurrency = runtime.knowledgeGraphIngestionOrgConcurrency;
    logger.info(
      { orgCount: orgs.length, concurrency },
      "Knowledge graph ingestion scheduler tick started",
    );

    const results = await settleWithConcurrency(
      orgs,
      concurrency,
      async (org) => await this.ingestOrgWithLock(org.id),
    );

    let failedOrgs = 0;
    let skippedOrgs = 0;
    for (const result of results) {
      if (result.status === "rejected") {
        failedOrgs += 1;
        logger.warn(
          { err: result.reason, orgId: result.item.id },
          "Knowledge graph ingestion failed",
        );
        continue;
      }

      if (result.value === "skipped") {
        skippedOrgs += 1;
      }
    }

    logger.info(
      { orgCount: orgs.length, concurrency, failedOrgs, skippedOrgs },
      "Knowledge graph ingestion scheduler tick completed",
    );
  }

  private async ingestOrgWithLock(
    orgId: string,
  ): Promise<KnowledgeGraphSchedulerOrgRunStatus> {
    const locked = await this.cache.withLock(
      `cron:knowledge-graph-ingestion:org:${orgId}`,
      KNOWLEDGE_GRAPH_INGESTION_ORG_LOCK_TTL_MS,
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
      "Skipped knowledge graph ingestion because previous org run is still in progress",
    );
    return "skipped";
  }

  private async ingestOrg(orgId: string) {
    const settings = await this.settings.getSettings(orgId);
    if (!settings.enabled || !settings.ingestionEnabled) {
      return;
    }

    let state = await this.prisma.knowledgeGraphIngestionState.findUnique({
      where: { orgId },
    });
    if (!state) {
      state = await this.prisma.knowledgeGraphIngestionState.create({
        data: { orgId },
      });
    }

    const baselineStartAt =
      state.lastProcessedAt ??
      new Date(Date.now() - DEFAULT_BACKFILL_DAYS * 24 * 60 * 60 * 1000);

    const where: Prisma.ProcessedArticleWhereInput = {
      status: "completed",
      orgId,
      ...(state.lastProcessedAt
        ? {
            OR: [
              { processedAt: { gt: state.lastProcessedAt } },
              {
                processedAt: state.lastProcessedAt,
                articleId: { gt: state.lastProcessedArticleId ?? "" },
              },
            ],
          }
        : {
            processedAt: { gte: baselineStartAt },
          }),
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
        llmPromptVersion: true,
      },
      orderBy: [{ processedAt: "asc" }, { articleId: "asc" }],
      take: settings.maxBatchSize,
    });

    if (batch.length === 0) {
      return;
    }

    let processedArticles = 0;
    let upsertedEdges = 0;
    let validatedRelations = 0;
    let filteredRelations = 0;
    let failedArticles = 0;

    for (const entry of batch) {
      try {
        const prepared = await this.quality.prepareRelationsForIngestion({
          orgId,
          articleId: entry.articleId,
          title: entry.title,
          summary: entry.summary,
          language: entry.language,
          kgRelations: entry.kgRelations,
          settings,
          maxRelationsPerArticle: settings.maxRelationsPerArticle,
        });

        const result = await this.graph.ingestProcessedArticle({
          orgId,
          articleId: entry.articleId,
          extractorVersion: entry.llmPromptVersion,
          kgRelations: prepared.relations,
          maxRelationsPerArticle: settings.maxRelationsPerArticle,
        });

        try {
          const contextText = [entry.title, entry.summary]
            .filter(Boolean)
            .join("\n\n")
            .trim();
          await this.graph.linkArticleEntities({
            orgId,
            articleId: entry.articleId,
            extractorVersion: entry.llmPromptVersion,
            entities: entry.entities,
            maxEntitiesPerArticle: DEFAULT_MAX_ENTITIES_PER_ARTICLE,
            minConfidence: DEFAULT_MIN_ENTITY_CONFIDENCE,
            createMissingEntities: true,
            disambiguationEnabled: settings.entityDisambiguationEnabled,
            disambiguationContextText:
              contextText.length > 0 ? contextText.slice(0, 4_000) : undefined,
            disambiguationMaxCandidates:
              settings.entityDisambiguationMaxCandidates,
          });
        } catch (error) {
          logger.warn(
            { err: error, orgId, articleId: entry.articleId },
            "Knowledge graph entity linking failed",
          );
        }

        processedArticles += 1;
        upsertedEdges += result.edgesUpserted;
        validatedRelations += prepared.validatedRelations;
        filteredRelations += prepared.filteredRelations;
      } catch (error) {
        failedArticles += 1;
        logger.warn(
          { err: error, orgId, articleId: entry.articleId },
          "Knowledge graph ingestion skipped article due to processing error",
        );
      } finally {
        try {
          await this.prisma.knowledgeGraphIngestionState.update({
            where: { orgId },
            data: {
              lastProcessedAt: entry.processedAt,
              lastProcessedArticleId: entry.articleId,
            },
          });
        } catch (error) {
          logger.warn(
            { err: error, orgId, articleId: entry.articleId },
            "Knowledge graph ingestion failed to advance cursor",
          );
        }
      }
    }

    logger.info(
      {
        orgId,
        processedArticles,
        failedArticles,
        upsertedEdges,
        validatedRelations,
        filteredRelations,
      },
      "Knowledge graph ingestion completed",
    );
  }
}
