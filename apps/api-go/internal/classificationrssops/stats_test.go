package classificationrssops

import (
	"testing"
	"time"
)

// strPtr is a test helper for the optional string fields.
func strPtr(value string) *string { return &value }

// floatPtr is a test helper for the optional numeric fields.
func floatPtr(value float64) *float64 { return &value }

// TestPercentileMatchesMathRound pins the percentile helper: an empty sample has
// no percentile, the index is floor(pct * (n-1)) and the value is Math.round-ed.
func TestPercentileMatchesMathRound(t *testing.T) {
	if percentile(nil, 0.95) != nil {
		t.Fatalf("empty sample must yield nil")
	}
	values := []float64{10, 20, 30, 40, 50}
	cases := []struct {
		pct  float64
		want float64
	}{
		{0, 10},
		{0.5, 30},
		// index = floor(0.95 * (5-1)) = 3
		{0.95, 40},
		{1, 50},
		{1.5, 50},
		{-1, 10},
	}
	for _, tc := range cases {
		got := percentile(values, tc.pct)
		if got == nil || *got != tc.want {
			t.Fatalf("percentile(%v) = %v, want %v", tc.pct, got, tc.want)
		}
	}
	// Math.round rounds halves up for positive values.
	rounded := percentile([]float64{1.5}, 0.5)
	if rounded == nil || *rounded != 2 {
		t.Fatalf("percentile rounding = %v, want 2", rounded)
	}
}

// TestBuildHistogramBuckets pins the ten-bucket confidence histogram: labels use
// one decimal, min/max use four, values are clamped to [0, 1] and a confidence
// of exactly 1.0 lands in the last bucket.
func TestBuildHistogramBuckets(t *testing.T) {
	buckets := buildHistogram([]float64{0, 0.05, 0.99, 1, 2, -1}, 10)
	if len(buckets) != 10 {
		t.Fatalf("bucket count = %d, want 10", len(buckets))
	}
	if buckets[0].Bucket != "0.0-0.1" || buckets[9].Bucket != "0.9-1.0" {
		t.Fatalf("bucket labels = %q .. %q", buckets[0].Bucket, buckets[9].Bucket)
	}
	if buckets[0].Min != 0 || buckets[0].Max != 0.1 {
		t.Fatalf("first bucket bounds = %v..%v", buckets[0].Min, buckets[0].Max)
	}
	// 0, 0.05 and the clamped -1 land in the first bucket.
	if buckets[0].Count != 3 {
		t.Fatalf("first bucket count = %d, want 3", buckets[0].Count)
	}
	// 0.99, 1.0 and the clamped 2 land in the last bucket.
	if buckets[9].Count != 3 {
		t.Fatalf("last bucket count = %d, want 3", buckets[9].Count)
	}
	if buckets[1].Count != 0 {
		t.Fatalf("second bucket count = %d, want 0", buckets[1].Count)
	}
}

// TestToSamplingMeta pins the bounded-scan coverage report.
func TestToSamplingMeta(t *testing.T) {
	meta := toSamplingMeta(5000, 3000, 3000)
	if meta.Matched != 5000 || meta.Scanned != 3000 || meta.Limit != 3000 {
		t.Fatalf("meta = %+v", meta)
	}
	if !meta.Truncated {
		t.Fatalf("matched > scanned >= limit must be truncated")
	}
	if meta.Coverage != 0.6 {
		t.Fatalf("coverage = %v, want 0.6", meta.Coverage)
	}

	empty := toSamplingMeta(0, 0, 0)
	if empty.Coverage != 1 || empty.Limit != 1 || empty.Truncated {
		t.Fatalf("empty meta = %+v", empty)
	}

	untruncated := toSamplingMeta(10, 10, 3000)
	if untruncated.Truncated || untruncated.Coverage != 1 {
		t.Fatalf("untruncated meta = %+v", untruncated)
	}
}

// TestRoundHelpers pins the toFixed(4) rounding used by every rate.
func TestRoundHelpers(t *testing.T) {
	if got := round4(1.0 / 3.0); got != 0.3333 {
		t.Fatalf("round4(1/3) = %v", got)
	}
	if got := ratio4(0, 0, 1); got != 1 {
		t.Fatalf("ratio4 with a zero denominator must fall back: %v", got)
	}
	if got := ratio4(1, 3, 0); got != 0.3333 {
		t.Fatalf("ratio4(1,3) = %v", got)
	}
}

// TestFloorBucketAlignsToEpoch pins the trend bucket alignment.
func TestFloorBucketAlignsToEpoch(t *testing.T) {
	moment := time.Date(2026, 10, 17, 12, 34, 56, 789000000, time.UTC)
	hourly := floorBucket(moment, 60)
	if want := time.Date(2026, 10, 17, 12, 0, 0, 0, time.UTC); !hourly.Equal(want) {
		t.Fatalf("hourly bucket = %s, want %s", hourly, want)
	}
	fiveMinutes := floorBucket(moment, 5)
	if want := time.Date(2026, 10, 17, 12, 30, 0, 0, time.UTC); !fiveMinutes.Equal(want) {
		t.Fatalf("five-minute bucket = %s, want %s", fiveMinutes, want)
	}
}

// TestResolveWindowBuckets pins the three aggregation windows.
func TestResolveWindowBuckets(t *testing.T) {
	cases := []struct {
		window QualityWindow
		hours  int
		bucket int
	}{
		{QualityWindow1h, 1, 5},
		{QualityWindow24h, 24, 60},
		{QualityWindow7d, 24 * 7, 360},
	}
	for _, tc := range cases {
		from, to, bucket := resolveWindow(tc.window)
		if bucket != tc.bucket {
			t.Fatalf("%s bucket = %d, want %d", tc.window, bucket, tc.bucket)
		}
		if diff := to.Sub(from); diff != time.Duration(tc.hours)*time.Hour {
			t.Fatalf("%s span = %s, want %dh", tc.window, diff, tc.hours)
		}
	}
}
