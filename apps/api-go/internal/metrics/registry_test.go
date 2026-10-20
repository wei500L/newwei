package metrics

import (
	"math"
	"strings"
	"testing"
)

// renderFamily renders one named family from a registry, without the Go runtime
// series, so the expected text is exact.
func renderFamily(t *testing.T, registry *Registry, name string) string {
	t.Helper()
	for _, family := range registry.snapshot() {
		if family.name == name {
			return render(family)
		}
	}
	t.Fatalf("family %q is not registered", name)
	return ""
}

// TestCounterAndGaugeTextFormat pins counter/gauge lines and the label escaping
// rules (backslash, quote, newline).
func TestCounterAndGaugeTextFormat(t *testing.T) {
	registry := NewRegistry()
	counter := registry.Counter("integration_events_total",
		"External \"event\"\ncounts.", "integration", "operation", "status")
	counter.Inc("a\\b", "x\"y", "line\nbreak")
	counter.Add(2, "a\\b", "x\"y", "line\nbreak")

	want := "# HELP integration_events_total External \"event\"\\ncounts.\n" +
		"# TYPE integration_events_total counter\n" +
		"integration_events_total{integration=\"a\\\\b\",operation=\"x\\\"y\",status=\"line\\nbreak\"} 3\n"
	if got := renderFamily(t, registry, "integration_events_total"); got != want {
		t.Fatalf("counter output:\n%s\nwant:\n%s", got, want)
	}

	gauge := registry.Gauge("pipeline_metric_value",
		"Latest pipeline metric value by slug.", "org_id", "metric")
	gauge.Set(1.5, "org-1", "m1")
	wantGauge := "# HELP pipeline_metric_value Latest pipeline metric value by slug.\n" +
		"# TYPE pipeline_metric_value gauge\n" +
		"pipeline_metric_value{org_id=\"org-1\",metric=\"m1\"} 1.5\n"
	if got := renderFamily(t, registry, "pipeline_metric_value"); got != wantGauge {
		t.Fatalf("gauge output:\n%s\nwant:\n%s", got, wantGauge)
	}
}

// TestHistogramTextFormat pins cumulative buckets, the le label position, +Inf,
// _sum and _count.
func TestHistogramTextFormat(t *testing.T) {
	registry := NewRegistry()
	histogram := registry.Histogram("http_request_duration_seconds",
		"HTTP request duration in seconds.", []float64{0.25, 1},
		"method", "route", "status_code")
	// Exactly representable values keep _sum deterministic.
	histogram.Observe(0.25, "GET", "/x", "200")
	histogram.Observe(0.5, "GET", "/x", "200")
	histogram.Observe(1, "GET", "/x", "200")

	want := "# HELP http_request_duration_seconds HTTP request duration in seconds.\n" +
		"# TYPE http_request_duration_seconds histogram\n" +
		"http_request_duration_seconds_bucket{le=\"0.25\",method=\"GET\",route=\"/x\",status_code=\"200\"} 1\n" +
		"http_request_duration_seconds_bucket{le=\"1\",method=\"GET\",route=\"/x\",status_code=\"200\"} 3\n" +
		"http_request_duration_seconds_bucket{le=\"+Inf\",method=\"GET\",route=\"/x\",status_code=\"200\"} 3\n" +
		"http_request_duration_seconds_sum{method=\"GET\",route=\"/x\",status_code=\"200\"} 1.75\n" +
		"http_request_duration_seconds_count{method=\"GET\",route=\"/x\",status_code=\"200\"} 3\n"
	if got := renderFamily(t, registry, "http_request_duration_seconds"); got != want {
		t.Fatalf("histogram output:\n%s\nwant:\n%s", got, want)
	}
}

// TestHelpEscaping pins escapeString: only backslash and newline are escaped in
// HELP, quotes are not.
func TestHelpEscaping(t *testing.T) {
	if got := escapeString("a\\b\nc\"d"); got != "a\\\\b\\nc\"d" {
		t.Fatalf("help escape = %q", got)
	}
	if got := escapeLabelValue("a\\b\nc\"d"); got != "a\\\\b\\nc\\\"d" {
		t.Fatalf("label escape = %q", got)
	}
}

// TestFormatNumber pins the JavaScript `${value}` shapes for the values these
// families carry.
func TestFormatNumber(t *testing.T) {
	cases := []struct {
		value float64
		want  string
	}{
		{0, "0"},
		{1, "1"},
		{0.005, "0.005"},
		{-0.1, "-0.1"},
		{2.504, "2.504"},
		{1e-7, "1e-7"},
		{1e21, "1e+21"},
		{1e20, "100000000000000000000"},
		{math.NaN(), "Nan"},
		{math.Inf(1), "+Inf"},
		{math.Inf(-1), "-Inf"},
	}
	for _, tc := range cases {
		if got := formatNumber(tc.value); got != tc.want {
			t.Fatalf("formatNumber(%v) = %q, want %q", tc.value, got, tc.want)
		}
	}
}

// TestDefaultFamiliesMatchNestJS pins the five custom family names, types and
// label sets. The Go runtime/process series are additional replacements for the
// nodejs_* series.
func TestDefaultFamiliesMatchNestJS(t *testing.T) {
	output := Render()
	for _, expected := range []string{
		"# TYPE http_request_duration_seconds histogram\n",
		"# TYPE background_job_duration_seconds histogram\n",
		"# TYPE integration_events_total counter\n",
		"# TYPE scheduler_runs_total counter\n",
		"# TYPE pipeline_metric_value gauge\n",
		"# TYPE go_goroutines gauge\n",
		"# TYPE process_start_time_seconds gauge\n",
		"# TYPE process_cpu_seconds_total counter\n",
	} {
		if !strings.Contains(output, expected) {
			t.Fatalf("output is missing %q:\n%s", expected, output)
		}
	}
}

// TestRecordFunctions pin the label tuples the recording helpers write.
func TestRecordFunctions(t *testing.T) {
	RecordIntegrationEvent(IntegrationEventInput{
		Integration: "unit-integration", Operation: "unit-operation", Status: "ok",
	})
	RecordSchedulerRun("unit-scheduler", SchedulerStatusSuccess)
	RecordHTTPRequestMetric(HTTPRequestInput{
		Method: "GET", Route: "/unit-route", StatusCode: 204, DurationMS: 25,
	})
	RecordJobDurationMetric(JobDurationInput{
		Queue: "unit-queue", Job: "unit-job", Status: "completed", DurationMS: 500,
	})
	SetPipelineMetric("unit-org", "unit-metric", 4)

	output := Render()
	for _, expected := range []string{
		`integration_events_total{integration="unit-integration",operation="unit-operation",status="ok"} 1`,
		`scheduler_runs_total{scheduler="unit-scheduler",status="success"} 1`,
		`http_request_duration_seconds_bucket{le="+Inf",method="GET",route="/unit-route",status_code="204"} 1`,
		`background_job_duration_seconds_sum{queue="unit-queue",job="unit-job",status="completed"} 0.5`,
		`pipeline_metric_value{org_id="unit-org",metric="unit-metric"} 4`,
	} {
		if !strings.Contains(output, expected) {
			t.Fatalf("output is missing %q:\n%s", expected, output)
		}
	}
}

// TestSetPipelineMetricIgnoresNonFinite pins Number.isFinite.
func TestSetPipelineMetricIgnoresNonFinite(t *testing.T) {
	SetPipelineMetric("unit-org-nan", "nan", math.NaN())
	SetPipelineMetric("unit-org-nan", "inf", math.Inf(1))
	if output := Render(); strings.Contains(output, "unit-org-nan") {
		t.Fatalf("non-finite values must be ignored:\n%s", output)
	}
}
