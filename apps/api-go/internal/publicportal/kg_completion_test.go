package publicportal

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

func profilesJSON(t *testing.T, apiBase string, extra map[string]any) []byte {
	t.Helper()
	profile := map[string]any{
		"id":                 "p1",
		"model":              "primary",
		"apiBase":            apiBase,
		"apiKey":             "test-key",
		"maxRetries":         1,
		"sendMetadata":       true,
		"responseFormatMode": "json_schema",
		"apiSurface":         "chat_completions",
		"fallbackModels":     []string{"fallback"},
	}
	for key, value := range extra {
		profile[key] = value
	}
	encoded, err := json.Marshal(map[string]any{
		"activeId": "p1",
		"profiles": []map[string]any{profile},
	})
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

type kgRecordingObserver struct {
	mu       sync.Mutex
	attempts []KGCompletionAttempt
}

func (o *kgRecordingObserver) ObserveKGCompletionAttempt(_ context.Context, attempt KGCompletionAttempt) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.attempts = append(o.attempts, attempt)
}

func (o *kgRecordingObserver) captured() []KGCompletionAttempt {
	o.mu.Lock()
	defer o.mu.Unlock()
	return append([]KGCompletionAttempt(nil), o.attempts...)
}

func TestKGCompletionChatRequestShapeAndResult(t *testing.T) {
	var body map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			t.Errorf("path = %s", r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode body: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"model":"primary","choices":[{"message":{"content":"{\"verdict\":\"yes\",\"confidence\":0.9}"}}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}`))
	}))
	defer server.Close()

	observer := &kgRecordingObserver{}
	completer := NewKGCompleter(fakeGatewaySettings{profiles: profilesJSON(t, server.URL, nil)}, GatewayEnv{})
	result, err := completer.KGComplete(context.Background(), KGCompletionRequest{
		OrgID:      "org",
		Model:      "primary",
		System:     "system",
		User:       "user",
		SchemaName: "kg_relation_validation",
		Schema:     json.RawMessage(KGRelationValidationSchema),
		MaxTokens:  120,
		TimeoutMS:  45_000,
		MaxRetries: 1,
		Metadata:   KGCompletionMetadata{Task: "kg_relation_validation", OrgID: "org", ArticleID: "a1"},
		Observer:   observer,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Content != `{"verdict":"yes","confidence":0.9}` || result.Model != "primary" {
		t.Fatalf("result = %+v", result)
	}
	if result.Usage.TotalTokens == nil || *result.Usage.TotalTokens != 15 {
		t.Fatalf("usage = %+v", result.Usage)
	}

	if body["temperature"] != float64(0) {
		t.Fatalf("temperature = %v", body["temperature"])
	}
	if body["max_tokens"] != float64(120) {
		t.Fatalf("max_tokens = %v", body["max_tokens"])
	}
	if body["top_p"] != 0.9 {
		t.Fatalf("top_p = %v", body["top_p"])
	}
	if body["stream"] != false {
		t.Fatalf("stream = %v", body["stream"])
	}
	format, _ := body["response_format"].(map[string]any)
	if format["type"] != "json_schema" {
		t.Fatalf("response_format = %v", format)
	}
	envelope, _ := format["json_schema"].(map[string]any)
	if envelope["name"] != "kg_relation_validation" || envelope["schema"] == nil {
		t.Fatalf("json_schema = %v", envelope)
	}
	metadata, _ := body["metadata"].(map[string]any)
	if metadata["task"] != "kg_relation_validation" || metadata["orgId"] != "org" || metadata["articleId"] != "a1" {
		t.Fatalf("metadata = %v", metadata)
	}

	attempts := observer.captured()
	if len(attempts) != 1 || !attempts[0].Success {
		t.Fatalf("attempts = %+v", attempts)
	}
	if attempts[0].Metadata.Task != "kg_relation_validation" {
		t.Fatalf("attempt metadata = %+v", attempts[0].Metadata)
	}
}

func TestKGCompletionFallsBackToNextModel(t *testing.T) {
	var models []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		model, _ := body["model"].(string)
		models = append(models, model)
		if model == "primary" {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`{"error":"boom"}`))
			return
		}
		_, _ = w.Write([]byte(`{"model":"fallback","choices":[{"message":{"content":"{\"verdict\":\"no\",\"confidence\":0.2}"}}]}`))
	}))
	defer server.Close()

	observer := &kgRecordingObserver{}
	completer := NewKGCompleter(fakeGatewaySettings{profiles: profilesJSON(t, server.URL, nil)}, GatewayEnv{})
	result, err := completer.KGComplete(context.Background(), KGCompletionRequest{
		OrgID:      "org",
		Model:      "primary",
		SchemaName: "kg_relation_validation",
		Schema:     json.RawMessage(KGRelationValidationSchema),
		MaxTokens:  120,
		MaxRetries: 1,
		Observer:   observer,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Model != "fallback" {
		t.Fatalf("model = %s", result.Model)
	}
	if len(models) != 2 || models[0] != "primary" || models[1] != "fallback" {
		t.Fatalf("models = %v", models)
	}
	attempts := observer.captured()
	if len(attempts) != 2 || attempts[0].Success || !attempts[1].Success {
		t.Fatalf("attempts = %+v", attempts)
	}
	if attempts[0].Err == nil {
		t.Fatal("first attempt has no error")
	}
}

func TestKGCompletionStopsOnGuardrailBlock(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests++
		_, _ = w.Write([]byte(`{"messages":[{"role":"assistant","content":"blocked"}],"choices":[]}`))
	}))
	defer server.Close()

	observer := &kgRecordingObserver{}
	completer := NewKGCompleter(fakeGatewaySettings{profiles: profilesJSON(t, server.URL, nil)}, GatewayEnv{})
	_, err := completer.KGComplete(context.Background(), KGCompletionRequest{
		OrgID:      "org",
		Model:      "primary",
		SchemaName: "kg_relation_validation",
		Schema:     json.RawMessage(KGRelationValidationSchema),
		MaxTokens:  120,
		MaxRetries: 1,
		Observer:   observer,
	})
	if !errors.Is(err, errKGContentBlocked) {
		t.Fatalf("err = %v", err)
	}
	if requests != 1 {
		t.Fatalf("requests = %d, want no fallback after guardrail", requests)
	}
	if len(observer.captured()) != 1 {
		t.Fatalf("attempts = %d, want no fallback after guardrail", len(observer.captured()))
	}
}

func TestKGCompletionResponsesSurface(t *testing.T) {
	var body map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/responses" {
			t.Errorf("path = %s", r.URL.Path)
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		_, _ = w.Write([]byte(`{"model":"primary","output_text":"{\"entityId\":\"e1\",\"confidence\":0.7}"}`))
	}))
	defer server.Close()

	completer := NewKGCompleter(fakeGatewaySettings{profiles: profilesJSON(t, server.URL, map[string]any{"apiSurface": "responses"})}, GatewayEnv{})
	result, err := completer.KGComplete(context.Background(), KGCompletionRequest{
		OrgID:      "org",
		Model:      "primary",
		System:     "system",
		User:       "user",
		SchemaName: "kg_entity_disambiguation",
		Schema:     json.RawMessage(KGEntityDisambiguationSchema),
		MaxTokens:  160,
		MaxRetries: 1,
		Metadata:   KGCompletionMetadata{Task: "kg_entity_disambiguation", OrgID: "org"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Content == "" {
		t.Fatal("empty content")
	}
	if body["max_output_tokens"] != float64(160) {
		t.Fatalf("max_output_tokens = %v", body["max_output_tokens"])
	}
	if _, ok := body["messages"]; ok {
		t.Fatal("responses payload must not carry messages")
	}
	input, _ := body["input"].([]any)
	if len(input) != 2 {
		t.Fatalf("input = %v", input)
	}
	text, _ := body["text"].(map[string]any)
	format, _ := text["format"].(map[string]any)
	if format["type"] != "json_schema" {
		t.Fatalf("text.format = %v", text)
	}
}

func TestKGCompletionModels(t *testing.T) {
	completer := NewKGCompleter(fakeGatewaySettings{profiles: profilesJSON(t, "http://127.0.0.1:1", nil)}, GatewayEnv{})
	models, err := completer.KGModels(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(models) != 2 || models[0] != "primary" || models[1] != "fallback" {
		t.Fatalf("models = %v", models)
	}
}

func TestKGCompletionWithoutProfileFails(t *testing.T) {
	completer := NewKGCompleter(fakeGatewaySettings{}, GatewayEnv{})
	_, err := completer.KGComplete(context.Background(), KGCompletionRequest{OrgID: "org", SchemaName: "kg_relation_validation"})
	if err == nil {
		t.Fatal("expected configuration error")
	}
}

func TestKGCompletionTimeoutOverride(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		time.Sleep(100 * time.Millisecond)
		_, _ = w.Write([]byte(`{"model":"primary","choices":[{"message":{"content":"{}"}}]}`))
	}))
	defer server.Close()

	observer := &kgRecordingObserver{}
	completer := NewKGCompleter(fakeGatewaySettings{profiles: profilesJSON(t, server.URL, nil)}, GatewayEnv{TimeoutMs: 60_000})
	_, err := completer.KGComplete(context.Background(), KGCompletionRequest{
		OrgID:      "org",
		Model:      "primary",
		SchemaName: "kg_relation_validation",
		Schema:     json.RawMessage(KGRelationValidationSchema),
		MaxTokens:  120,
		TimeoutMS:  10,
		MaxRetries: 1,
		Observer:   observer,
	})
	if err == nil {
		t.Fatal("expected timeout")
	}
	if len(observer.captured()) != 2 {
		t.Fatalf("attempts = %d, want one per model", len(observer.captured()))
	}
}
