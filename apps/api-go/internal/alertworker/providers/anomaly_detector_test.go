package providers

import (
	"fmt"
	"testing"
)

// seriesOf builds a deterministic series; the timestamp text is irrelevant to
// the detectors, it only has to be stable.
func seriesOf(values ...float64) []SeriesPoint {
	series := make([]SeriesPoint, len(values))
	for index, value := range values {
		series[index] = SeriesPoint{
			Timestamp: fmt.Sprintf("2026-01-01T00:00:%02d.000Z", index),
			Value:     value,
		}
	}
	return series
}

type expectedFinding struct {
	index  int
	reason string
	score  float64
}

func assertAnomalyFindings(t *testing.T, got []AnomalyFinding, want []expectedFinding) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("findings = %d %+v, want %d %+v", len(got), got, len(want), want)
	}
	for index, expected := range want {
		finding := got[index]
		if finding.Index != expected.index {
			t.Fatalf("finding[%d].Index = %d, want %d", index, finding.Index, expected.index)
		}
		if finding.Reason != expected.reason {
			t.Fatalf("finding[%d].Reason = %q, want %q", index, finding.Reason, expected.reason)
		}
		if finding.Score != expected.score {
			t.Fatalf("finding[%d].Score = %v, want %v", index, finding.Score, expected.score)
		}
	}
}

func TestDetectZScoreAnomalies(t *testing.T) {
	tests := []struct {
		name   string
		series []SeriesPoint
		want   []expectedFinding
	}{
		{
			name:   "empty series",
			series: nil,
		},
		{
			name:   "flat series has zero deviation",
			series: seriesOf(5, 5, 5),
		},
		{
			name:   "single outlier on the last point",
			series: seriesOf(0, 0, 0, 0, 0, 0, 0, 0, 0, 100),
			want: []expectedFinding{
				{index: 9, reason: "Z-Score 3.00 >= 3", score: 3},
			},
		},
		{
			name:   "scores below the threshold are not reported",
			series: seriesOf(0, 0, 0, 100),
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			assertAnomalyFindings(t, DetectZScoreAnomalies(test.series, 3), test.want)
		})
	}
}

func TestDetectRollingSpike(t *testing.T) {
	// Twenty alternating points make the window mean 11 with variance 1, so the
	// 20 appended at the end is nine standard deviations away.
	spike := make([]SeriesPoint, 0, 21)
	for index := 0; index < 20; index++ {
		value := 10.0
		if index%2 == 1 {
			value = 12
		}
		spike = append(spike, SeriesPoint{Value: value})
	}
	spike = append(spike, SeriesPoint{Value: 20})

	tests := []struct {
		name       string
		series     []SeriesPoint
		window     int
		multiplier float64
		want       []expectedFinding
	}{
		{
			name:   "empty series",
			series: nil,
			window: 20, multiplier: 2.5,
		},
		{
			name:   "fewer points than the window",
			series: seriesOf(10, 10, 10),
			window: 20, multiplier: 2.5,
		},
		{
			name:   "flat window has zero deviation",
			series: seriesOf(10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 20),
			window: 20, multiplier: 2.5,
		},
		{
			name:   "last point is a rolling spike",
			series: spike,
			window: 20, multiplier: 2.5,
			want: []expectedFinding{
				{index: 20, reason: "Rolling spike |9| >= 2.5σ", score: 9},
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			assertAnomalyFindings(t, DetectRollingSpike(test.series, test.window, test.multiplier), test.want)
		})
	}
}

func TestDetectTrend(t *testing.T) {
	tests := []struct {
		name         string
		series       []SeriesPoint
		days         int
		thresholdPct float64
		want         []expectedFinding
	}{
		{
			name:   "empty series",
			series: nil,
			days:   3, thresholdPct: 10,
		},
		{
			name:   "shorter than the window",
			series: seriesOf(100, 110),
			days:   3, thresholdPct: 10,
		},
		{
			name:   "rising trend",
			series: seriesOf(100, 120, 150),
			days:   3, thresholdPct: 10,
			want: []expectedFinding{
				{index: 2, reason: "Trend 3d change 50.00%", score: 5},
			},
		},
		{
			name:   "falling trend",
			series: seriesOf(200, 150, 100),
			days:   3, thresholdPct: 10,
			want: []expectedFinding{
				{index: 2, reason: "Trend 3d change -50.00%", score: 5},
			},
		},
		{
			name:   "zero start value is skipped",
			series: seriesOf(0, 5, 10),
			days:   3, thresholdPct: 10,
		},
		{
			name:   "below the threshold",
			series: seriesOf(100, 102, 105),
			days:   3, thresholdPct: 10,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			assertAnomalyFindings(t, DetectTrend(test.series, test.days, test.thresholdPct), test.want)
		})
	}
}

func TestDetectVolumeSpike(t *testing.T) {
	spike := make([]SeriesPoint, 0, 21)
	for index := 0; index < 20; index++ {
		spike = append(spike, SeriesPoint{Value: 10})
	}
	spike = append(spike, SeriesPoint{Value: 40})

	belowRatio := make([]SeriesPoint, 0, 21)
	for index := 0; index < 20; index++ {
		belowRatio = append(belowRatio, SeriesPoint{Value: 10})
	}
	belowRatio = append(belowRatio, SeriesPoint{Value: 25})

	zeros := make([]SeriesPoint, 21)

	tests := []struct {
		name   string
		series []SeriesPoint
		window int
		ratio  float64
		want   []expectedFinding
	}{
		{
			name:   "empty series",
			series: nil,
			window: 20, ratio: 3,
		},
		{
			name:   "no window to compare against",
			series: seriesOf(1, 2, 3),
			window: 20, ratio: 3,
		},
		{
			name:   "last point spikes over the mean",
			series: spike,
			window: 20, ratio: 3,
			want: []expectedFinding{
				{index: 20, reason: "Volume 40.00 >= 3x 10.00", score: 4},
			},
		},
		{
			name:   "below the ratio",
			series: belowRatio,
			window: 20, ratio: 3,
		},
		{
			name:   "non-positive mean cannot spike",
			series: zeros,
			window: 20, ratio: 3,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			assertAnomalyFindings(t, DetectVolumeSpike(test.series, test.window, test.ratio), test.want)
		})
	}
}
