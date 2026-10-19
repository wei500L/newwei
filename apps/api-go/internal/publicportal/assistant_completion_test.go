package publicportal

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type assistantSettingsReader struct {
	profiles   []byte
	governance []byte
}

func (r assistantSettingsReader) GatewaySettings(context.Context) ([]byte, []byte, error) {
	return r.profiles, r.governance, nil
}

type recordingAssistantObserver struct {
	attempts []AssistantAttempt
}

func (o *recordingAssistantObserver) ObserveAssistantAttempt(_ context.Context, attempt AssistantAttempt) {
	o.attempts = append(o.attempts, attempt)
}

func assistantProfileJSON(apiBase, surface string, assistantModel string) []byte {
	return []byte(fmt.Sprintf(`{
		"activeId": "p1",
		"profiles": [{
			"id": "p1",
			"name": "primary",
			"apiBase": %q,
			"model": "model-a",
			"fallbackModels": ["model-b"],
			"assistantModel": %q,
			"assistantWebSearchEnabled": true,
			"timeoutMs": 5000,
			"temperature": 0.3,
			"topP": 0.8,
			"maxOutputTokens": 900,
			"maxRetries": 1,
			"sendMetadata": true,
			"responseFormatMode": "json_schema",
			"apiSurface": %q,
			"enabled": true
		}]
	}`, apiBase, assistantModel, surface))
}

func newAssistantTestClient(t *testing.T, serverURL, surface string, observer AssistantAttemptObserver) AssistantLLM {
	t.Helper()
	return NewAssistantLLM(assistantSettingsReader{profiles: assistantProfileJSON(serverURL, surface, "assistant-model")}, AssistantGatewayEnv{
		GatewayEnv:      GatewayEnv{APIBase: serverURL, TimeoutMs: 5000, MaxRetries: 1, TopP: 0.9},
		Temperature:     0.2,
		MaxOutputTokens: 1200,
	})
}

func TestAssistantCompleteChatPayloadAndLogging(t *testing.T) {
	var received map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			t.Errorf("path = %s", r.URL.Path)
		}
		body, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(body, &received); err != nil {
			t.Errorf("body: %v", err)
		}
		w.Header().Set("content-type", "application/json")
		w.Header().Set("x-litellm-response-cost", "0.25")
		_, _ = w.Write([]byte(`{"id":"c1","model":"model-a","created":1,"choices":[{"index":0,"message":{"role":"assistant","content":"hello"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}`))
	}))
	defer server.Close()
	observer := &recordingAssistantObserver{}
	client := newAssistantTestClient(t, server.URL, "chat_completions", observer)
	result, err := client.Complete(context.Background(), AssistantCompletionRequest{
		OrgID:          "org-1",
		Messages:       []AssistantMessage{{Role: "system", Content: "sys"}, {Role: "user", Content: "hi"}},
		Guardrails:     []string{"openai-moderation-pre"},
		ResponseFormat: json.RawMessage(`{"type":"json_schema","json_schema":{"name":"x","schema":{"type":"object"}}}`),
		Metadata:       AssistantRequestMetadata{OrgID: "org-1", Source: "assistant-planner", Feature: "assistant"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Content != "hello" || result.Model != "model-a" || result.Usage.TotalTokens == nil || *result.Usage.TotalTokens != 15 {
		t.Fatalf("result = %+v", result)
	}
	if result.Usage.CostUSD == nil || *result.Usage.CostUSD != 0.25 {
		t.Fatalf("cost = %v", result.Usage.CostUSD)
	}
	if received["model"] != "assistant-model" {
		t.Fatalf("model = %v", received["model"])
	}
	if received["max_tokens"] != float64(900) || received["temperature"] != 0.3 || received["top_p"] != 0.8 {
		t.Fatalf("sampling = %v %v %v", received["max_tokens"], received["temperature"], received["top_p"])
	}
	guardrails, _ := received["guardrails"].([]any)
	if len(guardrails) != 1 || guardrails[0] != "openai-moderation-pre" {
		t.Fatalf("guardrails = %v", received["guardrails"])
	}
	metadata, _ := received["metadata"].(map[string]any)
	if metadata["feature"] != "assistant" || metadata["source"] != "assistant-planner" || metadata["orgId"] != "org-1" {
		t.Fatalf("metadata = %v", metadata)
	}
	if _, ok := received["response_format"].(map[string]any); !ok {
		t.Fatalf("response_format = %v", received["response_format"])
	}
	if len(observer.attempts) != 1 || !observer.attempts[0].Success || observer.attempts[0].Model != "assistant-model" ||
		observer.attempts[0].GatewayProfileID != "p1" || observer.attempts[0].APISurface != "chat_completions" {
		t.Fatalf("attempts = %+v", observer.attempts)
	}
}

func TestAssistantCompleteFallsBackToNextModel(t *testing.T) {
	var models []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		model, _ := body["model"].(string)
		models = append(models, model)
		w.Header().Set("content-type", "application/json")
		if model == "assistant-model" {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`{"error":{"message":"upstream failed"}}`))
			return
		}
		_, _ = w.Write([]byte(`{"id":"c2","model":"model-b","choices":[{"index":0,"message":{"role":"assistant","content":"fallback"}}],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}`))
	}))
	defer server.Close()
	observer := &recordingAssistantObserver{}
	client := newAssistantTestClient(t, server.URL, "chat_completions", observer)
	result, err := client.Complete(context.Background(), AssistantCompletionRequest{
		OrgID:    "org-1",
		Messages: []AssistantMessage{{Role: "user", Content: "hi"}},
		Metadata: AssistantRequestMetadata{OrgID: "org-1", Source: "assistant", Feature: "assistant"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Content != "fallback" || result.Model != "model-b" {
		t.Fatalf("result = %+v", result)
	}
	if strings.Join(models, ",") != "assistant-model,model-b" {
		t.Fatalf("models = %v", models)
	}
	if len(observer.attempts) != 2 || observer.attempts[0].Success || !observer.attempts[1].Success || observer.attempts[1].ModelIndex != 2 {
		t.Fatalf("attempts = %+v", observer.attempts)
	}
}

func TestAssistantStreamChatDeltas(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			t.Errorf("path = %s", r.URL.Path)
		}
		w.Header().Set("content-type", "text/event-stream")
		flusher, _ := w.(http.Flusher)
		_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"he\"}}],\"model\":\"model-a\"}\n\n")
		if flusher != nil {
			flusher.Flush()
		}
		_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"llo\"}}],\"usage\":{\"prompt_tokens\":2,\"completion_tokens\":3}}\n\n")
		_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer server.Close()
	observer := &recordingAssistantObserver{}
	client := newAssistantTestClient(t, server.URL, "chat_completions", observer)
	events, err := client.Stream(context.Background(), AssistantCompletionRequest{
		OrgID:    "org-1",
		Messages: []AssistantMessage{{Role: "user", Content: "hi"}},
		Metadata: AssistantRequestMetadata{OrgID: "org-1", Source: "assistant-stream", Feature: "assistant"},
		Observer: observer,
	})
	if err != nil {
		t.Fatal(err)
	}
	var deltas []string
	var terminal error
	for event := range events {
		if event.Err != nil {
			terminal = event.Err
			continue
		}
		deltas = append(deltas, event.Delta)
	}
	if terminal != nil {
		t.Fatalf("stream error = %v", terminal)
	}
	if strings.Join(deltas, "") != "hello" {
		t.Fatalf("deltas = %v", deltas)
	}
	if len(observer.attempts) != 1 || !observer.attempts[0].Success || !observer.attempts[0].Streaming {
		t.Fatalf("attempts = %+v", observer.attempts)
	}
	if observer.attempts[0].Usage.TotalTokens == nil || *observer.attempts[0].Usage.TotalTokens != 5 {
		t.Fatalf("usage = %+v", observer.attempts[0].Usage)
	}
}

func TestAssistantResponsesSurfacePayload(t *testing.T) {
	var received map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/responses" {
			t.Errorf("path = %s", r.URL.Path)
		}
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &received)
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"id":"r1","model":"model-a","created_at":1,"output":[{"content":[{"type":"output_text","text":"response text"}]}],"usage":{"input_tokens":4,"output_tokens":6}}`))
	}))
	defer server.Close()
	client := newAssistantTestClient(t, server.URL, "responses", nil)
	result, err := client.Complete(context.Background(), AssistantCompletionRequest{
		OrgID:          "org-1",
		Messages:       []AssistantMessage{{Role: "system", Content: "sys"}, {Role: "user", Content: "hi"}},
		ResponseFormat: json.RawMessage(`{"type":"json_schema","json_schema":{"name":"x","schema":{"type":"object"}}}`),
		Tools:          []json.RawMessage{json.RawMessage(`{"type":"web_search_preview"}`)},
		Metadata:       AssistantRequestMetadata{OrgID: "org-1", Source: "assistant-stream", Feature: "assistant"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Content != "response text" || result.Usage.TotalTokens == nil || *result.Usage.TotalTokens != 10 {
		t.Fatalf("result = %+v", result)
	}
	if received["max_output_tokens"] != float64(900) {
		t.Fatalf("max_output_tokens = %v", received["max_output_tokens"])
	}
	input, _ := received["input"].([]any)
	if len(input) != 2 {
		t.Fatalf("input = %v", received["input"])
	}
	text, _ := received["text"].(map[string]any)
	if _, ok := text["format"].(map[string]any); !ok {
		t.Fatalf("text format = %v", received["text"])
	}
	tools, _ := received["tools"].([]any)
	if len(tools) != 1 {
		t.Fatalf("tools = %v", received["tools"])
	}
}

func TestAssistantGuardrailResponseBecomesTypedError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		w.Header().Set("x-litellm-applied-guardrails", "openai-moderation-pre, openai-moderation-post")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":{"message":"moderation flagged the prompt"}}`))
	}))
	defer server.Close()
	observer := &recordingAssistantObserver{}
	client := newAssistantTestClient(t, server.URL, "chat_completions", observer)
	_, err := client.Complete(context.Background(), AssistantCompletionRequest{
		OrgID:      "org-1",
		Messages:   []AssistantMessage{{Role: "user", Content: "hi"}},
		Guardrails: []string{"openai-moderation-pre"},
		Metadata:   AssistantRequestMetadata{OrgID: "org-1", Source: "assistant", Feature: "assistant"},
	})
	var guardrail *AssistantGuardrailError
	if !errors.As(err, &guardrail) {
		t.Fatalf("error = %v", err)
	}
	if guardrail.Code != "MODERATION_BLOCKED" || len(guardrail.AppliedGuardrails) != 2 || guardrail.UpstreamStatus != 400 {
		t.Fatalf("guardrail = %+v", guardrail)
	}
}

func TestAssistantStreamGuardrailTerminates(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"error":{"message":"blocked by guardrail policy"}}`))
	}))
	defer server.Close()
	client := newAssistantTestClient(t, server.URL, "chat_completions", nil)
	events, err := client.Stream(context.Background(), AssistantCompletionRequest{
		OrgID:      "org-1",
		Messages:   []AssistantMessage{{Role: "user", Content: "hi"}},
		Guardrails: []string{"openai-moderation-pre"},
		Metadata:   AssistantRequestMetadata{OrgID: "org-1", Source: "assistant-stream", Feature: "assistant"},
	})
	if err != nil {
		t.Fatal(err)
	}
	var terminal error
	for event := range events {
		if event.Err != nil {
			terminal = event.Err
		}
	}
	var guardrail *AssistantGuardrailError
	if !errors.As(terminal, &guardrail) || guardrail.Code != "GUARDRAIL_BLOCKED" {
		t.Fatalf("terminal = %v", terminal)
	}
}
