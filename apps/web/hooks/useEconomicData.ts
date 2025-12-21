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
  values: { timestamp: string; value: number }[];
}

export interface EconomicSeriesGroup {
  name: string;
  unit?: string | null;
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

  const grouped: EconomicSeriesMap = useMemo(() => {
    const points = data?.getEconomicData ?? [];
    const map: EconomicSeriesMap = new Map();
    for (const point of points) {
      const slug = point.item.slug;
      const fieldKey = point.sourceField ?? `${slug}-default`;
      const existing = map.get(point.item.slug);
      const group: EconomicSeriesGroup =
        existing ??
        {
          name: point.item.displayName,
          unit: point.unit,
          dataType: point.dataType,
          fields: new Map()
        };
      const fieldSeries = group.fields.get(fieldKey) ?? {
        key: fieldKey,
        label: point.sourceField ?? point.item.displayName,
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
  }, [data]);

  return {
    loading,
    error,
    refetch,
    seriesMap: grouped
  };
}
