import { ProcessedItemModel } from "@modular/mongo";
import { createLogger } from "@modular/utils";
import { Injectable, Optional } from "@nestjs/common";
import {
  NewsEventAssignmentMethod,
  NewsEventStatus,
  Prisma,
} from "@prisma/client";

import { PrismaService } from "../config/prisma.service";
import type { NewsSignal, NewsSignalEntity } from "../news-signals/news-signal";
import { VectorClientService } from "../vector/vector-client.service";

import type { NewsEventSettings } from "./news-events-settings.service";
import { NewsEventSourcePolicyService } from "./news-event-source-policy.service";
import {
  classifySourceByLabelAndUrl,
  createSourcePolicyMatcher,
  getDefaultNewsEventSourcePolicy,
  resolveSourceKey,
} from "./news-event-source-classifier";

const logger = createLogger({ name: "news-events" });

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_VECTOR_SEARCH_LIMIT = 50;
const DEFAULT_CANDIDATE_EVENTS_LIMIT = 30;

export type NewsEventSourceClassification =
  | "authoritative"
  | "mixed"
  | "blog"
  | "unknown";

export interface NewsEventAuthorityProfile {
  sourceType: NewsEventSourceClassification;
  credibilityScore: number;
  uniqueSourceCount: number;
  authoritativeSourceCount: number;
  blogSourceCount: number;
  corroborated: boolean;
}

export interface NewsEventReferencedArticle {
  id: string;
  url: string;
  sourceLabel: string | null;
  crawlAt: Date;
  title: string | null;
  publishedAt: Date | null;
  processedAt: Date;
  processedArticleId: string;
}

@Injectable()
export class NewsEventsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly vectorClient: VectorClientService,
    @Optional()
    private readonly sourcePolicyService?: NewsEventSourcePolicyService,
  ) {}

  async listEvents(
    orgId: string,
    options?: { limit?: number; windowDays?: number; status?: NewsEventStatus },
  ) {
    const limit = Math.min(Math.max(options?.limit ?? 20, 1), 300);
    const windowDays = Math.min(Math.max(options?.windowDays ?? 30, 1), 365);
    const since = new Date(Date.now() - windowDays * DAY_MS);

    return this.prisma.newsEvent.findMany({
      where: {
        orgId,
        ...(options?.status ? { status: options.status } : {}),
        lastAt: { gte: since },
      },
      orderBy: [{ lastAt: "desc" }, { startAt: "desc" }],
      take: limit,
      include: {
        _count: { select: { items: true } },
      },
    });
  }

  async getEvent(
    orgId: string,
    eventId: string,
    options?: { itemsLimit?: number; timelineLimit?: number },
  ) {
    const itemsLimit = Math.min(Math.max(options?.itemsLimit ?? 50, 1), 200);
    const timelineLimit = Math.min(
      Math.max(options?.timelineLimit ?? 200, 1),
      2000,
    );

    return this.prisma.newsEvent.findFirst({
      where: { orgId, id: eventId },
      include: {
        _count: { select: { items: true } },
        items: {
          orderBy: [{ createdAt: "desc" }],
          take: itemsLimit,
          include: {
            processedArticle: {
              include: {
                article: {
                  select: {
                    id: true,
                    url: true,
                    sourceLabel: true,
                    crawlAt: true,
                  },
                },
              },
            },
          },
        },
        timeline: {
          orderBy: [{ bucketStart: "asc" }],
          take: timelineLimit,
        },
      },
    });
  }

  async listEventReferencedArticles(
    orgId: string,
    eventId: string,
    articleIds: string[],
    options?: { limit?: number },
  ): Promise<NewsEventReferencedArticle[]> {
    const normalizedArticleIds = Array.from(
      new Set(
        articleIds
          .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
          .filter((entry) => entry.length > 0),
      ),
    ).slice(0, 600);

    if (normalizedArticleIds.length === 0) {
      return [];
    }

    const limit = Math.min(Math.max(options?.limit ?? 300, 1), 2000);
    const rows = await this.prisma.processedArticle.findMany({
      where: {
        articleId: { in: normalizedArticleIds },
        newsEventItems: {
          some: {
            orgId,
            eventId,
          },
        },
      },
      orderBy: [{ processedAt: "desc" }],
      take: limit,
      include: {
        article: {
          select: {
            id: true,
            url: true,
            sourceLabel: true,
            crawlAt: true,
          },
        },
      },
    });

    const dedupedByArticleId = new Map<string, NewsEventReferencedArticle>();
    for (const row of rows) {
      if (!row.article?.id || dedupedByArticleId.has(row.article.id)) {
        continue;
      }
      dedupedByArticleId.set(row.article.id, {
        id: row.article.id,
        url: row.article.url,
        sourceLabel: row.article.sourceLabel ?? null,
        crawlAt: row.article.crawlAt,
        title: row.title ?? null,
        publishedAt: row.publishedAt ?? null,
        processedAt: row.processedAt,
        processedArticleId: row.id,
      });
    }

    return Array.from(dedupedByArticleId.values());
  }

  async getEventAuthorityMap(
    orgId: string,
    eventIds: string[],
    options?: { windowDays?: number },
  ): Promise<Map<string, NewsEventAuthorityProfile>> {
    if (eventIds.length === 0) {
      return new Map();
    }
    const windowDays = Math.min(Math.max(options?.windowDays ?? 45, 1), 365);
    const since = new Date(Date.now() - windowDays * DAY_MS);
    const sourcePolicy = await this.resolveSourcePolicy(orgId);
    const sourcePolicyMatcher = createSourcePolicyMatcher(sourcePolicy);

    const rows = await this.prisma.newsEventItem.findMany({
      where: {
        orgId,
        eventId: { in: eventIds },
        createdAt: { gte: since },
      },
      select: {
        eventId: true,
        processedArticle: {
          select: {
            article: {
              select: {
                url: true,
                sourceLabel: true,
              },
            },
          },
        },
      },
    });

    const aggregateByEventId = new Map<
      string,
      {
        sourceKeys: Set<string>;
        authoritativeSources: Set<string>;
        blogSources: Set<string>;
        authoritativeItems: number;
        blogItems: number;
        totalItems: number;
      }
    >();

    for (const eventId of eventIds) {
      aggregateByEventId.set(eventId, {
        sourceKeys: new Set<string>(),
        authoritativeSources: new Set<string>(),
        blogSources: new Set<string>(),
        authoritativeItems: 0,
        blogItems: 0,
        totalItems: 0,
      });
    }

    for (const row of rows) {
      const aggregate = aggregateByEventId.get(row.eventId);
      if (!aggregate) {
        continue;
      }
      const article = row.processedArticle.article;
      const sourceKey = resolveSourceKey(
        article?.sourceLabel,
        article?.url,
      ).toLowerCase();
      if (sourceKey && sourceKey !== "unknown") {
        aggregate.sourceKeys.add(sourceKey);
      }

      const classifiedSource = classifySourceByLabelAndUrl(
        article?.sourceLabel,
        article?.url,
        sourcePolicyMatcher,
      );
      aggregate.totalItems += 1;
      if (classifiedSource === "authoritative") {
        aggregate.authoritativeItems += 1;
        if (sourceKey && sourceKey !== "unknown") {
          aggregate.authoritativeSources.add(sourceKey);
        }
      } else if (classifiedSource === "blog") {
        aggregate.blogItems += 1;
        if (sourceKey && sourceKey !== "unknown") {
          aggregate.blogSources.add(sourceKey);
        }
      }
    }

    const result = new Map<string, NewsEventAuthorityProfile>();
    for (const eventId of eventIds) {
      const aggregate = aggregateByEventId.get(eventId);
      if (!aggregate) {
        result.set(eventId, {
          sourceType: "unknown",
          credibilityScore: 0,
          uniqueSourceCount: 0,
          authoritativeSourceCount: 0,
          blogSourceCount: 0,
          corroborated: false,
        });
        continue;
      }

      const uniqueSourceCount = aggregate.sourceKeys.size;
      const authoritativeSourceCount = aggregate.authoritativeSources.size;
      const blogSourceCount = aggregate.blogSources.size;

      let sourceType: NewsEventSourceClassification = "unknown";
      if (authoritativeSourceCount > 0 && blogSourceCount === 0) {
        sourceType = "authoritative";
      } else if (authoritativeSourceCount > 0 && blogSourceCount > 0) {
        sourceType = "mixed";
      } else if (authoritativeSourceCount === 0 && blogSourceCount > 0) {
        sourceType = "blog";
      }

      if (aggregate.totalItems <= 0 || uniqueSourceCount <= 0) {
        result.set(eventId, {
          sourceType,
          credibilityScore: 0,
          uniqueSourceCount,
          authoritativeSourceCount,
          blogSourceCount,
          corroborated: false,
        });
        continue;
      }

      const corroboration = this.clamp01(
        Math.log1p(uniqueSourceCount) / Math.log1p(6),
      );
      const authoritativeCoverage =
        uniqueSourceCount > 0
          ? authoritativeSourceCount / uniqueSourceCount
          : 0;
      const authoritativeItemShare =
        aggregate.totalItems > 0
          ? aggregate.authoritativeItems / aggregate.totalItems
          : 0;
      const crossVerification =
        authoritativeSourceCount >= 3
          ? 1
          : authoritativeSourceCount === 2
            ? 0.82
            : authoritativeSourceCount === 1
              ? 0.46
              : uniqueSourceCount >= 4
                ? 0.34
                : uniqueSourceCount >= 2
                  ? 0.2
                  : 0.05;
      const blogPenalty = Math.min(
        0.38,
        (blogSourceCount / Math.max(1, uniqueSourceCount)) * 0.38,
      );

      let credibility01 =
        0.44 * authoritativeCoverage +
        0.24 * corroboration +
        0.18 * authoritativeItemShare +
        0.14 * crossVerification -
        blogPenalty;
      credibility01 = this.clamp01(credibility01);

      result.set(eventId, {
        sourceType,
        credibilityScore: Math.round(credibility01 * 10_000) / 100,
        uniqueSourceCount,
        authoritativeSourceCount,
        blogSourceCount,
        corroborated: authoritativeSourceCount >= 2,
      });
    }

    return result;
  }

  private async resolveSourcePolicy(orgId: string) {
    if (!this.sourcePolicyService) {
      return getDefaultNewsEventSourcePolicy();
    }
    try {
      return await this.sourcePolicyService.getPolicy(orgId);
    } catch (error) {
      logger.warn(
        { err: error, orgId },
        "Failed to resolve news source policy; falling back to default policy",
      );
      return getDefaultNewsEventSourcePolicy();
    }
  }

  async assignNewsSignalToEvent(
    orgId: string,
    signal: NewsSignal,
    settings: NewsEventSettings,
  ) {
    const existing = await this.prisma.newsEventItem.findUnique({
      where: {
        orgId_processedArticleId: {
          orgId,
          processedArticleId: signal.processedArticleId,
        },
      },
      select: { id: true, eventId: true },
    });
    if (existing) {
      return { eventId: existing.eventId, created: false };
    }

    const timestamp = signal.timestamp;
    const language = this.normalizeOptionalString(signal.language);
    const primaryTopic = this.pickPrimaryTopic(signal.topics);
    const primaryEntity = this.pickPrimaryEntity(signal.entities);

    const assignment = await this.pickEventForSignal(orgId, signal, settings, {
      timestamp,
      language,
      primaryTopic,
      primaryEntity,
    });

    return this.prisma.runInTransaction(async (tx) => {
      const eventId =
        assignment.eventId ??
        (
          await this.createEvent(tx, orgId, signal, settings, {
            timestamp,
            language,
            primaryTopic,
            primaryEntity,
          })
        ).id;

      try {
        await tx.newsEventItem.create({
          data: {
            orgId,
            eventId,
            processedArticleId: signal.processedArticleId,
            processedItemId: this.normalizeOptionalString(
              signal.processedItemId,
            ),
            similarity: assignment.similarity ?? null,
            assignedBy: assignment.method,
          },
        });
      } catch (error) {
        if (this.isUniqueConstraintError(error)) {
          return { eventId, created: false };
        }
        throw error;
      }

      if (assignment.eventId) {
        const current = await tx.newsEvent.findUnique({
          where: { id: eventId },
          select: { startAt: true, lastAt: true },
        });

        const startAt = current
          ? this.minDate(current.startAt, timestamp)
          : timestamp;
        const lastAt = current
          ? this.maxDate(current.lastAt, timestamp)
          : timestamp;

        await tx.newsEvent.update({
          where: { id: eventId },
          data: { startAt, lastAt },
        });
      }

      return { eventId, created: true };
    });
  }

  private async pickEventForSignal(
    orgId: string,
    signal: NewsSignal,
    settings: NewsEventSettings,
    derived: {
      timestamp: Date;
      language: string | null;
      primaryTopic: string | null;
      primaryEntity: string | null;
    },
  ): Promise<{
    eventId?: string;
    similarity?: number | null;
    method: NewsEventAssignmentMethod;
  }> {
    const vector = await this.tryResolveSummaryEmbedding(
      signal.processedItemId,
    );
    if (vector) {
      const matches = await this.vectorClient.searchBestEffort({
        orgId,
        embeddingModel: vector.model,
        vector: vector.embedding,
        limit: DEFAULT_VECTOR_SEARCH_LIMIT,
        minScore: settings.vectorMinScore,
        lookbackMs: settings.lookbackDays * DAY_MS,
      });

      const matchIds = (matches ?? [])
        .map((match) =>
          typeof match.processedItemId === "string"
            ? match.processedItemId
            : "",
        )
        .filter((id) => id.length > 0 && id !== signal.processedItemId);

      if (matchIds.length > 0) {
        const memberships = await this.prisma.newsEventItem.findMany({
          where: { orgId, processedItemId: { in: matchIds } },
          select: { eventId: true, processedItemId: true },
        });

        const membershipEntries = memberships
          .map((row) => {
            const processedItemId =
              typeof row.processedItemId === "string"
                ? row.processedItemId.trim()
                : "";
            if (!processedItemId) {
              return null;
            }
            return [processedItemId, row.eventId] as const;
          })
          .filter((entry): entry is readonly [string, string] =>
            Boolean(entry),
          );
        const membershipByProcessedItemId = new Map<string, string>(
          membershipEntries,
        );

        const scoreByEventId = new Map<string, number>();
        for (const match of matches ?? []) {
          const processedItemId =
            typeof match.processedItemId === "string"
              ? match.processedItemId
              : "";
          const score = typeof match.score === "number" ? match.score : null;
          const eventId = membershipByProcessedItemId.get(processedItemId);
          if (!eventId || score === null) {
            continue;
          }
          const existing = scoreByEventId.get(eventId);
          if (existing === undefined || score > existing) {
            scoreByEventId.set(eventId, score);
          }
        }

        if (scoreByEventId.size > 0) {
          const eventIds = Array.from(scoreByEventId.keys());
          const events = await this.prisma.newsEvent.findMany({
            where: {
              orgId,
              id: { in: eventIds },
              status: NewsEventStatus.active,
            },
            select: { id: true, language: true, startAt: true, lastAt: true },
          });
          const eventsById = new Map(events.map((event) => [event.id, event]));

          let best: { eventId: string; score: number } | null = null;
          for (const [eventId, rawScore] of scoreByEventId.entries()) {
            const event = eventsById.get(eventId);
            if (!event) {
              continue;
            }
            const adjusted = this.applyLanguagePenalty(
              rawScore,
              derived.language,
              event.language,
              settings,
            );
            if (!best || adjusted > best.score) {
              best = { eventId, score: adjusted };
            }
          }

          if (best && best.score >= settings.vectorMinScore) {
            return {
              eventId: best.eventId,
              similarity: best.score,
              method: NewsEventAssignmentMethod.vector,
            };
          }
        }
      }
    }

    const overlapCandidate = await this.pickEventByOverlap(
      orgId,
      derived,
      settings,
    );
    if (overlapCandidate) {
      return overlapCandidate;
    }

    return { method: NewsEventAssignmentMethod.overlap };
  }

  private async pickEventByOverlap(
    orgId: string,
    derived: {
      timestamp: Date;
      language: string | null;
      primaryTopic: string | null;
      primaryEntity: string | null;
    },
    settings: NewsEventSettings,
  ): Promise<{
    eventId?: string;
    similarity?: number | null;
    method: NewsEventAssignmentMethod;
  } | null> {
    const since = new Date(Date.now() - settings.lookbackDays * DAY_MS);
    const clauses: Prisma.NewsEventWhereInput[] = [];
    if (derived.primaryTopic) {
      clauses.push({ primaryTopic: derived.primaryTopic });
    }
    if (derived.primaryEntity) {
      clauses.push({ primaryEntity: derived.primaryEntity });
    }
    if (clauses.length === 0) {
      return null;
    }

    const candidates = await this.prisma.newsEvent.findMany({
      where: {
        orgId,
        status: NewsEventStatus.active,
        lastAt: { gte: since },
        OR: clauses,
      },
      orderBy: [{ lastAt: "desc" }, { startAt: "desc" }],
      take: DEFAULT_CANDIDATE_EVENTS_LIMIT,
    });

    let best: {
      id: string;
      score: number;
      startAt: Date;
      lastAt: Date;
    } | null = null;
    for (const candidate of candidates) {
      const topicMatch =
        Boolean(derived.primaryTopic) &&
        Boolean(candidate.primaryTopic) &&
        candidate.primaryTopic === derived.primaryTopic;
      const entityMatch =
        Boolean(derived.primaryEntity) &&
        Boolean(candidate.primaryEntity) &&
        candidate.primaryEntity === derived.primaryEntity;

      const matches = (topicMatch ? 1 : 0) + (entityMatch ? 1 : 0);
      if (matches <= 0) {
        continue;
      }

      let score = matches / 2;
      score = this.applyLanguagePenalty(
        score,
        derived.language,
        candidate.language,
        settings,
      );

      if (!best || score > best.score) {
        best = {
          id: candidate.id,
          score,
          startAt: candidate.startAt,
          lastAt: candidate.lastAt,
        };
      }
    }

    if (!best) {
      return null;
    }
    return {
      eventId: best.id,
      similarity: best.score,
      method: NewsEventAssignmentMethod.overlap,
    };
  }

  private async createEvent(
    tx: Prisma.TransactionClient,
    orgId: string,
    signal: NewsSignal,
    _settings: NewsEventSettings,
    derived: {
      timestamp: Date;
      language: string | null;
      primaryTopic: string | null;
      primaryEntity: string | null;
    },
  ) {
    return tx.newsEvent.create({
      data: {
        orgId,
        status: NewsEventStatus.active,
        language: derived.language,
        primaryTopic: derived.primaryTopic,
        primaryEntity: derived.primaryEntity,
        title: signal.title,
        summary: signal.summary,
        startAt: derived.timestamp,
        lastAt: derived.timestamp,
        representativeProcessedArticleId: signal.processedArticleId,
        representativeProcessedItemId: this.normalizeOptionalString(
          signal.processedItemId,
        ),
      },
    });
  }

  private pickPrimaryTopic(topics: string[]): string | null {
    for (const topic of topics) {
      const normalized = this.normalizeOptionalString(topic);
      if (normalized) {
        return normalized;
      }
    }
    return null;
  }

  private pickPrimaryEntity(entities: NewsSignalEntity[]): string | null {
    let fallback: string | null = null;
    let best: { name: string; confidence: number } | null = null;

    for (const entity of entities) {
      const normalizedName = this.normalizeOptionalString(entity.name);
      if (!normalizedName) {
        continue;
      }

      if (!fallback) {
        fallback = normalizedName;
      }

      const confidence = entity.confidence;
      if (confidence === null || !Number.isFinite(confidence)) {
        continue;
      }

      if (!best || confidence > best.confidence) {
        best = { name: normalizedName, confidence };
      }
    }

    return best?.name ?? fallback;
  }

  private normalizeOptionalString(value: unknown): string | null {
    if (typeof value !== "string") {
      return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private async tryResolveSummaryEmbedding(processedItemId: string | null) {
    const normalized = this.normalizeOptionalString(processedItemId);
    if (!normalized) {
      return null;
    }
    try {
      const doc = await ProcessedItemModel.findById(normalized)
        .select({ summaryEmbedding: 1, summaryEmbeddingModel: 1 })
        .lean()
        .exec();
      const embedding = (doc as unknown as { summaryEmbedding?: unknown })
        ?.summaryEmbedding;
      const model = (doc as unknown as { summaryEmbeddingModel?: unknown })
        ?.summaryEmbeddingModel;
      if (!Array.isArray(embedding) || embedding.length === 0) {
        return null;
      }
      const numeric = embedding.filter(
        (v) => typeof v === "number" && Number.isFinite(v),
      ) as number[];
      if (numeric.length !== embedding.length) {
        return null;
      }
      const embeddingModel = typeof model === "string" ? model.trim() : "";
      if (!embeddingModel) {
        return null;
      }
      return { embedding: numeric, model: embeddingModel };
    } catch (error) {
      logger.warn(
        { error, processedItemId: normalized },
        "Failed to load summary embedding from Mongo",
      );
      return null;
    }
  }

  private applyLanguagePenalty(
    score: number,
    signalLanguage: string | null,
    eventLanguage: string | null,
    settings: NewsEventSettings,
  ) {
    if (!signalLanguage || !eventLanguage || signalLanguage === eventLanguage) {
      return score;
    }
    const penalty = Math.min(Math.max(settings.crossLanguagePenalty, 0), 1);
    return score * (1 - penalty);
  }

  private isUniqueConstraintError(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    );
  }

  private minDate(a: Date, b: Date) {
    return a.getTime() <= b.getTime() ? a : b;
  }

  private maxDate(a: Date, b: Date) {
    return a.getTime() >= b.getTime() ? a : b;
  }

  private clamp01(value: number): number {
    if (!Number.isFinite(value)) {
      return 0;
    }
    return Math.max(0, Math.min(1, value));
  }

  /**
   * Calculate heat map for a batch of events.
   * Returns breaking flag and heat score for each event.
   */
  async getEventHeatMap(
    orgId: string,
    eventIds: string[],
  ): Promise<Map<string, { breaking: boolean; heatScore: number }>> {
    if (eventIds.length === 0) {
      return new Map();
    }

    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const fourHoursAgo = new Date(now.getTime() - 4 * 60 * 60 * 1000);

    const [events, recentItems] = await Promise.all([
      this.prisma.newsEvent.findMany({
        where: {
          orgId,
          id: { in: eventIds },
        },
        select: {
          id: true,
          lastAt: true,
        },
      }),
      this.prisma.newsEventItem.findMany({
        where: {
          orgId,
          eventId: { in: eventIds },
          createdAt: { gte: fourHoursAgo },
        },
        select: {
          eventId: true,
          createdAt: true,
          processedArticle: {
            select: {
              article: {
                select: {
                  sourceId: true,
                },
              },
            },
          },
        },
      }),
    ]);

    const eventLastAtById = new Map(
      events.map((event) => [event.id, event.lastAt]),
    );
    const aggregateByEventId = new Map<
      string,
      { itemsLast1h: number; itemsLast4h: number; sourceIds: Set<string> }
    >();

    for (const eventId of eventIds) {
      aggregateByEventId.set(eventId, {
        itemsLast1h: 0,
        itemsLast4h: 0,
        sourceIds: new Set<string>(),
      });
    }

    for (const item of recentItems) {
      const aggregate = aggregateByEventId.get(item.eventId);
      if (!aggregate) {
        continue;
      }

      aggregate.itemsLast4h += 1;
      if (item.createdAt >= oneHourAgo) {
        aggregate.itemsLast1h += 1;
      }

      const sourceId = item.processedArticle.article.sourceId;
      if (typeof sourceId === "string" && sourceId.trim()) {
        aggregate.sourceIds.add(sourceId);
      }
    }

    const result = new Map<string, { breaking: boolean; heatScore: number }>();

    for (const eventId of eventIds) {
      const aggregate = aggregateByEventId.get(eventId);
      const lastAt = eventLastAtById.get(eventId);
      if (!aggregate || !lastAt || aggregate.itemsLast4h <= 0) {
        result.set(eventId, { breaking: false, heatScore: 0 });
        continue;
      }

      const itemsLast1h = aggregate.itemsLast1h;
      const itemsLast4h = aggregate.itemsLast4h;
      const uniqueSourcesLast4h = aggregate.sourceIds.size;

      // Calculate recency (hours since last update)
      const recencyHours =
        (now.getTime() - lastAt.getTime()) / (60 * 60 * 1000);
      const recency = Math.exp(-recencyHours / 6); // 6-hour half-life

      // Calculate heat score
      // Formula: recency * (log1p(n) + 1.5*log1p(v) + 0.75*log1p(d))
      const n = itemsLast4h;
      const v = itemsLast1h;
      const d = uniqueSourcesLast4h;

      const heatScore =
        recency * (Math.log1p(n) + 1.5 * Math.log1p(v) + 0.75 * Math.log1p(d));

      // Breaking criteria:
      // - Recent (within 4 hours)
      // - Fast growth + diversity OR high volume + diversity OR high heat score
      const isRecent = recencyHours <= 4;
      const hasFastGrowth = v >= 2 && d >= 2;
      const hasHighVolume = n >= 5 && d >= 3;
      const hasHighHeat = heatScore >= 1.6;

      const breaking =
        isRecent && (hasFastGrowth || hasHighVolume || hasHighHeat);

      result.set(eventId, {
        breaking,
        heatScore: Math.round(heatScore * 100) / 100,
      });
    }

    return result;
  }
}
