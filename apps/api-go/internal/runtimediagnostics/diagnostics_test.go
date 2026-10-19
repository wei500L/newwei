package runtimediagnostics

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/wei500L/newwei/apps/api-go/internal/llmgatewayprofiles"
	"github.com/wei500L/newwei/apps/api-go/internal/modelaccesssettings"
	"github.com/wei500L/newwei/apps/api-go/internal/platformgovernance"
)

func TestNormalizeLiteLlmBase(t *testing.T) {
	cases := map[string]string{
		"http://litellm:4000/":                    "http://litellm:4000",
		"http://litellm:4000/v1/chat/completions": "http://litellm:4000",
		"http://litellm:4000/chat/completions":    "http://litellm:4000",
		"http://litellm:4000/v1/models":           "http://litellm:4000",
		"http://litellm:4000/models":              "http://litellm:4000",
		"http://litellm:4000/health/liveliness":   "http://litellm:4000",
		"http://litellm:4000/v1":                  "http://litellm:4000",
		"http://litellm:4000/v1/":                 "http://litellm:4000",
		"  http://litellm:4000/models//  ":        "http://litellm:4000",
	}
	for input, want := range cases {
		if got := normalizeLiteLlmBase(input); got != want {
			t.Fatalf("normalize(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestExtractConfiguredGuardrailNames(t *testing.T) {
	cases := []struct {
		body string
		want []string
	}{
		{`["a"," a ", "", 5]`, []string{"a"}},
		{`[{"guardrail_name":"pre"},{"name":"post"},{"guardrailName":"third"}]`, []string{"pre", "post", "third"}},
		{`{"guardrails":["one"]}`, []string{"one"}},
		{`{"data":[{"name":"two"}]}`, []string{"two"}},
		{`{"items":["three"],"guardrails":"nope"}`, []string{"three"}},
		{`{}`, []string{}},
		{`null`, []string{}},
	}
	for _, tc := range cases {
		got := extractConfiguredGuardrailNames([]byte(tc.body))
		if strings.Join(got, ",") != strings.Join(tc.want, ",") {
			t.Fatalf("%s => %v, want %v", tc.body, got, tc.want)
		}
	}
}

func TestExpectedGuardrailsExpansionAndMissing(t *testing.T) {
	safety := platformgovernance.AssistantSafetySettingsResponse{
		Enabled:    true,
		Guardrails: []string{"pre", "post"},
	}
	expected, missing := expectedGuardrails(safety, 3, true, []string{"pre", "post", "post-2"})
	if strings.Join(expected, ",") != "pre,pre-2,pre-3,post,post-2,post-3" {
		t.Fatalf("expected = %v", expected)
	}
	if strings.Join(missing, ",") != "pre-2,pre-3,post-3" {
		t.Fatalf("missing = %v", missing)
	}
	// A failed guardrails probe makes every expected name missing.
	_, allMissing := expectedGuardrails(safety, 1, false, nil)
	if len(allMissing) != 2 {
		t.Fatalf("all missing = %v", allMissing)
	}
	// Disabled safety has no expectations.
	disabled := platformgovernance.AssistantSafetySettingsResponse{Enabled: false, Guardrails: []string{"pre"}}
	expected, missing = expectedGuardrails(disabled, 2, false, nil)
	if len(expected) != 0 || len(missing) != 0 {
		t.Fatalf("disabled expected=%v missing=%v", expected, missing)
	}
}

type fakeProfiles struct {
	profile llmgatewayprofiles.ResolvedProfileConfig
	found   bool
}

func (f fakeProfiles) RuntimeBindings(context.Context) (llmgatewayprofiles.RuntimeBindings, error) {
	if !f.found {
		return llmgatewayprofiles.RuntimeBindings{}, nil
	}
	id := f.profile.ID
	return llmgatewayprofiles.RuntimeBindings{CompletionProfileID: &id}, nil
}

func (f fakeProfiles) RuntimeProfileConfig(context.Context, string) (llmgatewayprofiles.ResolvedProfileConfig, bool, error) {
	return f.profile, f.found, nil
}

type fakeGovernance struct{}

func (fakeGovernance) ManagedRuntimeCredentials(context.Context, string, string) (string, string, bool, error) {
	return "", "", false, nil
}

type fakeSafety struct {
	settings platformgovernance.AssistantSafetySettingsResponse
}

func (f fakeSafety) AssistantSafetyPublicSettings(context.Context) (platformgovernance.AssistantSafetySettingsResponse, error) {
	return f.settings, nil
}

type fakeKeys struct {
	keys modelaccesssettings.OpenAiKeysPublicSettings
}

func (f fakeKeys) PublicOpenAiKeysSettings(context.Context) (modelaccesssettings.OpenAiKeysPublicSettings, error) {
	return f.keys, nil
}

func TestSafetyRunFallsBackAndComputesMissing(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/health/liveliness":
			w.WriteHeader(http.StatusOK)
		case "/v1/models":
			w.WriteHeader(http.StatusNotFound)
		case "/models":
			_, _ = w.Write([]byte(`{"data":[{},{}]}`))
		case "/guardrails/list":
			w.WriteHeader(http.StatusNotFound)
		case "/v1/guardrails/list":
			_, _ = w.Write([]byte(`{"guardrails":[{"guardrail_name":"pre"}]}`))
		default:
			t.Errorf("unexpected path %s", r.URL.Path)
			w.WriteHeader(http.StatusTeapot)
		}
	}))
	defer server.Close()

	service := NewSafetyService(fakeProfiles{}, fakeGovernance{},
		fakeSafety{settings: platformgovernance.AssistantSafetySettingsResponse{
			Enabled:    true,
			Guardrails: []string{"pre", "post"},
		}},
		fakeKeys{keys: modelaccesssettings.OpenAiKeysPublicSettings{KeysCount: 2}},
		server.URL+"/v1/chat/completions", "env-key")

	result, err := service.Run(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if result.LiteLLM.APIBase != server.URL {
		t.Fatalf("apiBase = %q", result.LiteLLM.APIBase)
	}
	if !result.LiteLLM.Liveliness.OK || result.LiteLLM.Liveliness.Status == nil || *result.LiteLLM.Liveliness.Status != 200 {
		t.Fatalf("liveliness = %+v", result.LiteLLM.Liveliness)
	}
	if !result.LiteLLM.Models.OK || result.LiteLLM.Models.Count == nil || *result.LiteLLM.Models.Count != 2 {
		t.Fatalf("models = %+v", result.LiteLLM.Models)
	}
	if result.LiteLLM.Models.Status == nil || *result.LiteLLM.Models.Status != 200 {
		t.Fatalf("models status = %v (fallback not used?)", result.LiteLLM.Models.Status)
	}
	if !result.LiteLLM.Guardrails.OK || result.LiteLLM.Guardrails.Count == nil || *result.LiteLLM.Guardrails.Count != 1 {
		t.Fatalf("guardrails = %+v", result.LiteLLM.Guardrails)
	}
	if strings.Join(result.LiteLLM.Guardrails.Expected, ",") != "pre,pre-2,post,post-2" {
		t.Fatalf("expected = %v", result.LiteLLM.Guardrails.Expected)
	}
	if strings.Join(result.LiteLLM.Guardrails.Missing, ",") != "pre-2,post,post-2" {
		t.Fatalf("missing = %v", result.LiteLLM.Guardrails.Missing)
	}
	if result.CheckedAt == "" {
		t.Fatal("checkedAt is empty")
	}
}

func TestSafetyRunReportsUnreachableUpstreams(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	base := server.URL
	server.Close()

	service := NewSafetyService(fakeProfiles{}, fakeGovernance{},
		fakeSafety{settings: platformgovernance.AssistantSafetySettingsResponse{
			Enabled:    true,
			Guardrails: []string{"pre"},
		}},
		fakeKeys{}, base, "")
	result, err := service.Run(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if result.LiteLLM.Liveliness.Status != nil || result.LiteLLM.Liveliness.Error == nil {
		t.Fatalf("liveliness = %+v", result.LiteLLM.Liveliness)
	}
	if result.LiteLLM.Models.Status != nil || result.LiteLLM.Models.Error == nil {
		t.Fatalf("models = %+v", result.LiteLLM.Models)
	}
	if len(result.LiteLLM.Guardrails.Missing) != 1 || result.LiteLLM.Guardrails.Missing[0] != "pre" {
		t.Fatalf("guardrails = %+v", result.LiteLLM.Guardrails)
	}
}

func TestBuildAdsbRuntimeDiagnostics(t *testing.T) {
	interval := 600
	now := int64(1_700_000_000_000)
	missing := buildAdsbRuntimeDiagnostics(nil, 12, 3, now, interval)
	if missing.Freshness != "missing" || missing.RawAircraftCount != 12 || missing.StaleThresholdSec != 1800 {
		t.Fatalf("missing = %+v", missing)
	}
	updated := "2023-11-14T22:00:00.000Z"
	snapshot := &adsbSnapshot{
		UpdatedAt:          updated,
		LatestObservedAt:   &updated,
		ValidPositionCount: 5,
		Diagnostics: adsbDiagnostics{
			StaleThresholdSec: 600,
		},
	}
	// 20 minutes old against a 10 minute threshold → stale.
	stale := buildAdsbRuntimeDiagnostics(snapshot, 12, 3, now, interval)
	if stale.Freshness != "stale" || stale.SnapshotAgeSec == nil || *stale.SnapshotAgeSec != 800 {
		t.Fatalf("stale = %+v", stale)
	}
	fresh := buildAdsbRuntimeDiagnostics(snapshot, 12, 3, now-1100_000, interval)
	if fresh.Freshness != "fresh" {
		t.Fatalf("fresh = %+v", fresh)
	}
}

func TestBuildAisRuntimeSemantics(t *testing.T) {
	missing := buildAisRuntimeSemantics(nil, &sourceState{
		Status:        "error",
		LastError:     ptr("relay down"),
		LastErrorCode: ptr("ais_upstream_disconnected"),
		Context:       diagnosticContext{"configured": json.RawMessage("false")},
	})
	if missing.diagnostics.Configured || missing.statusReasonCode != "ais_upstream_disconnected" {
		t.Fatalf("missing = %+v", missing)
	}
	reason := "missing vessels"
	snapshot := &aisSnapshot{
		Status:      aisStatus{Vessels: 0},
		Diagnostics: aisRelayDiagnostics{HealthState: "ok"},
	}
	product := buildAisRuntimeSemantics(snapshot, nil)
	if product.statusReasonCode != "ais_snapshot_missing_vessels_contract" || product.statusReason == "" {
		t.Fatalf("product = %+v", product)
	}
	snapshot.Status.Vessels = 3
	snapshot.HasVesselSnapshot = true
	snapshot.Diagnostics.StatusReasonCode = &reason
	ok := buildAisRuntimeSemantics(snapshot, nil)
	if ok.statusReasonCode != "" || ok.statusReason != "" {
		t.Fatalf("ignored unknown relay code = %+v", ok)
	}
}

func TestResolveRuntimeSourceStatus(t *testing.T) {
	now := int64(1_700_000_000_000)
	status, code, _ := resolveRuntimeSourceStatus("ais", false, 60, nil, nil, nil, nil, now)
	if status != "idle" || code != "source_disabled" {
		t.Fatalf("disabled = %s/%s", status, code)
	}
	status, code, _ = resolveRuntimeSourceStatus("outages", true, 60, nil, nil,
		diagnosticContext{"configured": json.RawMessage("false")}, nil, now)
	if status != "not_configured" || code != "outages_not_configured" {
		t.Fatalf("not configured = %s/%s", status, code)
	}
	state := &sourceState{Status: "error", LastError: ptr("boom"), LastErrorCode: ptr("bad")}
	status, code, _ = resolveRuntimeSourceStatus("unrest", true, 60, state, nil, nil, nil, now)
	if status != "error" || code != "bad" {
		t.Fatalf("error = %s/%s", status, code)
	}
	status, code, _ = resolveRuntimeSourceStatus("unrest", true, 60, nil, nil, nil, nil, now)
	if status != "idle" || code != "no_successful_run" {
		t.Fatalf("no run = %s/%s", status, code)
	}
	lastRun := float64(now - 600_000)
	status, code, _ = resolveRuntimeSourceStatus("unrest", true, 60, nil, &lastRun, nil, nil, now)
	if status != "stale" || code != "last_success_stale" {
		t.Fatalf("stale = %s/%s", status, code)
	}
	state = &sourceState{Status: "success", LastSuccessAt: ptr("2023-11-14T22:10:00.000Z")}
	status, _, _ = resolveRuntimeSourceStatus("unrest", true, 60, state, nil, nil, nil, now)
	if status != "ok" {
		t.Fatalf("ok = %s", status)
	}
}

func TestEvaluatePoints(t *testing.T) {
	now := int64(1_700_000_000_000)
	empty := evaluatePoints(nil, 60, now)
	if empty.latest != nil || empty.previous != nil || empty.changePercent != nil {
		t.Fatalf("empty = %+v", empty)
	}
	points := []metricPoint{
		{TS: "2023-11-14T21:00:00.000Z", Value: 10},
		{TS: "2023-11-14T21:20:00.000Z", Value: 20},
		{TS: "2023-11-14T22:00:00.000Z", Value: 30},
	}
	result := evaluatePoints(points, 60, now)
	if result.latest == nil || *result.latest != 30 {
		t.Fatalf("latest = %+v", result.latest)
	}
	// Target is 21:00 and the point exactly there is selected.
	if result.previous == nil || *result.previous != 10 {
		t.Fatalf("previous = %+v", result.previous)
	}
	if result.changePercent == nil || *result.changePercent != 200 {
		t.Fatalf("change = %+v", result.changePercent)
	}
	stale := evaluatePoints(points, 60, now+3*60*60*1000)
	if stale.latest != nil || stale.context == nil {
		t.Fatalf("stale = %+v", stale)
	}
	if value, ok := stale.context.str("latestTimestamp"); !ok || value != "2023-11-14T22:00:00.000Z" {
		t.Fatalf("stale context = %v", stale.context)
	}
}

func ptr(value string) *string { return &value }
