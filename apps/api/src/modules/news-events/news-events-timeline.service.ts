import { ProcessedItemModel } from "@modular/mongo";
import { createLogger } from "@modular/utils";
import { Injectable } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { NewsEventStatus, Prisma } from "@prisma/client";

import { PrismaService } from "../config/prisma.service";

import {
  NewsEventsSettingsService,
  type NewsEventSettings
} from "./news-events-settings.service";

const logger = createLogger({ name: "news-events-timeline" });

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_ITEMS_PER_EVENT = 5_000;
const MAX_REFERENCED_ARTICLES_PER_BUCKET = 20;
const DEFAULT_LOW_CONFIDENCE_THRESHOLD = 0.5;
const DEFAULT_HIGH_CONFIDENCE_THRESHOLD = 0.8;
const DEFAULT_KL_DIVERGENCE_THRESHOLD = 0.35;
const DEFAULT_MIN_BUCKET_ITEMS_FOR_DRIFT = 3;
const DEFAULT_CROSS_CATEGORY_WARNING_SHARE = 0.3;
const DEFAULT_MAX_CATEGORY_DISTRIBUTION_ITEMS = 16;
const DEFAULT_MAX_PHASE_SUMMARIES = 8;
const KL_EPSILON = 1e-6;
const CLASSIFICATION_CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_PRUNE_INTERVAL_MS = 60 * 1000;
const MIN_DRIFT_KL_THRESHOLD = 0;
const MAX_DRIFT_KL_THRESHOLD = 5;
const MIN_MAX_CATEGORY_DISTRIBUTION_ITEMS = 4;
const MAX_MAX_CATEGORY_DISTRIBUTION_ITEMS = 64;
const MIN_MAX_PHASE_SUMMARIES = 1;
const MAX_MAX_PHASE_SUMMARIES = 20;
const MIN_MIN_BUCKET_ITEMS_FOR_DRIFT = 1;
const MAX_MIN_BUCKET_ITEMS_FOR_DRIFT = 50;

interface TimelineSourceItem {
  processedArticleId: string;
  articleId: string;
  processedItemId: string | null;
  timestamp: Date;
  title: string | null;
  summary: string | null;
  keyPoints: Prisma.JsonValue | null;
  qualityScore: number | null;
  legacyCategory: string | null;
  categoryPath: string | null;
  categoryConfidence: number | null;
}

interface ProcessedItemClassification {
  legacyCategory: string | null;
  categoryPath: string | null;
  categoryConfidence: number | null;
}

interface TimelineEntryClassificationMetadata {
  categoryPath: string | null;
  categoryConfidence: number | null;
  tentative: boolean;
  anchor: boolean;
  importanceScore: number;
  itemCount: number;
}

interface TimelinePhaseSummary {
  phase: number;
  label: string;
  categoryPrefix: string;
  startAt: string;
  endAt: string;
  itemCount: number;
  bucketCount: number;
  summary: string;
}

interface TopicDriftWarning {
  fromBucketStart: string;
  toBucketStart: string;
  klDivergence: number;
  fromCategoryPrefix: string;
  toCategoryPrefix: string;
}

interface CategoryDistributionEntry {
  categoryPath: string;
  count: number;
  share: number;
}

interface BuiltTimelineEntry {
  eventId: string;
  bucketStart: Date;
  title: string | null;
  summary: string | null;
  keyPoints: Prisma.JsonValue | null;
  referencedArticleIds: string[];
  classification: TimelineEntryClassificationMetadata;
  distribution: Record<string, number>;
  dominantCategoryPrefix: string;
}

interface TimelineAnalysis {
  categoryDistribution: CategoryDistributionEntry[];
  topicDriftWarning: boolean;
  topicDriftSummary: string | null;
  driftWarnings: TopicDriftWarning[];
  phaseSummaries: TimelinePhaseSummary[];
}

interface TimelineMetadataPayload {
  entries: Record<string, TimelineEntryClassificationMetadata>;
  categoryDistribution: CategoryDistributionEntry[];
  topicDriftWarning: boolean;
  topicDriftSummary: string | null;
  driftWarnings: TopicDriftWarning[];
  phaseSummaries: TimelinePhaseSummary[];
  subEvents: {
    id: string;
    parentEventId: string;
    phase: number;
    title: string;
    categoryPath: string;
    startAt: string;
    endAt: string;
    itemCount: number;
    bucketCount: number;
    summary: string;
  }[];
  updatedAt: string;
}

interface LoadEventItemsResult {
  items: TimelineSourceItem[];
  stats: {
    processedItemIds: number;
    cacheHits: number;
    lookupMs: number;
    classifiedItems: number;
  };
}

interface TimelineRuntimeSettings {
  confidenceFallback: number;
  lowConfidenceThreshold: number;
  highConfidenceThreshold: number;
  driftKlThreshold: number;
  minBucketItemsForDrift: number;
  crossCategoryWarningShare: number;
  maxCategoryDistributionItems: number;
  maxPhaseSummaries: number;
}

@Injectable()
export class NewsEventsTimelineService {
  private readonly processedItemClassificationCache = new Map<
    string,
    { expiresAt: number; value: ProcessedItemClassification | null }
  >();
  private processedItemClassificationCacheLastPruneAt = 0;

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
    const timelineRuntimeSettings = this.resolveTimelineRuntimeSettings(settings);

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
    let driftWarnings = 0;
    let classificationLookupMsTotal = 0;
    let classificationProcessedItemIdsTotal = 0;
    let classificationCacheHitsTotal = 0;
    let classifiedItemsTotal = 0;
    let totalItems = 0;
    const rebuildStartedAt = Date.now();

    for (const event of events) {
      const loaded = await this.loadEventItems(orgId, event.id, windowDays);
      const items = loaded.items;
      classificationLookupMsTotal += loaded.stats.lookupMs;
      classificationProcessedItemIdsTotal += loaded.stats.processedItemIds;
      classificationCacheHitsTotal += loaded.stats.cacheHits;
      classifiedItemsTotal += loaded.stats.classifiedItems;
      totalItems += items.length;
      if (items.length === 0) {
        processedEvents += 1;
        continue;
      }

      const buckets = this.groupByDayBucket(items);
      const bucketKeys = Array.from(buckets.keys()).sort();
      const timelineEntryMetadataByBucket: Record<string, TimelineEntryClassificationMetadata> = {};
      const builtEntries: BuiltTimelineEntry[] = [];

      for (const bucketKey of bucketKeys) {
        const bucket = buckets.get(bucketKey);
        if (!bucket || bucket.items.length === 0) {
          continue;
        }
        const entry = this.buildTimelineEntry(
          event.id,
          bucket.bucketStart,
          bucket.items,
          timelineRuntimeSettings
        );
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
        timelineEntryMetadataByBucket[this.toBucketKey(entry.bucketStart)] =
          entry.classification;
        builtEntries.push(entry);
        upserts += 1;
      }

      const analysis = this.analyzeTimeline(
        items,
        builtEntries,
        timelineRuntimeSettings
      );
      if (analysis.topicDriftWarning) {
        driftWarnings += 1;
        logger.warn(
          {
            orgId,
            eventId: event.id,
            summary: analysis.topicDriftSummary,
            warningCount: analysis.driftWarnings.length,
          },
          "Topic drift warning detected during timeline rebuild"
        );
      }

      const metadata = this.mergeTimelineMetadata(
        event.id,
        event.metadata,
        timelineEntryMetadataByBucket,
        analysis
      );
      await this.prisma.newsEvent.update({
        where: { id: event.id },
        data: { metadata }
      });

      processedEvents += 1;
    }

    const classificationCoverage =
      totalItems > 0 ? classifiedItemsTotal / totalItems : 0;
    const classificationCacheHitRate =
      classificationProcessedItemIdsTotal > 0
        ? classificationCacheHitsTotal / classificationProcessedItemIdsTotal
        : 0;
    logger.info(
      {
        orgId,
        processedEvents,
        upserts,
        driftWarnings,
        latencyMs: Date.now() - rebuildStartedAt,
        classificationLookupMsTotal,
        classificationProcessedItemIdsTotal,
        classificationCacheHitsTotal,
        classificationCacheHitRate: Math.round(classificationCacheHitRate * 10_000) / 10_000,
        classificationCoverage: Math.round(classificationCoverage * 10_000) / 10_000
      },
      "News event timeline rebuild completed"
    );
  }

  private async loadEventItems(
    orgId: string,
    eventId: string,
    windowDays: number
  ): Promise<LoadEventItemsResult> {
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
            category: true,
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

    const processedItemIds = Array.from(
      new Set(
        rows
          .map((row) => this.normalizeOptionalString(row.processedItemId))
          .filter((value): value is string => Boolean(value))
      )
    );
    const classificationLookupStartedAt = Date.now();
    const { classificationById, cacheHits } =
      await this.loadProcessedItemClassificationMap(processedItemIds);
    const classificationLookupMs = Date.now() - classificationLookupStartedAt;

    const items = rows.map((row) => {
      const processed = row.processedArticle;
      const timestamp = processed.publishedAt ?? processed.article?.crawlAt ?? processed.processedAt;
      const processedItemId = this.normalizeOptionalString(row.processedItemId);
      const classification = processedItemId
        ? classificationById.get(processedItemId) ?? null
        : null;
      const legacyCategory =
        classification?.legacyCategory ??
        this.normalizeLegacyCategory(processed.category);
      const categoryPath =
        this.normalizeCategoryPath(classification?.categoryPath) ??
        (legacyCategory ? legacyCategory : null);
      const categoryConfidence = this.normalizeConfidence(
        classification?.categoryConfidence
      );
      return {
        processedArticleId: processed.id,
        articleId: processed.articleId,
        processedItemId,
        timestamp,
        title: processed.title,
        summary: processed.summary,
        keyPoints: processed.keyPoints,
        qualityScore: this.normalizeConfidence(processed.qualityScore),
        legacyCategory,
        categoryPath,
        categoryConfidence
      };
    });
    const classifiedItems = items.filter(
      (item) =>
        this.normalizeCategoryPath(item.categoryPath) !== null ||
        this.normalizeLegacyCategory(item.legacyCategory) !== null
    ).length;

    logger.debug(
      {
        orgId,
        eventId,
        processedItemIds: processedItemIds.length,
        cacheHits,
        lookupMs: classificationLookupMs,
        classifiedItems
      },
      "Loaded timeline classification metadata"
    );

    return {
      items,
      stats: {
        processedItemIds: processedItemIds.length,
        cacheHits,
        lookupMs: classificationLookupMs,
        classifiedItems
      }
    };
  }

  private groupByDayBucket(items: TimelineSourceItem[]) {
    const buckets = new Map<string, { bucketStart: Date; items: TimelineSourceItem[] }>();
    for (const item of items) {
      const bucketStart = this.toUtcDayStart(item.timestamp);
      const bucketKey = this.toBucketKey(bucketStart);
      const existing = buckets.get(bucketKey);
      if (existing) {
        existing.items.push(item);
      } else {
        buckets.set(bucketKey, { bucketStart, items: [item] });
      }
    }
    return buckets;
  }

  private buildTimelineEntry(
    eventId: string,
    bucketStart: Date,
    items: TimelineSourceItem[],
    runtimeSettings: TimelineRuntimeSettings
  ): BuiltTimelineEntry {
    const sorted = items
      .slice()
      .sort((a, b) =>
        this.compareTimelineItems(a, b, runtimeSettings)
      );
    const primary = sorted[0]!;
    const referencedArticleIds = Array.from(new Set(items.map((item) => item.articleId)))
      .filter((id) => typeof id === "string" && id.length > 0)
      .sort()
      .slice(0, MAX_REFERENCED_ARTICLES_PER_BUCKET);
    const weightedCategoryDistribution =
      this.buildWeightedCategoryDistribution(items, runtimeSettings);
    const weightedPrefixDistribution =
      this.collapseDistributionToPrefix(weightedCategoryDistribution);
    const normalizedDistribution = this.normalizeDistribution(
      weightedPrefixDistribution
    );
    const dominantCategoryPath =
      this.pickDominantCategoryPath(weightedCategoryDistribution);
    const dominantCategoryPrefix =
      this.pickDominantCategoryPath(weightedPrefixDistribution) ??
      this.normalizeCategoryPrefix(dominantCategoryPath);
    const categoryConfidence = this.computeBucketCategoryConfidence(
      items,
      dominantCategoryPath,
      runtimeSettings
    );
    const tentative =
      categoryConfidence !== null &&
      categoryConfidence < runtimeSettings.lowConfidenceThreshold;
    const anchor =
      categoryConfidence !== null &&
      categoryConfidence > runtimeSettings.highConfidenceThreshold;
    const primaryImportance = this.computeItemImportance(
      primary,
      runtimeSettings
    );

    return {
      eventId,
      bucketStart,
      title: primary.title,
      summary: primary.summary,
      keyPoints: primary.keyPoints,
      referencedArticleIds,
      classification: {
        categoryPath: dominantCategoryPath,
        categoryConfidence,
        tentative,
        anchor,
        importanceScore: Math.round(primaryImportance * 10_000) / 10_000,
        itemCount: items.length
      },
      distribution: normalizedDistribution,
      dominantCategoryPrefix
    };
  }

  private compareTimelineItems(
    a: TimelineSourceItem,
    b: TimelineSourceItem,
    runtimeSettings: TimelineRuntimeSettings
  ) {
    const importanceDelta =
      this.computeItemImportance(b, runtimeSettings) -
      this.computeItemImportance(a, runtimeSettings);
    if (Math.abs(importanceDelta) > 1e-9) {
      return importanceDelta;
    }

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

  private computeItemImportance(
    item: TimelineSourceItem,
    runtimeSettings: TimelineRuntimeSettings
  ): number {
    const confidence = this.normalizeConfidence(item.categoryConfidence);
    const effectiveConfidence =
      confidence !== null
        ? confidence
        : this.normalizeConfidence(runtimeSettings.confidenceFallback) ?? 0.5;
    const quality = this.normalizeConfidence(item.qualityScore) ?? 0.5;
    let score = 0.72 * effectiveConfidence + 0.28 * quality;
    if (effectiveConfidence < runtimeSettings.lowConfidenceThreshold) {
      score *= 0.82;
    } else if (effectiveConfidence > runtimeSettings.highConfidenceThreshold) {
      score *= 1.08;
    }
    return score;
  }

  private buildWeightedCategoryDistribution(
    items: TimelineSourceItem[],
    runtimeSettings: TimelineRuntimeSettings
  ): Map<string, number> {
    const aggregate = new Map<string, number>();
    for (const item of items) {
      const path = this.resolveCategoryPath(item);
      const weight = this.computeItemImportance(item, runtimeSettings);
      aggregate.set(path, (aggregate.get(path) ?? 0) + weight);
    }
    return aggregate;
  }

  private collapseDistributionToPrefix(
    distribution: Map<string, number>
  ): Map<string, number> {
    const prefixDistribution = new Map<string, number>();
    for (const [path, weight] of distribution.entries()) {
      const prefix = this.normalizeCategoryPrefix(path);
      prefixDistribution.set(
        prefix,
        (prefixDistribution.get(prefix) ?? 0) + weight
      );
    }
    return prefixDistribution;
  }

  private computeBucketCategoryConfidence(
    items: TimelineSourceItem[],
    dominantCategoryPath: string | null,
    runtimeSettings: TimelineRuntimeSettings
  ): number | null {
    let weighted = 0;
    let totalWeight = 0;
    const dominant = dominantCategoryPath;

    for (const item of items) {
      const confidence = this.normalizeConfidence(item.categoryConfidence);
      if (confidence === null) {
        continue;
      }
      const itemPath = this.resolveCategoryPath(item);
      if (dominant && itemPath !== dominant) {
        continue;
      }
      const weight = this.computeItemImportance(item, runtimeSettings);
      weighted += confidence * weight;
      totalWeight += weight;
    }

    if (totalWeight <= 0) {
      return null;
    }
    return Math.max(0, Math.min(1, weighted / totalWeight));
  }

  private analyzeTimeline(
    items: TimelineSourceItem[],
    entries: BuiltTimelineEntry[],
    runtimeSettings: TimelineRuntimeSettings
  ): TimelineAnalysis {
    const countDistribution = this.computeCountCategoryDistribution(
      items,
      runtimeSettings.maxCategoryDistributionItems
    );
    const sortedEntries = entries
      .slice()
      .sort((a, b) => a.bucketStart.getTime() - b.bucketStart.getTime());

    const driftWarnings: TopicDriftWarning[] = [];
    let maxKl = 0;
    let evaluatedTransitions = 0;

    for (let idx = 1; idx < sortedEntries.length; idx += 1) {
      const previous = sortedEntries[idx - 1]!;
      const current = sortedEntries[idx]!;
      const comparable =
        previous.classification.itemCount >=
          runtimeSettings.minBucketItemsForDrift &&
        current.classification.itemCount >=
          runtimeSettings.minBucketItemsForDrift;
      if (!comparable) {
        continue;
      }
      evaluatedTransitions += 1;
      const divergence = this.computeKlDivergence(
        previous.distribution,
        current.distribution
      );
      if (divergence > maxKl) {
        maxKl = divergence;
      }
      if (divergence >= runtimeSettings.driftKlThreshold) {
        driftWarnings.push({
          fromBucketStart: this.toBucketKey(previous.bucketStart),
          toBucketStart: this.toBucketKey(current.bucketStart),
          klDivergence: Math.round(divergence * 10_000) / 10_000,
          fromCategoryPrefix: previous.dominantCategoryPrefix,
          toCategoryPrefix: current.dominantCategoryPrefix
        });
      }
    }

    const topShare =
      countDistribution.length > 0 ? countDistribution[0]!.share : 0;
    const crossCategoryShare = Math.max(0, 1 - topShare);
    const crossCategoryWarning =
      crossCategoryShare > runtimeSettings.crossCategoryWarningShare;
    const phaseSummaries = this.buildPhaseSummaries(
      sortedEntries,
      runtimeSettings
    );
    const topicDriftWarning =
      crossCategoryWarning || driftWarnings.length > 0 || phaseSummaries.length > 1;

    const summaryParts: string[] = [];
    if (crossCategoryWarning) {
      summaryParts.push(
        `cross-category share ${(crossCategoryShare * 100).toFixed(1)}%`
      );
    }
    if (driftWarnings.length > 0 || evaluatedTransitions > 0) {
      summaryParts.push(
        `max KL ${maxKl.toFixed(3)} across ${evaluatedTransitions} evaluated transitions`
      );
    }
    if (phaseSummaries.length > 1) {
      summaryParts.push(`${phaseSummaries.length} timeline phases detected`);
    }

    return {
      categoryDistribution: countDistribution,
      topicDriftWarning,
      topicDriftSummary:
        summaryParts.length > 0 ? summaryParts.join("; ") : null,
      driftWarnings,
      phaseSummaries
    };
  }

  private computeCountCategoryDistribution(
    items: TimelineSourceItem[],
    maxItems: number
  ): CategoryDistributionEntry[] {
    const aggregate = new Map<string, number>();
    for (const item of items) {
      const path = this.resolveCategoryPath(item);
      aggregate.set(path, (aggregate.get(path) ?? 0) + 1);
    }

    const total = Array.from(aggregate.values()).reduce((sum, count) => sum + count, 0);
    if (total <= 0) {
      return [];
    }

    return Array.from(aggregate.entries())
      .map(([categoryPath, count]) => ({
        categoryPath,
        count,
        share: Math.round((count / total) * 10_000) / 10_000
      }))
      .sort((a, b) => b.count - a.count || a.categoryPath.localeCompare(b.categoryPath))
      .slice(0, Math.max(1, maxItems));
  }

  private normalizeDistribution(
    distribution: Map<string, number>
  ): Record<string, number> {
    const total = Array.from(distribution.values()).reduce(
      (sum, weight) => sum + (Number.isFinite(weight) ? weight : 0),
      0
    );
    if (total <= 0) {
      return {};
    }

    const normalized: Record<string, number> = {};
    for (const [path, weight] of distribution.entries()) {
      if (!Number.isFinite(weight) || weight <= 0) {
        continue;
      }
      normalized[path] = weight / total;
    }
    return normalized;
  }

  private pickDominantCategoryPath(
    distribution: Map<string, number>
  ): string | null {
    let bestPath: string | null = null;
    let bestWeight = 0;
    for (const [path, weight] of distribution.entries()) {
      if (weight > bestWeight) {
        bestPath = path;
        bestWeight = weight;
      }
    }
    if (!bestPath || bestPath === "uncategorized") {
      return null;
    }
    return bestPath;
  }

  private computeKlDivergence(
    previous: Record<string, number>,
    next: Record<string, number>
  ): number {
    const keys = new Set<string>([
      ...Object.keys(previous),
      ...Object.keys(next),
    ]);
    if (keys.size === 0) {
      return 0;
    }

    let divergence = 0;
    for (const key of keys) {
      const p = Math.max(KL_EPSILON, previous[key] ?? KL_EPSILON);
      const q = Math.max(KL_EPSILON, next[key] ?? KL_EPSILON);
      divergence += p * Math.log(p / q);
    }
    return Math.max(0, divergence);
  }

  private buildPhaseSummaries(
    entries: BuiltTimelineEntry[],
    runtimeSettings: TimelineRuntimeSettings
  ): TimelinePhaseSummary[] {
    if (entries.length === 0) {
      return [];
    }

    const phases: {
      startAt: Date;
      endAt: Date;
      categoryPrefix: string;
      itemCount: number;
      bucketCount: number;
    }[] = [];

    let current = {
      startAt: entries[0]!.bucketStart,
      endAt: entries[0]!.bucketStart,
      categoryPrefix: entries[0]!.dominantCategoryPrefix,
      itemCount: entries[0]!.classification.itemCount,
      bucketCount: 1
    };

    for (let idx = 1; idx < entries.length; idx += 1) {
      const previous = entries[idx - 1]!;
      const next = entries[idx]!;
      const comparable =
        previous.classification.itemCount >=
          runtimeSettings.minBucketItemsForDrift &&
        next.classification.itemCount >=
          runtimeSettings.minBucketItemsForDrift;
      const driftScore = comparable
        ? this.computeKlDivergence(previous.distribution, next.distribution)
        : 0;
      const shouldSplit =
        comparable &&
        (driftScore >= runtimeSettings.driftKlThreshold ||
          previous.dominantCategoryPrefix !== next.dominantCategoryPrefix);

      if (shouldSplit) {
        phases.push(current);
        current = {
          startAt: next.bucketStart,
          endAt: next.bucketStart,
          categoryPrefix: next.dominantCategoryPrefix,
          itemCount: next.classification.itemCount,
          bucketCount: 1
        };
      } else {
        current = {
          ...current,
          endAt: next.bucketStart,
          itemCount: current.itemCount + next.classification.itemCount,
          bucketCount: current.bucketCount + 1
        };
      }
    }

    phases.push(current);

    return phases.slice(0, runtimeSettings.maxPhaseSummaries).map((phase, idx) => {
      const label = `${this.describePrefix(phase.categoryPrefix)} stage`;
      return {
        phase: idx + 1,
        label,
        categoryPrefix: phase.categoryPrefix,
        startAt: phase.startAt.toISOString(),
        endAt: phase.endAt.toISOString(),
        itemCount: phase.itemCount,
        bucketCount: phase.bucketCount,
        summary: `${label} (${phase.categoryPrefix})`
      };
    });
  }

  private describePrefix(prefix: string): string {
    if (prefix.startsWith("tech/ai")) {
      return "Technology release";
    }
    if (prefix.startsWith("gov/regulation")) {
      return "Regulatory response";
    }
    if (prefix.startsWith("finance/")) {
      return "Market impact";
    }
    if (prefix.startsWith("politics/")) {
      return "Political reaction";
    }
    if (prefix.startsWith("intel/")) {
      return "Intelligence assessment";
    }
    if (prefix.startsWith("ai/")) {
      return "AI development";
    }
    const [head, tail] = prefix.split("/");
    const safeHead = head ?? "mixed";
    const safeTail = tail ?? "";
    if (tail) {
      return `${this.capitalizeWord(safeHead)} ${this.capitalizeWord(safeTail)}`;
    }
    return this.capitalizeWord(safeHead);
  }

  private capitalizeWord(value: string): string {
    const normalized = this.normalizeOptionalString(value) ?? "mixed";
    return normalized.charAt(0).toUpperCase() + normalized.slice(1);
  }

  private mergeTimelineMetadata(
    eventId: string,
    existingMetadata: Prisma.JsonValue | null,
    entries: Record<string, TimelineEntryClassificationMetadata>,
    analysis: TimelineAnalysis
  ): Prisma.InputJsonValue {
    const base =
      existingMetadata &&
      typeof existingMetadata === "object" &&
      !Array.isArray(existingMetadata)
        ? { ...(existingMetadata as Record<string, unknown>) }
        : {};
    const existingTimeline =
      base.timeline && typeof base.timeline === "object" && !Array.isArray(base.timeline)
        ? (base.timeline as Record<string, unknown>)
        : null;
    const existingEntries =
      existingTimeline &&
      existingTimeline.entries &&
      typeof existingTimeline.entries === "object" &&
      !Array.isArray(existingTimeline.entries)
        ? this.normalizeTimelineEntries(
            existingTimeline.entries as Record<string, unknown>
          )
        : {};
    const timeline: TimelineMetadataPayload = {
      entries: {
        ...existingEntries,
        ...entries
      },
      categoryDistribution: analysis.categoryDistribution,
      topicDriftWarning: analysis.topicDriftWarning,
      topicDriftSummary: analysis.topicDriftSummary,
      driftWarnings: analysis.driftWarnings,
      phaseSummaries: analysis.phaseSummaries,
      subEvents: this.buildTimelineSubEvents(eventId, analysis.phaseSummaries),
      updatedAt: new Date().toISOString()
    };
    const merged = {
      ...base,
      timeline
    };
    return JSON.parse(JSON.stringify(merged)) as Prisma.InputJsonValue;
  }

  private normalizeTimelineEntries(
    value: Record<string, unknown>
  ): Record<string, TimelineEntryClassificationMetadata> {
    const normalized: Record<string, TimelineEntryClassificationMetadata> = {};
    for (const [bucketKey, raw] of Object.entries(value)) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        continue;
      }
      const entry = raw as Record<string, unknown>;
      const rawConfidence =
        typeof entry.categoryConfidence === "number" &&
        Number.isFinite(entry.categoryConfidence)
          ? entry.categoryConfidence
          : null;
      normalized[bucketKey] = {
        categoryPath: this.normalizeCategoryPath(entry.categoryPath),
        categoryConfidence:
          rawConfidence === null ? null : Math.max(0, Math.min(1, rawConfidence)),
        tentative: Boolean(entry.tentative),
        anchor: Boolean(entry.anchor),
        importanceScore:
          typeof entry.importanceScore === "number" &&
          Number.isFinite(entry.importanceScore)
            ? entry.importanceScore
            : 0,
        itemCount:
          typeof entry.itemCount === "number" &&
          Number.isFinite(entry.itemCount) &&
          entry.itemCount > 0
            ? Math.round(entry.itemCount)
            : 0
      };
    }
    return normalized;
  }

  private buildTimelineSubEvents(
    eventId: string,
    phaseSummaries: TimelinePhaseSummary[]
  ): TimelineMetadataPayload["subEvents"] {
    return phaseSummaries.map((phase) => ({
      id: `${eventId}:${phase.phase}`,
      parentEventId: eventId,
      phase: phase.phase,
      title: phase.label,
      categoryPath: phase.categoryPrefix,
      startAt: phase.startAt,
      endAt: phase.endAt,
      itemCount: phase.itemCount,
      bucketCount: phase.bucketCount,
      summary: phase.summary
    }));
  }

  private resolveTimelineRuntimeSettings(
    settings: Partial<NewsEventSettings>
  ): TimelineRuntimeSettings {
    const rawLowConfidenceThreshold = this.normalizeBoundedNumber(
      settings.timelineLowConfidenceThreshold,
      0,
      1,
      DEFAULT_LOW_CONFIDENCE_THRESHOLD
    );
    const rawHighConfidenceThreshold = this.normalizeBoundedNumber(
      settings.timelineHighConfidenceThreshold,
      0,
      1,
      DEFAULT_HIGH_CONFIDENCE_THRESHOLD
    );
    const lowConfidenceThreshold = Math.min(
      rawLowConfidenceThreshold,
      rawHighConfidenceThreshold
    );
    const highConfidenceThreshold = Math.max(
      rawLowConfidenceThreshold,
      rawHighConfidenceThreshold
    );

    return {
      confidenceFallback: this.normalizeBoundedNumber(
        settings.minCategoryConfidenceForGate,
        0,
        1,
        lowConfidenceThreshold
      ),
      lowConfidenceThreshold,
      highConfidenceThreshold,
      driftKlThreshold: this.normalizeBoundedNumber(
        settings.timelineDriftKlThreshold,
        MIN_DRIFT_KL_THRESHOLD,
        MAX_DRIFT_KL_THRESHOLD,
        DEFAULT_KL_DIVERGENCE_THRESHOLD
      ),
      minBucketItemsForDrift: this.normalizeBoundedInt(
        settings.timelineMinBucketItemsForDrift,
        MIN_MIN_BUCKET_ITEMS_FOR_DRIFT,
        MAX_MIN_BUCKET_ITEMS_FOR_DRIFT,
        DEFAULT_MIN_BUCKET_ITEMS_FOR_DRIFT
      ),
      crossCategoryWarningShare: this.normalizeBoundedNumber(
        settings.timelineCrossCategoryWarningShare,
        0,
        1,
        DEFAULT_CROSS_CATEGORY_WARNING_SHARE
      ),
      maxCategoryDistributionItems: this.normalizeBoundedInt(
        settings.timelineMaxCategoryDistributionItems,
        MIN_MAX_CATEGORY_DISTRIBUTION_ITEMS,
        MAX_MAX_CATEGORY_DISTRIBUTION_ITEMS,
        DEFAULT_MAX_CATEGORY_DISTRIBUTION_ITEMS
      ),
      maxPhaseSummaries: this.normalizeBoundedInt(
        settings.timelineMaxPhaseSummaries,
        MIN_MAX_PHASE_SUMMARIES,
        MAX_MAX_PHASE_SUMMARIES,
        DEFAULT_MAX_PHASE_SUMMARIES
      )
    };
  }

  private async loadProcessedItemClassificationMap(
    processedItemIds: string[]
  ): Promise<{
    classificationById: Map<string, ProcessedItemClassification | null>;
    cacheHits: number;
  }> {
    const classificationById = new Map<string, ProcessedItemClassification | null>();
    if (processedItemIds.length === 0) {
      return { classificationById, cacheHits: 0 };
    }

    const now = Date.now();
    this.pruneExpiredProcessedItemClassificationCache(now);
    const pendingIds: string[] = [];
    let cacheHits = 0;

    for (const id of processedItemIds) {
      const cached = this.processedItemClassificationCache.get(id);
      if (cached && cached.expiresAt > now) {
        classificationById.set(id, cached.value);
        cacheHits += 1;
        continue;
      }
      if (cached) {
        this.processedItemClassificationCache.delete(id);
      }
      pendingIds.push(id);
    }

    if (pendingIds.length === 0) {
      return { classificationById, cacheHits };
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
        const classification = this.extractClassificationFromResult(
          (doc as { result?: unknown }).result
        );
        classificationById.set(id, classification);
        this.processedItemClassificationCache.set(id, {
          expiresAt: now + CLASSIFICATION_CACHE_TTL_MS,
          value: classification
        });
      }

      for (const id of pendingIds) {
        if (found.has(id)) {
          continue;
        }
        classificationById.set(id, null);
        this.processedItemClassificationCache.set(id, {
          expiresAt: now + CLASSIFICATION_CACHE_TTL_MS,
          value: null
        });
      }
    } catch (error) {
      logger.warn(
        { err: error, ids: pendingIds.length },
        "Failed to load timeline classification context from Mongo"
      );
    }

    return { classificationById, cacheHits };
  }

  private pruneExpiredProcessedItemClassificationCache(now: number): void {
    if (now - this.processedItemClassificationCacheLastPruneAt < CACHE_PRUNE_INTERVAL_MS) {
      return;
    }
    for (const [key, entry] of this.processedItemClassificationCache.entries()) {
      if (entry.expiresAt <= now) {
        this.processedItemClassificationCache.delete(key);
      }
    }
    this.processedItemClassificationCacheLastPruneAt = now;
  }

  private extractClassificationFromResult(
    value: unknown
  ): ProcessedItemClassification {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return {
        legacyCategory: null,
        categoryPath: null,
        categoryConfidence: null
      };
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
      categoryConfidence: this.normalizeConfidence(rawConfidence)
    };
  }

  private resolveCategoryPath(item: TimelineSourceItem): string {
    const categoryPath = this.normalizeCategoryPath(item.categoryPath);
    if (categoryPath) {
      return categoryPath;
    }
    const legacy = this.normalizeLegacyCategory(item.legacyCategory);
    if (legacy) {
      return legacy;
    }
    return "uncategorized";
  }

  private normalizeCategoryPrefix(path: string | null): string {
    const normalized = this.normalizeCategoryPath(path) ?? "uncategorized";
    const segments = normalized.split("/").filter((segment) => segment.length > 0);
    if (segments.length >= 2) {
      return `${segments[0]}/${segments[1]}`;
    }
    return segments[0] ?? "uncategorized";
  }

  private normalizeOptionalString(value: unknown): string | null {
    if (typeof value !== "string") {
      return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private normalizeLegacyCategory(value: unknown): string | null {
    const normalized = this.normalizeOptionalString(value)?.toLowerCase();
    if (!normalized) {
      return null;
    }
    return new Set(["politics", "tech", "finance", "gov", "ai", "intel"]).has(
      normalized
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

  private normalizeBoundedNumber(
    value: unknown,
    min: number,
    max: number,
    fallback: number
  ): number {
    const numeric =
      typeof value === "number"
        ? value
        : typeof value === "string"
          ? Number(value)
          : NaN;
    if (!Number.isFinite(numeric)) {
      return fallback;
    }
    if (numeric < min) {
      return min;
    }
    if (numeric > max) {
      return max;
    }
    return numeric;
  }

  private normalizeBoundedInt(
    value: unknown,
    min: number,
    max: number,
    fallback: number
  ): number {
    const numeric = this.normalizeBoundedNumber(value, min, max, fallback);
    const rounded = Math.round(numeric);
    if (rounded < min) {
      return min;
    }
    if (rounded > max) {
      return max;
    }
    return rounded;
  }

  private normalizeConfidence(value: unknown): number | null {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return null;
    }
    return Math.max(0, Math.min(1, value));
  }

  private toBucketKey(bucketStart: Date): string {
    return bucketStart.toISOString();
  }

  private toUtcDayStart(value: Date): Date {
    const d = new Date(value);
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  }
}
