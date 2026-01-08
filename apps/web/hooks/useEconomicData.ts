import { useMemo } from "react";

import { useEconomicDataQuery } from "@/graphql/generated";
import { useDashboardRangeStore } from "@/store/time-range";
import type { ChartDataState } from "@/lib/chart-data-state";

export interface EconomicSeriesOptions {
  category: string;
  pollInterval?: number;
}

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
  dataType: string;
  fields: Map<string, EconomicSeriesField>;
}

export type EconomicSeriesMap = Map<string, EconomicSeriesGroup>;

export function useEconomicData({ category, pollInterval }: EconomicSeriesOptions) {
  const { start, end } = useDashboardRangeStore();
  const { data, loading, error, refetch } = useEconomicDataQuery({
    variables: {
      category,
      timeRange: {
        start: start.toISOString(),
        end: end.toISOString()
      }
    },
    pollInterval
  });
  const points = data?.getEconomicData ?? [];

  const grouped: EconomicSeriesMap = useMemo(() => {
    const map: EconomicSeriesMap = new Map();
    for (const point of points) {
      const slug = point.item.slug;
      const fieldKey = point.sourceField ?? `${slug}-default`;
      const existing = map.get(point.item.slug);
      const pointUnit = point.unit ?? null;
      const defaultUnit = point.item.defaultUnit ?? null;
      const group: EconomicSeriesGroup =
        existing ??
        {
          name: point.item.displayName,
          unit: pointUnit ?? defaultUnit,
          metadata: point.item.metadata ?? null,
          dataType: point.dataType,
          fields: new Map()
        };

      if (pointUnit && group.unit !== pointUnit) {
        group.unit = pointUnit;
      } else if (!group.unit && defaultUnit) {
        group.unit = defaultUnit;
      }

      const fieldSeries = group.fields.get(fieldKey) ?? {
        key: fieldKey,
        label: point.sourceField ?? point.item.displayName,
        unit: pointUnit ?? group.unit ?? defaultUnit,
        values: []
      };
      if (pointUnit && fieldSeries.unit !== pointUnit) {
        fieldSeries.unit = pointUnit;
      } else if (!fieldSeries.unit && group.unit) {
        fieldSeries.unit = group.unit;
      }
      fieldSeries.values.push({
        timestamp: point.timestamp,
        value: point.value
      });
      group.fields.set(fieldKey, fieldSeries);
      if (!existing) {
        map.set(slug, group);
      }
    }
    return map;
  }, [points]);

  const latestTimestamp = useMemo(() => {
    let latest = 0;
    for (const point of points) {
      const ts = new Date(point.timestamp).getTime();
      if (!Number.isNaN(ts) && ts > latest) {
        latest = ts;
      }
    }
    return latest > 0 ? new Date(latest) : null;
  }, [points]);

  const medianIntervalMs = useMemo(() => {
    const timestamps = Array.from(
      new Set(points.map((point) => new Date(point.timestamp).getTime()))
    ).filter((value) => Number.isFinite(value));
    if (timestamps.length < 2) {
      return null;
    }
    timestamps.sort((a, b) => a - b);
    const intervals: number[] = [];
    for (let i = 1; i < timestamps.length; i += 1) {
      const current = timestamps[i];
      const previous = timestamps[i - 1];
      if (current === undefined || previous === undefined) {
        continue;
      }
      if (!Number.isFinite(current) || !Number.isFinite(previous)) {
        continue;
      }
      intervals.push(current - previous);
    }
    intervals.sort((a, b) => a - b);
    return intervals[Math.floor(intervals.length / 2)] ?? null;
  }, [points]);

  const expectedIntervalMs = useMemo(() => medianIntervalMs ?? 24 * 60 * 60 * 1000, [medianIntervalMs]);

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
    seriesMap: grouped,
    hasData: points.length > 0,
    latestTimestamp,
    isDelayed,
    delayMs,
    expectedIntervalMs,
    chartState
  };
}
