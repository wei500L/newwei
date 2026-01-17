import { createLogger } from "@modular/utils";
import { Injectable } from "@nestjs/common";
import { NewsIndicatorFeatureMetric, NewsIndicatorScopeType } from "@prisma/client";

import { toPrismaJsonValue } from "../../common/prisma-json";
import { PrismaService } from "../config/prisma.service";

import {
  buildDailyEconomicValues,
  buildDailyReturns,
  computeBestLagCorrelation,
  runBacktest,
  toUtcDayStartMs,
  type BacktestConfig,
  type CorrelationResult,
  type DailySeries,
  type NumericSeriesPoint
} from "./news-indicator-math";
import { NewsIndicatorSettingsService } from "./news-indicator-settings.service";

const logger = createLogger({ name: "news-indicator-association" });

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_POINTS_PER_INDICATOR = 50_000;

function resolveFeatureValue(
  row: { totalDocs: number; avgScore: number; negativeRatio: number },
  metric: NewsIndicatorFeatureMetric
): number {
  switch (metric) {
    case NewsIndicatorFeatureMetric.avg_score:
      return row.avgScore;
    case NewsIndicatorFeatureMetric.negative_ratio:
      return row.negativeRatio;
    case NewsIndicatorFeatureMetric.volume:
    default:
      return row.totalDocs;
  }
}

@Injectable()
export class NewsIndicatorAssociationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settingsService: NewsIndicatorSettingsService
  ) {}

  async listAssociations(
    orgId: string,
    options?: {
      limit?: number;
      indicatorSlug?: string;
      scopeType?: NewsIndicatorScopeType;
      scopeKey?: string;
      featureMetric?: NewsIndicatorFeatureMetric;
    }
  ) {
    const limit = Math.min(Math.max(options?.limit ?? 50, 1), 200);
    const scopeKey = typeof options?.scopeKey === "string" ? options.scopeKey.trim() : "";
    const indicatorSlug = typeof options?.indicatorSlug === "string" ? options.indicatorSlug.trim() : "";

    return this.prisma.newsIndicatorAssociation.findMany({
      where: {
        orgId,
        ...(options?.scopeType ? { scopeType: options.scopeType } : {}),
        ...(scopeKey ? { scopeKey } : {}),
        ...(options?.featureMetric ? { featureMetric: options.featureMetric } : {}),
        ...(indicatorSlug
          ? {
              indicatorItem: {
                slug: indicatorSlug
              }
            }
          : {})
      },
      orderBy: [{ lastEvaluatedAt: "desc" }, { correlation: "desc" }],
      take: limit,
      include: {
        indicatorItem: true,
        backtests: {
          orderBy: { createdAt: "desc" },
          take: 1
        }
      }
    });
  }

  async getAssociation(orgId: string, associationId: string, options?: { backtestsLimit?: number }) {
    const backtestsLimit = Math.min(Math.max(options?.backtestsLimit ?? 10, 0), 100);

    return this.prisma.newsIndicatorAssociation.findFirst({
      where: { orgId, id: associationId },
      include: {
        indicatorItem: true,
        backtests:
          backtestsLimit > 0
            ? {
                orderBy: { createdAt: "desc" },
                take: backtestsLimit
              }
            : false
      }
    });
  }

  async refreshOrg(orgId: string) {
    const settings = await this.settingsService.getSettings(orgId);
    if (!settings.enabled || !settings.ingestionEnabled) {
      return { indicators: 0, associationsUpserted: 0, backtestsCreated: 0 };
    }
    if (settings.indicatorSlugs.length === 0) {
      return { indicators: 0, associationsUpserted: 0, backtestsCreated: 0 };
    }

    const indicators = await this.prisma.economicDataItem.findMany({
      where: { slug: { in: settings.indicatorSlugs }, isActive: true },
      select: { id: true, slug: true }
    });
    if (indicators.length === 0) {
      return { indicators: 0, associationsUpserted: 0, backtestsCreated: 0 };
    }

    const analyzedEndAt = new Date(toUtcDayStartMs(new Date()));
    const analyzedStartAt = new Date(analyzedEndAt.getTime() - settings.windowDays * DAY_MS);
    const maxHoldoutDays = Math.max(
      0,
      settings.windowDays - Math.max(settings.minSampleSize, settings.backtestBaselineDays)
    );
    const holdoutDays = Math.min(Math.max(settings.backtestHoldoutDays, 0), maxHoldoutDays);
    const holdoutStartDayMs = analyzedEndAt.getTime() - holdoutDays * DAY_MS;

    const [topEntities, topTopics] = await Promise.all([
      this.loadTopEntityKeys(orgId, analyzedStartAt, settings.topEntities),
      this.loadTopTopicKeys(orgId, analyzedStartAt, settings.topTopics)
    ]);

    const [entitySeries, topicSeries] = await Promise.all([
      topEntities.length > 0
        ? this.loadEntityFeatureSeries(orgId, analyzedStartAt, topEntities)
        : Promise.resolve(new Map<string, Map<NewsIndicatorFeatureMetric, DailySeries>>()),
      topTopics.length > 0
        ? this.loadTopicFeatureSeries(orgId, analyzedStartAt, topTopics)
        : Promise.resolve(new Map<string, Map<NewsIndicatorFeatureMetric, DailySeries>>())
    ]);

    const metricsToEvaluate: NewsIndicatorFeatureMetric[] = [
      NewsIndicatorFeatureMetric.volume,
      NewsIndicatorFeatureMetric.avg_score,
      NewsIndicatorFeatureMetric.negative_ratio
    ];

    let associationsUpserted = 0;
    let backtestsCreated = 0;

    for (const indicator of indicators) {
      const rawPoints = await this.prisma.economicDataPoint.findMany({
        where: {
          itemId: indicator.id,
          recordedAt: { gte: analyzedStartAt, lte: analyzedEndAt }
        },
        select: { id: true, recordedAt: true, value: true },
        orderBy: [{ recordedAt: "asc" }, { id: "asc" }],
        take: MAX_POINTS_PER_INDICATOR
      });

      const points: NumericSeriesPoint[] = rawPoints.map((point) => ({
        id: point.id,
        recordedAt: point.recordedAt,
        value: Number(point.value)
      }));

      const dailyValues = buildDailyEconomicValues(points);
      const targetReturns = buildDailyReturns(dailyValues);

      const candidates: Array<{
        scopeType: NewsIndicatorScopeType;
        scopeKey: string;
        scopeKeyType: string;
        metric: NewsIndicatorFeatureMetric;
        series: DailySeries;
      }> = [];

      for (const [entityKey, seriesByMetric] of entitySeries.entries()) {
        const [entityName, entityType] = entityKey.split("::");
        if (!entityName) {
          continue;
        }
        for (const metric of metricsToEvaluate) {
          const series = seriesByMetric.get(metric);
          if (!series || series.size === 0) {
            continue;
          }
          candidates.push({
            scopeType: NewsIndicatorScopeType.entity,
            scopeKey: entityName,
            scopeKeyType: entityType ?? "",
            metric,
            series
          });
        }
      }

      for (const [topic, seriesByMetric] of topicSeries.entries()) {
        for (const metric of metricsToEvaluate) {
          const series = seriesByMetric.get(metric);
          if (!series || series.size === 0) {
            continue;
          }
          candidates.push({
            scopeType: NewsIndicatorScopeType.topic,
            scopeKey: topic,
            scopeKeyType: "",
            metric,
            series
          });
        }
      }

      const scored: Array<{
        candidate: (typeof candidates)[number];
        best: CorrelationResult;
        all: CorrelationResult[];
      }> = [];

      for (const candidate of candidates) {
        const { best, all } = computeBestLagCorrelation(candidate.series, targetReturns, {
          maxLagDays: settings.maxLagDays,
          minSampleSize: settings.minSampleSize,
          maxTargetDayMsExclusive: holdoutDays > 0 ? holdoutStartDayMs : undefined
        });
        if (!best) {
          continue;
        }
        if (Math.abs(best.correlation) < settings.minAbsCorrelation) {
          continue;
        }
        if (best.pValue > settings.maxPValue) {
          continue;
        }
        scored.push({ candidate, best, all });
      }

      scored.sort((a, b) => Math.abs(b.best.correlation) - Math.abs(a.best.correlation));
      const selected = scored.slice(0, settings.maxAssociationsPerIndicator);

      for (const entry of selected) {
        const candidate = entry.candidate;
        const best = entry.best;
        const metadata = {
          indicatorSlug: indicator.slug,
          lagMetrics: entry.all,
          trainingTargetEndAt: new Date(holdoutStartDayMs).toISOString(),
          holdoutDays
        };

        const association = await this.prisma.newsIndicatorAssociation.upsert({
          where: {
            orgId_scopeType_scopeKey_scopeKeyType_featureMetric_indicatorItemId: {
              orgId,
              scopeType: candidate.scopeType,
              scopeKey: candidate.scopeKey,
              scopeKeyType: candidate.scopeKeyType,
              featureMetric: candidate.metric,
              indicatorItemId: indicator.id
            }
          },
          update: {
            windowDays: settings.windowDays,
            lagDays: best.lagDays,
            correlation: best.correlation,
            pValue: best.pValue,
            sampleSize: best.sampleSize,
            analyzedStartAt,
            analyzedEndAt,
            lastEvaluatedAt: new Date(),
            metadata: toPrismaJsonValue(metadata)
          },
          create: {
            orgId,
            scopeType: candidate.scopeType,
            scopeKey: candidate.scopeKey,
            scopeKeyType: candidate.scopeKeyType,
            featureMetric: candidate.metric,
            indicatorItemId: indicator.id,
            windowDays: settings.windowDays,
            lagDays: best.lagDays,
            correlation: best.correlation,
            pValue: best.pValue,
            sampleSize: best.sampleSize,
            analyzedStartAt,
            analyzedEndAt,
            lastEvaluatedAt: new Date(),
            metadata: toPrismaJsonValue(metadata)
          },
          select: { id: true }
        });
        associationsUpserted += 1;
        const backtestConfig: BacktestConfig = {
          triggerZScore: settings.backtestTriggerZScore,
          baselineDays: settings.backtestBaselineDays,
          holdoutDays,
          evaluationTargetStartDayMs: holdoutStartDayMs,
          evaluationTargetEndDayMs: analyzedEndAt.getTime()
        };
        const metrics = runBacktest(candidate.series, targetReturns, best, backtestConfig);

        await this.prisma.newsIndicatorAssociationBacktestRun.create({
          data: {
            orgId,
            associationId: association.id,
            status: "completed",
            windowStart: new Date(holdoutStartDayMs),
            windowEnd: analyzedEndAt,
            config: toPrismaJsonValue(backtestConfig),
            metrics: toPrismaJsonValue(metrics)
          }
        });
        backtestsCreated += 1;
      }
    }

    logger.info(
      { orgId, indicators: indicators.length, associationsUpserted, backtestsCreated },
      "News indicator association refresh completed"
    );

    return { indicators: indicators.length, associationsUpserted, backtestsCreated };
  }

  private async loadTopEntityKeys(orgId: string, since: Date, limit: number) {
    const take = Math.min(Math.max(limit, 0), 500);
    if (take === 0) {
      return [] as Array<{ entityName: string; entityType: string }>;
    }

    const rows = await this.prisma.entitySentimentSnapshot.groupBy({
      by: ["entityName", "entityType"],
      where: { orgId, bucketStart: { gte: since } },
      _sum: { totalDocs: true },
      orderBy: { _sum: { totalDocs: "desc" } },
      take
    });

    return rows
      .map((row) => ({
        entityName: row.entityName,
        entityType: row.entityType
      }))
      .filter((row) => row.entityName.length > 0);
  }

  private async loadTopTopicKeys(orgId: string, since: Date, limit: number) {
    const take = Math.min(Math.max(limit, 0), 500);
    if (take === 0) {
      return [] as Array<{ topic: string }>;
    }

    const rows = await this.prisma.topicSentimentSnapshot.groupBy({
      by: ["topic"],
      where: { orgId, bucketStart: { gte: since } },
      _sum: { totalDocs: true },
      orderBy: { _sum: { totalDocs: "desc" } },
      take
    });

    return rows
      .map((row) => ({ topic: row.topic }))
      .filter((row) => row.topic.length > 0);
  }

  private async loadEntityFeatureSeries(
    orgId: string,
    since: Date,
    keys: Array<{ entityName: string; entityType: string }>
  ) {
    const series = new Map<string, Map<NewsIndicatorFeatureMetric, DailySeries>>();
    const clauses = keys.map((key) => ({ entityName: key.entityName, entityType: key.entityType }));
    const rows = await this.prisma.entitySentimentSnapshot.findMany({
      where: {
        orgId,
        bucketStart: { gte: since },
        OR: clauses
      },
      select: {
        entityName: true,
        entityType: true,
        bucketStart: true,
        totalDocs: true,
        avgScore: true,
        negativeRatio: true
      }
    });

    for (const row of rows) {
      const entityKey = `${row.entityName}::${row.entityType ?? ""}`;
      const bucket = toUtcDayStartMs(row.bucketStart);

      const byMetric = series.get(entityKey) ?? new Map<NewsIndicatorFeatureMetric, DailySeries>();
      series.set(entityKey, byMetric);

      const data = {
        totalDocs: row.totalDocs,
        avgScore: row.avgScore,
        negativeRatio: row.negativeRatio
      };

      for (const metric of [
        NewsIndicatorFeatureMetric.volume,
        NewsIndicatorFeatureMetric.avg_score,
        NewsIndicatorFeatureMetric.negative_ratio
      ]) {
        const metricSeries = byMetric.get(metric) ?? new Map<number, number>();
        byMetric.set(metric, metricSeries);
        metricSeries.set(bucket, resolveFeatureValue(data, metric));
      }
    }

    return series;
  }

  private async loadTopicFeatureSeries(orgId: string, since: Date, keys: Array<{ topic: string }>) {
    const series = new Map<string, Map<NewsIndicatorFeatureMetric, DailySeries>>();
    const topics = keys.map((key) => key.topic);
    const rows = await this.prisma.topicSentimentSnapshot.findMany({
      where: {
        orgId,
        bucketStart: { gte: since },
        topic: { in: topics }
      },
      select: {
        topic: true,
        bucketStart: true,
        totalDocs: true,
        avgScore: true,
        negativeRatio: true
      }
    });

    for (const row of rows) {
      const bucket = toUtcDayStartMs(row.bucketStart);
      const byMetric = series.get(row.topic) ?? new Map<NewsIndicatorFeatureMetric, DailySeries>();
      series.set(row.topic, byMetric);

      const data = {
        totalDocs: row.totalDocs,
        avgScore: row.avgScore,
        negativeRatio: row.negativeRatio
      };

      for (const metric of [
        NewsIndicatorFeatureMetric.volume,
        NewsIndicatorFeatureMetric.avg_score,
        NewsIndicatorFeatureMetric.negative_ratio
      ]) {
        const metricSeries = byMetric.get(metric) ?? new Map<number, number>();
        byMetric.set(metric, metricSeries);
        metricSeries.set(bucket, resolveFeatureValue(data, metric));
      }
    }

    return series;
  }
}
