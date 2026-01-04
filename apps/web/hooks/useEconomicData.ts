import { useMemo } from "react";

import { useEconomicDataQuery } from "@/graphql/generated";
import { useDashboardRangeStore } from "@/store/time-range";

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
      const group: EconomicSeriesGroup =
        existing ??
        {
          name: point.item.displayName,
          unit: point.unit ?? point.item.defaultUnit ?? null,
          metadata: point.item.metadata ?? null,
          dataType: point.dataType,
          fields: new Map()
        };
      const fieldSeries = group.fields.get(fieldKey) ?? {
        key: fieldKey,
        label: point.sourceField ?? point.item.displayName,
        unit: point.unit ?? group.unit ?? null,
        values: []
      };
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
      intervals.push(timestamps[i] - timestamps[i - 1]);
    }
    intervals.sort((a, b) => a - b);
    return intervals[Math.floor(intervals.length / 2)] ?? null;
  }, [points]);

  const isDelayed = useMemo(() => {
    if (!latestTimestamp) {
      return false;
    }
    const latest = latestTimestamp.getTime();
    const rangeEnd = end.getTime();
    if (!Number.isFinite(latest) || rangeEnd <= latest) {
      return false;
    }
    const expected = medianIntervalMs ?? 24 * 60 * 60 * 1000;
    return rangeEnd - latest > expected * 2;
  }, [end, latestTimestamp, medianIntervalMs]);

  return {
    loading,
    error,
    refetch,
    seriesMap: grouped,
    hasData: points.length > 0,
    latestTimestamp,
    isDelayed
  };
}
