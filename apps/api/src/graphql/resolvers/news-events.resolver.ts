import { ForbiddenException, UseGuards } from "@nestjs/common";
import { Args, Context, Float, Int, Query, Resolver } from "@nestjs/graphql";
import { NewsEventStatus } from "@prisma/client";

import { GqlAuthGuard } from "../../common/guards/gql-auth.guard";
import { GqlPermissionsGuard } from "../../common/guards/gql-permissions.guard";
import type { AuthenticatedUser } from "../../modules/auth/auth.service";
import { NewsEventBriefService } from "../../modules/news-events/news-event-brief.service";
import {
  type NewsEventAuthorityProfile,
  type NewsEventSourceClassification,
  NewsEventsService
} from "../../modules/news-events/news-events.service";
import { HasPermission } from "../decorators/has-permission.decorator";
import type { GqlRequest } from "../graphql.types";
import { NewsEventBriefModel } from "../models/news-event-brief.model";
import {
  NewsEventModel,
  NewsEventSortBy,
  NewsEventSourceType,
  NewsEventItemModel,
  NewsEventTimelineEntryModel
} from "../models/news-events.model";

const EVENT_DEDUPE_WINDOW_MS = 5 * 24 * 60 * 60 * 1000;

interface EnrichedEvent {
  row: any;
  heat: { breaking: boolean; heatScore: number };
  authority: { credibilityScore: number; sourceType: NewsEventSourceType };
}

@Resolver(() => NewsEventModel)
@UseGuards(GqlAuthGuard, GqlPermissionsGuard)
export class NewsEventsResolver {
  constructor(
    private readonly events: NewsEventsService,
    private readonly briefs: NewsEventBriefService
  ) {}

  @HasPermission("items.read")
  @Query(() => [NewsEventModel])
  async newsEvents(
    @Context("req") req: GqlRequest,
    @Args("limit", { type: () => Int, nullable: true }) limit?: number,
    @Args("windowDays", { type: () => Int, nullable: true }) windowDays?: number,
    @Args("status", { type: () => NewsEventStatus, nullable: true }) status?: NewsEventStatus,
    @Args("sourceType", { type: () => NewsEventSourceType, nullable: true }) sourceType?: NewsEventSourceType,
    @Args("minHeatScore", { type: () => Float, nullable: true }) minHeatScore?: number,
    @Args("minCredibilityScore", { type: () => Float, nullable: true }) minCredibilityScore?: number,
    @Args("sortBy", { type: () => NewsEventSortBy, nullable: true }) sortBy?: NewsEventSortBy,
    @Args("dedupeSimilar", { nullable: true }) dedupeSimilar?: boolean
  ): Promise<NewsEventModel[]> {
    const user = this.requireUser(req);
    const requestedLimit = this.clampInt(limit ?? 20, 1, 100);
    const candidateLimit = Math.min(300, Math.max(requestedLimit, requestedLimit * 4));
    const rows = await this.events.listEvents(user.orgId, {
      limit: candidateLimit,
      windowDays,
      status
    });

    const eventIds = rows.map((row) => row.id);
    const [heatMap, authorityMap] = await Promise.all([
      this.events.getEventHeatMap(user.orgId, eventIds),
      this.events.getEventAuthorityMap(user.orgId, eventIds, { windowDays })
    ]);

    let enriched: EnrichedEvent[] = rows.map((row) => {
      const heat = heatMap.get(row.id) ?? { breaking: false, heatScore: 0 };
      const authority = this.toAuthorityScore(authorityMap.get(row.id));
      return { row, heat, authority };
    });

    const heatThreshold =
      typeof minHeatScore === "number" && Number.isFinite(minHeatScore)
        ? Math.max(0, minHeatScore)
        : null;
    const credibilityThreshold =
      typeof minCredibilityScore === "number" && Number.isFinite(minCredibilityScore)
        ? Math.max(0, Math.min(100, minCredibilityScore))
        : null;
    const effectiveSourceType = sourceType ?? NewsEventSourceType.all;

    if (effectiveSourceType !== NewsEventSourceType.all) {
      enriched = enriched.filter((entry) => entry.authority.sourceType === effectiveSourceType);
    }
    if (heatThreshold !== null) {
      enriched = enriched.filter((entry) => entry.heat.heatScore >= heatThreshold);
    }
    if (credibilityThreshold !== null) {
      enriched = enriched.filter((entry) => entry.authority.credibilityScore >= credibilityThreshold);
    }

    enriched = this.sortEvents(enriched, sortBy ?? NewsEventSortBy.latest);
    if (dedupeSimilar ?? true) {
      enriched = this.dedupeSimilarEvents(enriched);
    }

    return enriched.slice(0, requestedLimit).map((entry) => {
      const { row, heat, authority } = entry;
      return this.toModel(row, undefined, {
        breaking: heat.breaking,
        heatScore: heat.heatScore,
        credibilityScore: authority.credibilityScore,
        sourceType: authority.sourceType
      });
    });
  }

  @HasPermission("items.read")
  @Query(() => NewsEventModel, { nullable: true })
  async newsEvent(
    @Context("req") req: GqlRequest,
    @Args("id") id: string,
    @Args("itemsLimit", { type: () => Int, nullable: true }) itemsLimit?: number,
    @Args("timelineLimit", { type: () => Int, nullable: true }) timelineLimit?: number
  ): Promise<NewsEventModel | null> {
    const user = this.requireUser(req);
    const row = await this.events.getEvent(user.orgId, id, { itemsLimit, timelineLimit });
    if (!row) {
      return null;
    }

    const [heatMap, authorityMap] = await Promise.all([
      this.events.getEventHeatMap(user.orgId, [id]),
      this.events.getEventAuthorityMap(user.orgId, [id])
    ]);
    const heat = heatMap.get(id) ?? { breaking: false, heatScore: 0 };
    const authority = this.toAuthorityScore(authorityMap.get(id));

    return this.toModel(
      row,
      {
        items: row.items.map((item) => this.toItemModel(item)),
        timeline: row.timeline.map((entry) => this.toTimelineModel(entry))
      },
      {
        breaking: heat.breaking,
        heatScore: heat.heatScore,
        credibilityScore: authority.credibilityScore,
        sourceType: authority.sourceType
      }
    );
  }

  @HasPermission("items.read")
  @Query(() => NewsEventBriefModel, { nullable: true })
  async newsEventBrief(
    @Context("req") req: GqlRequest,
    @Args("eventId") eventId: string,
    @Args("language", { nullable: true }) language?: string,
    @Args("maxSources", { type: () => Int, nullable: true }) maxSources?: number,
    @Args("forceRefresh", { nullable: true }) forceRefresh?: boolean
  ): Promise<NewsEventBriefModel | null> {
    const user = this.requireUser(req);
    const result = await this.briefs.getBrief(user.orgId, eventId, {
      language,
      maxSources,
      forceRefresh
    });
    if (!result) {
      return null;
    }

    const toPoint = (point: { text: string; citations: number[] }) => ({
      text: point.text,
      citations: point.citations ?? []
    });

    const payload = result.payload;
    return {
      version: 1,
      generatedAt: result.generatedAt,
      language: result.language,
      tldr: payload.tldr,
      keyPoints: (payload.key_points ?? []).map(toPoint),
      whyItMatters: (payload.why_it_matters ?? []).map(toPoint),
      latestUpdate: payload.latest_update ? toPoint(payload.latest_update) : null,
      whatToWatch: (payload.what_to_watch ?? []).map(toPoint),
      comparison: payload.comparison
        ? {
            consensus: (payload.comparison.consensus ?? []).map(toPoint),
            divergence: (payload.comparison.divergence ?? []).map(toPoint)
          }
        : null,
      limitations: payload.limitations ?? null,
      sources: result.sources.map((source) => ({
        index: source.index,
        url: source.url,
        sourceLabel: source.sourceLabel,
        title: source.title,
        publishedAt: source.publishedAt,
        processedItemId: source.processedItemId,
        processedArticleId: source.processedArticleId
      }))
    };
  }

  private toModel(
    row: any,
    extras?: { items: NewsEventItemModel[]; timeline: NewsEventTimelineEntryModel[] },
    score?: {
      breaking: boolean;
      heatScore: number;
      credibilityScore: number;
      sourceType: NewsEventSourceType;
    }
  ): NewsEventModel {
    return {
      id: row.id,
      status: row.status,
      language: row.language,
      primaryTopic: row.primaryTopic,
      primaryEntity: row.primaryEntity,
      title: row.title,
      summary: row.summary,
      startAt: row.startAt,
      lastAt: row.lastAt,
      itemCount: row._count?.items ?? 0,
      representativeProcessedArticleId: row.representativeProcessedArticleId,
      representativeProcessedItemId: row.representativeProcessedItemId,
      metadata: row.metadata ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      ...(extras ? { items: extras.items, timeline: extras.timeline } : {}),
      breaking: score?.breaking ?? false,
      heatScore: score?.heatScore ?? 0,
      credibilityScore: score?.credibilityScore ?? 0,
      sourceType: score?.sourceType ?? NewsEventSourceType.unknown
    };
  }

  private toItemModel(item: any): NewsEventItemModel {
    return {
      id: item.id,
      eventId: item.eventId,
      processedArticleId: item.processedArticleId,
      processedItemId: item.processedItemId,
      similarity: item.similarity,
      assignedBy: item.assignedBy,
      createdAt: item.createdAt,
      processedArticle: {
        id: item.processedArticle.id,
        articleId: item.processedArticle.articleId,
        title: item.processedArticle.title,
        summary: item.processedArticle.summary,
        publishedAt: item.processedArticle.publishedAt,
        language: item.processedArticle.language,
        processedAt: item.processedArticle.processedAt,
        article: {
          id: item.processedArticle.article.id,
          url: item.processedArticle.article.url,
          sourceLabel: item.processedArticle.article.sourceLabel,
          crawlAt: item.processedArticle.article.crawlAt
        }
      }
    };
  }

  private toTimelineModel(entry: any): NewsEventTimelineEntryModel {
    return {
      id: entry.id,
      eventId: entry.eventId,
      bucketStart: entry.bucketStart,
      title: entry.title,
      summary: entry.summary,
      keyPoints: entry.keyPoints ?? null,
      referencedArticleIds: entry.referencedArticleIds ?? null,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt
    };
  }

  private toAuthorityScore(
    profile: NewsEventAuthorityProfile | undefined
  ): { credibilityScore: number; sourceType: NewsEventSourceType } {
    if (!profile) {
      return {
        credibilityScore: 0,
        sourceType: NewsEventSourceType.unknown
      };
    }
    return {
      credibilityScore:
        typeof profile.credibilityScore === "number" && Number.isFinite(profile.credibilityScore)
          ? profile.credibilityScore
          : 0,
      sourceType: this.toGraphqlSourceType(profile.sourceType)
    };
  }

  private toGraphqlSourceType(sourceType: NewsEventSourceClassification): NewsEventSourceType {
    switch (sourceType) {
      case "authoritative":
        return NewsEventSourceType.authoritative;
      case "mixed":
        return NewsEventSourceType.mixed;
      case "blog":
        return NewsEventSourceType.blog;
      default:
        return NewsEventSourceType.unknown;
    }
  }

  private sortEvents(rows: EnrichedEvent[], sortBy: NewsEventSortBy): EnrichedEvent[] {
    const sorted = rows.slice();
    sorted.sort((a, b) => {
      const heatDelta = (b.heat.heatScore ?? 0) - (a.heat.heatScore ?? 0);
      const credibilityDelta = (b.authority.credibilityScore ?? 0) - (a.authority.credibilityScore ?? 0);
      const lastAtDelta = this.safeTimeMs(b.row.lastAt) - this.safeTimeMs(a.row.lastAt);
      if (sortBy === NewsEventSortBy.heat) {
        return heatDelta || credibilityDelta || lastAtDelta;
      }
      if (sortBy === NewsEventSortBy.credibility) {
        return credibilityDelta || heatDelta || lastAtDelta;
      }
      return lastAtDelta || heatDelta || credibilityDelta;
    });
    return sorted;
  }

  private dedupeSimilarEvents(rows: EnrichedEvent[]): EnrichedEvent[] {
    const kept: Array<{ entry: EnrichedEvent; tokens: Set<string>; startMs: number; lastMs: number }> = [];
    for (const entry of rows) {
      const tokens = this.buildEventTokenSet(entry.row);
      const startMs = this.safeTimeMs(entry.row.startAt);
      const lastMs = this.safeTimeMs(entry.row.lastAt);

      let duplicate = false;
      for (const existing of kept) {
        const closeByTime =
          (Number.isFinite(startMs) &&
            Number.isFinite(existing.startMs) &&
            Math.abs(startMs - existing.startMs) <= EVENT_DEDUPE_WINDOW_MS) ||
          (Number.isFinite(lastMs) &&
            Number.isFinite(existing.lastMs) &&
            Math.abs(lastMs - existing.lastMs) <= EVENT_DEDUPE_WINDOW_MS);
        if (!closeByTime) {
          continue;
        }
        const similarity = this.jaccard(tokens, existing.tokens);
        if (similarity >= 0.74) {
          duplicate = true;
          break;
        }
      }

      if (!duplicate) {
        kept.push({ entry, tokens, startMs, lastMs });
      }
    }

    return kept.map((record) => record.entry);
  }

  private buildEventTokenSet(row: any): Set<string> {
    const parts = [
      typeof row?.primaryEntity === "string" ? row.primaryEntity : "",
      typeof row?.primaryTopic === "string" ? row.primaryTopic : "",
      typeof row?.title === "string" ? row.title : ""
    ];
    const normalized = parts
      .join(" ")
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ")
      .trim();
    if (!normalized) {
      return new Set();
    }

    const tokens = normalized
      .split(/\s+/)
      .filter((token) => token.length >= 3 || /[\u4e00-\u9fff]/.test(token))
      .slice(0, 24);
    return new Set(tokens);
  }

  private jaccard(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 || b.size === 0) {
      return 0;
    }

    const [small, large] = a.size <= b.size ? [a, b] : [b, a];
    let intersection = 0;
    for (const token of small) {
      if (large.has(token)) {
        intersection += 1;
      }
    }

    const union = a.size + b.size - intersection;
    return union > 0 ? intersection / union : 0;
  }

  private safeTimeMs(value: unknown): number {
    if (value instanceof Date) {
      return value.getTime();
    }
    if (typeof value === "string") {
      const parsed = new Date(value).getTime();
      return Number.isFinite(parsed) ? parsed : 0;
    }
    return 0;
  }

  private clampInt(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) {
      return min;
    }
    const rounded = Math.round(value);
    return Math.max(min, Math.min(max, rounded));
  }

  private requireUser(req: GqlRequest): AuthenticatedUser {
    const user = req?.user as AuthenticatedUser | undefined;
    if (!user) {
      throw new ForbiddenException("Unauthenticated");
    }
    return user;
  }
}
