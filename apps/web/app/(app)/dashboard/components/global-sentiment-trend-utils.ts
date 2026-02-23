import dayjs from "@/lib/dayjs";

export type SentimentSeriesKey = "positive" | "neutral" | "negative";

export interface GlobalSentimentTrendDataPoint {
  timestamp: string;
  effectiveGranularity?: string | null;
  value: number;
  sourceField?: string | null;
  item?: {
    slug?: string | null;
    displayName?: string | null;
  } | null;
}

interface SplitTrendSeries {
  mode: "split";
  timestamps: string[];
  positiveValues: number[];
  neutralValues: number[];
  negativeValues: number[];
  recognizedCount: number;
  totalCount: number;
}

interface AggregateTrendSeries {
  mode: "aggregate";
  timestamps: string[];
  aggregateValues: number[];
  recognizedCount: number;
  totalCount: number;
}

export type PreparedGlobalSentimentTrendSeries =
  | SplitTrendSeries
  | AggregateTrendSeries;

export const resolveSentimentSeriesKey = (
  point: GlobalSentimentTrendDataPoint
): SentimentSeriesKey | null => {
  const candidates = [point.sourceField, point.item?.slug, point.item?.displayName];
  for (const candidate of candidates) {
    const normalized =
      typeof candidate === "string" ? candidate.trim().toLowerCase() : "";
    if (!normalized) {
      continue;
    }
    if (normalized.includes("positive")) {
      return "positive";
    }
    if (normalized.includes("neutral")) {
      return "neutral";
    }
    if (normalized.includes("negative")) {
      return "negative";
    }
  }
  return null;
};

const sortTimestamps = (timestamps: string[]) =>
  [...timestamps].sort((a, b) => {
    const left = dayjs(a).valueOf();
    const right = dayjs(b).valueOf();
    const leftValid = Number.isFinite(left);
    const rightValid = Number.isFinite(right);
    if (leftValid && rightValid) {
      return left - right;
    }
    if (leftValid) return -1;
    if (rightValid) return 1;
    return a.localeCompare(b);
  });

export const prepareGlobalSentimentTrendSeries = (
  points: GlobalSentimentTrendDataPoint[]
): PreparedGlobalSentimentTrendSeries => {
  const byTimestamp = new Map<
    string,
    {
      aggregate: number;
      positive: number;
      neutral: number;
      negative: number;
    }
  >();

  let recognizedCount = 0;
  for (const point of points) {
    const timestamp = point.timestamp?.trim();
    if (!timestamp) {
      continue;
    }
    const numericValue = Number(point.value);
    if (!Number.isFinite(numericValue)) {
      continue;
    }

    const existing = byTimestamp.get(timestamp) ?? {
      aggregate: 0,
      positive: 0,
      neutral: 0,
      negative: 0,
    };
    existing.aggregate += numericValue;

    const key = resolveSentimentSeriesKey(point);
    if (key) {
      existing[key] += numericValue;
      recognizedCount += 1;
    }
    byTimestamp.set(timestamp, existing);
  }

  const timestamps = sortTimestamps(Array.from(byTimestamp.keys()));
  if (recognizedCount <= 0) {
    return {
      mode: "aggregate",
      timestamps,
      aggregateValues: timestamps.map((ts) => byTimestamp.get(ts)?.aggregate ?? 0),
      recognizedCount: 0,
      totalCount: points.length,
    };
  }

  return {
    mode: "split",
    timestamps,
    positiveValues: timestamps.map((ts) => byTimestamp.get(ts)?.positive ?? 0),
    neutralValues: timestamps.map((ts) => byTimestamp.get(ts)?.neutral ?? 0),
    negativeValues: timestamps.map((ts) => byTimestamp.get(ts)?.negative ?? 0),
    recognizedCount,
    totalCount: points.length,
  };
};
