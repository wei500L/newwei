export interface SeriesPoint {
  timestamp: string | Date;
  value: number;
}

export interface AnomalyDetectionResult {
  point: SeriesPoint;
  reason: string;
  score: number;
}

export function detectZScoreAnomalies(series: SeriesPoint[], threshold = 3): AnomalyDetectionResult[] {
  if (series.length === 0) return [];
  const values = series.map((p) => p.value);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length;
  const std = Math.sqrt(variance);
  if (std === 0) return [];
  return series
    .map((p) => {
      const score = Math.abs((p.value - mean) / std);
      return score >= threshold ? { point: p, reason: `Z-Score ${score.toFixed(2)} >= ${threshold}`, score } : null;
    })
    .filter((r): r is AnomalyDetectionResult => !!r);
}

export function detectRollingSpike(series: SeriesPoint[], window = 20, multiplier = 2.5): AnomalyDetectionResult[] {
  const results: AnomalyDetectionResult[] = [];
  for (let i = window; i < series.length; i++) {
    const windowSlice = series.slice(i - window, i);
    const mean = windowSlice.reduce((a, b) => a + b.value, 0) / windowSlice.length;
    const variance = windowSlice.reduce((sum, v) => sum + Math.pow(v.value - mean, 2), 0) / windowSlice.length;
    const std = Math.sqrt(variance);
    if (std === 0) continue;
    const point = series[i];
    if (Math.abs(point.value - mean) >= multiplier * std) {
      results.push({
        point,
        reason: `Rolling spike |${point.value - mean}| >= ${multiplier}σ`,
        score: Math.abs(point.value - mean) / std
      });
    }
  }
  return results;
}

export function detectTrend(series: SeriesPoint[], days = 3, thresholdPct = 10): AnomalyDetectionResult[] {
  const results: AnomalyDetectionResult[] = [];
  if (series.length < days) return results;
  for (let i = days - 1; i < series.length; i++) {
    const windowSlice = series.slice(i - (days - 1), i + 1);
    const start = windowSlice[0].value;
    const end = windowSlice[windowSlice.length - 1].value;
    if (start === 0) continue;
    const changePct = ((end - start) / Math.abs(start)) * 100;
    if (Math.abs(changePct) >= thresholdPct) {
      results.push({
        point: windowSlice[windowSlice.length - 1],
        reason: `Trend ${days}d change ${changePct.toFixed(2)}%`,
        score: Math.abs(changePct) / thresholdPct
      });
    }
  }
  return results;
}

export function detectVolumeSpike(
  series: SeriesPoint[],
  window = 20,
  volumeToValueRatio = 3
): AnomalyDetectionResult[] {
  const results: AnomalyDetectionResult[] = [];
  for (let i = window; i < series.length; i++) {
    const windowSlice = series.slice(i - window, i);
    const mean = windowSlice.reduce((a, b) => a + b.value, 0) / windowSlice.length;
    const point = series[i];
    if (mean > 0 && point.value >= mean * volumeToValueRatio) {
      results.push({
        point,
        reason: `Volume ${point.value.toFixed(2)} >= ${volumeToValueRatio}x ${mean.toFixed(2)}`,
        score: point.value / mean
      });
    }
  }
  return results;
}
