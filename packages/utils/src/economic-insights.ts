export type SeriesDirection = "up" | "down" | "flat";

export type SeriesInsightClassification =
  | "insufficient_data"
  | "stable"
  | "trend"
  | "volatility"
  | "anomaly";

export interface TimeSeriesPoint {
  timestamp: Date;
  value: number;
}

export interface SeriesInsightOptions {
  anomalyZScore?: number;
  trendPercentChange?: number;
  volatilityCoefficient?: number;
  minSampleCount?: number;
  messageDecimals?: number;
}

export interface SeriesInsight {
  sampleCount: number;
  currentValue: number | null;
  previousValue: number | null;
  change: number | null;
  percentChange: number | null;
  mean: number | null;
  stdDev: number | null;
  zScore: number | null;
  direction: SeriesDirection;
  classification: SeriesInsightClassification;
  message: string;
}

const DEFAULT_OPTIONS: Required<SeriesInsightOptions> = {
  anomalyZScore: 2.5,
  trendPercentChange: 5,
  volatilityCoefficient: 0.2,
  minSampleCount: 5,
  messageDecimals: 1
};

const safeFiniteNumber = (value: unknown): number | null => {
  if (typeof value !== "number") {
    return null;
  }
  if (!Number.isFinite(value)) {
    return null;
  }
  return value;
};

const sortPointsByTimestamp = (points: TimeSeriesPoint[]): TimeSeriesPoint[] => {
  return [...points].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
};

const meanOf = (values: number[]): number | null => {
  if (values.length === 0) {
    return null;
  }
  const sum = values.reduce((acc, value) => acc + value, 0);
  return sum / values.length;
};

const stdDevOf = (values: number[], mean: number): number => {
  if (values.length === 0) {
    return 0;
  }
  const variance =
    values.reduce((acc, value) => {
      const delta = value - mean;
      return acc + delta * delta;
    }, 0) / values.length;
  return Math.sqrt(variance);
};

const toFixedSafe = (value: number, decimals: number): string => {
  if (!Number.isFinite(value)) {
    return "0";
  }
  return value.toFixed(Math.max(0, Math.min(decimals, 6)));
};

const resolveDirection = (change: number | null, percentChange: number | null): SeriesDirection => {
  const value = percentChange ?? change;
  if (value === null) {
    return "flat";
  }
  if (value > 0) {
    return "up";
  }
  if (value < 0) {
    return "down";
  }
  return "flat";
};

const buildMessage = (
  classification: SeriesInsightClassification,
  direction: SeriesDirection,
  metrics: {
    percentChange: number | null;
    zScore: number | null;
    volatilityCoefficient: number | null;
  },
  decimals: number
): string => {
  switch (classification) {
    case "anomaly": {
      const z = metrics.zScore;
      if (z === null) {
        return "Latest value deviates materially from the series mean.";
      }
      const zAbs = Math.abs(z);
      const above = z > 0;
      return `Latest value is ${toFixedSafe(zAbs, decimals)} sigma ${above ? "above" : "below"} the series mean.`;
    }
    case "trend": {
      const pct = metrics.percentChange;
      if (pct === null) {
        return direction === "up"
          ? "Latest value increased vs previous point."
          : direction === "down"
            ? "Latest value decreased vs previous point."
            : "Latest value is unchanged vs previous point.";
      }
      const abs = Math.abs(pct);
      return `Latest value changed ${toFixedSafe(abs, decimals)}% ${direction === "up" ? "up" : "down"} vs previous point.`;
    }
    case "volatility": {
      const cv = metrics.volatilityCoefficient;
      if (cv === null) {
        return "Series volatility is elevated.";
      }
      return `Series volatility is elevated (CV ${toFixedSafe(cv, decimals)}).`;
    }
    case "stable":
      return "Series is stable around its recent mean.";
    case "insufficient_data":
    default:
      return "Not enough data to infer a trend.";
  }
};

export const computeSeriesInsight = (
  input: TimeSeriesPoint[],
  options?: SeriesInsightOptions
): SeriesInsight => {
  const merged = { ...DEFAULT_OPTIONS, ...(options ?? {}) };
  const points = sortPointsByTimestamp(input)
    .map((point) => {
      const timestamp = point.timestamp instanceof Date ? point.timestamp : new Date(point.timestamp);
      const value = safeFiniteNumber(point.value);
      if (value === null) {
        return null;
      }
      if (!Number.isFinite(timestamp.valueOf())) {
        return null;
      }
      return { timestamp, value } satisfies TimeSeriesPoint;
    })
    .filter((entry): entry is TimeSeriesPoint => Boolean(entry));

  const sampleCount = points.length;
  if (sampleCount < 2) {
    return {
      sampleCount,
      currentValue: sampleCount === 1 ? points[0]?.value ?? null : null,
      previousValue: null,
      change: null,
      percentChange: null,
      mean: sampleCount === 1 ? points[0]?.value ?? null : null,
      stdDev: sampleCount === 1 ? 0 : null,
      zScore: null,
      direction: "flat",
      classification: "insufficient_data",
      message: "Not enough data to infer a trend."
    };
  }

  const current = points[points.length - 1]!;
  const previous = points[points.length - 2]!;
  const change = current.value - previous.value;
  const percentChange =
    previous.value === 0 ? null : (change / previous.value) * 100;

  const values = points.map((point) => point.value);
  const mean = meanOf(values);
  const stdDev = mean === null ? null : stdDevOf(values, mean);
  const zScore =
    mean !== null && stdDev !== null && stdDev > 0
      ? (current.value - mean) / stdDev
      : null;

  const direction = resolveDirection(change, percentChange);
  const volatilityCoefficient =
    mean !== null && stdDev !== null && mean !== 0
      ? Math.abs(stdDev / mean)
      : null;

  const classification = (() => {
    if (
      sampleCount >= merged.minSampleCount &&
      zScore !== null &&
      Math.abs(zScore) >= merged.anomalyZScore
    ) {
      return "anomaly" satisfies SeriesInsightClassification;
    }
    if (percentChange !== null && Math.abs(percentChange) >= merged.trendPercentChange) {
      return "trend" satisfies SeriesInsightClassification;
    }
    if (
      sampleCount >= merged.minSampleCount &&
      volatilityCoefficient !== null &&
      volatilityCoefficient >= merged.volatilityCoefficient
    ) {
      return "volatility" satisfies SeriesInsightClassification;
    }
    return "stable" satisfies SeriesInsightClassification;
  })();

  const message = buildMessage(
    classification,
    direction,
    { percentChange, zScore, volatilityCoefficient },
    merged.messageDecimals
  );

  return {
    sampleCount,
    currentValue: current.value,
    previousValue: previous.value,
    change,
    percentChange,
    mean,
    stdDev,
    zScore,
    direction,
    classification,
    message
  };
};

export interface EconomicDataPointForInsight {
  recordedAt: Date;
  value: number;
  unit?: string | null;
  sourceField?: string | null;
  item: {
    slug: string;
    defaultUnit?: string | null;
  };
}

export interface EconomicSeriesInsight extends SeriesInsight {
  itemSlug: string;
  seriesKey: string;
  sourceField: string | null;
  unit: string | null;
}

const resolveSeriesKey = (itemSlug: string, sourceField: string | null): string => {
  return sourceField ?? `${itemSlug}-default`;
};

const resolveUnit = (points: EconomicDataPointForInsight[], defaultUnit: string | null): string | null => {
  let current = defaultUnit;
  for (const point of points) {
    const unit = typeof point.unit === "string" ? point.unit.trim() : "";
    if (unit && unit !== current) {
      current = unit;
    }
  }
  return current;
};

export const computeEconomicSeriesInsights = (
  points: EconomicDataPointForInsight[],
  options?: SeriesInsightOptions
): EconomicSeriesInsight[] => {
  const grouped = new Map<
    string,
    {
      itemSlug: string;
      sourceField: string | null;
      seriesKey: string;
      defaultUnit: string | null;
      points: EconomicDataPointForInsight[];
    }
  >();

  for (const point of points) {
    const itemSlugRaw = point.item?.slug;
    const itemSlug = typeof itemSlugRaw === "string" ? itemSlugRaw.trim() : "";
    if (!itemSlug) {
      continue;
    }
    const sourceField = typeof point.sourceField === "string" ? point.sourceField.trim() : null;
    const seriesKey = resolveSeriesKey(itemSlug, sourceField);
    const mapKey = `${itemSlug}::${seriesKey}`;

    const entry =
      grouped.get(mapKey) ??
      {
        itemSlug,
        sourceField,
        seriesKey,
        defaultUnit:
          typeof point.item?.defaultUnit === "string" ? point.item.defaultUnit : null,
        points: []
      };

    entry.points.push(point);
    grouped.set(mapKey, entry);
  }

  const results: EconomicSeriesInsight[] = [];
  for (const entry of grouped.values()) {
    const unit = resolveUnit(entry.points, entry.defaultUnit);
    const seriesPoints: TimeSeriesPoint[] = entry.points
      .map((point) => {
        const timestamp = point.recordedAt;
        const value = safeFiniteNumber(point.value);
        if (value === null) {
          return null;
        }
        if (!(timestamp instanceof Date) || !Number.isFinite(timestamp.valueOf())) {
          return null;
        }
        return { timestamp, value } satisfies TimeSeriesPoint;
      })
      .filter((point): point is TimeSeriesPoint => Boolean(point));

    const insight = computeSeriesInsight(seriesPoints, options);
    results.push({
      ...insight,
      itemSlug: entry.itemSlug,
      seriesKey: entry.seriesKey,
      sourceField: entry.sourceField,
      unit
    });
  }

  results.sort((a, b) => {
    if (a.itemSlug === b.itemSlug) {
      return a.seriesKey.localeCompare(b.seriesKey);
    }
    return a.itemSlug.localeCompare(b.itemSlug);
  });

  return results;
};
