import { ProcessedItemModel } from "@modular/mongo";
import { Injectable } from "@nestjs/common";
import {
  NewsEventStatus,
  NewsIndicatorFeatureMetric,
  NewsIndicatorScopeType,
  Prisma,
} from "@prisma/client";

import { toPrismaJsonValue } from "../../common/prisma-json";
import { PrismaService } from "../config/prisma.service";
import {
  type DigestSubscriptionValues,
  UserContentSubscriptionsService,
} from "../user-content-subscriptions/user-content-subscriptions.service";

import { USER_DIGEST_PREFERENCE_KEY } from "./user-digest.constants";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface UserDigestPreferenceV1 {
  version: 1;
  focusEntities: string[];
  focusTopics: string[];
  windowDays: number;
  maxEvents: number;
  includeIndicators: boolean;
  maxIndicatorsPerEvent: number;
}

export interface UserDigestV1 {
  version: 1;
  generatedAt: string;
  windowStart: string;
  windowEnd: string;
  preference: UserDigestPreferenceV1;
  events: UserDigestEventV1[];
}

export interface UserDigestEventV1 {
  eventId: string;
  title: string | null;
  summary: string | null;
  primaryTopic: string | null;
  primaryEntity: string | null;
  startAt: string;
  lastAt: string;
  itemCount: number;
  representativeUrl: string | null;
  topicSentiment?: {
    bucketStart: string;
    totalDocs: number;
    avgScore: number;
    negativeRatio: number;
  } | null;
  entitySentiment?: {
    bucketStart: string;
    totalDocs: number;
    avgScore: number;
    negativeRatio: number;
  } | null;
  indicatorAssociations?: {
    scopeType: NewsIndicatorScopeType;
    featureMetric: NewsIndicatorFeatureMetric;
    indicatorSlug: string;
    indicatorDisplayName: string;
    lagDays: number;
    correlation: number;
    pValue: number | null;
    latestBacktest?: {
      createdAt: string;
      metrics?: unknown;
    } | null;
  }[];
}

function normalizeStringArray(value: unknown, limit: number): string[] {
  const items = Array.isArray(value) ? value : [];
  const out: string[] = [];
  for (const entry of items) {
    if (typeof entry !== "string") {
      continue;
    }
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }
    out.push(trimmed.slice(0, 128));
    if (out.length >= limit) {
      break;
    }
  }
  return Array.from(new Set(out));
}

function clampInt(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  const numeric =
    typeof value === "number" && Number.isFinite(value)
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value.trim())
        : Number.NaN;
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  const rounded = Math.round(numeric);
  return Math.min(Math.max(rounded, min), max);
}

function normalizePreference(
  value: unknown,
  fallback?: UserDigestPreferenceV1,
): UserDigestPreferenceV1 {
  const defaults: UserDigestPreferenceV1 = fallback ?? {
    version: 1,
    focusEntities: [],
    focusTopics: [],
    windowDays: 3,
    maxEvents: 8,
    includeIndicators: true,
    maxIndicatorsPerEvent: 5,
  };

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return defaults;
  }

  const record = value as Record<string, unknown>;

  return {
    version: 1,
    focusEntities: normalizeStringArray(record.focusEntities, 50),
    focusTopics: normalizeStringArray(record.focusTopics, 50),
    windowDays: clampInt(record.windowDays, 1, 30, defaults.windowDays),
    maxEvents: clampInt(record.maxEvents, 1, 30, defaults.maxEvents),
    includeIndicators:
      typeof record.includeIndicators === "boolean"
        ? record.includeIndicators
        : defaults.includeIndicators,
    maxIndicatorsPerEvent: clampInt(
      record.maxIndicatorsPerEvent,
      0,
      50,
      defaults.maxIndicatorsPerEvent,
    ),
  };
}

@Injectable()
export class UserDigestService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly contentSubscriptions: UserContentSubscriptionsService,
  ) {}

  async getPreference(
    orgId: string,
    userId: string,
  ): Promise<UserDigestPreferenceV1> {
    const stored = await this.getStoredPreference(orgId, userId);
    const contentPreference =
      await this.contentSubscriptions.getDigestPreferenceValues(orgId, userId);
    return {
      ...stored,
      focusTopics: contentPreference.focusTopics,
      focusEntities: contentPreference.focusEntities,
    };
  }

  private async getStoredPreference(
    orgId: string,
    userId: string,
  ): Promise<UserDigestPreferenceV1> {
    const record = await this.prisma.userSetting.findUnique({
      where: {
        orgId_userId_key: {
          orgId,
          userId,
          key: USER_DIGEST_PREFERENCE_KEY,
        },
      },
      select: { value: true },
    });
    return normalizePreference(record?.value);
  }

  async updatePreference(
    orgId: string,
    userId: string,
    input: Partial<UserDigestPreferenceV1>,
  ): Promise<UserDigestPreferenceV1> {
    const current = await this.getStoredPreference(orgId, userId);

    if (input.focusTopics !== undefined || input.focusEntities !== undefined) {
      await this.contentSubscriptions.replaceSubscriptionsFromDigestPreference(
        orgId,
        userId,
        {
          ...(input.focusTopics !== undefined
            ? { focusTopics: input.focusTopics }
            : {}),
          ...(input.focusEntities !== undefined
            ? { focusEntities: input.focusEntities }
            : {}),
        },
      );
    }

    const contentPreference =
      await this.contentSubscriptions.getDigestPreferenceValues(orgId, userId);
    const merged: UserDigestPreferenceV1 = normalizePreference(
      {
        ...current,
        ...input,
        focusTopics: contentPreference.focusTopics,
        focusEntities: contentPreference.focusEntities,
      },
      current,
    );

    await this.prisma.userSetting.upsert({
      where: {
        orgId_userId_key: {
          orgId,
          userId,
          key: USER_DIGEST_PREFERENCE_KEY,
        },
      },
      update: {
        value: toPrismaJsonValue(merged),
      },
      create: {
        orgId,
        userId,
        key: USER_DIGEST_PREFERENCE_KEY,
        value: toPrismaJsonValue(merged),
      },
    });

    return merged;
  }

  async generateDigest(orgId: string, userId: string): Promise<UserDigestV1> {
    const preference = await this.getPreference(orgId, userId);
    const subscriptionValues =
      await this.contentSubscriptions.getDigestSubscriptionValues(
        orgId,
        userId,
      );
    const now = new Date();
    const windowEnd = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const windowStart = new Date(
      windowEnd.getTime() - preference.windowDays * DAY_MS,
    );

    const events = await this.loadEvents(
      orgId,
      preference,
      subscriptionValues,
      windowStart,
    );
    const uniqueTopics = Array.from(
      new Set(
        events
          .map((event) =>
            typeof event.primaryTopic === "string"
              ? event.primaryTopic.trim()
              : "",
          )
          .filter((topic) => topic.length > 0),
      ),
    );
    const uniqueEntities = Array.from(
      new Set(
        events
          .map((event) =>
            typeof event.primaryEntity === "string"
              ? event.primaryEntity.trim()
              : "",
          )
          .filter((entity) => entity.length > 0),
      ),
    );
    const [
      topicSentimentByTopic,
      entitySentimentByEntity,
      indicatorAssociationsByScope,
    ] = await Promise.all([
      this.loadLatestTopicSentiments(orgId, uniqueTopics),
      this.loadLatestEntitySentiments(orgId, uniqueEntities),
      preference.includeIndicators && preference.maxIndicatorsPerEvent > 0
        ? this.loadIndicatorAssociationsByScope(
            orgId,
            events,
            preference.maxIndicatorsPerEvent,
          )
        : Promise.resolve(
            new Map<
              string,
              NonNullable<UserDigestEventV1["indicatorAssociations"]>
            >(),
          ),
    ]);
    const enriched = events.map((event) =>
      this.enrichEvent(
        event,
        preference,
        topicSentimentByTopic,
        entitySentimentByEntity,
        indicatorAssociationsByScope,
      ),
    );

    return {
      version: 1,
      generatedAt: new Date().toISOString(),
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      preference,
      events: enriched,
    };
  }

  private async loadEvents(
    orgId: string,
    preference: UserDigestPreferenceV1,
    subscriptions: DigestSubscriptionValues,
    since: Date,
  ) {
    const baseWhere: Prisma.NewsEventWhereInput = {
      orgId,
      status: NewsEventStatus.active,
      lastAt: { gte: since },
    };
    const include = this.digestEventInclude();
    const hasTopicEntityFilters =
      subscriptions.focusTopics.length > 0 ||
      subscriptions.focusEntities.length > 0;
    const hasRelatedFilters =
      subscriptions.focusSources.length > 0 ||
      subscriptions.focusKeywords.length > 0 ||
      subscriptions.focusGeos.length > 0;
    const hasAnyFilter = hasTopicEntityFilters || hasRelatedFilters;

    if (!hasAnyFilter) {
      return this.prisma.newsEvent.findMany({
        where: baseWhere,
        orderBy: [{ lastAt: "desc" }, { startAt: "desc" }],
        take: preference.maxEvents,
        include,
      });
    }

    const matchedEventIds = new Set<string>();

    if (hasTopicEntityFilters) {
      const filters: Prisma.NewsEventWhereInput[] = [];
      if (subscriptions.focusTopics.length > 0) {
        filters.push({ primaryTopic: { in: subscriptions.focusTopics } });
      }
      if (subscriptions.focusEntities.length > 0) {
        filters.push({ primaryEntity: { in: subscriptions.focusEntities } });
      }
      const rows = await this.prisma.newsEvent.findMany({
        where: { ...baseWhere, OR: filters },
        select: { id: true },
        take: preference.maxEvents * 8,
      });
      for (const row of rows) {
        matchedEventIds.add(row.id);
      }
    }

    if (hasRelatedFilters) {
      const relatedEventIds = await this.findMatchedEventIdsFromRelatedContent(
        orgId,
        since,
        subscriptions,
      );
      for (const eventId of relatedEventIds) {
        matchedEventIds.add(eventId);
      }
    }

    const primary =
      matchedEventIds.size > 0
        ? await this.prisma.newsEvent.findMany({
            where: {
              ...baseWhere,
              id: { in: Array.from(matchedEventIds) },
            },
            orderBy: [{ lastAt: "desc" }, { startAt: "desc" }],
            take: preference.maxEvents,
            include,
          })
        : [];

    if (primary.length >= preference.maxEvents) {
      return primary;
    }

    const already = new Set(primary.map((event) => event.id));
    const remaining = preference.maxEvents - primary.length;

    const fallback = await this.prisma.newsEvent.findMany({
      where: {
        ...baseWhere,
        id: { notIn: Array.from(already) },
      },
      orderBy: [{ lastAt: "desc" }, { startAt: "desc" }],
      take: remaining,
      include,
    });

    return [...primary, ...fallback];
  }

  private digestEventInclude() {
    return {
      _count: { select: { items: true } },
      representativeProcessedArticle: {
        include: {
          article: { select: { url: true } },
        },
      },
    } satisfies Prisma.NewsEventInclude;
  }

  private async findMatchedEventIdsFromRelatedContent(
    orgId: string,
    since: Date,
    subscriptions: DigestSubscriptionValues,
  ): Promise<Set<string>> {
    const matchedEventIds = new Set<string>();

    if (subscriptions.focusSources.length > 0) {
      const sourceIds = subscriptions.focusSources.map(
        (entry) => entry.sourceId,
      );
      const rows = await this.prisma.newsEventItem.findMany({
        where: {
          orgId,
          event: {
            orgId,
            status: NewsEventStatus.active,
            lastAt: { gte: since },
          },
          processedArticle: {
            article: {
              sourceId: { in: sourceIds },
            },
          },
        },
        select: { eventId: true },
        distinct: ["eventId"],
      });
      for (const row of rows) {
        matchedEventIds.add(row.eventId);
      }
    }

    if (
      subscriptions.focusKeywords.length === 0 &&
      subscriptions.focusGeos.length === 0
    ) {
      return matchedEventIds;
    }

    const relatedRows = await this.prisma.newsEventItem.findMany({
      where: {
        orgId,
        event: {
          orgId,
          status: NewsEventStatus.active,
          lastAt: { gte: since },
        },
        processedItemId: { not: null },
      },
      select: {
        eventId: true,
        processedItemId: true,
      },
    });

    const processedItemIds = Array.from(
      new Set(
        relatedRows
          .map((row) =>
            typeof row.processedItemId === "string"
              ? row.processedItemId.trim()
              : "",
          )
          .filter((value) => value.length > 0),
      ),
    );
    if (processedItemIds.length === 0) {
      return matchedEventIds;
    }

    const docs = await ProcessedItemModel.find({
      _id: { $in: processedItemIds },
    })
      .select({ _id: 1, result: 1 })
      .lean()
      .exec();
    const resultById = new Map(
      docs.map((doc) => [
        String((doc as { _id?: unknown })._id ?? ""),
        (doc as { result?: unknown }).result ?? null,
      ]),
    );

    for (const row of relatedRows) {
      const processedItemId =
        typeof row.processedItemId === "string"
          ? row.processedItemId.trim()
          : "";
      if (!processedItemId) {
        continue;
      }
      const result = resultById.get(processedItemId);
      if (
        this.matchesKeywordSubscription(result, subscriptions.focusKeywords) ||
        this.matchesGeoSubscription(result, subscriptions.focusGeos)
      ) {
        matchedEventIds.add(row.eventId);
      }
    }

    return matchedEventIds;
  }

  private enrichEvent(
    event: {
      id: string;
      title: string | null;
      summary: string | null;
      primaryTopic: string | null;
      primaryEntity: string | null;
      startAt: Date;
      lastAt: Date;
      _count?: { items: number };
      representativeProcessedArticle?: {
        article?: { url: string } | null;
      } | null;
    },
    preference: UserDigestPreferenceV1,
    topicSentimentByTopic: Map<
      string,
      NonNullable<UserDigestEventV1["topicSentiment"]>
    >,
    entitySentimentByEntity: Map<
      string,
      NonNullable<UserDigestEventV1["entitySentiment"]>
    >,
    indicatorAssociationsByScope: Map<
      string,
      NonNullable<UserDigestEventV1["indicatorAssociations"]>
    >,
  ): UserDigestEventV1 {
    const indicatorLimit = Math.min(
      Math.max(preference.maxIndicatorsPerEvent, 1),
      50,
    );
    const indicatorAssociations = preference.includeIndicators
      ? [
          ...(event.primaryTopic
            ? (indicatorAssociationsByScope.get(
                `topic:${event.primaryTopic}`,
              ) ?? [])
            : []),
          ...(event.primaryEntity
            ? (indicatorAssociationsByScope.get(
                `entity:${event.primaryEntity}`,
              ) ?? [])
            : []),
        ]
          .sort(
            (left, right) =>
              Math.abs(right.correlation) - Math.abs(left.correlation),
          )
          .slice(0, indicatorLimit)
      : [];

    return {
      eventId: event.id,
      title: event.title,
      summary: event.summary,
      primaryTopic: event.primaryTopic,
      primaryEntity: event.primaryEntity,
      startAt: event.startAt.toISOString(),
      lastAt: event.lastAt.toISOString(),
      itemCount: event._count?.items ?? 0,
      representativeUrl:
        event.representativeProcessedArticle?.article?.url ?? null,
      topicSentiment: event.primaryTopic
        ? (topicSentimentByTopic.get(event.primaryTopic) ?? null)
        : null,
      entitySentiment: event.primaryEntity
        ? (entitySentimentByEntity.get(event.primaryEntity) ?? null)
        : null,
      ...(indicatorAssociations.length > 0 ? { indicatorAssociations } : {}),
    };
  }

  private matchesKeywordSubscription(result: unknown, keywords: string[]) {
    if (keywords.length === 0) {
      return false;
    }
    const haystack = [
      this.pickResultString(result, [
        "title",
        "headline",
        "title_zh",
        "titleZh",
      ]),
      this.pickResultString(result, ["summary", "abstract", "subtitle"]),
      ...this.pickResultStringArray(result, [
        "topics",
        "entities",
        "keyPoints",
      ]),
    ]
      .filter((entry): entry is string => Boolean(entry))
      .map((entry) => this.normalizeTerm(entry))
      .join(" ");

    if (!haystack) {
      return false;
    }

    return keywords.some((keyword) => {
      const normalized = this.normalizeTerm(keyword);
      return normalized.length > 0 && haystack.includes(normalized);
    });
  }

  private matchesGeoSubscription(
    result: unknown,
    geos: DigestSubscriptionValues["focusGeos"],
  ) {
    if (geos.length === 0) {
      return false;
    }

    const location = this.pickResultString(result, ["location"]);
    const region = this.pickResultString(result, ["region", "country", "area"]);
    const values = [location, region]
      .filter((entry): entry is string => Boolean(entry))
      .map((entry) => this.normalizeTerm(entry));
    const haystack = values.join(" ");
    const countryCode = this.extractCountryCode(
      `${location ?? ""} ${region ?? ""}`,
    );

    return geos.some((entry) => {
      if (
        entry.countryCodeAlpha2 &&
        countryCode &&
        entry.countryCodeAlpha2.toLowerCase() === countryCode.toLowerCase()
      ) {
        return true;
      }
      const normalized = this.normalizeTerm(entry.normalizedValue);
      if (!normalized) {
        return false;
      }
      return (
        values.some(
          (value) => value === normalized || value.includes(normalized),
        ) || haystack.includes(normalized)
      );
    });
  }

  private pickResultString(result: unknown, keys: string[]) {
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      return null;
    }
    const record = result as Record<string, unknown>;
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "string" && value.trim().length > 0) {
        return value.trim();
      }
    }
    return null;
  }

  private pickResultStringArray(result: unknown, keys: string[]) {
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      return [] as string[];
    }
    const record = result as Record<string, unknown>;
    const values: string[] = [];
    for (const key of keys) {
      const field = record[key];
      if (!Array.isArray(field)) {
        continue;
      }
      for (const entry of field) {
        if (typeof entry === "string" && entry.trim().length > 0) {
          values.push(entry.trim());
          continue;
        }
        if (
          entry &&
          typeof entry === "object" &&
          !Array.isArray(entry) &&
          typeof (entry as Record<string, unknown>).name === "string"
        ) {
          values.push(String((entry as Record<string, unknown>).name).trim());
        }
      }
    }
    return values;
  }

  private extractCountryCode(value: string) {
    const normalized = value.trim();
    if (!normalized) {
      return null;
    }
    const upper = normalized.toUpperCase();
    if (/^[A-Z]{2,3}$/.test(upper)) {
      return upper;
    }
    for (const token of upper.split(/[^A-Z]+/).filter(Boolean)) {
      if (/^[A-Z]{2,3}$/.test(token)) {
        return token;
      }
    }
    return null;
  }

  private normalizeTerm(value: string) {
    return value.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 128);
  }

  private async loadLatestTopicSentiments(orgId: string, topics: string[]) {
    if (topics.length === 0) {
      return new Map<
        string,
        NonNullable<UserDigestEventV1["topicSentiment"]>
      >();
    }

    const rows = await this.prisma.topicSentimentSnapshot.findMany({
      where: { orgId, topic: { in: topics } },
      orderBy: [{ topic: "asc" }, { bucketStart: "desc" }],
      select: {
        topic: true,
        bucketStart: true,
        totalDocs: true,
        avgScore: true,
        negativeRatio: true,
      },
    });

    const topicSentimentByTopic = new Map<
      string,
      NonNullable<UserDigestEventV1["topicSentiment"]>
    >();
    for (const row of rows) {
      if (topicSentimentByTopic.has(row.topic)) {
        continue;
      }
      topicSentimentByTopic.set(row.topic, {
        bucketStart: row.bucketStart.toISOString(),
        totalDocs: row.totalDocs,
        avgScore: row.avgScore,
        negativeRatio: row.negativeRatio,
      });
    }

    return topicSentimentByTopic;
  }

  private async loadLatestEntitySentiments(
    orgId: string,
    entityNames: string[],
  ) {
    if (entityNames.length === 0) {
      return new Map<
        string,
        NonNullable<UserDigestEventV1["entitySentiment"]>
      >();
    }

    const rows = await this.prisma.entitySentimentSnapshot.findMany({
      where: { orgId, entityName: { in: entityNames } },
      orderBy: [
        { entityName: "asc" },
        { bucketStart: "desc" },
        { entityType: "asc" },
      ],
      select: {
        entityName: true,
        bucketStart: true,
        totalDocs: true,
        avgScore: true,
        negativeRatio: true,
      },
    });

    const entitySentimentByEntity = new Map<
      string,
      NonNullable<UserDigestEventV1["entitySentiment"]>
    >();
    for (const row of rows) {
      if (entitySentimentByEntity.has(row.entityName)) {
        continue;
      }
      entitySentimentByEntity.set(row.entityName, {
        bucketStart: row.bucketStart.toISOString(),
        totalDocs: row.totalDocs,
        avgScore: row.avgScore,
        negativeRatio: row.negativeRatio,
      });
    }

    return entitySentimentByEntity;
  }

  private async loadIndicatorAssociationsByScope(
    orgId: string,
    events: { primaryTopic: string | null; primaryEntity: string | null }[],
    limit: number,
  ) {
    const scopeKeys = new Map<
      string,
      { scopeType: NewsIndicatorScopeType; scopeKey: string }
    >();
    for (const event of events) {
      if (event.primaryTopic) {
        scopeKeys.set(`topic:${event.primaryTopic}`, {
          scopeType: NewsIndicatorScopeType.topic,
          scopeKey: event.primaryTopic,
        });
      }
      if (event.primaryEntity) {
        scopeKeys.set(`entity:${event.primaryEntity}`, {
          scopeType: NewsIndicatorScopeType.entity,
          scopeKey: event.primaryEntity,
        });
      }
    }
    const uniqueScopes = Array.from(scopeKeys.values());
    if (uniqueScopes.length === 0) {
      return new Map<
        string,
        NonNullable<UserDigestEventV1["indicatorAssociations"]>
      >();
    }
    const perEventLimit = Math.min(Math.max(limit, 1), 50);

    const rows = await this.prisma.newsIndicatorAssociation.findMany({
      where: {
        orgId,
        featureMetric: NewsIndicatorFeatureMetric.volume,
        OR: uniqueScopes.map((scope) => ({
          scopeType: scope.scopeType,
          scopeKey: scope.scopeKey,
        })),
      },
      select: {
        scopeType: true,
        scopeKey: true,
        featureMetric: true,
        lagDays: true,
        correlation: true,
        pValue: true,
        indicatorItem: {
          select: {
            slug: true,
            displayName: true,
          },
        },
        backtests: {
          select: {
            createdAt: true,
            metrics: true,
          },
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
      take: Math.min(perEventLimit * uniqueScopes.length * 3, 5000),
      orderBy: [
        { scopeType: "asc" },
        { scopeKey: "asc" },
        { lastEvaluatedAt: "desc" },
        { correlation: "desc" },
        { lagDays: "asc" },
        { id: "asc" },
      ],
    });

    const grouped = new Map<
      string,
      NonNullable<UserDigestEventV1["indicatorAssociations"]>
    >();
    for (const row of rows) {
      const key = `${row.scopeType}:${row.scopeKey}`;
      const existing = grouped.get(key) ?? [];
      existing.push({
        scopeType: row.scopeType,
        featureMetric: row.featureMetric,
        indicatorSlug: row.indicatorItem.slug,
        indicatorDisplayName:
          row.indicatorItem.displayName ?? row.indicatorItem.slug,
        lagDays: row.lagDays,
        correlation: row.correlation,
        pValue: row.pValue ?? null,
        latestBacktest:
          row.backtests.length > 0
            ? {
                createdAt: row.backtests[0]!.createdAt.toISOString(),
                metrics: row.backtests[0]!.metrics ?? null,
              }
            : null,
      });
      grouped.set(key, existing);
    }

    for (const [key, entries] of grouped) {
      grouped.set(
        key,
        entries
          .sort(
            (left, right) =>
              Math.abs(right.correlation) - Math.abs(left.correlation),
          )
          .slice(0, perEventLimit),
      );
    }

    return grouped;
  }
}
