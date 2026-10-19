package publicportal

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// fakeGatewaySettings is a BriefSettingsReader backed by in-memory documents.
type fakeGatewaySettings struct {
	profiles   []byte
	governance []byte
}

func (f fakeGatewaySettings) GatewaySettings(context.Context) ([]byte, []byte, error) {
	return f.profiles, f.governance, nil
}

func clusteringProfiles(t *testing.T, apiBase string, fallback []string) []byte {
	t.Helper()
	profile := map[string]any{
		"id":                 "p1",
		"model":              "gpt-main",
		"apiBase":            apiBase,
		"apiKey":             "key-1",
		"maxRetries":         1,
		"sendMetadata":       true,
		"responseFormatMode": "json_schema",
		"apiSurface":         "chat_completions",
		"fallbackModels":     fallback,
	}
	encoded, err := json.Marshal(map[string]any{
		"activeId": "p1",
		"profiles": []any{profile},
	})
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

type clusteringObserver struct {
	attempts []ClusteringDecisionAttempt
}

func (o *clusteringObserver) ObserveClusteringDecisionAttempt(_ context.Context, attempt ClusteringDecisionAttempt) {
	o.attempts = append(o.attempts, attempt)
}

type capturedClusteringRequest struct {
	Model    string `json:"model"`
	Messages []struct {
		Role    string `json:"role"`
		Content string `json:"content"`
	} `json:"messages"`
	Temperature    float64 `json:"temperature"`
	TopP           float64 `json:"top_p"`
	MaxTokens      int     `json:"max_tokens"`
	Stream         bool    `json:"stream"`
	ResponseFormat *struct {
		Type       string `json:"type"`
		JSONSchema *struct {
			Name   string         `json:"name"`
			Schema map[string]any `json:"schema"`
		} `json:"json_schema"`
	} `json:"response_format"`
	Metadata *ClusteringDecisionMetadata `json:"metadata"`
}

func TestCompleteClusteringDecisionSendsFixedRequestShape(t *testing.T) {
	var captured capturedClusteringRequest
	var authHeader string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			t.Fatalf("path = %s", r.URL.Path)
		}
		authHeader = r.Header.Get("Authorization")
		body, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(body, &captured); err != nil {
			t.Fatalf("decode body: %v (%s)", err, body)
		}
		_, _ = w.Write([]byte(`{"model":"gpt-main","choices":[{"message":{"content":"{\"action\":\"create_new\"}"}}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15},"response_cost":0.25}`))
	}))
	defer server.Close()

	observer := &clusteringObserver{}
	completer := NewClusteringDecisionCompleter(
		fakeGatewaySettings{profiles: clusteringProfiles(t, server.URL, nil)},
		GatewayEnv{APIBase: server.URL, APIKey: "env-key", TimeoutMs: 5000, MaxRetries: 3},
	)
	result, err := completer.CompleteClusteringDecision(context.Background(), ClusteringDecisionRequest{
		OrgID:              "org-1",
		Model:              "gpt-main",
		System:             "system prompt",
		User:               "user prompt",
		CandidateCount:     2,
		ArticleFingerprint: "abcdef0123456789",
		Observer:           observer,
	})
	if err != nil {
		t.Fatalf("CompleteClusteringDecision: %v", err)
	}
	if authHeader != "Bearer key-1" {
		t.Fatalf("authorization = %q", authHeader)
	}
	if captured.Model != "gpt-main" || captured.Temperature != 0 || captured.TopP != 1 || captured.MaxTokens != 350 || captured.Stream {
		t.Fatalf("params = %+v", captured)
	}
	if len(captured.Messages) != 2 || captured.Messages[0].Role != "system" || captured.Messages[1].Role != "user" {
		t.Fatalf("messages = %+v", captured.Messages)
	}
	if captured.ResponseFormat == nil || captured.ResponseFormat.Type != "json_schema" ||
		captured.ResponseFormat.JSONSchema == nil || captured.ResponseFormat.JSONSchema.Name != "news_event_llm_backfill_decision_v1" {
		t.Fatalf("response_format = %+v", captured.ResponseFormat)
	}
	if captured.ResponseFormat.JSONSchema.Schema["type"] != "object" {
		t.Fatalf("schema = %+v", captured.ResponseFormat.JSONSchema.Schema)
	}
	if captured.Metadata == nil || captured.Metadata.Feature != "news_event_clustering_llm_backfill" ||
		captured.Metadata.CandidateCount != 2 || captured.Metadata.ArticleFingerprint != "abcdef0123456789" {
		t.Fatalf("metadata = %+v", captured.Metadata)
	}
	if result.Content != `{"action":"create_new"}` || result.Model != "gpt-main" {
		t.Fatalf("result = %+v", result)
	}
	if result.Usage.PromptTokens == nil || *result.Usage.PromptTokens != 10 ||
		result.Usage.CompletionTokens == nil || *result.Usage.CompletionTokens != 5 ||
		result.Usage.TotalTokens == nil || *result.Usage.TotalTokens != 15 ||
		result.Usage.CostUSD == nil || *result.Usage.CostUSD != 0.25 {
		t.Fatalf("usage = %+v", result.Usage)
	}
	if len(observer.attempts) != 1 {
		t.Fatalf("attempts = %d", len(observer.attempts))
	}
	attempt := observer.attempts[0]
	if !attempt.Success || attempt.Model != "gpt-main" || attempt.ModelIndex != 1 || attempt.Attempt != 1 ||
		attempt.Metadata.CandidateCount != 2 {
		t.Fatalf("attempt = %+v", attempt)
	}
}

func TestCompleteClusteringDecisionReturnsEmptyContentWithoutError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"model":"gpt-main","choices":[{"message":{"content":"   "}}]}`))
	}))
	defer server.Close()

	completer := NewClusteringDecisionCompleter(
		fakeGatewaySettings{profiles: clusteringProfiles(t, server.URL, nil)},
		GatewayEnv{APIBase: server.URL},
	)
	result, err := completer.CompleteClusteringDecision(context.Background(), ClusteringDecisionRequest{OrgID: "org-1", Model: "gpt-main"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Content != "" {
		t.Fatalf("content = %q", result.Content)
	}
}

func TestCompleteClusteringDecisionKeepsInvalidJSONForTheCaller(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"model":"gpt-main","choices":[{"message":{"content":"not json"}}]}`))
	}))
	defer server.Close()

	completer := NewClusteringDecisionCompleter(
		fakeGatewaySettings{profiles: clusteringProfiles(t, server.URL, nil)},
		GatewayEnv{APIBase: server.URL},
	)
	result, err := completer.CompleteClusteringDecision(context.Background(), ClusteringDecisionRequest{OrgID: "org-1", Model: "gpt-main"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Content != "not json" {
		t.Fatalf("content = %q", result.Content)
	}
}

func TestCompleteClusteringDecisionFallsBackToTheNextModel(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		var body capturedClusteringRequest
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body.Model == "gpt-main" {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`{"error":{"message":"upstream exploded"}}`))
			return
		}
		_, _ = w.Write([]byte(`{"model":"gpt-fallback","choices":[{"message":{"content":"{\"action\":\"assign_existing\",\"eventId\":\"event-1\"}"}}]}`))
	}))
	defer server.Close()

	observer := &clusteringObserver{}
	completer := NewClusteringDecisionCompleter(
		fakeGatewaySettings{profiles: clusteringProfiles(t, server.URL, []string{"gpt-fallback"})},
		GatewayEnv{APIBase: server.URL, MaxRetries: 1},
	)
	result, err := completer.CompleteClusteringDecision(context.Background(), ClusteringDecisionRequest{
		OrgID:    "org-1",
		Model:    "gpt-main",
		Observer: observer,
	})
	if err != nil {
		t.Fatalf("CompleteClusteringDecision: %v", err)
	}
	if requests != 2 {
		t.Fatalf("requests = %d, want 2", requests)
	}
	if result.Model != "gpt-fallback" {
		t.Fatalf("model = %q", result.Model)
	}
	if len(observer.attempts) != 2 {
		t.Fatalf("attempts = %d", len(observer.attempts))
	}
	if observer.attempts[0].Success || observer.attempts[0].Model != "gpt-main" || observer.attempts[0].ModelIndex != 1 {
		t.Fatalf("first attempt = %+v", observer.attempts[0])
	}
	if !observer.attempts[1].Success || observer.attempts[1].ModelIndex != 2 {
		t.Fatalf("second attempt = %+v", observer.attempts[1])
	}
}

func TestCompleteClusteringDecisionStopsOnGuardrail(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests++
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":{"message":"blocked by content policy"}}`))
	}))
	defer server.Close()

	completer := NewClusteringDecisionCompleter(
		fakeGatewaySettings{profiles: clusteringProfiles(t, server.URL, []string{"gpt-fallback"})},
		GatewayEnv{APIBase: server.URL, MaxRetries: 1},
	)
	_, err := completer.CompleteClusteringDecision(context.Background(), ClusteringDecisionRequest{OrgID: "org-1", Model: "gpt-main"})
	if err == nil || !strings.Contains(strings.ToLower(err.Error()), "guardrail") {
		t.Fatalf("error = %v", err)
	}
	if requests != 1 {
		t.Fatalf("requests = %d, want the chain to stop after the guardrail", requests)
	}
}

func TestCompleteClusteringDecisionJSONObjectModeReplacesSchema(t *testing.T) {
	var captured capturedClusteringRequest
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&captured)
		_, _ = w.Write([]byte(`{"model":"gpt-main","choices":[{"message":{"content":"{}"}}]}`))
	}))
	defer server.Close()

	profiles := clusteringProfiles(t, server.URL, nil)
	profiles = []byte(strings.Replace(string(profiles), `"responseFormatMode":"json_schema"`, `"responseFormatMode":"json_object"`, 1))
	completer := NewClusteringDecisionCompleter(fakeGatewaySettings{profiles: profiles}, GatewayEnv{APIBase: server.URL})
	if _, err := completer.CompleteClusteringDecision(context.Background(), ClusteringDecisionRequest{OrgID: "org-1", Model: "gpt-main"}); err != nil {
		t.Fatalf("CompleteClusteringDecision: %v", err)
	}
	if captured.ResponseFormat == nil || captured.ResponseFormat.Type != "json_object" || captured.ResponseFormat.JSONSchema != nil {
		t.Fatalf("response_format = %+v", captured.ResponseFormat)
	}
}

func TestCompleteClusteringDecisionRetriesRetryableStatus(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests++
		if requests == 1 {
			w.WriteHeader(http.StatusBadGateway)
			_, _ = w.Write([]byte(`{"error":{"message":"temporary"}}`))
			return
		}
		_, _ = w.Write([]byte(`{"model":"gpt-main","choices":[{"message":{"content":"{}"}}]}`))
	}))
	defer server.Close()

	profiles := []byte(strings.Replace(string(clusteringProfiles(t, server.URL, nil)), `"maxRetries":1`, `"maxRetries":2`, 1))
	completer := NewClusteringDecisionCompleter(fakeGatewaySettings{profiles: profiles}, GatewayEnv{APIBase: server.URL, MaxRetries: 2})
	result, err := completer.CompleteClusteringDecision(context.Background(), ClusteringDecisionRequest{OrgID: "org-1", Model: "gpt-main"})
	if err != nil {
		t.Fatalf("CompleteClusteringDecision: %v", err)
	}
	if requests != 2 {
		t.Fatalf("requests = %d, want 2", requests)
	}
	if result.Content != "{}" {
		t.Fatalf("content = %q", result.Content)
	}
}

func TestPrimaryModelReturnsTheConfiguredModel(t *testing.T) {
	completer := NewClusteringDecisionCompleter(
		fakeGatewaySettings{profiles: clusteringProfiles(t, "http://127.0.0.1:1", nil)},
		GatewayEnv{APIBase: "http://127.0.0.1:1"},
	)
	model, err := completer.PrimaryModel(context.Background())
	if err != nil {
		t.Fatalf("PrimaryModel: %v", err)
	}
	if model != "gpt-main" {
		t.Fatalf("model = %q", model)
	}
}

func TestClusteringDecisionSchemaShape(t *testing.T) {
	schema := clusteringDecisionJSONSchema()
	properties, ok := schema["properties"].(map[string]any)
	if !ok {
		t.Fatalf("properties = %T", schema["properties"])
	}
	action, ok := properties["action"].(map[string]any)
	if !ok {
		t.Fatalf("action = %T", properties["action"])
	}
	enum, ok := action["enum"].([]string)
	if !ok || len(enum) != 2 || enum[0] != "assign_existing" || enum[1] != "create_new" {
		t.Fatalf("enum = %v", action["enum"])
	}
	required, ok := schema["required"].([]string)
	if !ok || len(required) != 1 || required[0] != "action" {
		t.Fatalf("required = %v", schema["required"])
	}
	if schema["additionalProperties"] != false {
		t.Fatalf("additionalProperties = %v", schema["additionalProperties"])
	}
	eventID := properties["eventId"].(map[string]any)
	types, ok := eventID["type"].([]string)
	if !ok || len(types) != 2 || types[0] != "string" || types[1] != "null" {
		t.Fatalf("eventId type = %v", eventID["type"])
	}
	if eventID["minLength"] != 1 || eventID["maxLength"] != 64 {
		t.Fatalf("eventId bounds = %v", eventID)
	}
	confidence := properties["confidence"].(map[string]any)
	if confidence["minimum"] != 0 || confidence["maximum"] != 1 {
		t.Fatalf("confidence bounds = %v", confidence)
	}
	reasoning := properties["reasoning"].(map[string]any)
	if reasoning["maxLength"] != 500 {
		t.Fatalf("reasoning max = %v", reasoning["maxLength"])
	}
}

func TestClusteringDecisionMetadataEntries(t *testing.T) {
	entries := (ClusteringDecisionMetadata{
		Feature:            "news_event_clustering_llm_backfill",
		CandidateCount:     3,
		ArticleFingerprint: "abc",
	}).entries()
	if len(entries) != 3 {
		t.Fatalf("entries = %d", len(entries))
	}
	if entries[0].Key != "feature" || entries[0].Text == nil || *entries[0].Text != "news_event_clustering_llm_backfill" {
		t.Fatalf("feature entry = %+v", entries[0])
	}
	if entries[1].Key != "candidateCount" || entries[1].Number == nil || *entries[1].Number != 3 {
		t.Fatalf("candidateCount entry = %+v", entries[1])
	}
	if entries[2].Key != "articleFingerprint" || entries[2].Text == nil || *entries[2].Text != "abc" {
		t.Fatalf("fingerprint entry = %+v", entries[2])
	}
}

// compiler check: the production gateway satisfies the exported interface.
var _ ClusteringDecisionCompleter = (*gatewayClient)(nil)
