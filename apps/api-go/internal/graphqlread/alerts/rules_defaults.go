package alerts

import (
	"strings"
	"unicode/utf16"
)

// Default metric providers and enum members this batch writes. The read models
// already carry providerEconomic and providerAnomaly in convert.go.
const (
	providerPipelineJob    = "pipeline_job"
	providerCrawlTask      = "crawl_task"
	providerSystemMetric   = "system_metric"
	providerRealtimeSignal = "realtime_signal"

	severityMedium = "medium"
	severityHigh   = "high"

	statusActive = "active"

	// customManualSystemMetricSlug is CUSTOM_MANUAL_SYSTEM_METRIC_SLUG in
	// packages/utils/src/alert-metric-slugs.ts.
	customManualSystemMetricSlug = "custom.manual"
)

// defaultRuleDefinition is one system default rule. The definitions and their
// thresholds mirror AlertsService's DEFAULT_CRAWL_QUALITY_RULES,
// REALTIME_SIGNAL_DEFAULT_RULES and DEFAULT_PIPELINE_RULES.
type defaultRuleDefinition struct {
	Key            string
	Name           string
	Description    string
	MetricSlug     string
	Operator       string
	Severity       string
	ThresholdValue float64
}

// defaultRuleGroup is one provider's set of default rules. IDPrefix is the
// human-readable segment in the deterministic id and differs from Provider for
// crawl_task ("crawl-quality") and pipeline_job ("pipeline").
type defaultRuleGroup struct {
	Provider        string
	IDPrefix        string
	CooldownSeconds int
	Definitions     []defaultRuleDefinition
}

// defaultRuleGroups is the ordered 3 + 9 + 5 = 17 default rule set. The order is
// the order ensureDefaultRules creates them in, which also keeps the
// deterministic id tie-break in alertRules stable.
var defaultRuleGroups = []defaultRuleGroup{
	{
		Provider:        providerCrawlTask,
		IDPrefix:        "crawl-quality",
		CooldownSeconds: 3600,
		Definitions: []defaultRuleDefinition{
			{
				Key:            "preflight_failure_rate",
				Name:           "Crawl Quality: Preflight Failure Rate High",
				Description:    "Alert when preflight failure rate remains too high.",
				MetricSlug:     "crawl_quality.preflight_failure_rate",
				Operator:       opGTE,
				Severity:       severityMedium,
				ThresholdValue: 0.15,
			},
			{
				Key:            "http_304_hit_rate",
				Name:           "Crawl Quality: HTTP 304 Hit Rate Low",
				Description:    "Alert when HTTP 304 hit rate drops below expected baseline.",
				MetricSlug:     "crawl_quality.http_304_hit_rate",
				Operator:       opLTE,
				Severity:       severityMedium,
				ThresholdValue: 0.05,
			},
			{
				Key:            "org_hash_dedupe_hit_rate",
				Name:           "Crawl Quality: Org Hash Dedupe Hit Rate High",
				Description:    "Alert when org-level content hash dedupe hit rate spikes.",
				MetricSlug:     "crawl_quality.org_hash_dedupe_hit_rate",
				Operator:       opGTE,
				Severity:       severityMedium,
				ThresholdValue: 0.3,
			},
		},
	},
	{
		Provider:        providerRealtimeSignal,
		IDPrefix:        "realtime-signal",
		CooldownSeconds: 1800,
		Definitions: []defaultRuleDefinition{
			{
				Key:            "opensky",
				Name:           "Realtime Signal: Military Flight Activity Surge",
				Description:    "Alert when conservative OpenSky military flight detections exceed baseline threshold.",
				MetricSlug:     "realtime.opensky.military_flights",
				Operator:       opGTE,
				Severity:       severityMedium,
				ThresholdValue: 50,
			},
			{
				Key:            "opensky_snapshot_health",
				Name:           "Realtime Signal: OpenSky Snapshot Degraded",
				Description:    "Alert when the OpenSky military snapshot is stale or the map is temporarily using the previous retained snapshot.",
				MetricSlug:     "realtime.opensky.snapshot_health",
				Operator:       opGTE,
				Severity:       severityHigh,
				ThresholdValue: 1,
			},
			{
				Key:            "ais",
				Name:           "Realtime Signal: Maritime Disruptions Elevated",
				Description:    "Alert when AIS disruptions count crosses the threshold.",
				MetricSlug:     "realtime.ais.disruptions",
				Operator:       opGTE,
				Severity:       severityMedium,
				ThresholdValue: 5,
			},
			{
				Key:            "unrest",
				Name:           "Realtime Signal: Unrest Event Spike",
				Description:    "Alert when protest/unrest events rise above the configured threshold.",
				MetricSlug:     "realtime.unrest.events",
				Operator:       opGTE,
				Severity:       severityMedium,
				ThresholdValue: 20,
			},
			{
				Key:            "outages",
				Name:           "Realtime Signal: Internet Outages Detected",
				Description:    "Alert when internet outage annotations increase materially.",
				MetricSlug:     "realtime.outages.internet",
				Operator:       opGTE,
				Severity:       severityHigh,
				ThresholdValue: 3,
			},
			{
				Key:            "keyword_spike",
				Name:           "Realtime Signal: Keyword Spike",
				Description:    "Alert when cross-source keyword spikes are detected in near realtime.",
				MetricSlug:     "realtime.keyword_spike.count",
				Operator:       opGTE,
				Severity:       severityMedium,
				ThresholdValue: 1,
			},
			{
				Key:            "pizzint",
				Name:           "Realtime Signal: PizzINT DEFCON Escalation",
				Description:    "Alert when PizzINT DEFCON reaches elevated levels.",
				MetricSlug:     "realtime.pizzint.defcon",
				Operator:       opLTE,
				Severity:       severityHigh,
				ThresholdValue: 2,
			},
			{
				Key:            "gdelt_tension",
				Name:           "Realtime Signal: GDELT Tension Escalation",
				Description:    "Alert when bilateral tension score exceeds the configured threshold.",
				MetricSlug:     "realtime.gdelt_tension.max_score",
				Operator:       opGTE,
				Severity:       severityHigh,
				ThresholdValue: 70,
			},
			{
				Key:            "polymarket_leads",
				Name:           "Realtime Signal: Prediction Leads News",
				Description:    "Alert when prediction market movement leads low-coverage news topics.",
				MetricSlug:     "realtime.polymarket_leads.count",
				Operator:       opGTE,
				Severity:       severityMedium,
				ThresholdValue: 1,
			},
		},
	},
	{
		Provider:        providerPipelineJob,
		IDPrefix:        "pipeline",
		CooldownSeconds: 1800,
		Definitions: []defaultRuleDefinition{
			{
				Key:            "success_rate",
				Name:           "Pipeline: Success Rate Low",
				Description:    "Alert when pipeline success rate drops below the expected baseline.",
				MetricSlug:     "pipeline.success_rate",
				Operator:       opLTE,
				Severity:       severityHigh,
				ThresholdValue: 0.9,
			},
			{
				Key:            "failure_rate",
				Name:           "Pipeline: Failure Rate High",
				Description:    "Alert when pipeline failure rate remains too high.",
				MetricSlug:     "pipeline.failure_rate",
				Operator:       opGTE,
				Severity:       severityHigh,
				ThresholdValue: 0.1,
			},
			{
				Key:            "average_llm_latency_ms",
				Name:           "Pipeline: Average LLM Latency High",
				Description:    "Alert when average LLM latency exceeds the operational threshold.",
				MetricSlug:     "pipeline.average_llm_latency_ms",
				Operator:       opGTE,
				Severity:       severityMedium,
				ThresholdValue: 8000,
			},
			{
				Key:            "ingestion_p90_ms",
				Name:           "Pipeline: Ingestion P90 High",
				Description:    "Alert when p90 ingestion latency exceeds the operational threshold.",
				MetricSlug:     "pipeline.ingestion_p90_ms",
				Operator:       opGTE,
				Severity:       severityMedium,
				ThresholdValue: 300000,
			},
			{
				Key:            "ingestion_p99_ms",
				Name:           "Pipeline: Ingestion P99 High",
				Description:    "Alert when p99 ingestion latency exceeds the operational threshold.",
				MetricSlug:     "pipeline.ingestion_p99_ms",
				Operator:       opGTE,
				Severity:       severityHigh,
				ThresholdValue: 900000,
			},
		},
	},
}

// defaultAlertRuleID builds the deterministic default rule id:
// default-<group>-<key>-<orgId with unsafe characters replaced> truncated to
// 191 characters (the Prisma VARCHAR(191) primary key width).
func defaultAlertRuleID(idPrefix, key, orgID string) string {
	id := "default-" + idPrefix + "-" + key + "-" + normalizeOrgIDPart(orgID)
	if len(id) > 191 {
		id = id[:191]
	}
	return id
}

// normalizeOrgIDPart mirrors orgId.replace(/[^a-zA-Z0-9_-]/g, "_"). The regex
// works on UTF-16 code units, so an astral rune becomes two underscores.
func normalizeOrgIDPart(orgID string) string {
	units := utf16.Encode([]rune(orgID))
	var builder strings.Builder
	builder.Grow(len(units))
	for _, unit := range units {
		switch {
		case unit >= 'a' && unit <= 'z',
			unit >= 'A' && unit <= 'Z',
			unit >= '0' && unit <= '9',
			unit == '_',
			unit == '-':
			builder.WriteRune(rune(unit))
		default:
			builder.WriteByte('_')
		}
	}
	return builder.String()
}

// defaultRuleMetadata is the metadata document every default rule carries.
type defaultRuleMetadata struct {
	SystemDefault  bool   `json:"systemDefault"`
	DefaultRuleKey string `json:"defaultRuleKey"`
	Version        int    `json:"version"`
}

// defaultRuleCount is 3 crawl quality + 9 realtime signal + 5 pipeline rules.
func defaultRuleCount() int {
	total := 0
	for _, group := range defaultRuleGroups {
		total += len(group.Definitions)
	}
	return total
}
