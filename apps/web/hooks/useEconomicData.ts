import { NetworkStatus } from "@apollo/client";
import { useMemo } from "react";
import { useSession } from "next-auth/react";

import { useDashboardRangeStore } from "@/store/time-range";
import type { ChartDataState } from "@/lib/chart-data-state";
import {
  isEconomicQueryRefreshing,
  resolveEconomicQueryData,
} from "@/lib/economic-query-state";
import { deriveUnitFromValueType, normalizeUnit } from "@/lib/economic-units";
import {
  pickCoarsestGranularity,
  pickFinestGranularity,
  timeGranularityToUiGranularity,
  UiTimeGranularity,
} from "@/lib/time-granularity";
import {
  type EconomicSeriesInsightModel,
  type EconomicDataPointModel,
  EconomicDataValueType,
  TimeGranularity,
  useEconomicDataWithInsightsQuery
} from "@/graphql/generated";

export interface EconomicSeriesOptions {
  category: string;
  pollInterval?: number;
}

const ECONOMIC_DATA_PERMISSION = "economicdata.read";

export type EconomicSeriesInsight = EconomicSeriesInsightModel;

export interface EconomicSeriesField {
  key: string;
  label: string;
  unit?: string | null;
  values: { timestamp: string; value: number }[];
}

export interface EconomicSeriesGroup {
  name: string;
  unit?: string | null;
  metadata?: Record<string, unknown> | null;
  dataType: EconomicDataValueType;
  fields: Record<string, EconomicSeriesField>;
}

export type EconomicSeriesMap = Record<string, EconomicSeriesGroup>;

export type EconomicSeriesInsightsMap = Record<string, Record<string, EconomicSeriesInsight>>;

/**
 * Resolves the unit to use based on precedence rules.
 * Precedence (highest to lowest):
 * 1. pointUnit - if exists and differs from currentUnit
 * 2. currentUnit - if exists
 * 3. defaultUnit - fallback
 *
 * @param pointUnit - Unit from the current data point
 * @param currentUnit - Currently assigned unit (group or field level)
 * @param defaultUnit - Default unit from item configuration
 * @param dataType - Data type of the economic series (used as a unit fallback)
 * @returns The resolved unit or null if none available
 */
function resolveUnit(
  pointUnit: string | null,
  currentUnit: string | null | undefined,
  defaultUnit: string | null,
  dataType: EconomicDataValueType
): string | null {
  const normalizedPointUnit = normalizeUnit(pointUnit);
  const normalizedCurrentUnit = normalizeUnit(currentUnit);
  const normalizedDefaultUnit = normalizeUnit(defaultUnit);

  if (normalizedPointUnit && normalizedPointUnit !== normalizedCurrentUnit) {
    return normalizedPointUnit;
  }
  if (normalizedCurrentUnit) {
    return normalizedCurrentUnit;
  }
  if (normalizedDefaultUnit) {
    return normalizedDefaultUnit;
  }
  return deriveUnitFromValueType(dataType);
}

function normalizePointTimestamp(point: Pick<EconomicDataPointModel, "timestamp">): string {
  const raw = (point as { timestamp: unknown }).timestamp;
  if (typeof raw === "string") {
    return raw;
  }
  if (raw instanceof Date) {
    return raw.toISOString();
  }
  return String(raw);
}

interface EconomicFreshnessPoint {
  timestamp: string | Date;
  sourceField?: string | null;
  effectiveGranularity: TimeGranularity;
  item: { slug: string };
}

function fallbackIntervalMsForGranularity(granularity: TimeGranularity): number | null {
  switch (granularity) {
    case TimeGranularity.Minute:
      return 60_000;
    case TimeGranularity.Hour:
      return 60 * 60 * 1000;
    case TimeGranularity.Day:
      return 24 * 60 * 60 * 1000;
    case TimeGranularity.Week:
      return 7 * 24 * 60 * 60 * 1000;
    case TimeGranularity.Month:
      return 30 * 24 * 60 * 60 * 1000;
    case TimeGranularity.Quarter:
      return 90 * 24 * 60 * 60 * 1000;
    case TimeGranularity.Year:
      return 365 * 24 * 60 * 60 * 1000;
    case TimeGranularity.Realtime:
      return 60_000;
    default:
      return null;
  }
}

export function deriveEconomicFreshness(points: readonly EconomicFreshnessPoint[]): {
  latestTimestamp: Date | null;
  expectedIntervalMs: number | null;
} {
  const seriesTimestamps = new Map<
    string,
    { latest: number; timestamps: number[]; granularity: TimeGranularity }
  >();

  for (const point of points) {
    const timestamp = new Date(point.timestamp).getTime();
    if (!Number.isFinite(timestamp)) {
      continue;
    }
    const seriesKey = `${point.item.slug}::${point.sourceField ?? ""}`;
    const existing = seriesTimestamps.get(seriesKey);
    if (existing) {
      existing.timestamps.push(timestamp);
      if (timestamp > existing.latest) {
        existing.latest = timestamp;
      }
      continue;
    }
    seriesTimestamps.set(seriesKey, {
      latest: timestamp,
      timestamps: [timestamp],
      granularity: point.effectiveGranularity
    });
  }

  const freshestSeries = Array.from(seriesTimestamps.values()).reduce<
    { latest: number; timestamps: number[]; granularity: TimeGranularity } | null
  >((currentFreshest, candidate) => {
    if (!currentFreshest || candidate.latest > currentFreshest.latest) {
      return candidate;
    }
    return currentFreshest;
  }, null);

  if (!freshestSeries) {
    return { latestTimestamp: null, expectedIntervalMs: null };
  }

  const timestamps = Array.from(new Set(freshestSeries.timestamps)).sort((a, b) => a - b);
  const intervals: number[] = [];
  for (let index = 1; index < timestamps.length; index += 1) {
    const current = timestamps[index];
    const previous = timestamps[index - 1];
    if (current === undefined || previous === undefined) {
      continue;
    }
    intervals.push(current - previous);
  }
  intervals.sort((a, b) => a - b);

  return {
    latestTimestamp: new Date(freshestSeries.latest),
    expectedIntervalMs:
      intervals[Math.floor(intervals.length / 2)] ??
      fallbackIntervalMsForGranularity(freshestSeries.granularity)
  };
}

export function useEconomicData({ category, pollInterval }: EconomicSeriesOptions) {
  const { start, end } = useDashboardRangeStore();
  const { data: session, status: sessionStatus } = useSession();
  const permissions = session?.permissions ?? session?.user?.permissions ?? [];
  const canQuery =
    sessionStatus === "authenticated" &&
    permissions.includes(ECONOMIC_DATA_PERMISSION);
  const resolveRequestedGranularity = (
    windowStart: Date,
    windowEnd: Date
  ): TimeGranularity => {
    const diffMs = Math.max(0, windowEnd.getTime() - windowStart.getTime());
    const minuteMs = 60 * 1000;
    const hourMs = 60 * minuteMs;
    const dayMs = 24 * hourMs;
    const diffDays = Math.max(1, Math.round(diffMs / dayMs));

    if (diffMs <= 6 * hourMs) return TimeGranularity.Minute;
    if (diffMs <= 2 * dayMs) return TimeGranularity.Hour;
    if (diffDays > 1095) return TimeGranularity.Year;
    if (diffDays > 365) return TimeGranularity.Quarter;
    if (diffDays > 120) return TimeGranularity.Month;
    if (diffDays > 45) return TimeGranularity.Week;
    return TimeGranularity.Day;
  };
  const requestedGranularity = resolveRequestedGranularity(start, end);
  const variables = useMemo(
    () => ({
      category,
      timeRange: {
        start: start.toISOString(),
        end: end.toISOString()
      },
      granularity: requestedGranularity
    }),
    [category, end, requestedGranularity, start]
  );
  const {
    data,
    previousData,
    loading: queryLoading,
    error,
    refetch,
    networkStatus,
  } = useEconomicDataWithInsightsQuery(
    canQuery
      ? {
          variables,
          pollInterval,
          notifyOnNetworkStatusChange: true
        }
      : {
          skip: true,
          notifyOnNetworkStatusChange: true
        }
  );
  const resolvedData = canQuery
    ? resolveEconomicQueryData({
        data,
        previousData,
        networkStatus
      })
    : null;
  const points = resolvedData?.getEconomicDataWithInsights?.points ?? [];
  const insights = resolvedData?.getEconomicDataWithInsights?.insights ?? [];
  const hasData = points.length > 0;
  const loading =
    sessionStatus === "loading" ||
    (canQuery &&
      (networkStatus === NetworkStatus.setVariables ||
        (!resolvedData &&
          (queryLoading || networkStatus === NetworkStatus.loading))));
  const refreshing = canQuery && isEconomicQueryRefreshing(networkStatus);

  const grouped: EconomicSeriesMap = useMemo(() => {
    const map: EconomicSeriesMap = {};
    for (const point of points) {
      const slug = point.item.slug;
      const fieldKey = point.sourceField ?? `${slug}-default`;
      const existing = map[point.item.slug];
      const pointUnit = point.unit ?? null;
      const defaultUnit = point.item.defaultUnit ?? null;
      const group: EconomicSeriesGroup =
        existing ??
        ({
          name: point.item.displayName,
          unit: resolveUnit(pointUnit, null, defaultUnit, point.dataType),
          metadata: point.item.metadata ?? null,
          dataType: point.dataType,
          fields: {}
        } satisfies EconomicSeriesGroup);

      group.unit = resolveUnit(pointUnit, group.unit, defaultUnit, point.dataType);

      const fieldSeries: EconomicSeriesField = group.fields[fieldKey] ?? {
        key: fieldKey,
        label: point.sourceField ?? point.item.displayName,
        unit: resolveUnit(pointUnit, group.unit, defaultUnit, point.dataType),
        values: []
      };
      fieldSeries.unit = resolveUnit(pointUnit, fieldSeries.unit, group.unit, point.dataType);
      fieldSeries.values.push({
        timestamp: normalizePointTimestamp(point),
        value: point.value
      });
      group.fields[fieldKey] = fieldSeries;
      if (!existing) {
        map[slug] = group;
      }
    }
    return map;
  }, [points]);

  const insightsMap: EconomicSeriesInsightsMap = useMemo(() => {
    const map: EconomicSeriesInsightsMap = {};
    for (const insight of insights) {
      const slug = insight.itemSlug;
      const seriesKey = insight.seriesKey;
      if (!map[slug]) {
        map[slug] = {};
      }
      map[slug]![seriesKey] = insight;
    }
    return map;
  }, [insights]);

  const freshness = useMemo(() => deriveEconomicFreshness(points), [points]);
  const latestTimestamp = freshness.latestTimestamp;

  const appliedGranularityInfo = useMemo(() => {
    const granularities = points.map((point) => timeGranularityToUiGranularity(point.effectiveGranularity));
    const coarsest = pickCoarsestGranularity(granularities);
    const finest = pickFinestGranularity(granularities);
    const range =
      coarsest !== UiTimeGranularity.Unknown &&
      finest !== UiTimeGranularity.Unknown &&
      coarsest !== finest
        ? { finest, coarsest }
        : null;
    return { coarsest, range };
  }, [points]);

  const expectedIntervalMs = useMemo(
    () => freshness.expectedIntervalMs ?? 24 * 60 * 60 * 1000,
    [freshness.expectedIntervalMs]
  );

  const delayMs = useMemo(() => {
    if (!latestTimestamp) {
      return null;
    }
    const latest = latestTimestamp.getTime();
    const rangeEnd = end.getTime();
    if (!Number.isFinite(latest) || !Number.isFinite(rangeEnd)) {
      return null;
    }
    const delta = rangeEnd - latest;
    return delta > 0 ? delta : 0;
  }, [end, latestTimestamp]);

  const isDelayed = useMemo(() => {
    if (!latestTimestamp) {
      return false;
    }
    const latest = latestTimestamp.getTime();
    const rangeEnd = end.getTime();
    if (!Number.isFinite(latest) || rangeEnd <= latest) {
      return false;
    }
    return rangeEnd - latest > expectedIntervalMs * 2;
  }, [end, expectedIntervalMs, latestTimestamp]);

  const chartState: ChartDataState = useMemo(() => {
    if (error) {
      return "error";
    }
    if (loading) {
      return "backfilling";
    }
    if (points.length === 0) {
      return "empty";
    }
    if (isDelayed) {
      return "delayed";
    }
    return "ok";
  }, [error, isDelayed, loading, points.length]);

  return {
    loading,
    error,
    refetch,
    refreshing,
    seriesMap: grouped,
    hasData,
    latestTimestamp,
    appliedGranularity: hasData ? appliedGranularityInfo.coarsest : UiTimeGranularity.Unknown,
    appliedGranularityRange: hasData ? appliedGranularityInfo.range : null,
    isDelayed,
    delayMs,
    expectedIntervalMs,
    chartState,
    insightsMap
  };
}
