package publicportal

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func hottestProfiles(t *testing.T, apiBase string, fallback []string) []byte {
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
	encoded, err := json.Marshal(map[string]any{"activeId": "p1", "profiles": []any{profile}})
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

type hottestObserver struct {
	attempts []HottestClusterAttempt
}

func (o *hottestObserver) ObserveHottestClusterAttempt(_ context.Context, attempt HottestClusterAttempt) {
	o.attempts = append(o.attempts, attempt)
}

type capturedHottestRequest struct {
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
	Metadata *HottestClusterMetadata `json:"metadata"`
}

func TestCompleteHottestClusterInsightsSendsFixedRequestShape(t *testing.T) {
	var captured capturedHottestRequest
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			t.Fatalf("path = %s", r.URL.Path)
		}
		body, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(body, &captured); err != nil {
			t.Fatalf("decode body: %v (%s)", err, body)
		}
		_, _ = w.Write([]byte(`{"model":"gpt-main","choices":[{"message":{"content":"{\"clusters\":[]}"}}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}`))
	}))
	defer server.Close()

	observer := &hottestObserver{}
	completer := NewHottestClusterCompleter(
		fakeGatewaySettings{profiles: hottestProfiles(t, server.URL, nil)},
		GatewayEnv{APIBase: server.URL, APIKey: "env-key", TimeoutMs: 5000, MaxRetries: 3},
	)
	result, err := completer.CompleteHottestClusterInsights(context.Background(), HottestClusterRequest{
		OrgID:        "org-1",
		System:       "system prompt",
		User:         "user prompt",
		ClusterCount: 3,
		Observer:     observer,
	})
	if err != nil {
		t.Fatalf("complete: %v", err)
	}
	if captured.Model != "gpt-main" || captured.Temperature != 0.15 || captured.TopP != 0.9 ||
		captured.MaxTokens != 1800 || captured.Stream {
		t.Fatalf("params = %+v", captured)
	}
	if len(captured.Messages) != 2 || captured.Messages[0].Role != "system" ||
		captured.Messages[0].Content != "system prompt" || captured.Messages[1].Content != "user prompt" {
		t.Fatalf("messages = %+v", captured.Messages)
	}
	if captured.ResponseFormat == nil || captured.ResponseFormat.Type != "json_schema" ||
		captured.ResponseFormat.JSONSchema == nil ||
		captured.ResponseFormat.JSONSchema.Name != "newsnow_hottest_cluster_insights_v1" {
		t.Fatalf("response_format = %+v", captured.ResponseFormat)
	}
	if captured.ResponseFormat.JSONSchema.Schema["type"] != "object" {
		t.Fatalf("schema = %+v", captured.ResponseFormat.JSONSchema.Schema)
	}
	if captured.Metadata == nil || captured.Metadata.Feature != "newsnow_hottest_cluster_analysis" ||
		captured.Metadata.Clusters != 3 {
		t.Fatalf("metadata = %+v", captured.Metadata)
	}
	if result.Content != `{"clusters":[]}` || result.Model != "gpt-main" {
		t.Fatalf("result = %+v", result)
	}
	if result.Usage.TotalTokens == nil || *result.Usage.TotalTokens != 15 {
		t.Fatalf("usage = %+v", result.Usage)
	}
	if len(observer.attempts) != 1 {
		t.Fatalf("attempts = %d", len(observer.attempts))
	}
	attempt := observer.attempts[0]
	if !attempt.Success || attempt.Metadata.Clusters != 3 || attempt.OrgID != "org-1" || attempt.ModelIndex != 1 {
		t.Fatalf("attempt = %+v", attempt)
	}
}

func TestCompleteHottestClusterInsightsReportsFailedAttempt(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":{"message":"upstream down"}}`))
	}))
	defer server.Close()

	observer := &hottestObserver{}
	completer := NewHottestClusterCompleter(
		fakeGatewaySettings{profiles: hottestProfiles(t, server.URL, nil)},
		GatewayEnv{APIBase: server.URL, TimeoutMs: 5000, MaxRetries: 3},
	)
	if _, err := completer.CompleteHottestClusterInsights(context.Background(), HottestClusterRequest{
		OrgID:        "org-1",
		System:       "s",
		User:         "u",
		ClusterCount: 1,
		Observer:     observer,
	}); err == nil {
		t.Fatal("expected an error")
	}
	if len(observer.attempts) != 1 || observer.attempts[0].Success || observer.attempts[0].Err == nil {
		t.Fatalf("attempts = %+v", observer.attempts)
	}
}
