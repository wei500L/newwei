package litellmcompat

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/llmlogs"
)

type capturedLog struct {
	mu      sync.Mutex
	entries []llmlogs.ModelRequestEntry
}

func (c *capturedLog) Write(_ context.Context, entry llmlogs.ModelRequestEntry) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries = append(c.entries, entry)
	return nil
}

func (c *capturedLog) all() []llmlogs.ModelRequestEntry {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]llmlogs.ModelRequestEntry{}, c.entries...)
}

func staticLoader(values map[string]string) SettingLoader {
	return func(_ context.Context, key string) (json.RawMessage, bool, error) {
		value, ok := values[key]
		if !ok {
			return nil, false, nil
		}
		return json.RawMessage(value), true, nil
	}
}

func profileDocument(serverURL string, overrides map[string]any) string {
	profile := map[string]any{
		"id": "profile-1", "name": "Primary", "apiBase": serverURL, "apiKey": "profile-key",
		"model": "primary-model", "embeddingModel": "embed-model", "rerankModel": "rerank-model",
		"enabled": true, "maxRetries": 1, "timeoutMs": 5000,
		"sendMetadata": true, "responseFormatMode": "json_schema", "apiSurface": "chat_completions",
	}
	for key, value := range overrides {
		profile[key] = value
	}
	document := map[string]any{
		"activeId": "profile-1", "embeddingActiveId": "profile-1", "rerankActiveId": "profile-1",
		"profiles": []any{profile},
	}
	encoded, _ := json.Marshal(document)
	return string(encoded)
}

func newTestClient(t *testing.T, serverURL string, overrides map[string]any) (*Client, *capturedLog) {
	t.Helper()
	logs := &capturedLog{}
	loader := staticLoader(map[string]string{
		gatewaySettingsKey:    profileDocument(serverURL, overrides),
		assistantSafetyKey:    `{"enabled":true,"outputModerationEnabled":false}`,
		governanceSettingsKey: `{"enabled":false}`,
	})
	client := NewClient(nil, logs, Config{
		EncryptionKey: "", APIBase: serverURL, Timeout: 5 * time.Second, MaxRetries: 1,
		DefaultModel: "default-model", DefaultTemperature: 0.2, DefaultTopP: 0.9, DefaultMaxOutputTokens: 2048,
		AssistantGuardrailsEnabled: true, AssistantGuardrailsRaw: "openai-moderation-pre",
	}).WithSettingLoader(loader)
	return client, logs
}

func TestCompletionRequestShapeGuardrailsAndLog(t *testing.T) {
	var body map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			t.Errorf("path = %s", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer profile-key" {
			t.Errorf("authorization = %q", got)
		}
		raw, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(raw, &body); err != nil {
			t.Errorf("body: %v", err)
		}
		_, _ = w.Write([]byte(`{"id":"c1","model":"primary-model","choices":[{"message":{"role":"assistant","content":"{\"candidates\":[]}"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}}`))
	}))
	defer server.Close()
	client, logs := newTestClient(t, server.URL, nil)

	temperature := 0.0
	topP := 1.0
	maxTokens := 450
	response, err := client.Completion(context.Background(), CompletionRequest{
		OrgID: "org-1",
		Messages: []Message{
			{Role: "system", Content: "system"},
			{Role: "user", Content: "user"},
		},
		Temperature: &temperature, TopP: &topP, MaxTokens: &maxTokens,
		ResponseFormat: &ResponseFormat{Type: "json_schema", JSONSchema: &JSONSchemaFormat{Name: "s", Schema: json.RawMessage(`{"type":"object"}`)}},
		Metadata:       NewsClassifierMetadata{OrgID: "org-1", JobID: "job-1"},
	})
	if err != nil {
		t.Fatalf("completion: %v", err)
	}
	if response.Content != `{"candidates":[]}` || response.Model != "primary-model" || response.FallbackUsed {
		t.Fatalf("response = %+v", response)
	}
	if body["model"] != "primary-model" || body["temperature"] != 0.0 || body["top_p"] != 1.0 || body["max_tokens"] != 450.0 {
		t.Fatalf("body = %#v", body)
	}
	guardrails, _ := body["guardrails"].([]any)
	if len(guardrails) != 1 || guardrails[0] != "openai-moderation-pre" {
		t.Fatalf("guardrails = %#v", body["guardrails"])
	}
	metadata, _ := body["metadata"].(map[string]any)
	if metadata["source"] != "news-classifier" || metadata["orgId"] != "org-1" || metadata["jobId"] != "job-1" {
		t.Fatalf("metadata = %#v", metadata)
	}
	format, _ := body["response_format"].(map[string]any)
	if format["type"] != "json_schema" {
		t.Fatalf("response_format = %#v", format)
	}
	entries := logs.all()
	if len(entries) != 1 || entries[0].Status != "success" || entries[0].Feature != "news-classifier" {
		t.Fatalf("logs = %+v", entries)
	}
	if entries[0].Usage.TotalTokens == nil || *entries[0].Usage.TotalTokens != 7 {
		t.Fatalf("usage = %+v", entries[0].Usage)
	}
}

func TestCompletionFallsBackAfterRetryableFailure(t *testing.T) {
	var models []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var body map[string]any
		_ = json.Unmarshal(raw, &body)
		model, _ := body["model"].(string)
		models = append(models, model)
		if model == "primary-model" {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`{"error":{"message":"boom"}}`))
			return
		}
		_, _ = w.Write([]byte(`{"model":"backup-model","choices":[{"message":{"role":"assistant","content":"ok"}}]}`))
	}))
	defer server.Close()
	client, logs := newTestClient(t, server.URL, map[string]any{
		"fallbackModels": []string{"backup-model"},
	})
	response, err := client.Completion(context.Background(), CompletionRequest{
		OrgID: "org-1", Messages: []Message{{Role: "user", Content: "hi"}},
	})
	if err != nil {
		t.Fatalf("completion: %v", err)
	}
	if !response.FallbackUsed || response.RequestedModel != "primary-model" || response.Model != "backup-model" {
		t.Fatalf("response = %+v", response)
	}
	if strings.Join(models, ",") != "primary-model,backup-model" {
		t.Fatalf("models = %v", models)
	}
	entries := logs.all()
	if len(entries) != 2 || entries[0].Status != "error" || entries[1].Status != "success" {
		t.Fatalf("logs = %+v", entries)
	}
}

func TestCompletionRetriesSameModel(t *testing.T) {
	attempts := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts++
		if attempts == 1 {
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = w.Write([]byte(`{"error":{"message":"temporary"}}`))
			return
		}
		_, _ = w.Write([]byte(`{"model":"primary-model","choices":[{"message":{"role":"assistant","content":"ok"}}]}`))
	}))
	defer server.Close()
	client, logs := newTestClient(t, server.URL, map[string]any{"maxRetries": 2})
	if _, err := client.Completion(context.Background(), CompletionRequest{
		OrgID: "org-1", Messages: []Message{{Role: "user", Content: "hi"}},
	}); err != nil {
		t.Fatalf("completion: %v", err)
	}
	if attempts != 2 {
		t.Fatalf("attempts = %d", attempts)
	}
	if len(logs.all()) != 2 {
		t.Fatalf("logs = %+v", logs.all())
	}
}

func TestCompletionGuardrailBlockedResponseStopsFallback(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		_, _ = w.Write([]byte(`{"messages":[{"content":"blocked by moderation"}],"choices":[]}`))
	}))
	defer server.Close()
	client, logs := newTestClient(t, server.URL, map[string]any{"fallbackModels": []string{"backup-model"}})
	_, err := client.Completion(context.Background(), CompletionRequest{
		OrgID: "org-1", Messages: []Message{{Role: "user", Content: "hi"}},
	})
	var violation *GuardrailViolationError
	if !errors.As(err, &violation) {
		t.Fatalf("error = %v", err)
	}
	if requests != 1 {
		t.Fatalf("guardrail must not retry/fallback, requests = %d", requests)
	}
	entries := logs.all()
	if len(entries) != 1 || entries[0].Status != "error" {
		t.Fatalf("logs = %+v", entries)
	}
}

func TestCompletionCompatibilityErrorStopsFallback(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		w.WriteHeader(http.StatusNotImplemented)
		_, _ = w.Write([]byte(`{"error":{"message":"metadata is not supported"}}`))
	}))
	defer server.Close()
	client, _ := newTestClient(t, server.URL, map[string]any{"fallbackModels": []string{"backup-model"}})
	_, err := client.Completion(context.Background(), CompletionRequest{
		OrgID: "org-1", Messages: []Message{{Role: "user", Content: "hi"}},
	})
	var compatibility *CompatibilityError
	if !errors.As(err, &compatibility) {
		t.Fatalf("error = %v", err)
	}
	if compatibility.Code != "UNSUPPORTED_METADATA" || requests != 1 {
		t.Fatalf("compatibility = %+v requests=%d", compatibility, requests)
	}
}

func TestCompletionUsesGovernedRuntimeKey(t *testing.T) {
	var authorization string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authorization = r.Header.Get("Authorization")
		_, _ = w.Write([]byte(`{"model":"primary-model","choices":[{"message":{"role":"assistant","content":"ok"}}]}`))
	}))
	defer server.Close()
	logs := &capturedLog{}
	loader := staticLoader(map[string]string{
		gatewaySettingsKey:    profileDocument(server.URL, nil),
		assistantSafetyKey:    `{"enabled":true,"outputModerationEnabled":false}`,
		governanceSettingsKey: `{"enabled":true,"targetProfileId":"profile-1","managedRuntimeKey":"managed-key"}`,
	})
	client := NewClient(nil, logs, Config{APIBase: server.URL, Timeout: 5 * time.Second, MaxRetries: 1, DefaultModel: "default"}).WithSettingLoader(loader)
	if _, err := client.Completion(context.Background(), CompletionRequest{
		OrgID: "org-1", Messages: []Message{{Role: "user", Content: "hi"}},
	}); err != nil {
		t.Fatalf("completion: %v", err)
	}
	if authorization != "Bearer managed-key" {
		t.Fatalf("authorization = %q", authorization)
	}
	entries := logs.all()
	if len(entries) != 1 || entries[0].GovernanceApplied == nil || !*entries[0].GovernanceApplied || entries[0].AuthMode != "managed_runtime_key" {
		t.Fatalf("log = %+v", entries)
	}
}

func TestEmbeddingRequestShapeAndRows(t *testing.T) {
	var body map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/embeddings" {
			t.Errorf("path = %s", r.URL.Path)
		}
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &body)
		_, _ = w.Write([]byte(`{"model":"embed-model","data":[{"index":0,"embedding":[1,0]},{"index":1,"embedding":[0,1]}],"usage":{"prompt_tokens":2,"total_tokens":2}}`))
	}))
	defer server.Close()
	client, logs := newTestClient(t, server.URL, nil)
	response, err := client.Embedding(context.Background(), EmbeddingRequest{
		OrgID: "org-1", Input: []string{"q", "doc"},
		Metadata: ArchiveEmbeddingMetadata{Layer: "embedding", OrgID: "org-1", TaxonomyVersion: "v2", ProcessedArticleIDs: []string{"a1"}},
	})
	if err != nil {
		t.Fatalf("embedding: %v", err)
	}
	if len(response.Rows) != 2 || response.Rows[1].Index != 1 || len(response.Rows[1].Embedding) != 2 {
		t.Fatalf("rows = %+v", response.Rows)
	}
	if body["model"] != "embed-model" {
		t.Fatalf("body = %#v", body)
	}
	metadata, _ := body["metadata"].(map[string]any)
	if metadata["source"] != "archive-classification" || metadata["layer"] != "embedding" || metadata["taxonomyVersion"] != "v2" {
		t.Fatalf("metadata = %#v", metadata)
	}
	if len(logs.all()) != 1 || logs.all()[0].APISurface != "embeddings" {
		t.Fatalf("logs = %+v", logs.all())
	}
}

func TestRerankRequestShapeAndScoreOrder(t *testing.T) {
	var body map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/rerank" {
			t.Errorf("path = %s", r.URL.Path)
		}
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &body)
		_, _ = w.Write([]byte(`{"model":"rerank-model","results":[{"index":0,"relevance_score":0.2},{"index":1,"relevance_score":0.9}]}`))
	}))
	defer server.Close()
	client, logs := newTestClient(t, server.URL, nil)
	response, err := client.Rerank(context.Background(), RerankRequest{
		OrgID: "org-1", Query: "q", Documents: []string{"a", "b"}, TopN: 2,
		Metadata: ArchiveRerankMetadata{Layer: "rerank", OrgID: "org-1", TaxonomyVersion: "v2", ProcessedArticleID: "p", ArticleID: "a"},
	})
	if err != nil {
		t.Fatalf("rerank: %v", err)
	}
	if len(response.Results) != 2 || response.Results[0].Index != 1 || response.Results[0].Score != 0.9 {
		t.Fatalf("results = %+v", response.Results)
	}
	if body["top_n"] != 2.0 {
		t.Fatalf("top_n = %#v", body["top_n"])
	}
	if len(logs.all()) != 1 || logs.all()[0].APISurface != "rerank" {
		t.Fatalf("logs = %+v", logs.all())
	}
}
