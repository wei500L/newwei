import { Injectable } from "@nestjs/common";
import {
  KnowledgeEntityType,
  type KnowledgeEdge,
  type KnowledgeEntity,
} from "@prisma/client";

import { PrismaService } from "../config/prisma.service";

import { KnowledgeGraphService } from "./knowledge-graph.service";

export interface EntityIntelligenceCardResult {
  entity: KnowledgeEntity;
  aliases: string[];
  metrics: {
    relationshipCount: number;
    incomingEdgeCount: number;
    outgoingEdgeCount: number;
    mentionedArticleCount: number;
    recentEventCount: number;
    avgSentiment: number | null;
    negativeRatio: number | null;
    latestMentionAt: Date | null;
  };
  relationships: {
    direction: "incoming" | "outgoing";
    edge: KnowledgeEdge;
    neighbor: KnowledgeEntity;
    evidenceCount: number;
    latestEvidenceAt: Date | null;
  }[];
  sentimentSeries: {
    entityName: string;
    entityType: string;
    bucketStart: Date;
    totalDocs: number;
    negativeDocs: number;
    positiveDocs: number;
    neutralDocs: number;
    scoreSum: number;
    avgScore: number;
    negativeRatio: number;
    evidenceProcessedItemIds?: unknown;
  }[];
  neighborhood: {
    seed: KnowledgeEntity;
    nodes: KnowledgeEntity[];
    edges: KnowledgeEdge[];
  };
  generatedAt: Date;
}

export interface EntityIntelligenceEvidenceResult {
  restricted: boolean;
  events: {
    id: string;
    status: string;
    title: string | null;
    summary: string | null;
    primaryTopic: string | null;
    primaryEntity: string | null;
    startAt: Date;
    lastAt: Date;
    itemCount: number;
  }[];
  articles: {
    article: {
      id: string;
      url: string;
      sourceLabel: string | null;
      title: string | null;
      summary: string | null;
      language: string | null;
      crawlAt: Date;
    };
    mention: string | null;
    confidence: number | null;
    linkedAt: Date;
  }[];
  generatedAt: Date;
}

@Injectable()
export class KnowledgeGraphIntelligenceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly graph: KnowledgeGraphService
  ) {}

  async resolveEntityByName(
    orgId: string,
    name: string,
    type?: string | null
  ): Promise<KnowledgeEntity | null> {
    const entityType = this.normalizeEntityType(type);
    return this.graph.resolveEntity(orgId, name, entityType);
  }

  async getCard(input: {
    orgId: string;
    entityId: string;
    windowDays?: number | null;
    relatedLimit?: number | null;
  }): Promise<EntityIntelligenceCardResult | null> {
    const entity = await this.prisma.knowledgeEntity.findFirst({
      where: { id: input.entityId, orgId: input.orgId },
    });
    if (!entity) {
      return null;
    }

    const windowDays = this.clampInteger(input.windowDays, 1, 180, 30);
    const relatedLimit = this.clampInteger(input.relatedLimit, 1, 50, 12);
    const since = this.daysAgo(windowDays);

    const [
      aliases,
      relationshipRows,
      incomingEdgeCount,
      outgoingEdgeCount,
      mentionedArticleCount,
      latestMention,
      recentEventCount,
      sentimentSeries,
    ] = await Promise.all([
      this.loadAliases(input.orgId, entity.id, entity.canonicalName),
      this.loadRelationships(input.orgId, entity.id, relatedLimit),
      this.prisma.knowledgeEdge.count({
        where: { orgId: input.orgId, toEntityId: entity.id },
      }),
      this.prisma.knowledgeEdge.count({
        where: { orgId: input.orgId, fromEntityId: entity.id },
      }),
      this.prisma.articleEntityLink.count({
        where: { orgId: input.orgId, entityId: entity.id, createdAt: { gte: since } },
      }),
      this.prisma.articleEntityLink.findFirst({
        where: { orgId: input.orgId, entityId: entity.id },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      }),
      this.prisma.newsEvent.count({
        where: {
          orgId: input.orgId,
          primaryEntity: entity.canonicalName,
          lastAt: { gte: since },
        },
      }),
      this.loadSentimentSeries(input.orgId, entity, since),
    ]);

    const relationships = relationshipRows.map((row) => {
      const direction: "incoming" | "outgoing" =
        row.fromEntityId === entity.id ? "outgoing" : "incoming";
      const neighbor = direction === "outgoing" ? row.toEntity : row.fromEntity;
      return {
        direction,
        edge: row,
        neighbor,
        evidenceCount: row._count.evidences,
        latestEvidenceAt: row.evidences[0]?.createdAt ?? null,
      };
    });

    const nodesById = new Map<string, KnowledgeEntity>([[entity.id, entity]]);
    for (const relationship of relationships) {
      nodesById.set(relationship.neighbor.id, relationship.neighbor);
    }
    const edges = relationships.map((relationship) => relationship.edge);
    const sentimentTotals = this.computeSentimentTotals(sentimentSeries);

    return {
      entity,
      aliases,
      metrics: {
        relationshipCount: incomingEdgeCount + outgoingEdgeCount,
        incomingEdgeCount,
        outgoingEdgeCount,
        mentionedArticleCount,
        recentEventCount,
        avgSentiment: sentimentTotals.avgSentiment,
        negativeRatio: sentimentTotals.negativeRatio,
        latestMentionAt: latestMention?.createdAt ?? null,
      },
      relationships,
      sentimentSeries,
      neighborhood: {
        seed: entity,
        nodes: Array.from(nodesById.values()),
        edges,
      },
      generatedAt: new Date(),
    };
  }

  async getEvidence(input: {
    orgId: string;
    entityId: string;
    windowDays?: number | null;
    eventsLimit?: number | null;
    evidenceLimit?: number | null;
    canReadItems: boolean;
  }): Promise<EntityIntelligenceEvidenceResult | null> {
    const entity = await this.prisma.knowledgeEntity.findFirst({
      where: { id: input.entityId, orgId: input.orgId },
    });
    if (!entity) {
      return null;
    }

    if (!input.canReadItems) {
      return {
        restricted: true,
        events: [],
        articles: [],
        generatedAt: new Date(),
      };
    }

    const windowDays = this.clampInteger(input.windowDays, 1, 180, 30);
    const eventsLimit = this.clampInteger(input.eventsLimit, 1, 50, 10);
    const evidenceLimit = this.clampInteger(input.evidenceLimit, 1, 50, 12);
    const since = this.daysAgo(windowDays);

    const [events, articleLinks] = await Promise.all([
      this.prisma.newsEvent.findMany({
        where: {
          orgId: input.orgId,
          primaryEntity: entity.canonicalName,
          lastAt: { gte: since },
        },
        orderBy: [{ lastAt: "desc" }, { updatedAt: "desc" }],
        take: eventsLimit,
        include: {
          _count: {
            select: { items: true },
          },
        },
      }),
      this.prisma.articleEntityLink.findMany({
        where: {
          orgId: input.orgId,
          entityId: entity.id,
          createdAt: { gte: since },
        },
        orderBy: { createdAt: "desc" },
        take: evidenceLimit,
        include: {
          article: {
            include: {
              processed: true,
            },
          },
        },
      }),
    ]);

    return {
      restricted: false,
      events: events.map((event) => ({
        id: event.id,
        status: event.status,
        title: event.title,
        summary: event.summary,
        primaryTopic: event.primaryTopic,
        primaryEntity: event.primaryEntity,
        startAt: event.startAt,
        lastAt: event.lastAt,
        itemCount: event._count.items,
      })),
      articles: articleLinks.map((link) => ({
        article: {
          id: link.articleId,
          url: link.article.url,
          sourceLabel: link.article.sourceLabel,
          title: link.article.processed?.title ?? link.article.titleGuess ?? null,
          summary: link.article.processed?.summary ?? null,
          language: link.article.processed?.language ?? link.article.language ?? null,
          crawlAt: link.article.crawlAt,
        },
        mention: link.mention ?? null,
        confidence: link.confidence ?? null,
        linkedAt: link.createdAt,
      })),
      generatedAt: new Date(),
    };
  }

  private async loadAliases(orgId: string, entityId: string, canonicalName: string) {
    const rows = await this.prisma.knowledgeEntityAlias.findMany({
      where: { orgId, entityId },
      orderBy: { createdAt: "asc" },
      select: { alias: true },
    });
    const aliases = new Set<string>();
    for (const row of rows) {
      const alias = row.alias.trim();
      if (alias && alias !== canonicalName) {
        aliases.add(alias);
      }
    }
    return Array.from(aliases);
  }

  private loadRelationships(orgId: string, entityId: string, take: number) {
    return this.prisma.knowledgeEdge.findMany({
      where: {
        orgId,
        OR: [{ fromEntityId: entityId }, { toEntityId: entityId }],
      },
      orderBy: [{ weight: "desc" }, { confidence: "desc" }, { updatedAt: "desc" }],
      take,
      include: {
        fromEntity: true,
        toEntity: true,
        evidences: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { createdAt: true },
        },
        _count: {
          select: { evidences: true },
        },
      },
    });
  }

  private async loadSentimentSeries(
    orgId: string,
    entity: KnowledgeEntity,
    since: Date
  ) {
    const exactRows = await this.prisma.entitySentimentSnapshot.findMany({
      where: {
        orgId,
        entityName: entity.canonicalName,
        entityType: entity.type,
        bucketStart: { gte: since },
      },
      orderBy: { bucketStart: "asc" },
    });
    if (exactRows.length > 0) {
      return exactRows;
    }
    const fallbackRows = await this.prisma.entitySentimentSnapshot.findMany({
      where: {
        orgId,
        entityName: entity.canonicalName,
        entityType: "",
        bucketStart: { gte: since },
      },
      orderBy: { bucketStart: "asc" },
    });
    if (fallbackRows.length === 0) {
      return fallbackRows;
    }
    // The legacy "" rows are ambiguous: another entity with the same name but
    // a different type may own them. Only fall back when this name has NO
    // other non-empty type snapshots — otherwise sentiment from a homonym
    // (company "长城" vs sector "长城") would leak onto the card.
    const otherTypedCount = await this.prisma.entitySentimentSnapshot.count({
      where: {
        orgId,
        entityName: entity.canonicalName,
        entityType: { notIn: ["", entity.type] },
      },
    });
    return otherTypedCount > 0 ? [] : fallbackRows;
  }

  private computeSentimentTotals(
    rows: EntityIntelligenceCardResult["sentimentSeries"]
  ) {
    const totalDocs = rows.reduce((sum, row) => sum + row.totalDocs, 0);
    if (totalDocs <= 0) {
      return { avgSentiment: null, negativeRatio: null };
    }
    const scoreSum = rows.reduce((sum, row) => sum + row.scoreSum, 0);
    const negativeDocs = rows.reduce((sum, row) => sum + row.negativeDocs, 0);
    return {
      avgSentiment: scoreSum / totalDocs,
      negativeRatio: negativeDocs / totalDocs,
    };
  }

  private normalizeEntityType(value: string | null | undefined) {
    if (!value) {
      return undefined;
    }
    const normalized = value.trim().toLowerCase();
    const allowed = new Set(Object.values(KnowledgeEntityType));
    return allowed.has(normalized as KnowledgeEntityType)
      ? (normalized as KnowledgeEntityType)
      : undefined;
  }

  private clampInteger(
    value: number | null | undefined,
    minimum: number,
    maximum: number,
    fallback: number
  ) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return fallback;
    }
    return Math.min(maximum, Math.max(minimum, Math.round(value)));
  }

  private daysAgo(days: number) {
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  }
}
