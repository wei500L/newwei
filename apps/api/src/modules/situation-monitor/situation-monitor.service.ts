import { RawItemModel, ProcessedItemModel } from "@modular/mongo";
import type { MongoConnection } from "@modular/mongo";
import { Inject, Injectable } from "@nestjs/common";

import { CacheService } from "../cache/cache.service";
import { MONGO_CONNECTION } from "../config/mongo.provider";

import { analyzeCorrelations, getCorrelationSummary } from "./analysis/correlation";
import { calculateMainCharacter, getMainCharacterSummary } from "./analysis/main-character";
import { analyzeNarratives, getNarrativeSummary } from "./analysis/narrative";
import type { SituationNewsItem } from "./analysis/types";

const HISTORY_RETENTION_MINUTES = 30;
const MOMENTUM_WINDOW_MINUTES = 10;
const CORRELATION_COUNTS_KEY_PREFIX = "situation-monitor:correlation:counts";

const SITUATION_MONITOR_CATEGORIES = ["politics", "tech", "finance", "gov", "ai", "intel"] as const;
type SituationMonitorCategory = (typeof SITUATION_MONITOR_CATEGORIES)[number];

const CATEGORY_TAG_PREFIX = "sm:";
const SOURCE_TAG = "situation-monitor";

const ALERT_KEYWORDS = [
  "war",
  "invasion",
  "military",
  "nuclear",
  "sanctions",
  "missile",
  "attack",
  "troops",
  "conflict",
  "strike",
  "bomb",
  "casualties",
  "ceasefire",
  "treaty",
  "nato",
  "coup",
  "martial law",
  "emergency",
  "assassination",
  "terrorist",
  "hostage",
  "evacuation",
] as const;

export interface SituationMonitorHeadline {
  id: string;
  title: string;
  link: string;
  source: string;
  timestamp: number;
  category: SituationMonitorCategory;
  isAlert: boolean;
  alertKeyword?: string;
}

export interface SituationMonitorInsightsResponse {
  generatedAt: string;
  windowHours: number;
  maxItems: number;
  analyzedItems: number;
  headlines: Record<SituationMonitorCategory, SituationMonitorHeadline[]>;
  correlation: ReturnType<typeof analyzeCorrelations>["results"];
  correlationSummary: ReturnType<typeof getCorrelationSummary>;
  narrative: ReturnType<typeof analyzeNarratives>;
  narrativeSummary: ReturnType<typeof getNarrativeSummary>;
  mainCharacter: ReturnType<typeof calculateMainCharacter>;
  mainCharacterSummary: ReturnType<typeof getMainCharacterSummary>;
}

@Injectable()
export class SituationMonitorService {
  constructor(
    private readonly cache: CacheService,
    @Inject(MONGO_CONNECTION) private readonly _mongo: MongoConnection,
  ) {
    void this._mongo;
  }

  async getInsights(
    orgId: string,
    options?: { windowHours?: number; maxItems?: number }
  ): Promise<SituationMonitorInsightsResponse> {
    const windowHours = this.clampInt(options?.windowHours, 1, 168, 24);
    const maxItems = this.clampInt(options?.maxItems, 50, 1000, 400);
    const maxHeadlinesPerCategory = 12;

    const since = new Date(Date.now() - windowHours * 60 * 60 * 1000);

    const processed = await ProcessedItemModel.find({
      orgId,
      status: "completed",
      duplicateOf: null,
      createdAt: { $gte: since },
    })
      .sort({ sortAt: -1, createdAt: -1 })
      .limit(maxItems)
      .select({ rawItemId: 1, result: 1, tags: 1, sortAt: 1, createdAt: 1 })
      .lean()
      .exec();

    const rawItemIds: string[] = processed
      .map((item) => item.rawItemId)
      .filter((id) => Boolean(id))
      .map((id) => String(id));

    const rawItems = rawItemIds.length
      ? await RawItemModel.find({ _id: { $in: rawItemIds } })
          .select({ _id: 1, payload: 1 })
          .lean()
          .exec()
      : [];

    const rawById = new Map<string, (typeof rawItems)[number]>();
    for (const raw of rawItems) {
      rawById.set(String(raw._id), raw);
    }

    const news: SituationNewsItem[] = [];
    for (const item of processed) {
      const raw = rawById.get(String(item.rawItemId));
      const url =
        raw?.payload && typeof raw.payload === "object" && !Array.isArray(raw.payload)
          ? (raw.payload as Record<string, unknown>).url
          : undefined;
      const link = typeof url === "string" ? url.trim() : "";
      const title =
        item.result && typeof item.result === "object" && !Array.isArray(item.result)
          ? ((item.result as Record<string, unknown>).title as string | null | undefined) ?? ""
          : "";
      const trimmedTitle = typeof title === "string" ? title.trim() : "";

      if (!trimmedTitle || !link) {
        continue;
      }

      const rawSourceName =
        raw?.payload && typeof raw.payload === "object" && !Array.isArray(raw.payload)
          ? (raw.payload as Record<string, unknown>).sourceName
          : undefined;
      const extractedSource =
        item.result && typeof item.result === "object" && !Array.isArray(item.result)
          ? (item.result as Record<string, unknown>).source
          : undefined;

      const source =
        (typeof extractedSource === "string" && extractedSource.trim()) ||
        (typeof rawSourceName === "string" && rawSourceName.trim()) ||
        this.tryDomain(link) ||
        "Unknown";

      const sortAt = this.toDate(item.sortAt);
      const createdAt = this.toDate(item.createdAt);
      const timestamp = (sortAt ?? createdAt ?? new Date()).getTime();

      news.push({ title: trimmedTitle, link, source, timestamp });
    }

    const headlines = await this.buildHeadlinesByCategory({
      orgId,
      since,
      maxPerCategory: maxHeadlinesPerCategory,
    });

    const nowMinute = Math.floor(Date.now() / 60_000);
    const previousMinute = nowMinute - MOMENTUM_WINDOW_MINUTES;
    const ttlSeconds = (HISTORY_RETENTION_MINUTES + MOMENTUM_WINDOW_MINUTES + 5) * 60;

    const previousCountsKey = `${CORRELATION_COUNTS_KEY_PREFIX}:${orgId}:${previousMinute}`;
    const currentCountsKey = `${CORRELATION_COUNTS_KEY_PREFIX}:${orgId}:${nowMinute}`;

    const previousCounts = await this.cache.get<Record<string, number>>(previousCountsKey);
    const { results: correlation, topicCounts } = analyzeCorrelations(news, {
      previousCounts: previousCounts ?? undefined,
    });
    await this.cache.set(currentCountsKey, topicCounts, ttlSeconds);

    const narrative = analyzeNarratives(news);
    const mainCharacter = calculateMainCharacter(news);

    return {
      generatedAt: new Date().toISOString(),
      windowHours,
      maxItems,
      analyzedItems: news.length,
      headlines,
      correlation,
      correlationSummary: getCorrelationSummary(correlation),
      narrative,
      narrativeSummary: getNarrativeSummary(narrative),
      mainCharacter,
      mainCharacterSummary: getMainCharacterSummary(mainCharacter),
    };
  }

  private async buildHeadlinesByCategory(options: {
    orgId: string;
    since: Date;
    maxPerCategory: number;
  }): Promise<Record<SituationMonitorCategory, SituationMonitorHeadline[]>> {
    const byCategory: Record<SituationMonitorCategory, SituationMonitorHeadline[]> = {
      politics: [],
      tech: [],
      finance: [],
      gov: [],
      ai: [],
      intel: [],
    };

    const maxCandidates = Math.max(50, options.maxPerCategory * SITUATION_MONITOR_CATEGORIES.length * 6);

    const processed = await ProcessedItemModel.find({
      orgId: options.orgId,
      status: "completed",
      duplicateOf: null,
      createdAt: { $gte: options.since },
      tags: SOURCE_TAG,
    })
      .sort({ sortAt: -1, createdAt: -1 })
      .limit(maxCandidates)
      .select({ rawItemId: 1, result: 1, tags: 1, sortAt: 1, createdAt: 1 })
      .lean()
      .exec();

    const rawItemIds: string[] = processed
      .map((item) => item.rawItemId)
      .filter((id) => Boolean(id))
      .map((id) => String(id));

    const rawItems = rawItemIds.length
      ? await RawItemModel.find({ _id: { $in: rawItemIds } })
          .select({ _id: 1, payload: 1 })
          .lean()
          .exec()
      : [];

    const rawById = new Map<string, (typeof rawItems)[number]>();
    for (const raw of rawItems) {
      rawById.set(String(raw._id), raw);
    }

    for (const item of processed) {
      const category = this.extractCategory(item.tags);
      if (!category) {
        continue;
      }
      if (byCategory[category].length >= options.maxPerCategory) {
        continue;
      }

      const raw = rawById.get(String(item.rawItemId));
      const url =
        raw?.payload && typeof raw.payload === "object" && !Array.isArray(raw.payload)
          ? (raw.payload as Record<string, unknown>).url
          : undefined;
      const link = typeof url === "string" ? url.trim() : "";

      const title =
        item.result && typeof item.result === "object" && !Array.isArray(item.result)
          ? ((item.result as Record<string, unknown>).title as string | null | undefined) ?? ""
          : "";
      const trimmedTitle = typeof title === "string" ? title.trim() : "";

      if (!trimmedTitle || !link) {
        continue;
      }

      const rawSourceName =
        raw?.payload && typeof raw.payload === "object" && !Array.isArray(raw.payload)
          ? (raw.payload as Record<string, unknown>).sourceName
          : undefined;
      const extractedSource =
        item.result && typeof item.result === "object" && !Array.isArray(item.result)
          ? (item.result as Record<string, unknown>).source
          : undefined;

      const source =
        (typeof extractedSource === "string" && extractedSource.trim()) ||
        (typeof rawSourceName === "string" && rawSourceName.trim()) ||
        this.tryDomain(link) ||
        "Unknown";

      const sortAt = this.toDate(item.sortAt);
      const createdAt = this.toDate(item.createdAt);
      const timestamp = (sortAt ?? createdAt ?? new Date()).getTime();

      const alertKeyword = this.findAlertKeyword(trimmedTitle);

      byCategory[category].push({
        id: String((item as { _id?: unknown })._id ?? link),
        title: trimmedTitle,
        link,
        source,
        timestamp,
        category,
        isAlert: Boolean(alertKeyword),
        alertKeyword: alertKeyword ?? undefined,
      });
    }

    return byCategory;
  }

  private extractCategory(tags: unknown): SituationMonitorCategory | null {
    if (!Array.isArray(tags)) {
      return null;
    }
    for (const tag of tags) {
      if (typeof tag !== "string") {
        continue;
      }
      if (!tag.startsWith(CATEGORY_TAG_PREFIX)) {
        continue;
      }
      const category = tag.slice(CATEGORY_TAG_PREFIX.length).trim().toLowerCase();
      if ((SITUATION_MONITOR_CATEGORIES as readonly string[]).includes(category)) {
        return category as SituationMonitorCategory;
      }
    }
    return null;
  }

  private findAlertKeyword(title: string): string | null {
    const haystack = title.toLowerCase();
    for (const keyword of ALERT_KEYWORDS) {
      if (haystack.includes(keyword)) {
        return keyword;
      }
    }
    return null;
  }

  private clampInt(value: unknown, min: number, max: number, fallback: number) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return fallback;
    }
    const rounded = Math.round(value);
    return Math.max(min, Math.min(max, rounded));
  }

  private tryDomain(url: string) {
    try {
      return new URL(url).hostname;
    } catch {
      return undefined;
    }
  }

  private toDate(value: unknown): Date | null {
    if (!value) {
      return null;
    }
    if (value instanceof Date && Number.isFinite(value.valueOf())) {
      return value;
    }
    if (typeof value === "number" || typeof value === "string") {
      const candidate = new Date(value);
      if (Number.isFinite(candidate.valueOf())) {
        return candidate;
      }
    }
    return null;
  }
}
