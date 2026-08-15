import { ProcessedItemModel } from "@modular/mongo";
import { createLogger } from "@modular/utils";
import { ForbiddenException, UseGuards } from "@nestjs/common";
import { Args, Context, Float, Int, Query, Resolver } from "@nestjs/graphql";
import { NewsEventStatus } from "@prisma/client";
import { Types } from "mongoose";

import { GqlAuthGuard } from "../../common/guards/gql-auth.guard";
import { GqlPermissionsGuard } from "../../common/guards/gql-permissions.guard";
import type { AuthenticatedUser } from "../../modules/auth/auth.service";
import { NewsEventBriefService } from "../../modules/news-events/news-event-brief.service";
import {
  NewsEventSourcePolicyService,
  type NewsEventSourcePolicySyncStatus,
} from "../../modules/news-events/news-event-source-policy.service";
import { NewsEventsSettingsService } from "../../modules/news-events/news-events-settings.service";
import {
  type NewsEventAuthorityProfile,
  type NewsEventSourceClassification,
  NewsEventsService,
} from "../../modules/news-events/news-events.service";
import { HasPermission } from "../decorators/has-permission.decorator";
import type { GqlRequest } from "../graphql.types";
import { NewsEventBriefModel } from "../models/news-event-brief.model";
import {
  NewsEventModel,
  NewsEventSortBy,
  NewsEventSourceType,
  NewsEventItemModel,
  NewsEventTimelineEntryModel,
  NewsEventReferencedArticleModel,
  NewsEventSourceEvidenceModel,
  NewsEventSourcePolicySyncStatusModel,
} from "../models/news-events.model";

const EVENT_DEDUPE_WINDOW_MS = 5 * 24 * 60 * 60 * 1000;
const logger = createLogger({ name: "news-events-resolver" });

interface EnrichedEvent {
  row: any;
  heat: { breaking: boolean; heatScore: number };
  authority: {
    credibilityScore: number;
    sourceType: NewsEventSourceType;
    sourceEvidence: NewsEventSourceEvidenceModel;
  };
}

@Resolver(() => NewsEventModel)
@UseGuards(GqlAuthGuard, GqlPermissionsGuard)
export class NewsEventsResolver {
  constructor(
    private readonly events: NewsEventsService,
    private readonly briefs: NewsEventBriefService,
    private readonly newsEventSettings: NewsEventsSettingsService,
    private readonly sourcePolicyService: NewsEventSourcePolicyService,
  ) {}

  @HasPermission("items.read")
  @Query(() => NewsEventSourcePolicySyncStatusModel)
  async newsEventSourcePolicySyncStatus(
    @Context("req") req: GqlRequest,
  ): Promise<NewsEventSourcePolicySyncStatusModel> {
    const user = this.requireUser(req);
    const [status, orgSettings] = await Promise.all([
      this.sourcePolicyService.getSyncStatus(user.orgId),
      this.newsEventSettings.getSettings(user.orgId).catch((error: unknown) => {
        logger.warn(
          { err: error, orgId: user.orgId },
          "news event settings lookup failed; using defaults",
        );
        return null;
      }),
    ]);
    return this.toSourcePolicySyncStatusModel(
      status,
      Boolean(orgSettings?.forceAuthoritativeMode),
      this.clampInt(orgSettings?.forceMinAuthoritativeSources ?? 1, 1, 10),
    );
  }

  @HasPermission("items.read")
  @Query(() => [NewsEventModel])
  async newsEvents(
    @Context("req") req: GqlRequest,
    @Args("limit", { type: () => Int, nullable: true }) limit?: number,
    @Args("windowDays", { type: () => Int, nullable: true })
    windowDays?: number,
    @Args("status", { type: () => NewsEventStatus, nullable: true })
    status?: NewsEventStatus,
    @Args("entity", { nullable: true }) entity?: string,
    @Args("sourceType", { type: () => NewsEventSourceType, nullable: true })
    sourceType?: NewsEventSourceType,
    @Args("minHeatScore", { type: () => Float, nullable: true })
    minHeatScore?: number,
    @Args("minCredibilityScore", { type: () => Float, nullable: true })
    minCredibilityScore?: number,
    @Args("minAuthoritativeSources", { type: () => Int, nullable: true })
    minAuthoritativeSources?: number,
    @Args("sortBy", { type: () => NewsEventSortBy, nullable: true })
    sortBy?: NewsEventSortBy,
    @Args("dedupeSimilar", { nullable: true }) dedupeSimilar?: boolean,
  ): Promise<NewsEventModel[]> {
    const user = this.requireUser(req);
    const requestedLimit = this.clampInt(limit ?? 20, 1, 100);
    const candidateLimit = Math.min(
      300,
      Math.max(requestedLimit, requestedLimit * 4),
    );
    const rows = await this.events.listEvents(user.orgId, {
      limit: candidateLimit,
      windowDays,
      status,
      entity,
    });

    const eventIds = rows.map((row) => row.id);
    const [heatMap, authorityMap] = await Promise.all([
      this.events.getEventHeatMap(user.orgId, eventIds),
      this.events.getEventAuthorityMap(user.orgId, eventIds, { windowDays }),
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
      typeof minCredibilityScore === "number" &&
      Number.isFinite(minCredibilityScore)
        ? Math.max(0, Math.min(100, minCredibilityScore))
        : null;
    const authoritativeSourcesThreshold =
      typeof minAuthoritativeSources === "number" &&
      Number.isFinite(minAuthoritativeSources)
        ? this.clampInt(Math.round(minAuthoritativeSources), 0, 100)
        : null;
    let effectiveSourceType = sourceType ?? NewsEventSourceType.all;
    let effectiveAuthoritativeSourcesThreshold = authoritativeSourcesThreshold;

    try {
      const orgSettings = await this.newsEventSettings.getSettings(user.orgId);
      if (orgSettings.forceAuthoritativeMode) {
        effectiveSourceType = NewsEventSourceType.authoritative;
        const forcedThreshold = this.clampInt(
          orgSettings.forceMinAuthoritativeSources,
          1,
          10,
        );
        effectiveAuthoritativeSourcesThreshold = Math.max(
          forcedThreshold,
          effectiveAuthoritativeSourcesThreshold ?? 0,
        );
      }
    } catch {
      // Ignore settings read failures and fall back to request-level filters.
    }

    if (effectiveSourceType !== NewsEventSourceType.all) {
      enriched = enriched.filter(
        (entry) => entry.authority.sourceType === effectiveSourceType,
      );
    }
    if (heatThreshold !== null) {
      enriched = enriched.filter(
        (entry) => entry.heat.heatScore >= heatThreshold,
      );
    }
    if (credibilityThreshold !== null) {
      enriched = enriched.filter(
        (entry) => entry.authority.credibilityScore >= credibilityThreshold,
      );
    }
    if (effectiveAuthoritativeSourcesThreshold !== null) {
      enriched = enriched.filter(
        (entry) =>
          entry.authority.sourceEvidence.authoritativeSourceCount >=
          effectiveAuthoritativeSourcesThreshold,
      );
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
        sourceType: authority.sourceType,
        sourceEvidence: authority.sourceEvidence,
      });
    });
  }

  @HasPermission("items.read")
  @Query(() => NewsEventModel, { nullable: true })
  async newsEvent(
    @Context("req") req: GqlRequest,
    @Args("id") id: string,
    @Args("itemsLimit", { type: () => Int, nullable: true })
    itemsLimit?: number,
    @Args("timelineLimit", { type: () => Int, nullable: true })
    timelineLimit?: number,
  ): Promise<NewsEventModel | null> {
    const user = this.requireUser(req);
    const row = await this.events.getEvent(user.orgId, id, {
      itemsLimit,
      timelineLimit,
    });
    if (!row) {
      return null;
    }

    const [heatMap, authorityMap, categoryDistributionMap, itemMetaIdByProcessedItemId] =
      await Promise.all([
        this.events.getEventHeatMap(user.orgId, [id]),
        this.events.getEventAuthorityMap(user.orgId, [id]),
        this.events.getEventCategoryDistributionMap(user.orgId, [id]),
        this.loadItemMetaIdByProcessedItemId(
          row.items.map((item) => item.processedItemId),
        ),
      ]);
    const heat = heatMap.get(id) ?? { breaking: false, heatScore: 0 };
    const authority = this.toAuthorityScore(authorityMap.get(id));
    const categoryDistribution = categoryDistributionMap.get(id) ?? null;

    return this.toModel(
      row,
      {
        items: row.items.map((item) =>
          this.toItemModel(item, itemMetaIdByProcessedItemId),
        ),
        timeline: row.timeline.map((entry) =>
          this.toTimelineModel(entry, row.metadata),
        ),
      },
      {
        breaking: heat.breaking,
        heatScore: heat.heatScore,
        credibilityScore: authority.credibilityScore,
        sourceType: authority.sourceType,
        sourceEvidence: authority.sourceEvidence,
      },
      {
        categoryDistribution,
      },
    );
  }

  @HasPermission("items.read")
  @Query(() => NewsEventBriefModel, { nullable: true })
  async newsEventBrief(
    @Context("req") req: GqlRequest,
    @Args("eventId") eventId: string,
    @Args("language", { nullable: true }) language?: string,
    @Args("maxSources", { type: () => Int, nullable: true })
    maxSources?: number,
    @Args("forceRefresh", { nullable: true }) forceRefresh?: boolean,
  ): Promise<NewsEventBriefModel | null> {
    const user = this.requireUser(req);
    const result = await this.briefs.getBrief(user.orgId, eventId, {
      language,
      maxSources,
      forceRefresh,
    });
    if (!result) {
      return null;
    }

    const toPoint = (point: { text: string; citations: number[] }) => ({
      text: point.text,
      citations: point.citations ?? [],
    });

    const payload = result.payload;
    return {
      version: 1,
      generatedAt: result.generatedAt,
      language: result.language,
      detailedSummary: payload.detailed_summary,
      tldr: payload.tldr,
      keyPoints: (payload.key_points ?? []).map(toPoint),
      whyItMatters: (payload.why_it_matters ?? []).map(toPoint),
      latestUpdate: payload.latest_update
        ? toPoint(payload.latest_update)
        : null,
      whatToWatch: (payload.what_to_watch ?? []).map(toPoint),
      comparison: payload.comparison
        ? {
            consensus: (payload.comparison.consensus ?? []).map(toPoint),
            divergence: (payload.comparison.divergence ?? []).map(toPoint),
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
        processedArticleId: source.processedArticleId,
      })),
    };
  }

  @HasPermission("items.read")
  @Query(() => [NewsEventReferencedArticleModel])
  async newsEventReferencedArticles(
    @Context("req") req: GqlRequest,
    @Args("eventId") eventId: string,
    @Args("articleIds", { type: () => [String] }) articleIds: string[],
    @Args("limit", { type: () => Int, nullable: true }) limit?: number,
  ): Promise<NewsEventReferencedArticleModel[]> {
    const user = this.requireUser(req);
    const rows = await this.events.listEventReferencedArticles(
      user.orgId,
      eventId,
      articleIds,
      { limit },
    );
    return rows.map((row) => ({
      id: row.id,
      url: row.url,
      sourceLabel: row.sourceLabel,
      title: row.title,
      crawlAt: row.crawlAt,
      publishedAt: row.publishedAt,
      processedAt: row.processedAt,
      processedArticleId: row.processedArticleId,
    }));
  }

  private toModel(
    row: any,
    extras?: {
      items: NewsEventItemModel[];
      timeline: NewsEventTimelineEntryModel[];
    },
    score?: {
      breaking: boolean;
      heatScore: number;
      credibilityScore: number;
      sourceType: NewsEventSourceType;
      sourceEvidence: NewsEventSourceEvidenceModel;
    },
    classification?: {
      categoryDistribution?: unknown;
    },
  ): NewsEventModel {
    const timelineMetadata = this.extractTimelineMetadata(row.metadata);
    const metadataDistribution =
      timelineMetadata &&
      Array.isArray(timelineMetadata.categoryDistribution)
        ? timelineMetadata.categoryDistribution
        : null;
    const categoryDistribution =
      classification?.categoryDistribution ?? metadataDistribution ?? null;
    const timelinePhases =
      timelineMetadata && Array.isArray(timelineMetadata.phaseSummaries)
        ? timelineMetadata.phaseSummaries
        : null;
    const subEvents =
      timelineMetadata && Array.isArray(timelineMetadata.subEvents)
        ? timelineMetadata.subEvents
        : timelinePhases;
    const topicDriftWarning =
      timelineMetadata &&
      typeof timelineMetadata.topicDriftWarning === "boolean"
        ? timelineMetadata.topicDriftWarning
        : null;
    const topicDriftSummary =
      timelineMetadata && typeof timelineMetadata.topicDriftSummary === "string"
        ? timelineMetadata.topicDriftSummary
        : null;

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
      categoryDistribution,
      topicDriftWarning,
      topicDriftSummary,
      timelinePhases,
      subEvents,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      ...(extras ? { items: extras.items, timeline: extras.timeline } : {}),
      breaking: score?.breaking ?? false,
      heatScore: score?.heatScore ?? 0,
      credibilityScore: score?.credibilityScore ?? 0,
      sourceType: score?.sourceType ?? NewsEventSourceType.unknown,
      sourceEvidence: score?.sourceEvidence ?? {
        uniqueSourceCount: 0,
        authoritativeSourceCount: 0,
        blogSourceCount: 0,
        corroborated: false,
      },
    };
  }

  private toItemModel(
    item: any,
    itemMetaIdByProcessedItemId?: Map<string, string>,
  ): NewsEventItemModel {
    const processedItemId =
      typeof item.processedItemId === "string" && item.processedItemId.trim().length > 0
        ? item.processedItemId.trim()
        : null;
    const itemMetaId = processedItemId
      ? (itemMetaIdByProcessedItemId?.get(processedItemId) ?? null)
      : null;
    return {
      id: item.id,
      eventId: item.eventId,
      processedArticleId: item.processedArticleId,
      itemMetaId,
      processedItemId,
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
          crawlAt: item.processedArticle.article.crawlAt,
        },
      },
    };
  }

  private async loadItemMetaIdByProcessedItemId(
    processedItemIds: (string | null | undefined)[],
  ) {
    const normalizedIds = Array.from(
      new Set(
        processedItemIds
          .map((value) => (typeof value === "string" ? value.trim() : ""))
          .filter((value) => value.length > 0),
      ),
    );
    if (normalizedIds.length === 0) {
      return new Map<string, string>();
    }

    const objectIds = normalizedIds
      .filter((value) => Types.ObjectId.isValid(value))
      .map((value) => new Types.ObjectId(value));
    if (objectIds.length === 0) {
      return new Map<string, string>();
    }

    const rows = await ProcessedItemModel.find(
      { _id: { $in: objectIds } },
      { _id: 1, itemMetaId: 1 },
    )
      .lean()
      .exec();
    const out = new Map<string, string>();
    for (const row of rows) {
      const rowRecord = row as { _id?: unknown; itemMetaId?: unknown };
      const processedItemId = String(rowRecord._id ?? "").trim();
      const itemMetaId =
        typeof rowRecord.itemMetaId === "string"
          ? rowRecord.itemMetaId.trim()
          : "";
      if (!processedItemId || !itemMetaId || out.has(processedItemId)) {
        continue;
      }
      out.set(processedItemId, itemMetaId);
    }
    return out;
  }

  private toTimelineModel(
    entry: any,
    eventMetadata?: unknown,
  ): NewsEventTimelineEntryModel {
    const metadata = this.extractTimelineEntryMetadata(
      eventMetadata,
      entry.bucketStart,
    );
    return {
      id: entry.id,
      eventId: entry.eventId,
      bucketStart: entry.bucketStart,
      title: entry.title,
      summary: entry.summary,
      keyPoints: entry.keyPoints ?? null,
      referencedArticleIds: entry.referencedArticleIds ?? null,
      categoryPath: metadata.categoryPath,
      categoryConfidence: metadata.categoryConfidence,
      tentative: metadata.tentative,
      anchor: metadata.anchor,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    };
  }

  private extractTimelineMetadata(
    metadata: unknown,
  ): Record<string, unknown> | null {
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      return null;
    }
    const record = metadata as Record<string, unknown>;
    const timeline = record.timeline;
    if (!timeline || typeof timeline !== "object" || Array.isArray(timeline)) {
      return null;
    }
    return timeline as Record<string, unknown>;
  }

  private extractTimelineEntryMetadata(
    metadata: unknown,
    bucketStart: unknown,
  ): {
    categoryPath: string | null;
    categoryConfidence: number | null;
    tentative: boolean | null;
    anchor: boolean | null;
  } {
    const timelineMetadata = this.extractTimelineMetadata(metadata);
    if (!timelineMetadata) {
      return {
        categoryPath: null,
        categoryConfidence: null,
        tentative: null,
        anchor: null,
      };
    }

    const entries = timelineMetadata.entries;
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
      return {
        categoryPath: null,
        categoryConfidence: null,
        tentative: null,
        anchor: null,
      };
    }

    const key = this.toBucketKey(bucketStart);
    if (!key) {
      return {
        categoryPath: null,
        categoryConfidence: null,
        tentative: null,
        anchor: null,
      };
    }
    const entry = (entries as Record<string, unknown>)[key];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return {
        categoryPath: null,
        categoryConfidence: null,
        tentative: null,
        anchor: null,
      };
    }

    const record = entry as Record<string, unknown>;
    const categoryPath =
      typeof record.categoryPath === "string" && record.categoryPath.trim()
        ? record.categoryPath.trim()
        : null;
    const rawConfidence =
      typeof record.categoryConfidence === "number" &&
      Number.isFinite(record.categoryConfidence)
        ? record.categoryConfidence
        : null;
    const categoryConfidence =
      rawConfidence === null ? null : Math.max(0, Math.min(1, rawConfidence));
    return {
      categoryPath,
      categoryConfidence,
      tentative:
        typeof record.tentative === "boolean" ? record.tentative : null,
      anchor: typeof record.anchor === "boolean" ? record.anchor : null,
    };
  }

  private toBucketKey(value: unknown): string | null {
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      return value.toISOString();
    }
    if (typeof value === "string") {
      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime())) {
        return parsed.toISOString();
      }
    }
    return null;
  }

  private toAuthorityScore(profile: NewsEventAuthorityProfile | undefined): {
    credibilityScore: number;
    sourceType: NewsEventSourceType;
    sourceEvidence: NewsEventSourceEvidenceModel;
  } {
    if (!profile) {
      return {
        credibilityScore: 0,
        sourceType: NewsEventSourceType.unknown,
        sourceEvidence: {
          uniqueSourceCount: 0,
          authoritativeSourceCount: 0,
          blogSourceCount: 0,
          corroborated: false,
        },
      };
    }
    return {
      credibilityScore:
        typeof profile.credibilityScore === "number" &&
        Number.isFinite(profile.credibilityScore)
          ? profile.credibilityScore
          : 0,
      sourceType: this.toGraphqlSourceType(profile.sourceType),
      sourceEvidence: {
        uniqueSourceCount: this.clampInt(
          profile.uniqueSourceCount ?? 0,
          0,
          10_000,
        ),
        authoritativeSourceCount: this.clampInt(
          profile.authoritativeSourceCount ?? 0,
          0,
          10_000,
        ),
        blogSourceCount: this.clampInt(profile.blogSourceCount ?? 0, 0, 10_000),
        corroborated: Boolean(profile.corroborated),
      },
    };
  }

  private toSourcePolicySyncStatusModel(
    status: NewsEventSourcePolicySyncStatus,
    forceAuthoritativeMode: boolean,
    forceMinAuthoritativeSources: number,
  ): NewsEventSourcePolicySyncStatusModel {
    return {
      degraded: Boolean(status.degraded),
      policyCacheStale: Boolean(status.policyCacheStale),
      presetCacheStale: Boolean(status.presetCacheStale),
      forceAuthoritativeMode,
      forceMinAuthoritativeSources: this.clampInt(
        forceMinAuthoritativeSources,
        1,
        10,
      ),
      warningCodes: Array.isArray(status.warningCodes)
        ? status.warningCodes
        : [],
    };
  }

  private toGraphqlSourceType(
    sourceType: NewsEventSourceClassification,
  ): NewsEventSourceType {
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

  private sortEvents(
    rows: EnrichedEvent[],
    sortBy: NewsEventSortBy,
  ): EnrichedEvent[] {
    const sorted = rows.slice();
    sorted.sort((a, b) => {
      const heatDelta = (b.heat.heatScore ?? 0) - (a.heat.heatScore ?? 0);
      const credibilityDelta =
        (b.authority.credibilityScore ?? 0) -
        (a.authority.credibilityScore ?? 0);
      const lastAtDelta =
        this.safeTimeMs(b.row.lastAt) - this.safeTimeMs(a.row.lastAt);
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
    const kept: {
      entry: EnrichedEvent;
      tokens: Set<string>;
      startMs: number;
      lastMs: number;
    }[] = [];
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
      typeof row?.title === "string" ? row.title : "",
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
