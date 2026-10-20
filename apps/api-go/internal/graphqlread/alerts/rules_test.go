package alerts

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
)

// TestDefaultAlertRuleID pins the deterministic id shape: group prefix, rule
// key, an orgId whose characters outside [A-Za-z0-9_-] become "_", and a
// 191-character truncation.
func TestDefaultAlertRuleID(t *testing.T) {
	if got, want := defaultAlertRuleID("crawl-quality", "preflight_failure_rate", "org-1"),
		"default-crawl-quality-preflight_failure_rate-org-1"; got != want {
		t.Fatalf("id = %q, want %q", got, want)
	}
	// "/" and ":" are one code unit each and are replaced one-for-one, while an
	// astral rune is a surrogate pair and becomes two underscores, matching the
	// JS regex on UTF-16 code units.
	if got, want := defaultAlertRuleID("pipeline", "success_rate", "Org/Ä:9"), "default-pipeline-success_rate-Org___9"; got != want {
		t.Fatalf("id = %q, want %q", got, want)
	}
	if got, want := defaultAlertRuleID("pipeline", "success_rate", "a😀b"), "default-pipeline-success_rate-a__b"; got != want {
		t.Fatalf("astral id = %q, want %q", got, want)
	}
	longOrg := strings.Repeat("a", 300)
	id := defaultAlertRuleID("pipeline", "success_rate", longOrg)
	if len(id) != 191 {
		t.Fatalf("truncated id length = %d, want 191", len(id))
	}
	if !strings.HasPrefix(id, "default-pipeline-success_rate-") {
		t.Fatalf("truncated id = %q", id)
	}
}

// TestDefaultRuleGroups verifies the 3 + 9 + 5 = 17 default rules of the three
// providers and their cooldowns.
func TestDefaultRuleGroups(t *testing.T) {
	if got := defaultRuleCount(); got != 17 {
		t.Fatalf("default rule count = %d, want 17", got)
	}
	want := []struct {
		provider string
		count    int
		cooldown int
	}{
		{providerCrawlTask, 3, 3600},
		{providerRealtimeSignal, 9, 1800},
		{providerPipelineJob, 5, 1800},
	}
	if len(defaultRuleGroups) != len(want) {
		t.Fatalf("groups = %d", len(defaultRuleGroups))
	}
	for index, group := range defaultRuleGroups {
		if group.Provider != want[index].provider ||
			len(group.Definitions) != want[index].count ||
			group.CooldownSeconds != want[index].cooldown {
			t.Fatalf("group %d = %s/%d/%d", index, group.Provider, len(group.Definitions), group.CooldownSeconds)
		}
		for _, definition := range group.Definitions {
			if definition.Key == "" || definition.MetricSlug == "" || definition.Operator == "" {
				t.Fatalf("incomplete definition %+v", definition)
			}
		}
	}
	// Every default slug must be stable under alias normalization, otherwise the
	// backfill would re-create a rule it already inserted.
	for _, group := range defaultRuleGroups {
		for _, definition := range group.Definitions {
			if got := normalizeMetricSlug(definition.MetricSlug); got != definition.MetricSlug {
				t.Errorf("default slug %q normalizes to %q", definition.MetricSlug, got)
			}
		}
	}
}

func TestNormalizeMetricSlugAliases(t *testing.T) {
	cases := []struct{ input, want string }{
		{"  realtime.adsb.military_flights  ", "realtime.opensky.military_flights"},
		{"realtime.adsb.snapshot_health", "realtime.opensky.snapshot_health"},
		{"realtime.opensky.military_flights", "realtime.opensky.military_flights"},
		{"  crawl_quality.http_304_hit_rate\t", "crawl_quality.http_304_hit_rate"},
		{"   ", ""},
	}
	for _, tc := range cases {
		if got := normalizeMetricSlug(tc.input); got != tc.want {
			t.Errorf("normalizeMetricSlug(%q) = %q, want %q", tc.input, got, tc.want)
		}
	}
}

func TestParseUpsertAlertRuleInputFull(t *testing.T) {
	input, err := parseUpsertAlertRuleInput(map[string]any{"input": map[string]any{
		"name":             "Rule",
		"description":      "desc",
		"severity":         "high",
		"status":           "paused",
		"metricProvider":   "crawl_task",
		"metricSlug":       " crawl_quality.http_304_hit_rate ",
		"operator":         "lte",
		"thresholdValue":   float64(0.05),
		"thresholdLower":   nil,
		"changeWindowMin":  int64(60),
		"cooldownSeconds":  int64(120),
		"checkIntervalSec": int64(90),
		"channelIds":       []any{"c1", "c1"},
		"metadata":         map[string]any{"currentValue": float64(1)},
	}})
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if input.Name != "Rule" || input.MetricSlug != " crawl_quality.http_304_hit_rate " || input.Operator != "lte" {
		t.Fatalf("input = %+v", input)
	}
	if input.Description == nil || *input.Description != "desc" || !input.DescriptionSet {
		t.Fatalf("description = %+v", input.Description)
	}
	if input.Severity == nil || *input.Severity != "high" || input.Status == nil || *input.Status != "paused" {
		t.Fatalf("enums = %+v/%+v", input.Severity, input.Status)
	}
	if input.MetricProvider == nil || *input.MetricProvider != "crawl_task" {
		t.Fatalf("provider = %+v", input.MetricProvider)
	}
	if input.ThresholdValue == nil || *input.ThresholdValue != 0.05 {
		t.Fatalf("thresholdValue = %+v", input.ThresholdValue)
	}
	// An explicit null threshold is "not provided": Q1 writes null instead of
	// reproducing NestJS's Decimal(null) throw.
	if input.ThresholdLower != nil {
		t.Fatalf("thresholdLower = %+v, want nil", input.ThresholdLower)
	}
	if input.ChangeWindowMin == nil || *input.ChangeWindowMin != 60 {
		t.Fatalf("changeWindowMin = %+v", input.ChangeWindowMin)
	}
	if !input.ChannelIDsSet || len(input.ChannelIDs) != 2 {
		t.Fatalf("channelIds = %+v set=%v", input.ChannelIDs, input.ChannelIDsSet)
	}
	if string(input.Metadata) != `{"currentValue":1}` {
		t.Fatalf("metadata = %s", input.Metadata)
	}
}

func TestParseUpsertAlertRuleInputDescriptionStates(t *testing.T) {
	base := func(extra map[string]any) map[string]any {
		input := map[string]any{
			"name":       "Rule",
			"metricSlug": "crawl_quality.http_304_hit_rate",
			"operator":   "lte",
		}
		for key, value := range extra {
			input[key] = value
		}
		return map[string]any{"input": input}
	}

	omitted, err := parseUpsertAlertRuleInput(base(nil))
	if err != nil {
		t.Fatal(err)
	}
	if omitted.DescriptionSet || omitted.Description != nil {
		t.Fatalf("omitted description = %+v set=%v", omitted.Description, omitted.DescriptionSet)
	}

	explicitNull, err := parseUpsertAlertRuleInput(base(map[string]any{"description": nil}))
	if err != nil {
		t.Fatal(err)
	}
	if !explicitNull.DescriptionSet || explicitNull.Description != nil {
		t.Fatalf("null description = %+v set=%v", explicitNull.Description, explicitNull.DescriptionSet)
	}

	value, err := parseUpsertAlertRuleInput(base(map[string]any{"description": "text"}))
	if err != nil {
		t.Fatal(err)
	}
	if !value.DescriptionSet || value.Description == nil || *value.Description != "text" {
		t.Fatalf("value description = %+v set=%v", value.Description, value.DescriptionSet)
	}
}

func TestParseUpsertAlertRuleInputValidation(t *testing.T) {
	base := func(extra map[string]any) map[string]any {
		input := map[string]any{
			"name":       "Rule",
			"metricSlug": "crawl_quality.http_304_hit_rate",
			"operator":   "lte",
		}
		for key, value := range extra {
			input[key] = value
		}
		return map[string]any{"input": input}
	}
	cases := []struct {
		name    string
		input   map[string]any
		message string
	}{
		{"name too long", base(map[string]any{"name": strings.Repeat("a", 121)}),
			"name must be shorter than or equal to 120 characters"},
		{"description too long", base(map[string]any{"description": strings.Repeat("a", 241)}),
			"description must be shorter than or equal to 240 characters"},
		{"changeWindowMin not positive", base(map[string]any{"changeWindowMin": int64(0)}),
			"changeWindowMin must be a positive number"},
		{"cooldownSeconds not positive", base(map[string]any{"cooldownSeconds": int64(-1)}),
			"cooldownSeconds must be a positive number"},
		{"checkIntervalSec not positive", base(map[string]any{"checkIntervalSec": int64(0)}),
			"checkIntervalSec must be a positive number"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := parseUpsertAlertRuleInput(tc.input)
			var failure *contract.Failure
			if !errors.As(err, &failure) {
				t.Fatalf("error = %v, want *contract.Failure", err)
			}
			if failure.Status != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400", failure.Status)
			}
			if !strings.Contains(failure.Message, tc.message) {
				t.Fatalf("message = %q, want %q", failure.Message, tc.message)
			}
		})
	}
}

func TestParseUpsertAlertRuleInputCombinesMessages(t *testing.T) {
	_, err := parseUpsertAlertRuleInput(map[string]any{"input": map[string]any{
		"name":            strings.Repeat("a", 121),
		"metricSlug":      "slug",
		"operator":        "gte",
		"changeWindowMin": int64(0),
	}})
	var failure *contract.Failure
	if !errors.As(err, &failure) {
		t.Fatalf("error = %v", err)
	}
	const want = "name must be shorter than or equal to 120 characters; changeWindowMin must be a positive number"
	if failure.Message != want {
		t.Fatalf("message = %q, want %q", failure.Message, want)
	}
}

func TestParseUpsertAlertRuleInputEmptyIDCreates(t *testing.T) {
	parsed, err := parseUpsertAlertRuleInput(map[string]any{"input": map[string]any{
		"id":         "",
		"name":       "Rule",
		"metricSlug": "slug",
		"operator":   "gte",
	}})
	if err != nil {
		t.Fatal(err)
	}
	// `input.id ? ... : null` treats "" as the create branch.
	if parsed.ID != nil {
		t.Fatalf("id = %+v, want nil", parsed.ID)
	}
}

func TestParseUpsertAlertRuleInputMetadataDefaults(t *testing.T) {
	base := map[string]any{
		"name":       "Rule",
		"metricSlug": "slug",
		"operator":   "gte",
	}
	for _, extra := range []map[string]any{
		{"metadata": nil},
		{},
	} {
		input := map[string]any{}
		for key, value := range base {
			input[key] = value
		}
		for key, value := range extra {
			input[key] = value
		}
		parsed, err := parseUpsertAlertRuleInput(map[string]any{"input": input})
		if err != nil {
			t.Fatal(err)
		}
		if string(parsed.Metadata) != "{}" {
			t.Fatalf("metadata = %s, want {}", parsed.Metadata)
		}
	}
}

func TestDedupeChannelIDsKeepsFirstOccurrence(t *testing.T) {
	got := dedupeChannelIDs([]string{"b", "a", "b", "c", "a"})
	want := []string{"b", "a", "c"}
	if len(got) != len(want) {
		t.Fatalf("dedupe = %v, want %v", got, want)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("dedupe = %v, want %v", got, want)
		}
	}
	if empty := dedupeChannelIDs(nil); empty == nil || len(empty) != 0 {
		t.Fatalf("dedupe(nil) = %#v", empty)
	}
}

func TestCurrentValueFinite(t *testing.T) {
	cases := []struct {
		metadata string
		want     bool
	}{
		{`{"currentValue":5}`, true},
		{`{"currentValue":-1.25}`, true},
		{`{"currentValue":"5"}`, false},
		{`{"currentValue":null}`, false},
		{`{}`, false},
		{`null`, false},
		{`[]`, false},
		{`not-json`, false},
	}
	for _, tc := range cases {
		if got := currentValueFinite(json.RawMessage(tc.metadata)); got != tc.want {
			t.Errorf("currentValueFinite(%s) = %v, want %v", tc.metadata, got, tc.want)
		}
	}
}

func TestProjectRuleNormalizesAndDefaultsChannels(t *testing.T) {
	model := projectRule(ruleRow{
		ID:             "rule-1",
		Name:           "Rule",
		Severity:       "medium",
		Status:         "active",
		MetricProvider: "realtime_signal",
		MetricSlug:     "  realtime.adsb.military_flights  ",
		Operator:       "gte",
	}, nil)
	if model.MetricSlug != "realtime.opensky.military_flights" {
		t.Fatalf("metricSlug = %q", model.MetricSlug)
	}
	if model.Channels == nil || len(model.Channels) != 0 {
		t.Fatalf("channels = %#v, want empty non-nil slice", model.Channels)
	}
}

// TestRegisterRulesDoesNotRegisterSharedModels keeps the exactly-once rule:
// AlertChannelModel belongs to the alert read roots and the workspace write
// batch, so RegisterRules must only add AlertRuleModel and its four roots.
func TestRegisterRulesDoesNotRegisterSharedModels(t *testing.T) {
	reg := contract.NewRegistry()
	RegisterRules(reg, nil, nil)
	if !reg.HasType("AlertRuleModel") {
		t.Fatal("AlertRuleModel was not registered")
	}
	if reg.HasType("AlertChannelModel") {
		t.Fatal("RegisterRules must not register AlertChannelModel")
	}
	query, ok := reg.Query("alertRules")
	if !ok || query.Permission != "alerts.read" {
		t.Fatalf("alertRules root = %+v ok=%v", query, ok)
	}
	for _, name := range []string{"upsertAlertRule", "deleteAlertRule", "triggerAlertRule"} {
		mutation, ok := reg.Mutation(name)
		if !ok || mutation.Permission != "alerts.manage" {
			t.Fatalf("%s root = %+v ok=%v", name, mutation, ok)
		}
	}
	if len(RegisteredRoots) != 4 {
		t.Fatalf("RegisteredRoots = %v", RegisteredRoots)
	}
}

// TestRegisterCombinations mirrors main.go's model-registration conditions for
// the read switch and the workspace write switch. Every combination must
// register the shared models once and all four rule roots without a duplicate
// root panic.
func TestRegisterCombinations(t *testing.T) {
	cases := []struct {
		name           string
		read           bool
		workspaceWrite bool
	}{
		{"rules only", false, false},
		{"read and rules", true, false},
		{"workspace write and rules", false, true},
		{"read, workspace write and rules", true, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			reg := contract.NewRegistry()
			modelsRegistered := false
			if tc.read {
				Register(reg, nil)
				modelsRegistered = true
			}
			if tc.workspaceWrite {
				if !modelsRegistered {
					RegisterModels(reg)
					modelsRegistered = true
				}
			}
			if !tc.read && !tc.workspaceWrite {
				RegisterModels(reg)
			}
			RegisterRules(reg, nil, nil)
			if !reg.HasType("AlertChannelModel") || !reg.HasType("AlertRuleModel") {
				t.Fatalf("models missing: channel=%v rule=%v",
					reg.HasType("AlertChannelModel"), reg.HasType("AlertRuleModel"))
			}
			if _, ok := reg.Query("alertRules"); !ok {
				t.Fatal("alertRules missing")
			}
			if _, ok := reg.Query("alertChannels"); ok != tc.read {
				t.Fatalf("alertChannels present=%v, want %v", ok, tc.read)
			}
		})
	}
}
