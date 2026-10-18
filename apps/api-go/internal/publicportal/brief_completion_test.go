package publicportal

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

type recordedAttempt struct {
	model        string
	modelIndex   int
	attempt      int
	success      bool
	surface      string
	governance   bool
	authMode     string
	targetID     string
	promptTokens *float64
	costUSD      *float64
}

type recordingObserver struct {
	attempts []recordedAttempt
}

func (o *recordingObserver) ObserveBriefCompletionAttempt(_ context.Context, attempt BriefCompletionAttempt) {
	o.attempts = append(o.attempts, recordedAttempt{
		model:        attempt.Model,
		modelIndex:   attempt.ModelIndex,
		attempt:      attempt.Attempt,
		success:      attempt.Success,
		surface:      attempt.APISurface,
		governance:   attempt.GovernanceApplied,
		authMode:     attempt.AuthMode,
		targetID:     attempt.GovernanceTargetProfileID,
		promptTokens: attempt.Usage.PromptTokens,
		costUSD:      attempt.Usage.CostUSD,
	})
}

func TestBriefCompleterResponsesSurfaceAndUsage(t *testing.T) {
	var gotPath string
	var gotBody map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &gotBody)
		_, _ = w.Write([]byte(`{"output_text":"{\"detailed_summary\":\"D\"}","usage":{"input_tokens":5,"output_tokens":7,"total_tokens":12}}`))
	}))
	defer server.Close()

	store := &fakeStore{gatewayJSON: []byte(`{
		"activeId":"p1",
		"profiles":[{"id":"p1","model":"m1","apiBase":"` + server.URL + `","enabled":true,"maxRetries":1,"timeoutMs":5000,"apiSurface":"responses"}]
	}`)}
	completer := NewBriefCompleter(store, GatewayEnv{MaxRetries: 1, TimeoutMs: 5000})
	result, err := completer.CompleteBrief(context.Background(), BriefCompletionRequest{
		System:   "system",
		User:     "user",
		Metadata: BriefCompletionMetadata{Feature: "news_event_brief", EventTitle: "T", Sources: 2},
	})
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/v1/responses" {
		t.Fatalf("path = %s", gotPath)
	}
	if gotBody["max_output_tokens"] != float64(1200) || gotBody["max_tokens"] != nil {
		t.Fatalf("body = %#v", gotBody)
	}
	if result.Model != "m1" || !strings.Contains(result.Content, "detailed_summary") {
		t.Fatalf("result = %+v", result)
	}
	if result.Usage.PromptTokens == nil || *result.Usage.PromptTokens != 5 {
		t.Fatalf("promptTokens = %v", result.Usage.PromptTokens)
	}
	if result.Usage.CompletionTokens == nil || *result.Usage.CompletionTokens != 7 {
		t.Fatalf("completionTokens = %v", result.Usage.CompletionTokens)
	}
	if result.Usage.TotalTokens == nil || *result.Usage.TotalTokens != 12 {
		t.Fatalf("totalTokens = %v", result.Usage.TotalTokens)
	}
	if result.Usage.CostUSD != nil {
		t.Fatalf("costUsd must stay nil when the gateway does not report it: %v", *result.Usage.CostUSD)
	}
}

func TestBriefCompleterObservesAttemptsAndFallsBack(t *testing.T) {
	var mu sync.Mutex
	var calls []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var body map[string]any
		_ = json.Unmarshal(raw, &body)
		model, _ := body["model"].(string)
		mu.Lock()
		calls = append(calls, model)
		mu.Unlock()
		if model == "m1" {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"{\"tldr\":\"T\"}"}}]}`))
	}))
	defer server.Close()

	store := &fakeStore{gatewayJSON: []byte(`{
		"activeId":"p1",
		"profiles":[{"id":"p1","model":"m1","apiBase":"` + server.URL + `","enabled":true,"maxRetries":1,"timeoutMs":5000,"fallbackModels":["m2"]}]
	}`)}
	observer := &recordingObserver{}
	completer := NewBriefCompleter(store, GatewayEnv{MaxRetries: 1, TimeoutMs: 5000})
	result, err := completer.CompleteBrief(context.Background(), BriefCompletionRequest{
		System:   "system",
		User:     "user",
		Metadata: BriefCompletionMetadata{Feature: "news_event_brief"},
		Observer: observer,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Model != "m2" {
		t.Fatalf("model = %s", result.Model)
	}
	if len(observer.attempts) != 2 {
		t.Fatalf("attempts = %+v", observer.attempts)
	}
	if observer.attempts[0].model != "m1" || observer.attempts[0].success || observer.attempts[0].modelIndex != 1 {
		t.Fatalf("first attempt = %+v", observer.attempts[0])
	}
	if observer.attempts[1].model != "m2" || !observer.attempts[1].success || observer.attempts[1].modelIndex != 2 {
		t.Fatalf("second attempt = %+v", observer.attempts[1])
	}
	if observer.attempts[0].surface != "chat_completions" {
		t.Fatalf("surface = %s", observer.attempts[0].surface)
	}
	mu.Lock()
	defer mu.Unlock()
	if strings.Join(calls, ",") != "m1,m2" {
		t.Fatalf("calls = %v", calls)
	}
}

func TestBriefCompleterStopsFallbackOnGuardrailBlock(t *testing.T) {
	var mu sync.Mutex
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		calls++
		mu.Unlock()
		_, _ = w.Write([]byte(`{"messages":["blocked by content safety guardrails"]}`))
	}))
	defer server.Close()

	store := &fakeStore{gatewayJSON: []byte(`{
		"activeId":"p1",
		"profiles":[{"id":"p1","model":"m1","apiBase":"` + server.URL + `","enabled":true,"maxRetries":1,"timeoutMs":5000,"fallbackModels":["m2"]}]
	}`)}
	observer := &recordingObserver{}
	completer := NewBriefCompleter(store, GatewayEnv{MaxRetries: 1, TimeoutMs: 5000})
	if _, err := completer.CompleteBrief(context.Background(), BriefCompletionRequest{
		System:   "system",
		User:     "user",
		Metadata: BriefCompletionMetadata{Feature: "news_event_brief"},
		Observer: observer,
	}); err == nil {
		t.Fatal("a guardrail refusal must not be reported as success")
	}
	mu.Lock()
	defer mu.Unlock()
	if calls != 1 {
		t.Fatalf("guardrail refusal must stop the fallback chain, calls = %d", calls)
	}
	if len(observer.attempts) != 1 || observer.attempts[0].success {
		t.Fatalf("attempts = %+v", observer.attempts)
	}
}

func TestBriefCompleterReportsGovernance(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("x-litellm-response-cost", "0.0042")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"{\"tldr\":\"T\"}"}}],"usage":{"prompt_tokens":3,"completion_tokens":4}}`))
	}))
	defer server.Close()

	store := &fakeStore{
		gatewayJSON: []byte(`{
			"activeId":"p1",
			"profiles":[{"id":"p1","model":"m1","apiBase":"` + server.URL + `","apiKey":"old-key","enabled":true,"maxRetries":1,"timeoutMs":5000}]
		}`),
		governanceJSON: []byte(`{"enabled":true,"targetProfileId":"p1","managedRuntimeKey":"sk-runtime"}`),
	}
	observer := &recordingObserver{}
	completer := NewBriefCompleter(store, GatewayEnv{MaxRetries: 1, TimeoutMs: 5000})
	result, err := completer.CompleteBrief(context.Background(), BriefCompletionRequest{
		System:   "system",
		User:     "user",
		Metadata: BriefCompletionMetadata{Feature: "news_event_brief"},
		Observer: observer,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(observer.attempts) != 1 {
		t.Fatalf("attempts = %+v", observer.attempts)
	}
	attempt := observer.attempts[0]
	if !attempt.governance || attempt.authMode != "managed_runtime_key" || attempt.targetID != "p1" {
		t.Fatalf("governance attempt = %+v", attempt)
	}
	if attempt.costUSD == nil || *attempt.costUSD != 0.0042 {
		t.Fatalf("costUsd = %v", attempt.costUSD)
	}
	if result.Usage.TotalTokens == nil || *result.Usage.TotalTokens != 7 {
		t.Fatalf("totalTokens = %v", result.Usage.TotalTokens)
	}
}

func TestBriefCompleterFailsClosedOnUnreadableGovernanceKey(t *testing.T) {
	store := &fakeStore{
		gatewayJSON: []byte(`{
			"activeId":"p1",
			"profiles":[{"id":"p1","model":"m1","apiBase":"http://gateway.example","enabled":true}]
		}`),
		governanceJSON: []byte(`{"enabled":true,"targetProfileId":"p1","managedRuntimeKey":{"__enc":"system-settings:v1","alg":"aes-256-gcm","iv":"AA==","tag":"AA==","data":"AA=="}}`),
	}
	completer := NewBriefCompleter(store, GatewayEnv{})
	_, err := completer.CompleteBrief(context.Background(), BriefCompletionRequest{
		System: "system",
		User:   "user",
	})
	status, ok := err.(*StatusError)
	if !ok || status.Code != http.StatusServiceUnavailable {
		t.Fatalf("err = %v", err)
	}
}

func TestCompletionUsageResponsesNeedsBothTokenCounts(t *testing.T) {
	usage := completionUsage([]byte(`{"output_text":"x","usage":{"input_tokens":5}}`), "responses")
	if usage.PromptTokens != nil || usage.CompletionTokens != nil || usage.TotalTokens != nil {
		t.Fatalf("usage = %+v", usage)
	}
}
