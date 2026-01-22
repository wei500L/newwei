import { createLogger } from "@modular/utils";
import { Injectable } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { NewsEventStatus, Prisma } from "@prisma/client";

import { PrismaService } from "../config/prisma.service";

import { NewsEventsSettingsService } from "./news-events-settings.service";

const logger = createLogger({ name: "news-events-timeline" });

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_ITEMS_PER_EVENT = 5_000;
const MAX_REFERENCED_ARTICLES_PER_BUCKET = 20;

interface TimelineSourceItem {
  processedArticleId: string;
  articleId: string;
  timestamp: Date;
  title: string | null;
  summary: string | null;
  keyPoints: Prisma.JsonValue | null;
  qualityScore: number | null;
}

@Injectable()
export class NewsEventsTimelineService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: NewsEventsSettingsService
  ) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async rebuildRecentTimelines() {
    const orgs = await this.prisma.org.findMany({
      where: { isActive: true },
      select: { id: true }
    });

    for (const org of orgs) {
      try {
        await this.rebuildOrg(org.id);
      } catch (error) {
        logger.warn({ err: error, orgId: org.id }, "News event timeline rebuild failed");
      }
    }
  }

  private async rebuildOrg(orgId: string) {
    const settings = await this.settings.getSettings(orgId);
    if (!settings.enabled || !settings.ingestionEnabled || !settings.timelineEnabled) {
      return;
    }

    const windowDays = Math.max(settings.backfillDays, settings.lookbackDays);
    const since = new Date(Date.now() - windowDays * DAY_MS);
    const events = await this.prisma.newsEvent.findMany({
      where: { orgId, status: NewsEventStatus.active, lastAt: { gte: since } },
      orderBy: [{ lastAt: "desc" }, { startAt: "desc" }],
      take: settings.timelineMaxEventsPerRun
    });

    if (events.length === 0) {
      return;
    }

    let processedEvents = 0;
    let upserts = 0;

    for (const event of events) {
      const items = await this.loadEventItems(orgId, event.id, windowDays);
      if (items.length === 0) {
        processedEvents += 1;
        continue;
      }

      const buckets = this.groupByDayBucket(items);
      const bucketStarts = Array.from(buckets.keys()).sort((a, b) => a.getTime() - b.getTime());

      for (const bucketStart of bucketStarts) {
        const bucketItems = buckets.get(bucketStart);
        if (!bucketItems || bucketItems.length === 0) {
          continue;
        }
        const entry = this.buildTimelineEntry(event.id, bucketStart, bucketItems);
        const keyPoints =
          entry.keyPoints === null
            ? Prisma.DbNull
            : (JSON.parse(JSON.stringify(entry.keyPoints)) as Prisma.InputJsonValue);
        const referencedArticleIds =
          entry.referencedArticleIds.length > 0
            ? (JSON.parse(JSON.stringify(entry.referencedArticleIds)) as Prisma.InputJsonValue)
            : Prisma.DbNull;
        await this.prisma.newsEventTimelineEntry.upsert({
          where: {
            eventId_bucketStart: {
              eventId: entry.eventId,
              bucketStart: entry.bucketStart
            }
          },
          create: {
            orgId,
            eventId: entry.eventId,
            bucketStart: entry.bucketStart,
            title: entry.title,
            summary: entry.summary,
            keyPoints,
            referencedArticleIds
          },
          update: {
            title: entry.title,
            summary: entry.summary,
            keyPoints,
            referencedArticleIds
          }
        });
        upserts += 1;
      }

      processedEvents += 1;
    }

    logger.info({ orgId, processedEvents, upserts }, "News event timeline rebuild completed");
  }

  private async loadEventItems(orgId: string, eventId: string, windowDays: number): Promise<TimelineSourceItem[]> {
    const since = new Date(Date.now() - windowDays * DAY_MS);
    const rows = await this.prisma.newsEventItem.findMany({
      where: { orgId, eventId, processedArticle: { processedAt: { gte: since } } },
      orderBy: [{ createdAt: "desc" }],
      take: MAX_ITEMS_PER_EVENT,
      include: {
        processedArticle: {
          select: {
            id: true,
            articleId: true,
            title: true,
            summary: true,
            keyPoints: true,
            qualityScore: true,
            publishedAt: true,
            processedAt: true,
            article: { select: { crawlAt: true } }
          }
        }
      }
    });

    return rows.map((row) => {
      const processed = row.processedArticle;
      const timestamp = processed.publishedAt ?? processed.article?.crawlAt ?? processed.processedAt;
      return {
        processedArticleId: processed.id,
        articleId: processed.articleId,
        timestamp,
        title: processed.title,
        summary: processed.summary,
        keyPoints: processed.keyPoints,
        qualityScore: typeof processed.qualityScore === "number" ? processed.qualityScore : null
      };
    });
  }

  private groupByDayBucket(items: TimelineSourceItem[]) {
    const buckets = new Map<Date, TimelineSourceItem[]>();
    for (const item of items) {
      const bucketStart = this.toUtcDayStart(item.timestamp);
      const existing = buckets.get(bucketStart);
      if (existing) {
        existing.push(item);
      } else {
        buckets.set(bucketStart, [item]);
      }
    }
    return buckets;
  }

  private buildTimelineEntry(eventId: string, bucketStart: Date, items: TimelineSourceItem[]) {
    const sorted = items.slice().sort((a, b) => this.compareTimelineItems(a, b));
    const primary = sorted[0]!;
    const referencedArticleIds = Array.from(new Set(items.map((item) => item.articleId)))
      .filter((id) => typeof id === "string" && id.length > 0)
      .sort()
      .slice(0, MAX_REFERENCED_ARTICLES_PER_BUCKET);

    return {
      eventId,
      bucketStart,
      title: primary.title,
      summary: primary.summary,
      keyPoints: primary.keyPoints,
      referencedArticleIds
    };
  }

  private compareTimelineItems(a: TimelineSourceItem, b: TimelineSourceItem) {
    const timeDelta = b.timestamp.getTime() - a.timestamp.getTime();
    if (timeDelta !== 0) {
      return timeDelta;
    }
    const qualityA = typeof a.qualityScore === "number" ? a.qualityScore : -1;
    const qualityB = typeof b.qualityScore === "number" ? b.qualityScore : -1;
    const qualityDelta = qualityB - qualityA;
    if (qualityDelta !== 0) {
      return qualityDelta;
    }
    return a.processedArticleId.localeCompare(b.processedArticleId);
  }

  private toUtcDayStart(value: Date): Date {
    const d = new Date(value);
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  }
}
