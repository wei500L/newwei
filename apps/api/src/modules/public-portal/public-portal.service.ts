import { Injectable } from "@nestjs/common";
import { NewsEventStatus, type Prisma } from "@prisma/client";

import { PrismaService } from "../config/prisma.service";
import { NewsEventBriefService } from "../news-events/news-event-brief.service";
import {
  NewsEventsService,
  type NewsEventAuthorityProfile,
} from "../news-events/news-events.service";

const PUBLIC_PORTAL_ORG_SLUG_KEY = "public_portal_org_slug";
const STORY_LIMIT = 12;
const STORY_FETCH_LIMIT = 96;
const MIN_ITEM_COUNT = 2;
const MIN_CREDIBILITY_SCORE = 60;
const TOPIC_FALLBACK = "Top stories";

type PortalTopicSummary = {
  topic: string;
  topicSlug: string;
  storyCount: number;
  latestAt: string;
};

type PublicPortalStory = {
  id: string;
  slug: string;
  title: string;
  summary: string;
  topic: string;
  topicSlug: string;
  primaryEntity: string | null;
  language: string | null;
  lastAt: string;
  startAt: string;
  itemCount: number;
  breaking: boolean;
  heatScore: number;
  credibilityScore: number;
  sourceType: NewsEventAuthorityProfile["sourceType"];
  sourceEvidence: {
    uniqueSourceCount: number;
    authoritativeSourceCount: number;
    blogSourceCount: number;
    corroborated: boolean;
  };
};

type SelectedPortalEventRow = Prisma.NewsEventGetPayload<{
  select: {
    id: true;
    orgId: true;
    title: true;
    summary: true;
    primaryTopic: true;
    primaryEntity: true;
    language: true;
    startAt: true;
    lastAt: true;
    representativeProcessedArticleId: true;
    _count: {
      select: {
        items: true;
      };
    };
  };
}>;

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function sanitizeSlugSegment(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || "story";
}

function buildStorySlug(id: string, title: string): string {
  return `${id}-${sanitizeSlugSegment(title)}`;
}

function extractStoryId(slugOrId: string): string {
  const normalized = slugOrId.trim();
  if (!normalized) {
    return "";
  }
  const separatorIndex = normalized.indexOf("-");
  return separatorIndex > 0 ? normalized.slice(0, separatorIndex) : normalized;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
}

@Injectable()
export class PublicPortalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly newsEvents: NewsEventsService,
    private readonly newsEventBriefs: NewsEventBriefService,
  ) {}

  async getHome() {
    const org = await this.resolvePublicOrg();
    const stories = await this.listPortalStories(org.id, { limit: STORY_LIMIT });

    return {
      generatedAt: new Date().toISOString(),
      org,
      featuredStory: stories[0] ?? null,
      latestStories: stories.slice(1),
      channels: this.buildTopicSummaries(stories),
    };
  }

  async getChannel(topic: string) {
    const org = await this.resolvePublicOrg();
    const stories = await this.listPortalStories(org.id, {
      limit: 18,
      topicSlug: sanitizeSlugSegment(topic),
    });

    return {
      generatedAt: new Date().toISOString(),
      org,
      topic:
        stories[0]?.topic ??
        normalizeOptionalString(topic)?.replace(/-/g, " ") ??
        TOPIC_FALLBACK,
      topicSlug: sanitizeSlugSegment(topic),
      storyCount: stories.length,
      stories,
    };
  }

  async getStoryById(id: string) {
    return this.getStoryDetailByEventId(extractStoryId(id));
  }

  async getStoryBySlug(slug: string) {
    return this.getStoryDetailByEventId(extractStoryId(slug));
  }

  private async getStoryDetailByEventId(eventId: string) {
    const normalizedId = normalizeOptionalString(eventId);
    if (!normalizedId) {
      return null;
    }

    const org = await this.resolvePublicOrg();
    const event = await this.newsEvents.getEvent(org.id, normalizedId, {
      itemsLimit: 24,
      timelineLimit: 12,
    });
    if (!event || !event.title || !event.summary) {
      return null;
    }

    const [heatMap, authorityMap, brief] = await Promise.all([
      this.newsEvents.getEventHeatMap(org.id, [event.id]),
      this.newsEvents.getEventAuthorityMap(org.id, [event.id]),
      this.newsEventBriefs.getBrief(org.id, event.id, {
        language: event.language ?? undefined,
      }),
    ]);

    const story = this.toStoryCard(
      {
        id: event.id,
        orgId: event.orgId,
        title: event.title,
        summary: event.summary,
        primaryTopic: event.primaryTopic,
        primaryEntity: event.primaryEntity,
        language: event.language,
        startAt: event.startAt,
        lastAt: event.lastAt,
        representativeProcessedArticleId: event.representativeProcessedArticleId,
        _count: { items: event._count.items },
      },
      heatMap.get(event.id),
      authorityMap.get(event.id),
    );

    if (!story) {
      return null;
    }

    const referencedArticleIds = Array.from(
      new Set(
        event.timeline.flatMap((entry) => {
          if (!entry.referencedArticleIds) {
            return [];
          }
          return readStringArray(entry.referencedArticleIds);
        }),
      ),
    );

    const fallbackArticleIds =
      referencedArticleIds.length > 0
        ? referencedArticleIds
        : event.items
            .map((entry) => entry.processedArticle.article?.id ?? "")
            .filter((entry) => entry.length > 0);

    const referencedArticles = await this.newsEvents.listEventReferencedArticles(
      org.id,
      event.id,
      fallbackArticleIds,
      { limit: 12 },
    );

    const relatedStories = await this.listPortalStories(org.id, {
      limit: 4,
      topicSlug: story.topicSlug,
      excludeEventId: story.id,
    });

    return {
      generatedAt: new Date().toISOString(),
      org,
      story: {
        ...story,
        brief: brief
          ? {
              generatedAt: brief.generatedAt.toISOString(),
              language: brief.language,
              payload: brief.payload,
              sources: brief.sources.map((source) => ({
                index: source.index,
                url: source.url,
                sourceLabel: source.sourceLabel,
                title: source.title,
                publishedAt: source.publishedAt?.toISOString() ?? null,
              })),
            }
          : null,
        timeline: event.timeline.map((entry) => ({
          id: entry.id,
          bucketStart: entry.bucketStart.toISOString(),
          title: normalizeOptionalString(entry.title),
          summary: normalizeOptionalString(entry.summary),
        })),
        referencedArticles: referencedArticles.map((article) => ({
          id: article.id,
          url: article.url,
          sourceLabel: article.sourceLabel,
          title: article.title,
          publishedAt: article.publishedAt?.toISOString() ?? null,
        })),
      },
      relatedStories,
    };
  }

  private async listPortalStories(
    orgId: string,
    options: {
      limit: number;
      topicSlug?: string;
      excludeEventId?: string;
    },
  ): Promise<PublicPortalStory[]> {
    const rows = await this.prisma.newsEvent.findMany({
      where: {
        orgId,
        status: NewsEventStatus.active,
        title: { not: null },
        summary: { not: null },
        ...(options.excludeEventId ? { id: { not: options.excludeEventId } } : {}),
      },
      orderBy: [{ lastAt: "desc" }, { startAt: "desc" }],
      take: STORY_FETCH_LIMIT,
      select: {
        id: true,
        orgId: true,
        title: true,
        summary: true,
        primaryTopic: true,
        primaryEntity: true,
        language: true,
        startAt: true,
        lastAt: true,
        representativeProcessedArticleId: true,
        _count: {
          select: {
            items: true,
          },
        },
      },
    });

    const eventIds = rows.map((row) => row.id);
    const [heatMap, authorityMap] = await Promise.all([
      this.newsEvents.getEventHeatMap(orgId, eventIds),
      this.newsEvents.getEventAuthorityMap(orgId, eventIds),
    ]);

    const strictStories = rows
      .map((row) =>
        this.toStoryCard(row, heatMap.get(row.id), authorityMap.get(row.id)),
      )
      .filter((entry): entry is PublicPortalStory => Boolean(entry));

    const filteredStories = strictStories.filter((entry) =>
      options.topicSlug ? entry.topicSlug === options.topicSlug : true,
    );

    return filteredStories.slice(0, options.limit);
  }

  private toStoryCard(
    row: SelectedPortalEventRow,
    heat:
      | {
          breaking: boolean;
          heatScore: number;
        }
      | undefined,
    authority: NewsEventAuthorityProfile | undefined,
  ): PublicPortalStory | null {
    const title = normalizeOptionalString(row.title);
    const summary = normalizeOptionalString(row.summary);
    if (!title || !summary) {
      return null;
    }

    const itemCount = row._count.items ?? 0;
    if (itemCount < MIN_ITEM_COUNT) {
      return null;
    }

    const sourceType = authority?.sourceType ?? "unknown";
    if (sourceType !== "authoritative" && sourceType !== "mixed") {
      return null;
    }

    const credibilityScore = authority?.credibilityScore ?? 0;
    if (credibilityScore < MIN_CREDIBILITY_SCORE) {
      return null;
    }

    const topic =
      normalizeOptionalString(row.primaryTopic) ??
      normalizeOptionalString(row.primaryEntity) ??
      TOPIC_FALLBACK;

    return {
      id: row.id,
      slug: buildStorySlug(row.id, title),
      title,
      summary,
      topic,
      topicSlug: sanitizeSlugSegment(topic),
      primaryEntity: normalizeOptionalString(row.primaryEntity),
      language: normalizeOptionalString(row.language),
      lastAt: row.lastAt.toISOString(),
      startAt: row.startAt.toISOString(),
      itemCount,
      breaking: heat?.breaking ?? false,
      heatScore: heat?.heatScore ?? 0,
      credibilityScore,
      sourceType,
      sourceEvidence: {
        uniqueSourceCount: authority?.uniqueSourceCount ?? 0,
        authoritativeSourceCount: authority?.authoritativeSourceCount ?? 0,
        blogSourceCount: authority?.blogSourceCount ?? 0,
        corroborated: authority?.corroborated ?? false,
      },
    };
  }

  private buildTopicSummaries(stories: PublicPortalStory[]): PortalTopicSummary[] {
    const topicMap = new Map<string, PortalTopicSummary>();

    for (const story of stories) {
      const existing = topicMap.get(story.topicSlug);
      if (existing) {
        existing.storyCount += 1;
        if (story.lastAt > existing.latestAt) {
          existing.latestAt = story.lastAt;
        }
        continue;
      }

      topicMap.set(story.topicSlug, {
        topic: story.topic,
        topicSlug: story.topicSlug,
        storyCount: 1,
        latestAt: story.lastAt,
      });
    }

    return Array.from(topicMap.values()).sort((a, b) =>
      b.latestAt.localeCompare(a.latestAt),
    );
  }

  private async resolvePublicOrg() {
    const configuredSlug = await this.getConfiguredPublicOrgSlug();
    if (configuredSlug) {
      const configuredOrg = await this.prisma.org.findFirst({
        where: {
          slug: configuredSlug,
          isActive: true,
        },
        select: {
          id: true,
          slug: true,
          name: true,
        },
      });
      if (configuredOrg) {
        return configuredOrg;
      }
    }

    const orgFromRecentEvents = await this.prisma.newsEvent.findFirst({
      where: {
        status: NewsEventStatus.active,
        org: {
          isActive: true,
        },
      },
      orderBy: [{ lastAt: "desc" }],
      select: {
        org: {
          select: {
            id: true,
            slug: true,
            name: true,
          },
        },
      },
    });

    if (orgFromRecentEvents?.org) {
      return orgFromRecentEvents.org;
    }

    const fallbackOrg = await this.prisma.org.findFirst({
      where: {
        isActive: true,
      },
      orderBy: [{ updatedAt: "desc" }],
      select: {
        id: true,
        slug: true,
        name: true,
      },
    });

    if (!fallbackOrg) {
      throw new Error("No active organization available for public portal");
    }

    return fallbackOrg;
  }

  private async getConfiguredPublicOrgSlug(): Promise<string | null> {
    const record = await this.prisma.systemSetting.findUnique({
      where: { key: PUBLIC_PORTAL_ORG_SLUG_KEY },
      select: { value: true },
    });

    if (!record) {
      return null;
    }

    if (typeof record.value === "string") {
      return normalizeOptionalString(record.value)?.toLowerCase() ?? null;
    }

    if (
      record.value &&
      typeof record.value === "object" &&
      !Array.isArray(record.value) &&
      typeof (record.value as { slug?: unknown }).slug === "string"
    ) {
      return (
        normalizeOptionalString((record.value as { slug?: unknown }).slug)?.toLowerCase() ??
        null
      );
    }

    return null;
  }
}
