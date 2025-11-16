import type { EconomicSeriesField, EconomicSeriesGroup, EconomicSeriesMap } from "@/hooks/useEconomicData";

export function getSeriesField(seriesMap: EconomicSeriesMap, slug: string, field?: string) {
  const group = seriesMap.get(slug);
  if (!group || group.fields.size === 0) {
    return undefined;
  }
  if (field && group.fields.has(field)) {
    return group.fields.get(field);
  }
  const [first] = group.fields.values();
  return first;
}

export function getSortedValues(series?: EconomicSeriesField) {
  if (!series) {
    return [];
  }
  return [...series.values].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );
}

export function getLatestValue(series?: EconomicSeriesField) {
  const values = getSortedValues(series);
  if (values.length === 0) {
    return null;
  }
  return values[values.length - 1];
}

export function filterValuesByDays(series: EconomicSeriesField | undefined, days: number) {
  const values = getSortedValues(series);
  if (values.length === 0) {
    return [];
  }
  const cutoff = new Date(values[values.length - 1].timestamp);
  cutoff.setDate(cutoff.getDate() - days);
  return values.filter((entry) => new Date(entry.timestamp) >= cutoff);
}

export function calculatePercentChange(series: EconomicSeriesField | undefined, lookback: number) {
  const values = getSortedValues(series);
  if (values.length < 2) {
    return null;
  }
  const latest = values[values.length - 1];
  const baseTime = new Date(latest.timestamp);
  baseTime.setDate(baseTime.getDate() - lookback);
  let base = values[0];
  for (let i = values.length - 2; i >= 0; i -= 1) {
    const candidate = values[i];
    if (new Date(candidate.timestamp) <= baseTime) {
      base = candidate;
      break;
    }
  }
  if (!base) {
    return null;
  }
  if (base.value === 0) {
    return null;
  }
  return ((latest.value - base.value) / base.value) * 100;
}

export function computeMovingAverage(series: EconomicSeriesField | undefined, windowSize: number) {
  const values = getSortedValues(series);
  if (values.length === 0) {
    return [];
  }
  const result: Array<{ timestamp: string; value: number }> = [];
  let windowSum = 0;
  const window: number[] = [];
  for (const entry of values) {
    window.push(entry.value);
    windowSum += entry.value;
    if (window.length > windowSize) {
      windowSum -= window.shift() ?? 0;
    }
    if (window.length === windowSize) {
      result.push({
        timestamp: entry.timestamp,
        value: windowSum / windowSize
      });
    }
  }
  return result;
}

export function getCandlestickSeries(group?: EconomicSeriesGroup) {
  if (!group) {
    return [];
  }
  const openSeries = group.fields.get("开盘价");
  const closeSeries = group.fields.get("收盘价");
  const lowSeries = group.fields.get("最低价");
  const highSeries = group.fields.get("最高价");
  if (!openSeries || !closeSeries || !lowSeries || !highSeries) {
    return [];
  }
  const buckets = new Map<
    string,
    { open?: number; close?: number; low?: number; high?: number }
  >();
  const assign = (series: EconomicSeriesField, key: "open" | "close" | "low" | "high") => {
    for (const entry of series.values) {
      const bucket = buckets.get(entry.timestamp) ?? {};
      bucket[key] = entry.value;
      buckets.set(entry.timestamp, bucket);
    }
  };
  assign(openSeries, "open");
  assign(closeSeries, "close");
  assign(lowSeries, "low");
  assign(highSeries, "high");

  const sortedTimestamps = Array.from(buckets.keys()).sort(
    (a, b) => new Date(a).getTime() - new Date(b).getTime()
  );
  return sortedTimestamps
    .map((timestamp) => {
      const bucket = buckets.get(timestamp);
      if (!bucket || bucket.open === undefined || bucket.close === undefined || bucket.low === undefined || bucket.high === undefined) {
        return undefined;
      }
      return {
        timestamp,
        values: [bucket.open, bucket.close, bucket.low, bucket.high] as [number, number, number, number]
      };
    })
    .filter(Boolean) as Array<{ timestamp: string; values: [number, number, number, number] }>;
}
