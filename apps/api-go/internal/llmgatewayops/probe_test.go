package llmgatewayops

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/llmgatewayprofiles"
	"github.com/wei500L/newwei/apps/api-go/internal/llmlogs"
)

// TestCompletionFallback404LogsOneRow pins two load-bearing behaviours at once:
// the short path is tried only after a 404, and the two HTTP attempts produce one
// single log row for the final outcome.
func TestCompletionFallback404LogsOneRow(t *testing.T) {
	var (
		mu       sync.Mutex
		requests []string
	)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		requests = append(requests, r.URL.Path)
		mu.Unlock()
		switch r.URL.Path {
		case "/v1/chat/completions":
			w.Header().Set("content-type", "application/json")
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"detail":"not found"}`))
		case "/chat/completions":
			w.Header().Set("content-type", "application/json")
			w.Header().Set("x-litellm-call-id", "call-1")
			w.Header().Set("x-litellm-model-id", "model-id-1")
			_, _ = w.Write([]byte(`{"model":"m1","choices":[{"message":{"content":"OK"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	logs := &fakeLogWriter{}
	service := newTestService(&fakeProfilePort{profiles: map[string]llmgatewayprofiles.ResolvedProfileConfig{}}, logs)
	client := newUpstreamClient(service.http, server.URL, "sk-profile", 5*time.Second)

	result, completionErr := service.runCompletion(context.Background(), client, probeSettings{
		Model:           "m1",
		Temperature:     0.2,
		TopP:            0.9,
		MaxOutputTokens: 128,
	}, "Say OK", "", completionOptions{
		APISurface:         surfaceChat,
		ResponseFormatMode: "none",
		Log:                probeLogContext{OrgID: "org-1", ProfileID: "p1", AuthMode: authModeProfileKey},
	})
	if completionErr != nil {
		t.Fatalf("completion error = %+v", completionErr)
	}
	if result.Content == nil || *result.Content != "OK" {
		t.Fatalf("content = %v, want OK", result.Content)
	}
	if result.CallID == nil || *result.CallID != "call-1" {
		t.Fatalf("callId = %v, want call-1", result.CallID)
	}
	if result.LatencyMS < 0 {
		t.Fatalf("latency = %d", result.LatencyMS)
	}

	mu.Lock()
	gotRequests := append([]string{}, requests...)
	mu.Unlock()
	if len(gotRequests) != 2 || gotRequests[0] != "/v1/chat/completions" || gotRequests[1] != "/chat/completions" {
		t.Fatalf("requests = %v, want the primary then the short path", gotRequests)
	}
	entries := logs.snapshot()
	if len(entries) != 1 {
		t.Fatalf("log rows = %d, want exactly 1 for the final attempt", len(entries))
	}
	entry := entries[0]
	if entry.Status != "success" || entry.RequestType != llmlogs.ProbeRequestCompletion {
		t.Fatalf("entry = %+v", entry)
	}
	if entry.Model != "m1" || entry.Metadata.Model != "m1" {
		t.Fatalf("model = %q metadata=%q", entry.Model, entry.Metadata.Model)
	}
	if entry.Usage.PromptTokens == nil || *entry.Usage.PromptTokens != 3 {
		t.Fatalf("prompt tokens = %v, want 3", entry.Usage.PromptTokens)
	}
	if entry.GovernanceApplied {
		t.Fatal("a profile_key probe must not claim governance")
	}
}

// TestEmbeddingInvalidVectorLogsErrorOnly pins that a 2xx body without a vector
// writes one error row and no success row.
func TestEmbeddingInvalidVectorLogsErrorOnly(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"embedding":[]}]}`))
	}))
	defer server.Close()

	logs := &fakeLogWriter{}
	service := newTestService(&fakeProfilePort{}, logs)
	client := newUpstreamClient(service.http, server.URL, "", 5*time.Second)

	_, err := service.runEmbedding(context.Background(), client, embeddingConfig{
		Model:          "m1",
		EmbeddingModel: "e1",
	}, "hello", "", probeLogContext{OrgID: "org-1", ProfileID: "p1", AuthMode: authModeProfileKey})
	if err == nil {
		t.Fatal("an empty vector must fail")
	}
	coded, ok := err.(*httpError)
	if !ok || coded.code != errorCodeInvalidEmbeddingResponse {
		t.Fatalf("error = %+v, want %s", err, errorCodeInvalidEmbeddingResponse)
	}

	entries := logs.snapshot()
	if len(entries) != 1 {
		t.Fatalf("log rows = %d, want exactly 1 error row", len(entries))
	}
	if entries[0].Status != "error" || entries[0].RequestType != llmlogs.ProbeRequestEmbedding {
		t.Fatalf("entry = %+v", entries[0])
	}
	if entries[0].Error == "" {
		t.Fatal("an error row must carry the message")
	}
}

// TestRerankInvalidResponseLogsErrorOnly is the rerank counterpart.
func TestRerankInvalidResponseLogsErrorOnly(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"results":[]}`))
	}))
	defer server.Close()

	logs := &fakeLogWriter{}
	service := newTestService(&fakeProfilePort{}, logs)
	client := newUpstreamClient(service.http, server.URL, "", 5*time.Second)

	_, err := service.runRerank(context.Background(), client, rerankConfig{Rerank: "r1"}, rerankOptions{
		Query:     "query",
		Documents: []string{"a", "b"},
		Log:       probeLogContext{OrgID: "org-1", ProfileID: "p1", AuthMode: authModeProfileKey},
	})
	if err == nil {
		t.Fatal("an empty rerank result must fail")
	}
	coded, ok := err.(*httpError)
	if !ok || coded.code != errorCodeInvalidRerankResponse {
		t.Fatalf("error = %+v, want %s", err, errorCodeInvalidRerankResponse)
	}
	entries := logs.snapshot()
	if len(entries) != 1 || entries[0].Status != "error" || entries[0].RequestType != llmlogs.ProbeRequestRerank {
		t.Fatalf("log rows = %+v, want one rerank error row", entries)
	}
}

// TestLBTestWorkerPoolCountsAttempts pins the concurrency bound and the summary
// invariants: succeeded+failed equals attempts, the distributions only count
// successful attempts, and every attempt wrote exactly one log row.
func TestLBTestWorkerPoolCountsAttempts(t *testing.T) {
	var (
		inFlight    atomic.Int64
		maxInFlight atomic.Int64
		sequence    atomic.Int64
	)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		current := inFlight.Add(1)
		defer inFlight.Add(-1)
		for {
			peek := maxInFlight.Load()
			if current <= peek || maxInFlight.CompareAndSwap(peek, current) {
				break
			}
		}
		time.Sleep(5 * time.Millisecond)
		index := sequence.Add(1)
		if index%2 == 0 {
			w.Header().Set("x-litellm-model-id", "model-a")
			w.Header().Set("x-litellm-model-api-base", "http://a")
			w.Header().Set("x-litellm-call-id", "call-even")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{}`))
			return
		}
		w.Header().Set("x-litellm-model-id", "model-b")
		w.Header().Set("x-litellm-model-api-base", "http://b")
		w.Header().Set("x-litellm-call-id", "call-odd")
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"detail":"boom"}`))
	}))
	defer server.Close()

	logs := &fakeLogWriter{}
	port := &fakeProfilePort{profiles: map[string]llmgatewayprofiles.ResolvedProfileConfig{
		"p1": profileConfig("p1", server.URL, "m1"),
	}}
	service := newTestService(port, logs)

	result, err := service.TestProxyLoadBalancing(context.Background(), "p1", lbTestInput{
		Attempts:    optionalNumber{Present: true, Value: 10},
		Concurrency: optionalNumber{Present: true, Value: 3},
	}, probeActor{OrgID: "org-1", UserID: "user-1"})
	if err != nil {
		t.Fatalf("lb test error = %v", err)
	}
	if result.Attempts != 10 || result.Succeeded+result.Failed != 10 {
		t.Fatalf("result = %+v, want 10 attempts summing to 10", result)
	}
	if result.Succeeded != 5 || result.Failed != 5 {
		t.Fatalf("succeeded=%d failed=%d, want 5/5", result.Succeeded, result.Failed)
	}
	if maxInFlight.Load() > 3 {
		t.Fatalf("max in flight = %d, want <= 3", maxInFlight.Load())
	}
	distributionTotal := 0
	for _, count := range result.ModelIDDistribution {
		distributionTotal += count
	}
	if distributionTotal != result.Succeeded {
		t.Fatalf("distribution total = %d, want %d", distributionTotal, result.Succeeded)
	}
	if len(result.CallIDSamples) != result.Succeeded {
		t.Fatalf("callId samples = %d, want %d", len(result.CallIDSamples), result.Succeeded)
	}
	if len(result.Errors) != maxProbeErrors && len(result.Errors) != result.Failed {
		t.Fatalf("errors = %d, want min(failed, %d)", len(result.Errors), maxProbeErrors)
	}
	if entries := logs.snapshot(); len(entries) != 10 {
		t.Fatalf("log rows = %d, want one per attempt", len(entries))
	}
}

// TestLBTestAllFailuresStillSummarise pins that a fully failing pool still
// returns a 201-shaped summary instead of an error.
func TestLBTestAllFailuresStillSummarise(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte(`{"detail":"upstream down"}`))
	}))
	defer server.Close()

	service := newTestService(&fakeProfilePort{profiles: map[string]llmgatewayprofiles.ResolvedProfileConfig{
		"p1": profileConfig("p1", server.URL, "m1"),
	}}, &fakeLogWriter{})

	result, err := service.TestProxyLoadBalancing(context.Background(), "p1", lbTestInput{
		Attempts:    optionalNumber{Present: true, Value: 4},
		Concurrency: optionalNumber{Present: true, Value: 2},
	}, probeActor{OrgID: "org-1"})
	if err != nil {
		t.Fatalf("lb test error = %v", err)
	}
	if result.Succeeded != 0 || result.Failed != 4 {
		t.Fatalf("result = %+v, want 0 succeeded and 4 failed", result)
	}
	if len(result.Errors) != 4 {
		t.Fatalf("errors = %d, want 4", len(result.Errors))
	}
	if result.Errors[0].Status == nil || *result.Errors[0].Status != http.StatusBadGateway {
		t.Fatalf("first error = %+v, want the upstream 502", result.Errors[0])
	}
}

// TestGovernanceSecretStates pins the three-way key state and the projection
// override for a missing target.
func TestGovernanceSecretStates(t *testing.T) {
	port := &fakeProfilePort{decryptOK: false}
	service := newTestService(port, nil)

	plaintext := service.resolveGovernanceDocument([]byte(`{"enabled":true,"targetProfileId":"p1","managedRuntimeKey":"  sk-live  "}`))
	if plaintext.ManagedRuntimeKeyState != managedKeyAvailable || plaintext.ManagedRuntimeKey != "sk-live" {
		t.Fatalf("plaintext state=%s value=%q", plaintext.ManagedRuntimeKeyState, plaintext.ManagedRuntimeKey)
	}
	if !plaintext.hasManagedRuntimeKey() {
		t.Fatal("an available key must count as configured")
	}

	unreadable := service.resolveGovernanceDocument([]byte(`{"enabled":true,"targetProfileId":"p1","managedRuntimeKey":{"__enc":"system-settings:v1","alg":"aes-256-gcm","iv":"AA==","tag":"AA==","data":"AA=="}}`))
	if unreadable.ManagedRuntimeKeyState != managedKeyUnreadable {
		t.Fatalf("envelope state = %s, want unreadable", unreadable.ManagedRuntimeKeyState)
	}
	if !unreadable.hasManagedRuntimeKey() {
		t.Fatal("an unreadable key must still report hasManagedRuntimeKey=true")
	}
	if unreadable.ManagedRuntimeKey != "" {
		t.Fatal("an unreadable key must never leak a value")
	}

	missing := service.resolveGovernanceDocument([]byte(`{"enabled":false}`))
	if missing.ManagedRuntimeKeyState != managedKeyMissing || missing.DailyBudgetUSD != defaultDailyBudgetUSD {
		t.Fatalf("defaults state=%s budget=%v", missing.ManagedRuntimeKeyState, missing.DailyBudgetUSD)
	}

	// A stored string number still resolves through Number().
	legacy := service.resolveGovernanceDocument([]byte(`{"dailyBudgetUsd":"12.34567","maxParallelRequests":"7.9"}`))
	if legacy.DailyBudgetUSD != 12.3457 {
		t.Fatalf("budget = %v, want the four-decimal rounded 12.3457", legacy.DailyBudgetUSD)
	}
	if legacy.MaxParallelRequests != 7 {
		t.Fatalf("concurrency = %d, want the truncated 7", legacy.MaxParallelRequests)
	}
}

// TestGovernanceProjectionOverrides pins that a stale target and an unreadable
// key override the stored lastSyncError.
func TestGovernanceProjectionOverrides(t *testing.T) {
	port := &fakeProfilePort{
		profiles: map[string]llmgatewayprofiles.ResolvedProfileConfig{
			"p1": profileConfig("p1", "http://litellm:4000", "m1"),
		},
	}
	service := newTestService(port, nil)

	ok := service.toPublicSettings(governanceSourceDB, resolvedGovernance{
		Enabled:                true,
		TargetProfileID:        stringPointerOrNil("p1"),
		ManagedRuntimeKey:      "sk-1",
		ManagedRuntimeKeyState: managedKeyAvailable,
	}, &governanceTargetProfile{ID: "p1", Name: "primary", APIBase: "http://litellm:4000"})
	if ok.LastSyncError != nil || !ok.TargetProfileEnabled || ok.APIBase == nil {
		t.Fatalf("projection = %+v", ok)
	}

	missingTarget := service.toPublicSettings(governanceSourceDB, resolvedGovernance{
		Enabled:                true,
		TargetProfileID:        stringPointerOrNil("gone"),
		ManagedRuntimeKeyState: managedKeyMissing,
	}, nil)
	if missingTarget.LastSyncError == nil || *missingTarget.LastSyncError != "Managed governance target profile is missing or disabled" {
		t.Fatalf("lastSyncError = %v, want the missing-target text", missingTarget.LastSyncError)
	}

	unreadable := service.toPublicSettings(governanceSourceDB, resolvedGovernance{
		Enabled:                false,
		ManagedRuntimeKeyState: managedKeyUnreadable,
	}, nil)
	if unreadable.LastSyncError == nil || *unreadable.LastSyncError != "Managed runtime key is unreadable because secret decryption failed" {
		t.Fatalf("lastSyncError = %v, want the unreadable-key text", unreadable.LastSyncError)
	}
}

// TestProxyModelInfoForceSkipsCache pins the force semantics: the query only
// bypasses the read AND the write, it does not repopulate the entry.
func TestProxyModelInfoForceSkipsCache(t *testing.T) {
	var hits atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"models":[{"model_name":"gpt-4o","litellm_params":{"model":"openai/gpt-4o","api_key":"sk-secret","headers":{"Authorization":"Bearer abc"}}}]}`))
	}))
	defer server.Close()

	service := newTestService(&fakeProfilePort{profiles: map[string]llmgatewayprofiles.ResolvedProfileConfig{
		"p1": profileConfig("p1", server.URL, "m1"),
	}}, nil)

	result, err := service.GetProxyModelInfo(context.Background(), "p1", false)
	if err != nil {
		t.Fatalf("model info error = %v", err)
	}
	if len(result.Models) != 1 || result.Models[0].ModelName != "gpt-4o" {
		t.Fatalf("models = %+v", result.Models)
	}
	params := string(result.Models[0].LitellmParams)
	if strings.Contains(params, "sk-secret") || strings.Contains(params, "Bearer abc") || strings.Contains(params, "api_key") {
		t.Fatalf("sanitized params leaked a credential: %s", params)
	}
	if !json.Valid(result.Models[0].LitellmParams) {
		t.Fatalf("params are not valid json: %s", params)
	}
	if hits.Load() != 1 {
		t.Fatalf("upstream hits = %d, want 1", hits.Load())
	}
}

// ---- regression coverage for the source-fidelity fixes ----

// TestRerankQueryOrDefault pins that a missing or blank query falls back to the
// source constant instead of failing the probe.
func TestRerankQueryOrDefault(t *testing.T) {
	blank := "   "
	custom := "  how sticky is inflation  "
	if got := rerankQueryOrDefault(nil); got != defaultRerankQuery {
		t.Fatalf("omitted query = %q, want the default", got)
	}
	if got := rerankQueryOrDefault(&blank); got != defaultRerankQuery {
		t.Fatalf("blank query = %q, want the default", got)
	}
	if got := rerankQueryOrDefault(&custom); got != "how sticky is inflation" {
		t.Fatalf("supplied query = %q, want the trimmed input", got)
	}
}

// TestRerankOverrideKeepsFallbacks pins the difference between the completion and
// rerank candidate rules: the rerank override is tried first but the profile
// backup models still follow, while a completion override replaces them.
func TestRerankOverrideKeepsFallbacks(t *testing.T) {
	got := uniqueRerankModels(" override ", "primary", []string{"f1", "f2", "override"})
	want := []string{"override", "f1", "f2"}
	if len(got) != len(want) {
		t.Fatalf("rerank candidates = %v, want %v", got, want)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("rerank candidates = %v, want %v", got, want)
		}
	}
	completion := uniqueModels("override", "primary", []string{"f1"})
	if len(completion) != 1 || completion[0] != "override" {
		t.Fatalf("completion candidates = %v, want only the override", completion)
	}
}

// rerankBodyFromJSON decodes one rerank response body.
func rerankBodyFromJSON(t *testing.T, raw string) rerankBody {
	t.Helper()
	var body rerankBody
	if err := json.Unmarshal([]byte(raw), &body); err != nil {
		t.Fatalf("decode %s: %v", raw, err)
	}
	return body
}

// TestRerankScoreNullFallsThrough pins the `??` chain: an explicit null score
// spelling must not hide a later valid one, and the rows stay ordered by index.
func TestRerankScoreNullFallsThrough(t *testing.T) {
	rows := normalizeRerankResults(rerankBodyFromJSON(t,
		`{"results":[{"index":2,"relevance_score":null,"score":0.9},{"index":0,"relevance_score":0.4},{"index":1,"score":"0.7"}]}`))
	if len(rows) != 3 {
		t.Fatalf("rows = %+v, want 3", rows)
	}
	if rows[0].Index != 0 || rows[0].Score != 0.4 || rows[1].Score != 0.7 || rows[2].Score != 0.9 {
		t.Fatalf("rows = %+v, want the three scores ordered by index", rows)
	}
}

// TestRerankEmptyResultsDoesNotFallBackToData pins the Array.isArray branch: a
// present-but-empty results array is an empty result, not an invitation to read
// the data array.
func TestRerankEmptyResultsDoesNotFallBackToData(t *testing.T) {
	if rows := normalizeRerankResults(rerankBodyFromJSON(t,
		`{"results":[],"data":[{"index":0,"score":1}]}`)); len(rows) != 0 {
		t.Fatalf("rows = %+v, want the empty results array to win", rows)
	}
	if rows := normalizeRerankResults(rerankBodyFromJSON(t,
		`{"data":[{"index":0,"score":1}]}`)); len(rows) != 1 {
		t.Fatalf("rows = %+v, want the data fallback when results is absent", rows)
	}
}

// TestProbeLogCostPrefersTheHeader pins that the persisted row reuses the
// header-over-payload cost precedence instead of logging a null spend.
func TestProbeLogCostPrefersTheHeader(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		w.Header().Set("x-litellm-response-cost", "0.0025")
		_, _ = w.Write([]byte(`{"model":"m1","choices":[{"message":{"content":"OK"}}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}`))
	}))
	defer server.Close()

	logs := &fakeLogWriter{}
	service := newTestService(&fakeProfilePort{}, logs)
	client := newUpstreamClient(service.http, server.URL, "sk-profile", 5*time.Second)

	if _, completionErr := service.runCompletion(context.Background(), client, probeSettings{
		Model:           "m1",
		Temperature:     0.2,
		TopP:            0.9,
		MaxOutputTokens: 128,
	}, "Say OK", "", completionOptions{
		APISurface:         surfaceChat,
		ResponseFormatMode: "none",
		Log:                probeLogContext{OrgID: "org-1", ProfileID: "p1", AuthMode: authModeProfileKey},
	}); completionErr != nil {
		t.Fatalf("completion error = %+v", completionErr)
	}

	entries := logs.snapshot()
	if len(entries) != 1 {
		t.Fatalf("log rows = %d, want 1", len(entries))
	}
	cost := entries[0].Usage.CostUSD
	if cost == nil || *cost != 0.0025 {
		t.Fatalf("logged cost = %v, want the header cost", cost)
	}
}

// TestProxyModelInfoUnreadableBodyReturnsEmptyList pins that a 2xx body the
// source cannot read yields an empty model list instead of a 503.
func TestProxyModelInfoUnreadableBodyReturnsEmptyList(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`[1,2,3]`))
	}))
	defer server.Close()

	service := newTestService(&fakeProfilePort{profiles: map[string]llmgatewayprofiles.ResolvedProfileConfig{
		"p1": profileConfig("p1", server.URL, "m1"),
	}}, nil)

	result, err := service.GetProxyModelInfo(context.Background(), "p1", true)
	if err != nil {
		t.Fatalf("model info error = %v, want an empty list", err)
	}
	if len(result.Models) != 0 {
		t.Fatalf("models = %+v, want empty", result.Models)
	}
}

// TestTransportErrorKeepsTheReason pins that a connection failure names its cause
// instead of surfacing as a bare prefix.
func TestTransportErrorKeepsTheReason(t *testing.T) {
	expired, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancel()
	timedOut := classifyTransportError(expired, errors.New("ignored"), 60*time.Second)
	var upstream *upstreamError
	if !errors.As(timedOut, &upstream) || upstream.code != timeoutErrorCode {
		t.Fatalf("timeout error = %+v, want the axios timeout class", timedOut)
	}
	if info := toGatewayErrorInfo(timedOut, errorContext{}); !strings.Contains(info.Message, "timeout of 60000ms exceeded") {
		t.Fatalf("timeout message = %q, want the deadline text", info.Message)
	}

	refused := classifyTransportError(context.Background(), errors.New("dial tcp: connection refused"), time.Second)
	if info := toGatewayErrorInfo(refused, errorContext{}); !strings.Contains(info.Message, "connection refused") {
		t.Fatalf("transport message = %q, want the reason", info.Message)
	}
}

// TestNormalizeSecretRequiresWhitespaceAfterBearer pins the source regex
// /^bearer\s+/i: a key that merely starts with those letters is a literal key.
func TestNormalizeSecretRequiresWhitespaceAfterBearer(t *testing.T) {
	if got := normalizeSecret("bearertoken123"); got != "bearertoken123" {
		t.Fatalf("normalizeSecret = %q, want the literal key", got)
	}
	if got := normalizeSecret("  Bearer   sk-abc  "); got != "sk-abc" {
		t.Fatalf("normalizeSecret = %q, want the stripped key", got)
	}
	if got := normalizeSecret("   "); got != "" {
		t.Fatalf("normalizeSecret = %q, want empty", got)
	}
}

// TestUpstreamEndpointTrimsBaseSlashes pins the axios combineURLs join: the raw
// stored apiBase may end with "/", and a management path must not become
// "//team/update" because of it.
func TestUpstreamEndpointTrimsBaseSlashes(t *testing.T) {
	client := newUpstreamClient(nil, "http://litellm:4000/v1/", "", time.Second)
	target, err := client.endpoint("/team/update")
	if err != nil {
		t.Fatalf("endpoint error = %v", err)
	}
	if target != "http://litellm:4000/v1/team/update" {
		t.Fatalf("endpoint = %q, want a single slash join", target)
	}
}

// TestInvalidProbeLogRowDropsResponseUsage pins that an invalid 2xx embedding row
// is logged without the response-derived usage/cost/model: the source passes no
// response to the error row, so a rejected body must not book spend.
func TestInvalidProbeLogRowDropsResponseUsage(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		w.Header().Set("x-litellm-response-cost", "0.5")
		_, _ = w.Write([]byte(`{"model":"served-model","data":[{"embedding":[]}],"usage":{"prompt_tokens":9,"total_tokens":9},"response_cost":0.25}`))
	}))
	defer server.Close()

	logs := &fakeLogWriter{}
	service := newTestService(&fakeProfilePort{}, logs)
	client := newUpstreamClient(service.http, server.URL, "sk-profile", 5*time.Second)

	if _, err := service.runEmbedding(context.Background(), client, embeddingConfig{
		Model:          "m1",
		EmbeddingModel: "e1",
	}, "hello", "", probeLogContext{OrgID: "org-1", ProfileID: "p1", AuthMode: authModeProfileKey}); err == nil {
		t.Fatal("an empty vector must fail")
	}
	entries := logs.snapshot()
	if len(entries) != 1 {
		t.Fatalf("log rows = %d, want 1 error row", len(entries))
	}
	entry := entries[0]
	if entry.Model != "e1" {
		t.Fatalf("logged model = %q, want the requested model", entry.Model)
	}
	if entry.Usage.PromptTokens != nil || entry.Usage.TotalTokens != nil || entry.Usage.CostUSD != nil {
		t.Fatalf("usage = %+v, want no response-derived usage on an error row", entry.Usage)
	}
}

// TestTransportErrorCode pins the axios error-code approximation for the two
// unambiguous connection classes.
func TestTransportErrorCode(t *testing.T) {
	if got := transportErrorCode(&net.DNSError{IsNotFound: true}); got != "ENOTFOUND" {
		t.Fatalf("dns code = %q, want ENOTFOUND", got)
	}
	if got := transportErrorCode(fmt.Errorf("dial tcp: %w", syscall.ECONNREFUSED)); got != "ECONNREFUSED" {
		t.Fatalf("refused code = %q, want ECONNREFUSED", got)
	}
	if got := transportErrorCode(errors.New("some other failure")); got != "" {
		t.Fatalf("unknown code = %q, want empty", got)
	}
}
