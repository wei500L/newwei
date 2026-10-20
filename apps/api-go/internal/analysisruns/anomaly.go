package analysisruns

// This file ports the four analysis anomaly detectors and their reason
// strings. It is pure computation over the persisted series order.

import "math"

// Statistical anomaly detection ported from
// apps/api/src/modules/analysis/anomaly-detector.ts. The series order is never
// sorted or deduplicated, and every detector reports at most one finding per
// point. The concatenation order (z-score, rolling spike, trend, volume) is part
// of the output contract.
const (
	zScoreThreshold    = 3.0
	rollingWindow      = 20
	rollingMultiplier  = 2.5
	trendSamples       = 3
	trendThresholdPct  = 10.0
	volumeWindow       = 20
	volumeToValueRatio = 3.0
)

// EvaluateSeries runs the four detectors in the source order.
func EvaluateSeries(series []SeriesPoint) []AnomalyFinding {
	findings := make([]AnomalyFinding, 0)
	findings = append(findings, detectZScoreAnomalies(series)...)
	findings = append(findings, detectRollingSpike(series)...)
	findings = append(findings, detectTrend(series)...)
	findings = append(findings, detectVolumeSpike(series)...)
	return findings
}

func detectZScoreAnomalies(series []SeriesPoint) []AnomalyFinding {
	if len(series) == 0 {
		return nil
	}
	mean, variance := populationStats(series)
	std := math.Sqrt(variance)
	if std == 0 {
		return nil
	}
	results := make([]AnomalyFinding, 0)
	for _, point := range series {
		score := math.Abs((point.Value - mean) / std)
		if score >= zScoreThreshold {
			results = append(results, AnomalyFinding{
				Point:  point,
				Reason: "Z-Score " + jsToFixed(score, 2) + " >= " + jsNumberString(zScoreThreshold),
				Score:  score,
			})
		}
	}
	return results
}

func detectRollingSpike(series []SeriesPoint) []AnomalyFinding {
	results := make([]AnomalyFinding, 0)
	for index := rollingWindow; index < len(series); index++ {
		window := series[index-rollingWindow : index]
		mean, variance := windowStats(window)
		std := math.Sqrt(variance)
		if std == 0 {
			continue
		}
		point := series[index]
		deviation := math.Abs(point.Value - mean)
		if deviation >= rollingMultiplier*std {
			results = append(results, AnomalyFinding{
				Point:  point,
				Reason: "Rolling spike |" + jsNumberString(point.Value-mean) + "| >= " + jsNumberString(rollingMultiplier) + "σ",
				Score:  deviation / std,
			})
		}
	}
	return results
}

func detectTrend(series []SeriesPoint) []AnomalyFinding {
	results := make([]AnomalyFinding, 0)
	if len(series) < trendSamples {
		return results
	}
	for index := trendSamples - 1; index < len(series); index++ {
		startPoint := series[index-(trendSamples-1)]
		endPoint := series[index]
		start := startPoint.Value
		end := endPoint.Value
		if start == 0 {
			continue
		}
		changePct := ((end - start) / math.Abs(start)) * 100
		if math.Abs(changePct) >= trendThresholdPct {
			results = append(results, AnomalyFinding{
				Point:  endPoint,
				Reason: "Trend " + jsNumberString(float64(trendSamples)) + "d change " + jsToFixed(changePct, 2) + "%",
				Score:  math.Abs(changePct) / trendThresholdPct,
			})
		}
	}
	return results
}

func detectVolumeSpike(series []SeriesPoint) []AnomalyFinding {
	results := make([]AnomalyFinding, 0)
	for index := volumeWindow; index < len(series); index++ {
		window := series[index-volumeWindow : index]
		mean, _ := windowStats(window)
		point := series[index]
		if mean > 0 && point.Value >= mean*volumeToValueRatio {
			results = append(results, AnomalyFinding{
				Point:  point,
				Reason: "Volume " + jsToFixed(point.Value, 2) + " >= " + jsNumberString(volumeToValueRatio) + "x " + jsToFixed(mean, 2),
				Score:  point.Value / mean,
			})
		}
	}
	return results
}

// populationStats returns the population mean and variance (divide by n). The
// summation order matches the source reduce.
func populationStats(series []SeriesPoint) (float64, float64) {
	if len(series) == 0 {
		return 0, 0
	}
	sum := 0.0
	for _, point := range series {
		sum += point.Value
	}
	mean := sum / float64(len(series))
	variance := 0.0
	for _, point := range series {
		delta := point.Value - mean
		variance += delta * delta
	}
	return mean, variance / float64(len(series))
}

func windowStats(series []SeriesPoint) (float64, float64) {
	if len(series) == 0 {
		return 0, 0
	}
	sum := 0.0
	for _, point := range series {
		sum += point.Value
	}
	mean := sum / float64(len(series))
	variance := 0.0
	for _, point := range series {
		delta := point.Value - mean
		variance += delta * delta
	}
	return mean, variance / float64(len(series))
}
