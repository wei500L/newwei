import { Injectable } from "@nestjs/common";
import { NewsEventStatus, NewsIndicatorFeatureMetric, NewsIndicatorScopeType, Prisma } from "@prisma/client";

import { toPrismaJsonValue } from "../../common/prisma-json";
import { PrismaService } from "../config/prisma.service";

const DAY_MS = 24 * 60 * 60 * 1000;
const USER_DIGEST_PREFERENCE_KEY = "ai:digest:preference:v1";

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

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
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

function normalizePreference(value: unknown, fallback?: UserDigestPreferenceV1): UserDigestPreferenceV1 {
  const defaults: UserDigestPreferenceV1 =
    fallback ?? {
      version: 1,
      focusEntities: [],
      focusTopics: [],
      windowDays: 3,
      maxEvents: 8,
      includeIndicators: true,
      maxIndicatorsPerEvent: 5
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
    includeIndicators: typeof record.includeIndicators === "boolean" ? record.includeIndicators : defaults.includeIndicators,
    maxIndicatorsPerEvent: clampInt(record.maxIndicatorsPerEvent, 0, 50, defaults.maxIndicatorsPerEvent)
  };
}

@Injectable()
export class UserDigestService {
  constructor(private readonly prisma: PrismaService) {}

  async getPreference(orgId: string, userId: string): Promise<UserDigestPreferenceV1> {
    const record = await this.prisma.userSetting.findUnique({
      where: {
        orgId_userId_key: {
          orgId,
          userId,
          key: USER_DIGEST_PREFERENCE_KEY
        }
      },
      select: { value: true }
    });
    return normalizePreference(record?.value);
  }

  async updatePreference(
    orgId: string,
    userId: string,
    input: Partial<UserDigestPreferenceV1>
  ): Promise<UserDigestPreferenceV1> {
    const current = await this.getPreference(orgId, userId);
    const merged: UserDigestPreferenceV1 = normalizePreference({ ...current, ...input }, current);

    await this.prisma.userSetting.upsert({
      where: {
        orgId_userId_key: {
          orgId,
          userId,
          key: USER_DIGEST_PREFERENCE_KEY
        }
      },
      update: {
        value: toPrismaJsonValue(merged)
      },
      create: {
        orgId,
        userId,
        key: USER_DIGEST_PREFERENCE_KEY,
        value: toPrismaJsonValue(merged)
      }
    });

    return merged;
  }

  async generateDigest(orgId: string, userId: string): Promise<UserDigestV1> {
    const preference = await this.getPreference(orgId, userId);
    const now = new Date();
    const windowEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const windowStart = new Date(windowEnd.getTime() - preference.windowDays * DAY_MS);

    const events = await this.loadEvents(orgId, preference, windowStart);
    const enriched = await Promise.all(events.map((event) => this.enrichEvent(orgId, event, preference)));

    return {
      version: 1,
      generatedAt: new Date().toISOString(),
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      preference,
      events: enriched
    };
  }

  private async loadEvents(orgId: string, preference: UserDigestPreferenceV1, since: Date) {
    const focusTopics = preference.focusTopics;
    const focusEntities = preference.focusEntities;

    const filters: Prisma.NewsEventWhereInput[] = [];
    if (focusTopics.length > 0) {
      filters.push({ primaryTopic: { in: focusTopics } });
    }
    if (focusEntities.length > 0) {
      filters.push({ primaryEntity: { in: focusEntities } });
    }

    const baseWhere: Prisma.NewsEventWhereInput = {
      orgId,
      status: NewsEventStatus.active,
      lastAt: { gte: since }
    };

    const primary = await this.prisma.newsEvent.findMany({
      where: filters.length > 0 ? { ...baseWhere, OR: filters } : baseWhere,
      orderBy: [{ lastAt: "desc" }, { startAt: "desc" }],
      take: preference.maxEvents,
      include: {
        _count: { select: { items: true } },
        representativeProcessedArticle: {
          include: {
            article: { select: { url: true } }
          }
        }
      }
    });

    if (primary.length >= preference.maxEvents || filters.length === 0) {
      return primary;
    }

    const already = new Set(primary.map((event) => event.id));
    const remaining = preference.maxEvents - primary.length;

    const fallback = await this.prisma.newsEvent.findMany({
      where: {
        ...baseWhere,
        id: { notIn: Array.from(already) }
      },
      orderBy: [{ lastAt: "desc" }, { startAt: "desc" }],
      take: remaining,
      include: {
        _count: { select: { items: true } },
        representativeProcessedArticle: {
          include: {
            article: { select: { url: true } }
          }
        }
      }
    });

    return [...primary, ...fallback];
  }

  private async enrichEvent(
    orgId: string,
    event: {
      id: string;
      title: string | null;
      summary: string | null;
      primaryTopic: string | null;
      primaryEntity: string | null;
      startAt: Date;
      lastAt: Date;
      _count?: { items: number };
      representativeProcessedArticle?: { article?: { url: string } | null } | null;
    },
    preference: UserDigestPreferenceV1
  ): Promise<UserDigestEventV1> {
    const [topicSentiment, entitySentiment, indicatorAssociations] = await Promise.all([
      event.primaryTopic ? this.loadLatestTopicSentiment(orgId, event.primaryTopic) : Promise.resolve(null),
      event.primaryEntity ? this.loadLatestEntitySentiment(orgId, event.primaryEntity) : Promise.resolve(null),
      preference.includeIndicators && preference.maxIndicatorsPerEvent > 0
        ? this.loadIndicatorAssociations(orgId, event, preference.maxIndicatorsPerEvent)
        : Promise.resolve([])
    ]);

    return {
      eventId: event.id,
      title: event.title,
      summary: event.summary,
      primaryTopic: event.primaryTopic,
      primaryEntity: event.primaryEntity,
      startAt: event.startAt.toISOString(),
      lastAt: event.lastAt.toISOString(),
      itemCount: event._count?.items ?? 0,
      representativeUrl: event.representativeProcessedArticle?.article?.url ?? null,
      topicSentiment,
      entitySentiment,
      ...(indicatorAssociations.length > 0 ? { indicatorAssociations } : {})
    };
  }

  private async loadLatestTopicSentiment(orgId: string, topic: string) {
    const row = await this.prisma.topicSentimentSnapshot.findFirst({
      where: { orgId, topic },
      orderBy: { bucketStart: "desc" },
      select: { bucketStart: true, totalDocs: true, avgScore: true, negativeRatio: true }
    });
    if (!row) {
      return null;
    }
    return {
      bucketStart: row.bucketStart.toISOString(),
      totalDocs: row.totalDocs,
      avgScore: row.avgScore,
      negativeRatio: row.negativeRatio
    };
  }

  private async loadLatestEntitySentiment(orgId: string, entityName: string) {
    const rows = await this.prisma.entitySentimentSnapshot.findMany({
      where: { orgId, entityName },
      orderBy: [{ bucketStart: "desc" }, { entityType: "asc" }],
      take: 3,
      select: { bucketStart: true, totalDocs: true, avgScore: true, negativeRatio: true }
    });
    const row = rows[0];
    if (!row) {
      return null;
    }
    return {
      bucketStart: row.bucketStart.toISOString(),
      totalDocs: row.totalDocs,
      avgScore: row.avgScore,
      negativeRatio: row.negativeRatio
    };
  }

  private async loadIndicatorAssociations(
    orgId: string,
    event: { primaryTopic: string | null; primaryEntity: string | null },
    limit: number
  ) {
    const clauses: Prisma.NewsIndicatorAssociationWhereInput[] = [];

    if (event.primaryTopic) {
      clauses.push({
        scopeType: NewsIndicatorScopeType.topic,
        scopeKey: event.primaryTopic,
        featureMetric: NewsIndicatorFeatureMetric.volume
      });
    }
    if (event.primaryEntity) {
      clauses.push({
        scopeType: NewsIndicatorScopeType.entity,
        scopeKey: event.primaryEntity,
        featureMetric: NewsIndicatorFeatureMetric.volume
      });
    }

    if (clauses.length === 0) {
      return [];
    }

    const rows = await this.prisma.newsIndicatorAssociation.findMany({
      where: { orgId, OR: clauses },
      include: {
        indicatorItem: true,
        backtests: {
          orderBy: { createdAt: "desc" },
          take: 1
        }
      },
      take: Math.min(Math.max(limit, 1), 50) * 3
    });

    rows.sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));
    const selected = rows.slice(0, Math.min(Math.max(limit, 1), 50));

    return selected.map((row) => ({
      scopeType: row.scopeType,
      featureMetric: row.featureMetric,
      indicatorSlug: row.indicatorItem.slug,
      indicatorDisplayName: row.indicatorItem.displayName ?? row.indicatorItem.slug,
      lagDays: row.lagDays,
      correlation: row.correlation,
      pValue: row.pValue ?? null,
      latestBacktest:
        row.backtests.length > 0
          ? {
              createdAt: row.backtests[0]!.createdAt.toISOString(),
              metrics: row.backtests[0]!.metrics ?? null
            }
          : null
    }));
  }
}

