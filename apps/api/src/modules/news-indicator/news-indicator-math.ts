const DAY_MS = 24 * 60 * 60 * 1000;

export type DailySeries = Map<number, number>;

export type CorrelationResult = {
  lagDays: number;
  correlation: number;
  pValue: number;
  sampleSize: number;
};

export type BacktestConfig = {
  triggerZScore: number;
  baselineDays: number;
  holdoutDays: number;
  evaluationTargetStartDayMs: number;
  evaluationTargetEndDayMs: number;
};

export type BacktestMetrics = {
  samples: number;
  triggers: number;
  evaluatedSignals: number;
  hits: number;
  hitRate: number;
  avgSignedReturn: number;
  totalSignedReturn: number;
  baselineDays: number;
};

export type NumericSeriesPoint = {
  id: string;
  recordedAt: Date;
  value: number;
};

export function toUtcDayStartMs(value: Date): number {
  const d = new Date(value);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function clampFloat(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(Math.max(value, min), max);
}

function normalCDF(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  const scaled = Math.abs(x) / Math.sqrt(2);
  const t = 1.0 / (1.0 + p * scaled);
  const y = 1.0 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-scaled * scaled);
  return 0.5 * (1.0 + sign * y);
}

function approximatePValue(tStatistic: number, df: number): number {
  if (df > 30) {
    return 2 * (1 - normalCDF(tStatistic));
  }
  const x = df / (df + tStatistic * tStatistic);
  return x;
}

function pearsonCorrelation(x: number[], y: number[]): { correlation: number; pValue: number } {
  const n = Math.min(x.length, y.length);
  if (n < 2) {
    return { correlation: 0, pValue: 1 };
  }

  const muX = x.reduce((acc, v) => acc + v, 0) / n;
  const muY = y.reduce((acc, v) => acc + v, 0) / n;

  let sumXY = 0;
  let sumX2 = 0;
  let sumY2 = 0;

  for (let i = 0; i < n; i += 1) {
    const dx = x[i]! - muX;
    const dy = y[i]! - muY;
    sumXY += dx * dy;
    sumX2 += dx * dx;
    sumY2 += dy * dy;
  }

  if (sumX2 === 0 || sumY2 === 0) {
    return { correlation: 0, pValue: 1 };
  }

  const correlation = sumXY / Math.sqrt(sumX2 * sumY2);
  const clamped = clampFloat(correlation, -0.999999, 0.999999);
  const tStatistic = Math.abs(clamped) * Math.sqrt((n - 2) / (1 - clamped * clamped));
  const pValue = approximatePValue(tStatistic, n - 2);
  return { correlation: clamped, pValue };
}

export function buildDailyEconomicValues(points: NumericSeriesPoint[]): DailySeries {
  const byDay = new Map<number, { recordedAt: number; value: number; id: string }>();

  for (const point of points) {
    const dayKey = toUtcDayStartMs(point.recordedAt);
    const value = point.value;
    if (!Number.isFinite(value)) {
      continue;
    }

    const recordedAt = point.recordedAt.getTime();
    const existing = byDay.get(dayKey);
    if (!existing) {
      byDay.set(dayKey, { recordedAt, value, id: point.id });
      continue;
    }
    if (recordedAt > existing.recordedAt) {
      byDay.set(dayKey, { recordedAt, value, id: point.id });
      continue;
    }
    if (recordedAt === existing.recordedAt && point.id > existing.id) {
      byDay.set(dayKey, { recordedAt, value, id: point.id });
    }
  }

  const series: DailySeries = new Map();
  for (const [dayKey, record] of byDay.entries()) {
    series.set(dayKey, record.value);
  }
  return series;
}

export function buildDailyReturns(valuesByDay: DailySeries): DailySeries {
  const keys = Array.from(valuesByDay.keys()).sort((a, b) => a - b);
  const returns: DailySeries = new Map();
  for (let i = 1; i < keys.length; i += 1) {
    const day = keys[i]!;
    const prevDay = keys[i - 1]!;
    const prevValue = valuesByDay.get(prevDay);
    const value = valuesByDay.get(day);
    if (prevValue === undefined || value === undefined) {
      continue;
    }
    const diff = value - prevValue;
    const pct = prevValue !== 0 ? diff / Math.abs(prevValue) : diff;
    if (!Number.isFinite(pct)) {
      continue;
    }
    returns.set(day, pct);
  }
  return returns;
}

export function computeBestLagCorrelation(
  feature: DailySeries,
  targetReturns: DailySeries,
  options: { maxLagDays: number; minSampleSize: number; maxTargetDayMsExclusive?: number }
): { best: CorrelationResult | null; all: CorrelationResult[] } {
  const maxLagDays = Math.min(Math.max(Math.trunc(options.maxLagDays), 0), 30);
  const minSampleSize = Math.min(Math.max(Math.trunc(options.minSampleSize), 2), 10_000);
  const maxTargetDayMsExclusive =
    typeof options.maxTargetDayMsExclusive === "number" && Number.isFinite(options.maxTargetDayMsExclusive)
      ? options.maxTargetDayMsExclusive
      : undefined;

  const results: CorrelationResult[] = [];

  for (let lagDays = 0; lagDays <= maxLagDays; lagDays += 1) {
    const alignedX: number[] = [];
    const alignedY: number[] = [];

    for (const [day, featureValue] of feature.entries()) {
      const shiftedDay = day + lagDays * DAY_MS;
      if (maxTargetDayMsExclusive !== undefined && shiftedDay >= maxTargetDayMsExclusive) {
        continue;
      }
      const targetValue = targetReturns.get(shiftedDay);
      if (targetValue === undefined) {
        continue;
      }
      alignedX.push(featureValue);
      alignedY.push(targetValue);
    }

    if (alignedX.length < minSampleSize) {
      continue;
    }

    const { correlation, pValue } = pearsonCorrelation(alignedX, alignedY);
    results.push({ lagDays, correlation, pValue, sampleSize: alignedX.length });
  }

  let best: CorrelationResult | null = null;
  for (const result of results) {
    if (!best) {
      best = result;
      continue;
    }
    const abs = Math.abs(result.correlation);
    const bestAbs = Math.abs(best.correlation);
    if (abs > bestAbs) {
      best = result;
      continue;
    }
    if (abs === bestAbs && result.pValue < best.pValue) {
      best = result;
    }
  }

  return { best, all: results };
}

export function runBacktest(
  feature: DailySeries,
  targetReturns: DailySeries,
  association: { lagDays: number; correlation: number },
  config: BacktestConfig
): BacktestMetrics {
  const keys = Array.from(feature.keys()).sort((a, b) => a - b);
  const triggerZScore = clampFloat(config.triggerZScore, 0, 10);
  const baselineDays = Math.min(Math.max(Math.trunc(config.baselineDays), 5), 365);
  const direction = Math.sign(association.correlation);
  const evaluationStartDayMs = config.evaluationTargetStartDayMs;
  const evaluationEndDayMs = config.evaluationTargetEndDayMs;

  const values = keys
    .map((day) => feature.get(day))
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));

  let triggers = 0;
  let evaluatedSignals = 0;
  let hits = 0;
  let totalSignedReturn = 0;

  const baselineWindow: number[] = [];
  let baselineSum = 0;
  let baselineSumSq = 0;

  for (const day of keys) {
    const featureValue = feature.get(day);
    if (featureValue === undefined || !Number.isFinite(featureValue)) {
      continue;
    }

    if (baselineWindow.length >= 5) {
      const mu = baselineSum / baselineWindow.length;
      const variance = baselineSumSq / baselineWindow.length - mu * mu;
      const sigma = variance > 0 ? Math.sqrt(variance) : 0;
      if (sigma > 0) {
        const z = (featureValue - mu) / sigma;
        if (z >= triggerZScore) {
          triggers += 1;
          const shiftedDay = day + association.lagDays * DAY_MS;
          const inWindow = shiftedDay >= evaluationStartDayMs && shiftedDay < evaluationEndDayMs;
          const targetValue = inWindow ? targetReturns.get(shiftedDay) : undefined;
          if (targetValue !== undefined && Number.isFinite(targetValue) && direction !== 0) {
            evaluatedSignals += 1;
            const signedReturn = targetValue * direction;
            totalSignedReturn += signedReturn;
            if (signedReturn > 0) {
              hits += 1;
            }
          }
        }
      }
    }

    baselineWindow.push(featureValue);
    baselineSum += featureValue;
    baselineSumSq += featureValue * featureValue;
    if (baselineWindow.length > baselineDays) {
      const removed = baselineWindow.shift();
      if (removed !== undefined) {
        baselineSum -= removed;
        baselineSumSq -= removed * removed;
      }
    }
  }

  const hitRate = evaluatedSignals > 0 ? hits / evaluatedSignals : 0;
  const avgSignedReturn = evaluatedSignals > 0 ? totalSignedReturn / evaluatedSignals : 0;

  return {
    samples: values.length,
    triggers,
    evaluatedSignals,
    hits,
    hitRate,
    avgSignedReturn,
    totalSignedReturn,
    baselineDays
  };
}

