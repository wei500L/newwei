package litellmcompat

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/wei500L/newwei/apps/api-go/internal/metrics"
)

// litellmFallbackCount returns the integration_events_total value for one
// operation/status pair, so a test can assert an exact delta on the shared
// process registry.
func litellmFallbackCount(t *testing.T, operation, status string) float64 {
	t.Helper()
	for _, line := range strings.Split(metrics.Render(), "\n") {
		if !strings.HasPrefix(line, "integration_events_total{") {
			continue
		}
		if !strings.Contains(line, `integration="litellm"`) ||
			!strings.Contains(line, `operation="`+operation+`"`) ||
			!strings.Contains(line, `status="`+status+`"`) {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) != 2 {
			t.Fatalf("unexpected exposition line %q", line)
		}
		value, err := strconv.ParseFloat(fields[1], 64)
		if err != nil {
			t.Fatalf("parse %q: %v", line, err)
		}
		return value
	}
	return 0
}

// fallbackServer fails the primary model and answers the backup, which is the
// trigger for recordModelFallbackOrWarn's counted branch.
func fallbackServer(t *testing.T, primary string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var body map[string]any
		_ = json.Unmarshal(raw, &body)
		if body["model"] == primary {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`{"error":{"message":"boom"}}`))
			return
		}
		_, _ = w.Write([]byte(`{"model":"backup-model","choices":[{"message":{"role":"assistant","content":"ok"}}]}`))
	}))
}

// TestCompletionFallbackRecordsTheFallbackEvent proves the production completion
// path emits integration_events_total{integration="litellm",
// operation="completion_fallback", status="fallback"} exactly once, and that a
// successful request records nothing.
func TestCompletionFallbackRecordsTheFallbackEvent(t *testing.T) {
	// A successful request first: no fallback happened, so nothing is counted.
	okServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"id":"c1","model":"primary-model","choices":[{"message":{"role":"assistant","content":"ok"}}]}`))
	}))
	defer okServer.Close()
	okClient, _ := newTestClient(t, okServer.URL, nil)
	beforeOK := litellmFallbackCount(t, metrics.OperationCompletionFallback, metrics.IntegrationStatusFallback)
	if _, err := okClient.Completion(context.Background(), CompletionRequest{OrgID: "org-1"}); err != nil {
		t.Fatalf("completion: %v", err)
	}
	if after := litellmFallbackCount(t, metrics.OperationCompletionFallback, metrics.IntegrationStatusFallback); after != beforeOK {
		t.Fatalf("a successful completion recorded a fallback: %v -> %v", beforeOK, after)
	}

	// The failing primary with a backup records exactly one fallback.
	server := fallbackServer(t, "primary-model")
	defer server.Close()
	client, _ := newTestClient(t, server.URL, map[string]any{"fallbackModels": []string{"backup-model"}})
	before := litellmFallbackCount(t, metrics.OperationCompletionFallback, metrics.IntegrationStatusFallback)
	response, err := client.Completion(context.Background(), CompletionRequest{OrgID: "org-1"})
	if err != nil {
		t.Fatalf("completion: %v", err)
	}
	if !response.FallbackUsed {
		t.Fatalf("response did not report a fallback: %+v", response)
	}
	after := litellmFallbackCount(t, metrics.OperationCompletionFallback, metrics.IntegrationStatusFallback)
	if after != before+1 {
		t.Fatalf("fallback counter went %v -> %v, want exactly one sample", before, after)
	}
}

// TestExhaustedModelsAreNotCountedAsFallback proves the boundary the NestJS
// exhausted branch draws: with no next model there is no fallback, so only the log
// happens and no counter moves.
func TestExhaustedModelsAreNotCountedAsFallback(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":{"message":"boom"}}`))
	}))
	defer server.Close()
	client, _ := newTestClient(t, server.URL, nil)
	before := litellmFallbackCount(t, metrics.OperationCompletionFallback, metrics.IntegrationStatusFallback)
	if _, err := client.Completion(context.Background(), CompletionRequest{OrgID: "org-1"}); err == nil {
		t.Fatal("a single failing model returned no error")
	}
	if after := litellmFallbackCount(t, metrics.OperationCompletionFallback, metrics.IntegrationStatusFallback); after != before {
		t.Fatalf("an exhausted model list recorded a fallback: %v -> %v", before, after)
	}
}

// TestResponsesSurfaceRecordsItsOwnOperationName proves the completion fallback
// operation follows the gateway request shape, matching acompletion's two branches.
func TestResponsesSurfaceRecordsItsOwnOperationName(t *testing.T) {
	// The Responses surface needs its own response shape; only the failure that
	// triggers the fallback matters here.
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var body map[string]any
		_ = json.Unmarshal(raw, &body)
		if body["model"] == "primary-model" {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`{"error":{"message":"boom"}}`))
			return
		}
		_, _ = w.Write([]byte(`{"id":"r1","model":"backup-model","output":[{"type":"message","content":[{"type":"output_text","text":"ok"}]}]}`))
	}))
	defer server.Close()
	client, _ := newTestClient(t, server.URL, map[string]any{
		"apiSurface":     "responses",
		"fallbackModels": []string{"backup-model"},
	})
	before := litellmFallbackCount(t, metrics.OperationResponsesFallback, metrics.IntegrationStatusFallback)
	chatBefore := litellmFallbackCount(t, metrics.OperationCompletionFallback, metrics.IntegrationStatusFallback)
	_, _ = client.Completion(context.Background(), CompletionRequest{OrgID: "org-1"})
	after := litellmFallbackCount(t, metrics.OperationResponsesFallback, metrics.IntegrationStatusFallback)
	if after != before+1 {
		t.Fatalf("responses_fallback counter went %v -> %v, want one sample", before, after)
	}
	// The chat-completions operation name must not have moved for a Responses call.
	if chatAfter := litellmFallbackCount(t, metrics.OperationCompletionFallback, metrics.IntegrationStatusFallback); chatAfter != chatBefore {
		t.Fatalf("completion_fallback counter changed %v -> %v on a Responses call", chatBefore, chatAfter)
	}
}

// TestRerankFallbackRecordsItsOwnOperationName proves the rerank loop emits
// rerank_fallback, not the completion name.
func TestRerankFallbackRecordsItsOwnOperationName(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var body map[string]any
		_ = json.Unmarshal(raw, &body)
		if body["model"] == "rerank-model" {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`{"error":{"message":"boom"}}`))
			return
		}
		_, _ = w.Write([]byte(`{"model":"backup-rerank","results":[{"index":0,"relevance_score":0.9}]}`))
	}))
	defer server.Close()
	client, _ := newTestClient(t, server.URL, map[string]any{
		"rerankFallbackModels": []string{"backup-rerank"},
	})
	before := litellmFallbackCount(t, metrics.OperationRerankFallback, metrics.IntegrationStatusFallback)
	if _, err := client.Rerank(context.Background(), RerankRequest{
		OrgID:     "org-1",
		Query:     "q",
		Documents: []string{"d"},
	}); err != nil {
		t.Fatalf("rerank: %v", err)
	}
	after := litellmFallbackCount(t, metrics.OperationRerankFallback, metrics.IntegrationStatusFallback)
	if after != before+1 {
		t.Fatalf("rerank_fallback counter went %v -> %v, want one sample", before, after)
	}
}
