package providers

import (
	"fmt"
	"math"

	"github.com/wei500L/newwei/apps/api-go/internal/alertworker/jsnum"
)

// AnomalyFinding is one detector hit, the Go counterpart of
// AnomalyDetectionResult. Index is the position of Point in the input series:
// the NestJS fallback selects the last point with `hit.point === last` (object
// identity), which is the last Index in Go.
type AnomalyFinding struct {
	Index  int
	Point  SeriesPoint
	Reason string
	Score  float64
}

// DetectZScoreAnomalies mirrors detectZScoreAnomalies: population mean and
// standard deviation over the whole series, every point whose absolute z-score
// reaches the threshold is reported. A zero standard deviation reports nothing.
func DetectZScoreAnomalies(series []SeriesPoint, threshold float64) []AnomalyFinding {
	if len(series) == 0 {
		return nil
	}
	total := 0.0
	for _, point := range series {
		total += point.Value
	}
	mean := total / float64(len(series))
	variance := 0.0
	for _, point := range series {
		difference := point.Value - mean
		variance += difference * difference
	}
	variance /= float64(len(series))
	std := math.Sqrt(variance)
	if std == 0 {
		return nil
	}

	findings := make([]AnomalyFinding, 0)
	for index, point := range series {
		score := math.Abs((point.Value - mean) / std)
		if score >= threshold {
			findings = append(findings, AnomalyFinding{
				Index:  index,
				Point:  point,
				Reason: fmt.Sprintf("Z-Score %s >= %s", jsnum.ToFixed(score, 2), jsnum.Format(threshold)),
				Score:  score,
			})
		}
	}
	return findings
}

// DetectRollingSpike mirrors detectRollingSpike: for every point at or after
// index window, compare it against the previous window points (population
// standard deviation). A flat window has no spike by definition.
func DetectRollingSpike(series []SeriesPoint, window int, multiplier float64) []AnomalyFinding {
	findings := make([]AnomalyFinding, 0)
	if window <= 0 {
		return findings
	}
	for index := window; index < len(series); index++ {
		windowSlice := series[index-window : index]
		total := 0.0
		for _, point := range windowSlice {
			total += point.Value
		}
		mean := total / float64(len(windowSlice))
		variance := 0.0
		for _, point := range windowSlice {
			difference := point.Value - mean
			variance += difference * difference
		}
		variance /= float64(len(windowSlice))
		std := math.Sqrt(variance)
		if std == 0 {
			continue
		}
		point := series[index]
		difference := point.Value - mean
		if math.Abs(difference) >= multiplier*std {
			findings = append(findings, AnomalyFinding{
				Index:  index,
				Point:  point,
				Reason: fmt.Sprintf("Rolling spike |%s| >= %sσ", jsnum.Format(difference), jsnum.Format(multiplier)),
				Score:  math.Abs(difference) / std,
			})
		}
	}
	return findings
}

// DetectTrend mirrors detectTrend: compare the first and last point of every
// `days`-point window. A zero start value has no relative change and is
// skipped.
func DetectTrend(series []SeriesPoint, days int, thresholdPct float64) []AnomalyFinding {
	findings := make([]AnomalyFinding, 0)
	if days <= 0 || len(series) < days {
		return findings
	}
	for index := days - 1; index < len(series); index++ {
		windowSlice := series[index-(days-1) : index+1]
		start := windowSlice[0].Value
		end := windowSlice[len(windowSlice)-1].Value
		if start == 0 {
			continue
		}
		changePct := ((end - start) / math.Abs(start)) * 100
		if math.Abs(changePct) >= thresholdPct {
			findings = append(findings, AnomalyFinding{
				Index:  index,
				Point:  series[index],
				Reason: fmt.Sprintf("Trend %sd change %s%%", jsnum.Format(float64(days)), jsnum.ToFixed(changePct, 2)),
				Score:  math.Abs(changePct) / thresholdPct,
			})
		}
	}
	return findings
}

// DetectVolumeSpike mirrors detectVolumeSpike: a point whose value is at least
// `volumeToValueRatio` times the mean of the preceding window. A non-positive
// mean cannot produce a volume spike.
func DetectVolumeSpike(series []SeriesPoint, window int, volumeToValueRatio float64) []AnomalyFinding {
	findings := make([]AnomalyFinding, 0)
	if window <= 0 {
		return findings
	}
	for index := window; index < len(series); index++ {
		windowSlice := series[index-window : index]
		total := 0.0
		for _, point := range windowSlice {
			total += point.Value
		}
		mean := total / float64(len(windowSlice))
		point := series[index]
		if mean > 0 && point.Value >= mean*volumeToValueRatio {
			findings = append(findings, AnomalyFinding{
				Index:  index,
				Point:  point,
				Reason: fmt.Sprintf("Volume %s >= %sx %s", jsnum.ToFixed(point.Value, 2), jsnum.Format(volumeToValueRatio), jsnum.ToFixed(mean, 2)),
				Score:  point.Value / mean,
			})
		}
	}
	return findings
}
