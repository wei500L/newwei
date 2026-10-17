package classificationrssops

import (
	"math"
	"strconv"
	"time"
)

// round4 mirrors Number(value.toFixed(4)): four decimal places as a number.
func round4(value float64) float64 {
	return math.Round(value*10000) / 10000
}

// ratio4 mirrors Number((numerator / denominator).toFixed(4)) with the NestJS
// zero-denominator fallback.
func ratio4(numerator, denominator float64, fallback float64) float64 {
	if denominator == 0 {
		return fallback
	}
	return round4(numerator / denominator)
}

// percentile mirrors the private percentile helper. sorted must already be
// ascending. The result is Math.round of the sampled value, or nil for an empty
// sample.
func percentile(sorted []float64, pct float64) *float64 {
	if len(sorted) == 0 {
		return nil
	}
	clamped := math.Max(0, math.Min(1, pct))
	index := int(math.Floor(clamped * float64(len(sorted)-1)))
	value := sorted[index]
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return nil
	}
	rounded := math.Round(value)
	return &rounded
}

// histogramBucket is one bin of the confidence histogram. The JSON field order
// matches the NestJS object literal.
type histogramBucket struct {
	Bucket string  `json:"bucket"`
	Min    float64 `json:"min"`
	Max    float64 `json:"max"`
	Count  int     `json:"count"`
}

// buildHistogram mirrors the private buildHistogram helper: the bin count is
// clamped to 1..20 and values are clamped to [0, 1] before binning.
func buildHistogram(values []float64, bins int) []histogramBucket {
	safeBins := int(math.Max(1, math.Min(20, math.Round(float64(bins)))))
	counters := make([]int, safeBins)
	for _, value := range values {
		normalized := math.Max(0, math.Min(1, value))
		index := int(math.Min(float64(safeBins-1), math.Floor(normalized*float64(safeBins))))
		counters[index]++
	}
	out := make([]histogramBucket, 0, safeBins)
	for index, count := range counters {
		min := float64(index) / float64(safeBins)
		max := float64(index+1) / float64(safeBins)
		out = append(out, histogramBucket{
			Bucket: strconv.FormatFloat(min, 'f', 1, 64) + "-" + strconv.FormatFloat(max, 'f', 1, 64),
			Min:    round4(min),
			Max:    round4(max),
			Count:  count,
		})
	}
	return out
}

// floorBucket mirrors the private floorDate helper: epoch-based alignment to
// bucketMinutes, exactly like Math.floor(value.getTime() / ms) * ms.
func floorBucket(value time.Time, bucketMinutes int) time.Time {
	bucketMs := int64(bucketMinutes) * 60 * 1000
	if bucketMs <= 0 {
		return value.UTC()
	}
	millis := value.UnixMilli()
	aligned := millis - ((millis%bucketMs)+bucketMs)%bucketMs
	return time.UnixMilli(aligned).UTC()
}

// samplingMeta mirrors the private toSamplingMeta helper: how much of the
// matched set the bounded scan actually covered.
type samplingMeta struct {
	Matched   int     `json:"matched"`
	Scanned   int     `json:"scanned"`
	Limit     int     `json:"limit"`
	Truncated bool    `json:"truncated"`
	Coverage  float64 `json:"coverage"`
}

// toSamplingMeta mirrors the private toSamplingMeta helper.
func toSamplingMeta(matched, scanned, limit int) samplingMeta {
	safeMatched := maxInt(matched, 0)
	safeScanned := maxInt(scanned, 0)
	safeLimit := maxInt(limit, 1)
	coverage := 1.0
	if safeMatched > 0 {
		coverage = round4(float64(minInt(safeScanned, safeMatched)) / float64(safeMatched))
	}
	return samplingMeta{
		Matched:   safeMatched,
		Scanned:   safeScanned,
		Limit:     safeLimit,
		Truncated: safeMatched > safeScanned && safeScanned >= safeLimit,
		Coverage:  coverage,
	}
}

// minInt returns the smaller of two ints.
func minInt(left, right int) int {
	if left < right {
		return left
	}
	return right
}

// maxInt returns the larger of two ints.
func maxInt(left, right int) int {
	if left > right {
		return left
	}
	return right
}

// clampIntRange mirrors Math.max(min, Math.min(max, Math.trunc(value))).
func clampIntRange(value float64, min, max int) int {
	floored := math.Trunc(value)
	if floored < float64(min) {
		return min
	}
	if floored > float64(max) {
		return max
	}
	return int(floored)
}
