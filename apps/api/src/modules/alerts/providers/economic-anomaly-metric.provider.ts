import { Injectable } from "@nestjs/common";
import { AlertMetricProvider, type AlertRule } from "@prisma/client";

import { detectRollingSpike, detectZScoreAnomalies, type SeriesPoint } from "../../analysis/anomaly-detector";
import { CacheService } from "../../cache/cache.service";
import { PrismaService } from "../../config/prisma.service";
import { ModelServiceClient, type ModelServiceModelKind, type ModelServiceSeriesPoint } from "../../model-service/model-service.client";


import type { MetricEvaluation, MetricProvider } from "./metric-provider";

const DAY_MS = 24 * 60 * 60 * 1000;

function clampInt(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return min;
  }
  const normalized = Math.trunc(value);
  return Math.min(Math.max(normalized, min), max);
}

function clampFloat(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return min;
  }
  return Math.min(Math.max(value, min), max);
}

function toMetadata(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

@Injectable()
export class EconomicAnomalyMetricProvider implements MetricProvider {
  readonly type = AlertMetricProvider.economic_anomaly;

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly modelService: ModelServiceClient
  ) {}

  supports(rule: Pick<AlertRule, "metricProvider">) {
    return rule.metricProvider === this.type;
  }

  async fetch(
    rule: Pick<AlertRule, "metricSlug" | "operator" | "changeWindowMin" | "metadata" | "metricProvider" | "orgId">
  ): Promise<MetricEvaluation> {
    const metricSlug =
      typeof rule.metricSlug === "string" ? rule.metricSlug.trim() : "";
    if (!metricSlug) {
      return {
        latest: null,
        previous: null,
        changePercent: null,
        context: { error: "metric_slug_missing" }
      };
    }
    const metadata = toMetadata(rule.metadata);
    const lookbackDays = clampInt(typeof metadata?.lookbackDays === "number" ? metadata.lookbackDays : 365, 30, 3650);
    const maxPoints = clampInt(typeof metadata?.maxPoints === "number" ? metadata.maxPoints : 1000, 50, 5000);
    const cacheTtlSeconds = clampInt(typeof metadata?.cacheTtlSeconds === "number" ? metadata.cacheTtlSeconds : 300, 5, 3600);
    const confidenceLevel = clampFloat(typeof metadata?.confidenceLevel === "number" ? metadata.confidenceLevel : 0.95, 0.5, 0.999);
    const seasonalPeriod = clampInt(typeof metadata?.seasonalPeriod === "number" ? metadata.seasonalPeriod : 0, 0, 366);

    const rawModelKind = typeof metadata?.modelKind === "string" ? metadata.modelKind.trim().toLowerCase() : "";
    const modelKind: ModelServiceModelKind = rawModelKind === "ets" ? "ets" : "arima";

    const desiredSourceField = typeof metadata?.sourceField === "string" ? metadata.sourceField.trim() : "";

    const latestPoint = await this.prisma.economicDataPoint.findFirst({
      where: {
        item: { slug: metricSlug },
        ...(desiredSourceField ? { sourceField: desiredSourceField } : {})
      },
      orderBy: { recordedAt: "desc" },
      include: { item: true }
    });

    if (!latestPoint) {
      return { latest: null, previous: null, changePercent: null, context: { error: "no_data_points" } };
    }

    const sourceField = desiredSourceField || latestPoint.sourceField;
    const end = latestPoint.recordedAt;
    const start = new Date(end.getTime() - lookbackDays * DAY_MS);
    const points = await this.prisma.economicDataPoint.findMany({
      where: {
        itemId: latestPoint.itemId,
        recordedAt: { gte: start, lte: end },
        ...(sourceField ? { sourceField } : {})
      },
      orderBy: { recordedAt: "desc" },
      take: maxPoints,
      select: { recordedAt: true, value: true }
    });

    if (points.length < 10) {
      return {
        latest: null,
        previous: null,
        changePercent: null,
        context: {
          error: "insufficient_points",
          points: points.length,
          lookbackDays,
          metricSlug
        }
      };
    }

    const series: SeriesPoint[] = [...points]
      .reverse()
      .map((point) => ({
        timestamp: point.recordedAt.toISOString(),
        value: Number(point.value)
      }));

    const cacheKey = `alerts:economicAnomaly:${latestPoint.itemId}:${sourceField || "any"}:${modelKind}:${confidenceLevel.toFixed(3)}:${seasonalPeriod}:${end.toISOString()}`;

    return this.cache.wrap(
      cacheKey,
      cacheTtlSeconds,
      async () => {
        const observed = Number(latestPoint.value);
        const modelSeries: ModelServiceSeriesPoint[] = series.map((point) => ({
          timestamp: typeof point.timestamp === "string" ? point.timestamp : new Date(point.timestamp).toISOString(),
          value: point.value
        }));

        const forecast = await this.modelService.forecastHoldoutLastBestEffort({
          series: modelSeries,
          model: { kind: modelKind, seasonalPeriod, confidenceLevel },
          requestId: `economic_anomaly:${latestPoint.itemId}:${end.toISOString()}`
        });

        if (forecast?.forecast && Number.isFinite(forecast.forecast.expected) && Number.isFinite(forecast.forecast.sigma)) {
          const expected = forecast.forecast.expected;
          const sigma = Math.max(1e-12, Math.abs(forecast.forecast.sigma));
          const residual = observed - expected;
          const score = Math.abs(residual) / sigma;
          return {
            latest: score,
            previous: null,
            changePercent: null,
            context: {
              observed,
              expected,
              lower: forecast.forecast.lower,
              upper: forecast.forecast.upper,
              sigma,
              residual,
              score,
              metricSlug,
              itemName: latestPoint.item.displayName,
              recordedAt: latestPoint.recordedAt.toISOString(),
              model: forecast.model,
              diagnostics: forecast.diagnostics
            }
          };
        }

        const fallback = this.fallbackScore(series);
        return {
          latest: fallback.score,
          previous: null,
          changePercent: null,
          context: {
            observed,
            fallback: fallback.context,
            metricSlug,
            itemName: latestPoint.item.displayName,
            recordedAt: latestPoint.recordedAt.toISOString(),
            model: { kind: "fallback" }
          }
        };
      },
      { lockTtlMs: Math.min(30_000, cacheTtlSeconds * 1000), maxWaitMs: Math.min(30_000, cacheTtlSeconds * 1000) }
    );
  }

  private fallbackScore(series: SeriesPoint[]): { score: number; context: Record<string, unknown> } {
    if (series.length < 3) {
      return { score: 0, context: { error: "series_too_short" } };
    }
    const trimmed = series.slice(Math.max(0, series.length - 120));
    const anomalies = detectZScoreAnomalies(trimmed, 3);
    const last = trimmed[trimmed.length - 1];
    const lastHit = anomalies.find((hit) => hit.point === last) ?? null;
    if (lastHit) {
      return {
        score: lastHit.score,
        context: { kind: "zscore", reason: lastHit.reason }
      };
    }

    const spikes = detectRollingSpike(trimmed, 20, 2.5);
    const spikeHit = spikes.find((hit) => hit.point === last) ?? null;
    if (spikeHit) {
      return {
        score: spikeHit.score,
        context: { kind: "rolling_spike", reason: spikeHit.reason }
      };
    }

    return { score: 0, context: { kind: "none" } };
  }
}
