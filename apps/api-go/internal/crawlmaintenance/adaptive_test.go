package crawlmaintenance

import (
	"encoding/json"
	"testing"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/settingscrawl"
)

// TestComputePercentile covers the ceil(n * p) - 1 index rule.
func TestComputePercentile(t *testing.T) {
	values := make([]float64, 0, 20)
	for value := 1.0; value <= 20; value++ {
		values = append(values, value)
	}
	if got := computePercentile(values, 0.95); got == nil || *got != 19 {
		t.Fatalf("p95 of 1..20 = %v, want 19", got)
	}
	if got := computePercentile([]float64{42}, 0.95); got == nil || *got != 42 {
		t.Fatalf("p95 of one value = %v, want 42", got)
	}
	if got := computePercentile(nil, 0.95); got != nil {
		t.Fatalf("p95 of no values = %v, want nil", got)
	}
	hundred := make([]float64, 0, 100)
	for value := 1.0; value <= 100; value++ {
		hundred = append(hundred, value)
	}
	if got := computePercentile(hundred, 0.95); got == nil || *got != 95 {
		t.Fatalf("p95 of 1..100 = %v, want 95", got)
	}
}

// TestBuildAdaptiveMetrics covers the error rate, latency count and arithmetic
// mean headroom.
func TestBuildAdaptiveMetrics(t *testing.T) {
	metrics := buildAdaptiveMetrics(4, 1, []float64{200, 100}, []float64{0.5, 0.25})
	if metrics.TaskCount != 4 || metrics.FailedCount != 1 {
		t.Fatalf("counts = %d/%d", metrics.TaskCount, metrics.FailedCount)
	}
	if metrics.ErrorRate != 0.25 {
		t.Fatalf("errorRate = %v, want 0.25", metrics.ErrorRate)
	}
	if metrics.P95LatencyMs == nil || *metrics.P95LatencyMs != 200 {
		t.Fatalf("p95 = %v, want 200", metrics.P95LatencyMs)
	}
	if metrics.MemoryHeadroom == nil || *metrics.MemoryHeadroom != 0.375 {
		t.Fatalf("memoryHeadroom = %v, want 0.375", metrics.MemoryHeadroom)
	}
	if metrics.MemorySampleCount != 2 || metrics.LatencySampleCount != 2 {
		t.Fatalf("sample counts = %d/%d", metrics.MemorySampleCount, metrics.LatencySampleCount)
	}
	empty := buildAdaptiveMetrics(0, 0, nil, nil)
	if empty.ErrorRate != 0 || empty.P95LatencyMs != nil || empty.MemoryHeadroom != nil {
		t.Fatalf("empty metrics = %+v", empty)
	}
}

// TestBuildAdaptiveReasons pins the exact reason text, including the JS
// toFixed(1)/toFixed(0) rounding.
func TestBuildAdaptiveReasons(t *testing.T) {
	settings := settingscrawl.DefaultCrawlClientNormalized()
	settings.Settings.RequestTimeoutNormalMs = 1000
	settings.Settings.AdaptiveLatencyThresholdRatio = 0.85
	settings.Settings.AdaptiveErrorRateThreshold = 0.2
	settings.Settings.AdaptiveMemoryHeadroomThreshold = 0.12

	p95 := 900.0
	headroom := 0.1
	metrics := buildAdaptiveMetrics(40, 9, []float64{p95}, []float64{headroom})
	reasons := buildAdaptiveReasons(metrics, settings)
	want := []string{
		"p95 latency 900 > 850ms",
		"error rate 22.5% > 20%",
		"memory headroom 10.0% < 12%",
	}
	if len(reasons) != len(want) {
		t.Fatalf("reasons = %v", reasons)
	}
	for index := range want {
		if reasons[index] != want[index] {
			t.Errorf("reason[%d] = %q, want %q", index, reasons[index], want[index])
		}
	}
	if joined := joinReasons(reasons); joined != want[0]+"; "+want[1]+"; "+want[2] {
		t.Fatalf("joined = %q", joined)
	}

	stable := buildAdaptiveMetrics(3, 0, []float64{100, 200}, []float64{0.5})
	if got := buildAdaptiveReasons(stable, settings); len(got) != 0 {
		t.Fatalf("stable reasons = %v", got)
	}
}

// TestAdaptiveStateJSONContract pins the exact cached document: field order,
// null fields and numeric formatting. The Go reader in crawltaskwrite and the
// NestJS getStatus both read a subset of these keys.
func TestAdaptiveStateJSONContract(t *testing.T) {
	latency := 1200.0
	headroom := 0.5
	adjustedAt := "2026-10-20T15:00:00.000Z"
	reason := "error rate 25.0% > 20%"
	document := adaptiveStateDocument{
		Enabled:               true,
		LastDecision:          "decrease",
		LastAdjustedAt:        &adjustedAt,
		Reason:                &reason,
		CurrentMaxConcurrency: 2,
		UpdatedAt:             "2026-10-20T15:00:00.000Z",
		Metrics: adaptiveMetricsState{
			TaskCount:          4,
			FailedCount:        1,
			ErrorRate:          0.25,
			P95LatencyMs:       &latency,
			MemoryHeadroom:     &headroom,
			MemorySampleCount:  1,
			LatencySampleCount: 2,
			SamplingMode:       "recent_sample",
		},
	}
	encoded, err := json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"enabled":true,"lastDecision":"decrease","lastAdjustedAt":"2026-10-20T15:00:00.000Z",` +
		`"reason":"error rate 25.0% > 20%","currentMaxConcurrency":2,` +
		`"updatedAt":"2026-10-20T15:00:00.000Z","metrics":{"taskCount":4,"failedCount":1,` +
		`"errorRate":0.25,"p95LatencyMs":1200,"memoryHeadroom":0.5,"memorySampleCount":1,` +
		`"latencySampleCount":2,"samplingMode":"recent_sample"}}`
	if string(encoded) != want {
		t.Fatalf("state JSON = %s\nwant      = %s", encoded, want)
	}

	// The Go read side (crawltaskwrite adaptiveState) projects this subset.
	var readSide struct {
		LastDecision   string                `json:"lastDecision"`
		LastAdjustedAt *string               `json:"lastAdjustedAt"`
		Reason         *string               `json:"reason"`
		Metrics        *adaptiveMetricsState `json:"metrics"`
	}
	if err := json.Unmarshal(encoded, &readSide); err != nil {
		t.Fatal(err)
	}
	if readSide.LastDecision != "decrease" || readSide.LastAdjustedAt == nil ||
		readSide.Reason == nil || readSide.Metrics == nil || readSide.Metrics.SamplingMode != "recent_sample" {
		t.Fatalf("read side projection = %+v", readSide)
	}
}

// TestEmptyAdaptiveMetrics pins the empty metrics document used by the disabled
// and idle branches.
func TestEmptyAdaptiveMetrics(t *testing.T) {
	encoded, err := json.Marshal(emptyAdaptiveMetrics())
	if err != nil {
		t.Fatal(err)
	}
	want := `{"taskCount":0,"failedCount":0,"errorRate":0,"p95LatencyMs":null,"memoryHeadroom":null,` +
		`"memorySampleCount":0,"latencySampleCount":0,"samplingMode":"recent_sample"}`
	if string(encoded) != want {
		t.Fatalf("empty metrics = %s", encoded)
	}
}
