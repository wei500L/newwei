package providers

import (
	"context"
	"testing"
)

func TestSystemMetricFetch(t *testing.T) {
	// No case reaches a live service: the metadata branch returns before the
	// cache read, and the OREF case short-circuits because deps.Redis is nil.
	provider := NewSystem(Dependencies{})
	if provider.Type() != TypeSystemMetric {
		t.Fatalf("Type() = %q, want %q", provider.Type(), TypeSystemMetric)
	}

	tests := []struct {
		name        string
		rule        Rule
		wantLatest  *float64
		wantContext string
	}{
		{
			name:        "metadata currentValue wins over the slug",
			rule:        Rule{MetricSlug: systemMemoryUsageMetricSlug, Metadata: []byte(`{"currentValue":42.5}`)},
			wantLatest:  metricValuePtr(42.5),
			wantContext: `{"source":"metadata"}`,
		},
		{
			name:        "custom manual without a value",
			rule:        Rule{MetricSlug: customManualSystemMetricSlug},
			wantContext: `{"error":"custom_manual_requires_current_value"}`,
		},
		{
			name:        "non-numeric currentValue does not count",
			rule:        Rule{MetricSlug: customManualSystemMetricSlug, Metadata: []byte(`{"currentValue":"42.5"}`)},
			wantContext: `{"error":"custom_manual_requires_current_value"}`,
		},
		{
			name:        "memory usage is not readable from another host",
			rule:        Rule{MetricSlug: systemMemoryUsageMetricSlug},
			wantContext: `{"error":"unknown system metric"}`,
		},
		{
			name:        "load average is not readable from another host",
			rule:        Rule{MetricSlug: systemLoad1mMetricSlug},
			wantContext: `{"error":"unknown system metric"}`,
		},
		{
			name:        "uptime is not readable from another host",
			rule:        Rule{MetricSlug: systemUptimeSecondsMetricSlug},
			wantContext: `{"error":"unknown system metric"}`,
		},
		{
			name:        "oref snapshot without a configured cache",
			rule:        Rule{MetricSlug: situationOrefActiveAlertsMetricSlug},
			wantContext: `{"error":"metrics_unavailable"}`,
		},
		{
			name:        "unknown slug",
			rule:        Rule{MetricSlug: "system.something.else"},
			wantContext: `{"error":"unknown system metric"}`,
		},
		{
			name:        "empty slug",
			rule:        Rule{},
			wantContext: `{"error":"unknown system metric"}`,
		},
	}

	for _, test := range tests {
		evaluation, err := provider.Fetch(context.Background(), test.rule)
		if err != nil {
			t.Fatalf("%s: Fetch: %v", test.name, err)
		}
		if evaluation.Previous != nil || evaluation.ChangePercent != nil {
			t.Fatalf("%s: evaluation = %+v, want nil previous/changePercent", test.name, evaluation)
		}
		if test.wantLatest == nil {
			if evaluation.Latest != nil {
				t.Fatalf("%s: latest = %v, want nil", test.name, *evaluation.Latest)
			}
		} else if evaluation.Latest == nil || *evaluation.Latest != *test.wantLatest {
			t.Fatalf("%s: latest = %v, want %v", test.name, evaluation.Latest, *test.wantLatest)
		}
		if string(evaluation.Context) != test.wantContext {
			t.Fatalf("%s: context = %s, want %s", test.name, evaluation.Context, test.wantContext)
		}
	}
}

func TestEvaluateOrefSnapshot(t *testing.T) {
	tests := []struct {
		name        string
		payload     []byte
		key         string
		wantLatest  *float64
		wantContext string
		wantErr     bool
	}{
		{
			name:        "active alerts",
			payload:     []byte(`{"activeAlerts":7,"historyCount24h":3,"updatedAt":"2026-01-02T03:04:05.000Z"}`),
			key:         orefActiveAlertsField,
			wantLatest:  metricValuePtr(7),
			wantContext: `{"source":"situation-monitor-signals","updatedAt":"2026-01-02T03:04:05.000Z"}`,
		},
		{
			name:        "history count",
			payload:     []byte(`{"activeAlerts":7,"historyCount24h":3,"updatedAt":"2026-01-02T03:04:05.000Z"}`),
			key:         orefHistory24hField,
			wantLatest:  metricValuePtr(3),
			wantContext: `{"source":"situation-monitor-signals","updatedAt":"2026-01-02T03:04:05.000Z"}`,
		},
		{
			name:        "a real zero is a value",
			payload:     []byte(`{"activeAlerts":0}`),
			key:         orefActiveAlertsField,
			wantLatest:  metricValuePtr(0),
			wantContext: `{"source":"situation-monitor-signals"}`,
		},
		{
			name:        "missing field has no value",
			payload:     []byte(`{"activeAlerts":7}`),
			key:         orefHistory24hField,
			wantContext: `{"source":"situation-monitor-signals"}`,
		},
		{
			name:        "null value has no value",
			payload:     []byte(`{"activeAlerts":null}`),
			key:         orefActiveAlertsField,
			wantContext: `{"source":"situation-monitor-signals"}`,
		},
		{
			name:        "non-string updatedAt is dropped",
			payload:     []byte(`{"activeAlerts":2,"updatedAt":5}`),
			key:         orefActiveAlertsField,
			wantLatest:  metricValuePtr(2),
			wantContext: `{"source":"situation-monitor-signals"}`,
		},
		{
			name:        "missing cache entry",
			payload:     nil,
			key:         orefActiveAlertsField,
			wantContext: `{"error":"metrics_unavailable"}`,
		},
		{
			name:        "empty cache value",
			payload:     []byte("   "),
			key:         orefActiveAlertsField,
			wantContext: `{"error":"metrics_unavailable"}`,
		},
		{
			name:    "invalid JSON is reported",
			payload: []byte(`{"activeAlerts":`),
			key:     orefActiveAlertsField,
			wantErr: true,
		},
	}

	for _, test := range tests {
		evaluation, err := evaluateOrefSnapshot(test.payload, test.key)
		if test.wantErr {
			if err == nil {
				t.Fatalf("%s: error = nil, want an error", test.name)
			}
			continue
		}
		if err != nil {
			t.Fatalf("%s: evaluateOrefSnapshot: %v", test.name, err)
		}
		if test.wantLatest == nil {
			if evaluation.Latest != nil {
				t.Fatalf("%s: latest = %v, want nil", test.name, *evaluation.Latest)
			}
		} else if evaluation.Latest == nil || *evaluation.Latest != *test.wantLatest {
			t.Fatalf("%s: latest = %v, want %v", test.name, evaluation.Latest, *test.wantLatest)
		}
		if string(evaluation.Context) != test.wantContext {
			t.Fatalf("%s: context = %s, want %s", test.name, evaluation.Context, test.wantContext)
		}
	}
}
