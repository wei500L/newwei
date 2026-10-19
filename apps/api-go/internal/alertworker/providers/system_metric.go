package providers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/redis/go-redis/v9"
)

// Metric slug literals copied from packages/utils/src/alert-metric-slugs.ts and
// apps/api/src/modules/situation-monitor/signal-metrics.constants.ts. The
// comment above each constant names the NestJS constant it mirrors.
const (
	// SYSTEM_MEMORY_USAGE_METRIC_SLUG
	systemMemoryUsageMetricSlug = "system.memory.usage_pct"
	// SYSTEM_LOAD_1M_METRIC_SLUG
	systemLoad1mMetricSlug = "system.load.1m"
	// SYSTEM_UPTIME_SECONDS_METRIC_SLUG
	systemUptimeSecondsMetricSlug = "system.uptime.seconds"
	// CUSTOM_MANUAL_SYSTEM_METRIC_SLUG
	customManualSystemMetricSlug = "custom.manual"
	// SITUATION_MONITOR_OREF_ACTIVE_ALERTS_METRIC_SLUG
	situationOrefActiveAlertsMetricSlug = "situation.oref.active_alerts"
	// SITUATION_MONITOR_OREF_HISTORY_24H_METRIC_SLUG
	situationOrefHistory24hMetricSlug = "situation.oref.history_24h"
	// SITUATION_MONITOR_OREF_METRICS_CACHE_KEY
	situationOrefMetricsCacheKey = "situation-monitor:signals:metrics:oref:v1"

	// orefActiveAlertsField / orefHistory24hField are the snapshot keys
	// readOrefMetricSnapshot receives from the fetcher map.
	orefActiveAlertsField = "activeAlerts"
	orefHistory24hField   = "historyCount24h"
)

// systemMetricMetadata is the subset of AlertRule.metadata this provider reads.
type systemMetricMetadata struct {
	CurrentValue *float64 `json:"currentValue"`
}

// systemMetricSourceContext is the `{ source: "metadata" }` context.
type systemMetricSourceContext struct {
	Source string `json:"source"`
}

// orefMetricsSnapshot is the cached OREF metrics payload. updatedAt is
// `string | undefined` in NestJS, so a non-string value is dropped (see
// evaluateOrefSnapshot).
type orefMetricsSnapshot struct {
	ActiveAlerts    *float64 `json:"activeAlerts"`
	HistoryCount24h *float64 `json:"historyCount24h"`
	UpdatedAt       *string  `json:"updatedAt"`
}

// orefMetricContext is the context of an OREF snapshot read. updatedAt is
// omitted when the snapshot carried no string value, matching JSON.stringify
// dropping an `undefined` key.
type orefMetricContext struct {
	Source    string  `json:"source"`
	UpdatedAt *string `json:"updatedAt,omitempty"`
}

// systemMetricProvider ports SystemMetricProvider.
type systemMetricProvider struct {
	deps Dependencies
}

// NewSystem builds the system_metric provider.
func NewSystem(deps Dependencies) Provider {
	return &systemMetricProvider{deps: deps}
}

// Type implements Provider.
func (p *systemMetricProvider) Type() string { return TypeSystemMetric }

// Fetch implements Provider. The metadata `currentValue` wins over the slug,
// like the NestJS provider, then custom.manual without a value, then the OREF
// snapshot metrics.
func (p *systemMetricProvider) Fetch(ctx context.Context, rule Rule) (Evaluation, error) {
	metricSlug := strings.TrimSpace(rule.MetricSlug)
	metadata := systemMetricMetadata{}
	if len(rule.Metadata) > 0 {
		// A non-number currentValue leaves the pointer nil, which is exactly
		// the `typeof currentValue === "number"` guard; the decode error is
		// therefore intentionally ignored.
		_ = json.Unmarshal(rule.Metadata, &metadata)
	}
	if metadata.CurrentValue != nil && metricFinite(*metadata.CurrentValue) {
		payload, err := metricContextJSON(systemMetricSourceContext{Source: "metadata"})
		if err != nil {
			return Evaluation{}, err
		}
		return Evaluation{Latest: metricValuePtr(*metadata.CurrentValue), Context: payload}, nil
	}
	if metricSlug == customManualSystemMetricSlug {
		return metricErrorEvaluation("custom_manual_requires_current_value"), nil
	}

	switch metricSlug {
	case situationOrefActiveAlertsMetricSlug:
		return p.readOrefMetricSnapshot(ctx, orefActiveAlertsField)
	case situationOrefHistory24hMetricSlug:
		return p.readOrefMetricSnapshot(ctx, orefHistory24hField)
	case systemMemoryUsageMetricSlug, systemLoad1mMetricSlug, systemUptimeSecondsMetricSlug:
		// These three read the api-go host's own OS counters, which are not the
		// NestJS host's counters; the alert contract cannot be preserved by
		// reading a different machine, so rule evaluation for them reports the
		// unknown-metric context instead of a misleading value.
		return metricErrorEvaluation("unknown system metric"), nil
	}
	return metricErrorEvaluation("unknown system metric"), nil
}

// readOrefMetricSnapshot is CacheService.get(OREF_CACHE_KEY) + the JSON.parse
// in readOrefMetricSnapshot. A missing key or unset cache yields the
// metrics_unavailable context.
func (p *systemMetricProvider) readOrefMetricSnapshot(ctx context.Context, key string) (Evaluation, error) {
	if p.deps.Redis == nil {
		return metricErrorEvaluation("metrics_unavailable"), nil
	}
	payload, err := p.deps.Redis.Get(ctx, situationOrefMetricsCacheKey).Bytes()
	if errors.Is(err, redis.Nil) {
		return metricErrorEvaluation("metrics_unavailable"), nil
	}
	if err != nil {
		return Evaluation{}, fmt.Errorf("alertworker/providers: system metric oref snapshot: %w", err)
	}
	return evaluateOrefSnapshot(payload, key)
}

// evaluateOrefSnapshot decodes the cached snapshot and reads one field. key is
// the snapshot field name ("activeAlerts" / "historyCount24h"); an absent field
// has no value, mirroring Number(undefined) -> NaN -> null. A JSON null is also
// reported as "no value" instead of Number(null) -> 0, because a null in this
// cache means the producer had no reading.
func evaluateOrefSnapshot(payload []byte, key string) (Evaluation, error) {
	// CacheService.get returns null for an empty/missing value.
	if len(bytes.TrimSpace(payload)) == 0 {
		return metricErrorEvaluation("metrics_unavailable"), nil
	}
	var snapshot orefMetricsSnapshot
	if err := json.Unmarshal(payload, &snapshot); err != nil {
		var typeError *json.UnmarshalTypeError
		if !errors.As(err, &typeError) {
			// A syntax error throws in NestJS (JSON.parse), so it is reported.
			return Evaluation{}, fmt.Errorf("alertworker/providers: system metric oref snapshot: %w", err)
		}
		// Type mismatches are tolerated like the NestJS `typeof` guards; the
		// unaffected fields are still decoded.
	}

	var latest *float64
	switch key {
	case orefActiveAlertsField:
		latest = snapshot.ActiveAlerts
	case orefHistory24hField:
		latest = snapshot.HistoryCount24h
	}
	payloadContext, err := metricContextJSON(orefMetricContext{
		Source:    "situation-monitor-signals",
		UpdatedAt: snapshot.UpdatedAt,
	})
	if err != nil {
		return Evaluation{}, err
	}
	return Evaluation{Latest: latest, Context: payloadContext}, nil
}
