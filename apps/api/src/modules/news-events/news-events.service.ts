import { ProcessedItemModel, TaskLogModel } from "@modular/mongo";
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

import { NewsEventSourcePolicyService } from "./news-event-source-policy.service";
import {
  classifySourceByLabelAndUrl,
  createSourcePolicyMatcher,
  getDefaultNewsEventSourcePolicy,
  resolveSourceKey,
} from "./news-event-source-classifier";
import {
  NewsEventsSettingsService,
  type NewsEventSettings,
} from "./news-events-settings.service";

const logger = createLogger({ name: "news-events" });

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_VECTOR_SEARCH_LIMIT = 50;
const DEFAULT_CANDIDATE_EVENTS_LIMIT = 30;
const DEFAULT_CATEGORY_DISTRIBUTION_WINDOW_DAYS = 90;
const MAX_CATEGORY_DISTRIBUTION_WINDOW_DAYS = 365;
const CATEGORY_DISTRIBUTION_CACHE_TTL_MS = 2 * 60 * 1000;
const PROCESSED_ITEM_CLASSIFICATION_CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_PRUNE_INTERVAL_MS = 60 * 1000;
const MAX_CATEGORY_DISTRIBUTION_ITEMS = 16;

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

export interface NewsEventCategoryDistributionEntry {
  categoryPath: string;
  legacyCategory: string | null;
  count: number;
  share: number;
}

interface ProcessedItemCategoryClassification {
  legacyCategory: string | null;
  categoryPath: string | null;
  confidence: number | null;
}

@Injectable()
export class NewsEventsService {
  private readonly eventCategoryDistributionCache = new Map<
    string,
    {
      expiresAt: number;
      value: Map<string, NewsEventCategoryDistributionEntry[]>;
    }
  >();
  private readonly processedItemCategoryCache = new Map<
    string,
    { expiresAt: number; value: ProcessedItemCategoryClassification | null }
  >();
  private eventCategoryDistributionCacheLastPruneAt = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly vectorClient: VectorClientService,
    @Optional()
    private readonly sourcePolicyService?: NewsEventSourcePolicyService,
    @Optional()
    private readonly settingsService?: NewsEventsSettingsService,
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
    const timelineSince = await this.resolveTimelineSince(orgId);

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
          ...(timelineSince
            ? { where: { bucketStart: { gte: timelineSince } } }
            : {}),
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

  async getEventCategoryDistributionMap(
    orgId: string,
    eventIds: string[],
    options?: { windowDays?: number },
  ): Promise<Map<string, NewsEventCategoryDistributionEntry[]>> {
    const normalizedEventIds = Array.from(
      new Set(
        eventIds
          .map((entry) => this.normalizeOptionalString(entry))
          .filter((entry): entry is string => Boolean(entry)),
      ),
    );
    if (normalizedEventIds.length === 0) {
      return new Map();
    }

    const windowDays = Math.min(
      Math.max(
        options?.windowDays ?? DEFAULT_CATEGORY_DISTRIBUTION_WINDOW_DAYS,
        1,
      ),
      MAX_CATEGORY_DISTRIBUTION_WINDOW_DAYS,
    );
    const cacheKey = `${orgId}:${windowDays}:${normalizedEventIds
      .slice()
      .sort()
      .join(",")}`;
    const now = Date.now();
    this.pruneExpiredEventCategoryDistributionCache(now);
    const cached = this.eventCategoryDistributionCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return this.cloneCategoryDistributionMap(cached.value);
    }
    if (cached) {
      this.eventCategoryDistributionCache.delete(cacheKey);
    }

    const since = new Date(Date.now() - windowDays * DAY_MS);
    const rows = await this.prisma.newsEventItem.findMany({
      where: {
        orgId,
        eventId: { in: normalizedEventIds },
        processedArticle: {
          processedAt: { gte: since },
        },
      },
      select: {
        eventId: true,
        processedItemId: true,
        processedArticle: {
          select: {
            category: true,
          },
        },
      },
    });

    const processedItemIds = Array.from(
      new Set(
        rows
          .map((row) => this.normalizeOptionalString(row.processedItemId))
          .filter((entry): entry is string => Boolean(entry)),
      ),
    );
    const classificationByProcessedItemId =
      await this.loadProcessedItemCategoryClassification(processedItemIds);

    const countsByEventId = new Map<string, Map<string, number>>();
    for (const eventId of normalizedEventIds) {
      countsByEventId.set(eventId, new Map<string, number>());
    }

    for (const row of rows) {
      const eventAggregate = countsByEventId.get(row.eventId);
      if (!eventAggregate) {
        continue;
      }
      const processedItemId = this.normalizeOptionalString(row.processedItemId);
      const classification = processedItemId
        ? classificationByProcessedItemId.get(processedItemId) ?? null
        : null;
      const legacyCategory =
        this.normalizeLegacyCategory(classification?.legacyCategory) ??
        this.normalizeLegacyCategory(row.processedArticle.category);
      const categoryPath =
        this.normalizeCategoryPath(classification?.categoryPath) ??
        legacyCategory ??
        "uncategorized";
      eventAggregate.set(
        categoryPath,
        (eventAggregate.get(categoryPath) ?? 0) + 1,
      );
    }

    const result = new Map<string, NewsEventCategoryDistributionEntry[]>();
    for (const eventId of normalizedEventIds) {
      const aggregate = countsByEventId.get(eventId);
      if (!aggregate || aggregate.size === 0) {
        result.set(eventId, []);
        continue;
      }
      const total = Array.from(aggregate.values()).reduce(
        (sum, count) => sum + count,
        0,
      );
      if (total <= 0) {
        result.set(eventId, []);
        continue;
      }
      const entries = Array.from(aggregate.entries())
        .map(([categoryPath, count]) => ({
          categoryPath,
          legacyCategory: this.normalizeLegacyCategory(
            categoryPath.split("/")[0] ?? null,
          ),
          count,
          share: Math.round((count / total) * 10_000) / 10_000,
        }))
        .sort((a, b) => b.count - a.count || a.categoryPath.localeCompare(b.categoryPath))
        .slice(0, MAX_CATEGORY_DISTRIBUTION_ITEMS);
      result.set(eventId, entries);
    }

    this.eventCategoryDistributionCache.set(cacheKey, {
      expiresAt: now + CATEGORY_DISTRIBUTION_CACHE_TTL_MS,
      value: this.cloneCategoryDistributionMap(result),
    });
    return result;
  }

  private async resolveTimelineSince(orgId: string): Promise<Date | null> {
    if (!this.settingsService) {
      return null;
    }
    try {
      const settings = await this.settingsService.getSettings(orgId);
      const windowDays = Math.max(settings.backfillDays, settings.lookbackDays);
      return new Date(Date.now() - windowDays * DAY_MS);
    } catch (error) {
      logger.warn(
        { err: error, orgId },
        "Failed to resolve timeline window from settings; returning full timeline",
      );
      return null;
    }
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
            select: {
              id: true,
              language: true,
              startAt: true,
              lastAt: true,
              metadata: true,
            },
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
            const categoryAdjusted = await this.applyCategoryGate(
              orgId,
              adjusted,
              signal,
              event.metadata,
              settings,
            );
            if (categoryAdjusted === null) {
              continue;
            }
            if (!best || categoryAdjusted > best.score) {
              best = { eventId, score: categoryAdjusted };
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
      signal,
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
    signal: NewsSignal,
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
      const categoryAdjusted = await this.applyCategoryGate(
        orgId,
        score,
        signal,
        candidate.metadata,
        settings,
      );
      if (categoryAdjusted === null) {
        continue;
      }
      score = categoryAdjusted;

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
    const classificationMetadata = this.buildClassificationMetadata(signal);
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
        metadata: classificationMetadata
          ? ({ classification: classificationMetadata } as Prisma.InputJsonValue)
          : undefined,
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

  private async applyCategoryGate(
    orgId: string,
    score: number,
    signal: NewsSignal,
    eventMetadata: Prisma.JsonValue | null,
    settings: NewsEventSettings,
  ): Promise<number | null> {
    if (!settings.classificationGateEnabled) {
      await this.logCategoryGateDecision(orgId, signal, "skipped_disabled", {
        score,
      });
      return score;
    }

    const signalCategory = this.normalizeLegacyCategory(signal.legacyCategory);
    const signalConfidence =
      typeof signal.categoryConfidence === "number" &&
      Number.isFinite(signal.categoryConfidence)
        ? Math.max(0, Math.min(1, signal.categoryConfidence))
        : null;
    if (!signalCategory) {
      await this.logCategoryGateDecision(orgId, signal, "skipped_no_signal_category", {
        score,
      });
      return score;
    }
    if (
      signalConfidence === null ||
      signalConfidence < settings.minCategoryConfidenceForGate
    ) {
      await this.logCategoryGateDecision(
        orgId,
        signal,
        "skipped_low_signal_confidence",
        {
          score,
          signalConfidence,
          minCategoryConfidenceForGate: settings.minCategoryConfidenceForGate,
        },
      );
      return score;
    }

    const eventClassification = this.extractEventClassification(eventMetadata);
    if (!eventClassification.legacyCategory) {
      await this.logCategoryGateDecision(orgId, signal, "skipped_no_event_category", {
        score,
        signalCategory,
      });
      return score;
    }
    if (eventClassification.legacyCategory !== signalCategory) {
      if (settings.categoryConflictReject) {
        await this.logCategoryGateDecision(orgId, signal, "reject", {
          score,
          signalCategory,
          eventCategory: eventClassification.legacyCategory,
        });
        return null;
      }
      const adjusted = score * (1 - this.clamp01(settings.categorySoftPenalty));
      await this.logCategoryGateDecision(orgId, signal, "penalized", {
        score,
        adjustedScore: adjusted,
        signalCategory,
        eventCategory: eventClassification.legacyCategory,
      });
      return adjusted;
    }

    const signalPath = this.normalizeCategoryPath(signal.categoryPath);
    const eventPath = this.normalizeCategoryPath(eventClassification.categoryPath);
    if (!signalPath || !eventPath || signalPath === eventPath) {
      await this.logCategoryGateDecision(orgId, signal, "accepted", {
        score,
        signalCategory,
        signalPath,
        eventPath,
      });
      return score;
    }

    const adjusted = score * (1 - this.clamp01(settings.categorySoftPenalty * 0.5));
    await this.logCategoryGateDecision(orgId, signal, "penalized", {
      score,
      adjustedScore: adjusted,
      signalCategory,
      signalPath,
      eventPath,
    });
    return adjusted;
  }

  private async logCategoryGateDecision(
    orgId: string,
    signal: NewsSignal,
    decision:
      | "accepted"
      | "penalized"
      | "reject"
      | "skipped_disabled"
      | "skipped_no_signal_category"
      | "skipped_low_signal_confidence"
      | "skipped_no_event_category",
    data: Record<string, unknown>,
  ) {
    try {
      await TaskLogModel.create({
        queue: "news_events",
        jobId: signal.processedArticleId,
        orgId,
        stage: "category_gate",
        status: "completed",
        data: {
          decision,
          processedItemId: signal.processedItemId,
          processedArticleId: signal.processedArticleId,
          signalCategory: signal.legacyCategory ?? null,
          signalCategoryPath: signal.categoryPath ?? null,
          signalConfidence:
            typeof signal.categoryConfidence === "number"
              ? signal.categoryConfidence
              : null,
          ...data,
        },
      });
    } catch (error) {
      logger.warn(
        { err: error, orgId, processedArticleId: signal.processedArticleId, decision },
        "Failed to persist category gate task log",
      );
    }
  }

  private extractEventClassification(metadata: Prisma.JsonValue | null): {
    legacyCategory: string | null;
    categoryPath: string | null;
    confidence: number | null;
  } {
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      return { legacyCategory: null, categoryPath: null, confidence: null };
    }
    const record = metadata as Record<string, unknown>;
    const classification =
      record.classification &&
      typeof record.classification === "object" &&
      !Array.isArray(record.classification)
        ? (record.classification as Record<string, unknown>)
        : null;
    if (!classification) {
      return { legacyCategory: null, categoryPath: null, confidence: null };
    }
    const rawConfidence =
      typeof classification.confidence === "number"
        ? classification.confidence
        : null;
    return {
      legacyCategory: this.normalizeLegacyCategory(
        classification.legacyCategory,
      ),
      categoryPath: this.normalizeCategoryPath(classification.categoryPath),
      confidence:
        rawConfidence !== null && Number.isFinite(rawConfidence)
          ? Math.max(0, Math.min(1, rawConfidence))
          : null,
    };
  }

  private buildClassificationMetadata(signal: NewsSignal): {
    legacyCategory: string;
    categoryPath?: string | null;
    confidence?: number | null;
  } | null {
    const legacyCategory = this.normalizeLegacyCategory(signal.legacyCategory);
    if (!legacyCategory) {
      return null;
    }
    const categoryPath = this.normalizeCategoryPath(signal.categoryPath);
    const confidence =
      typeof signal.categoryConfidence === "number" &&
      Number.isFinite(signal.categoryConfidence)
        ? Math.max(0, Math.min(1, signal.categoryConfidence))
        : null;

    return {
      legacyCategory,
      ...(categoryPath ? { categoryPath } : {}),
      ...(confidence !== null ? { confidence } : {}),
    };
  }

  private normalizeLegacyCategory(value: unknown): string | null {
    if (typeof value !== "string") {
      return null;
    }
    const normalized = value.trim().toLowerCase();
    if (!normalized) {
      return null;
    }
    return new Set(["politics", "tech", "finance", "gov", "ai", "intel"]).has(
      normalized,
    )
      ? normalized
      : null;
  }

  private normalizeCategoryPath(value: unknown): string | null {
    if (typeof value !== "string") {
      return null;
    }
    const normalized = value
      .trim()
      .toLowerCase()
      .replace(/\\/g, "/")
      .replace(/\s+/g, "-")
      .replace(/\/+/g, "/")
      .replace(/^\/+|\/+$/g, "");
    return normalized || null;
  }

  private cloneCategoryDistributionMap(
    input: Map<string, NewsEventCategoryDistributionEntry[]>,
  ): Map<string, NewsEventCategoryDistributionEntry[]> {
    return new Map(
      Array.from(input.entries()).map(([eventId, entries]) => [
        eventId,
        entries.map((entry) => ({ ...entry })),
      ]),
    );
  }

  private pruneExpiredEventCategoryDistributionCache(now: number): void {
    if (now - this.eventCategoryDistributionCacheLastPruneAt < CACHE_PRUNE_INTERVAL_MS) {
      return;
    }
    for (const [key, entry] of this.eventCategoryDistributionCache.entries()) {
      if (entry.expiresAt <= now) {
        this.eventCategoryDistributionCache.delete(key);
      }
    }
    this.eventCategoryDistributionCacheLastPruneAt = now;
  }

  private async loadProcessedItemCategoryClassification(
    processedItemIds: string[],
  ): Promise<Map<string, ProcessedItemCategoryClassification | null>> {
    const result = new Map<string, ProcessedItemCategoryClassification | null>();
    if (processedItemIds.length === 0) {
      return result;
    }

    const now = Date.now();
    const pendingIds: string[] = [];
    for (const id of processedItemIds) {
      const cached = this.processedItemCategoryCache.get(id);
      if (cached && cached.expiresAt > now) {
        result.set(id, cached.value);
        continue;
      }
      if (cached) {
        this.processedItemCategoryCache.delete(id);
      }
      pendingIds.push(id);
    }

    if (pendingIds.length === 0) {
      return result;
    }

    try {
      const docs = await ProcessedItemModel.find({
        _id: { $in: pendingIds },
      })
        .select({ _id: 1, result: 1 })
        .lean()
        .exec();
      const found = new Set<string>();
      for (const doc of docs) {
        const id = String((doc as { _id?: unknown })._id ?? "").trim();
        if (!id) {
          continue;
        }
        found.add(id);
        const classification = this.extractProcessedItemCategoryClassification(
          (doc as { result?: unknown }).result,
        );
        result.set(id, classification);
        this.processedItemCategoryCache.set(id, {
          expiresAt: now + PROCESSED_ITEM_CLASSIFICATION_CACHE_TTL_MS,
          value: classification,
        });
      }

      for (const id of pendingIds) {
        if (found.has(id)) {
          continue;
        }
        result.set(id, null);
        this.processedItemCategoryCache.set(id, {
          expiresAt: now + PROCESSED_ITEM_CLASSIFICATION_CACHE_TTL_MS,
          value: null,
        });
      }
    } catch (error) {
      logger.warn(
        { err: error, ids: pendingIds.length },
        "Failed to load processed-item category classification for event distribution",
      );
    }

    return result;
  }

  private extractProcessedItemCategoryClassification(
    value: unknown,
  ): ProcessedItemCategoryClassification {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { legacyCategory: null, categoryPath: null, confidence: null };
    }
    const record = value as Record<string, unknown>;
    const rawConfidence =
      typeof record.category_confidence === "number"
        ? record.category_confidence
        : typeof record.categoryConfidence === "number"
          ? record.categoryConfidence
          : null;
    return {
      legacyCategory:
        this.normalizeLegacyCategory(record.category) ??
        this.normalizeLegacyCategory(record.legacy_category),
      categoryPath:
        this.normalizeCategoryPath(record.category_path) ??
        this.normalizeCategoryPath(record.categoryPath),
      confidence:
        typeof rawConfidence === "number" && Number.isFinite(rawConfidence)
          ? this.clamp01(rawConfidence)
          : null,
    };
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
