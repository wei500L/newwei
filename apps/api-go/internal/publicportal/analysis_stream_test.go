package publicportal

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type staticSettings struct {
	profiles   []byte
	governance []byte
}

func (s staticSettings) GatewaySettings(context.Context) ([]byte, []byte, error) {
	return s.profiles, s.governance, nil
}

func profileJSON(baseURL, surface string, fallback []string) []byte {
	profile := map[string]any{
		"id":             "p1",
		"model":          "primary",
		"apiBase":        baseURL,
		"apiKey":         "test-key",
		"apiSurface":     surface,
		"fallbackModels": fallback,
	}
	encoded, _ := json.Marshal(map[string]any{
		"activeId": "p1",
		"profiles": []any{profile},
	})
	return encoded
}

func streamRequest(chunks *[]AnalysisStreamChunk) AnalysisStreamRequest {
	return AnalysisStreamRequest{
		OrgID:   "org-1",
		Timeout: 2 * time.Second,
		Messages: []AnalysisMessage{
			{Role: "system", Content: "system"},
			{Role: "user", Content: "user"},
		},
		OnChunk: func(chunk AnalysisStreamChunk) error {
			*chunks = append(*chunks, chunk)
			return nil
		},
	}
}

func TestAnalysisStreamChatSurfaceHandlesSplitUTF8AndCRLF(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		flusher := w.(http.Flusher)
		frames := "data: {\"choices\":[{\"delta\":{\"content\":\"你\"}}]}\r\n\r\n" +
			"data: {\"choices\":[{\"delta\":{\"content\":\"好\"},\"finish_reason\":\"stop\"}]}\r\n\r\n" +
			"data: [DONE]\r\n\r\n"
		// Split in the middle of the UTF-8 sequence for 你 and inside a frame.
		bytes := []byte(frames)
		split := strings.Index(frames, "你") + 1
		_, _ = w.Write(bytes[:split])
		flusher.Flush()
		_, _ = w.Write(bytes[split:])
		flusher.Flush()
	}))
	defer server.Close()

	streamer := NewAnalysisStreamer(staticSettings{profiles: profileJSON(server.URL, "chat_completions", nil)}, GatewayEnv{})
	var chunks []AnalysisStreamChunk
	request := streamRequest(&chunks)
	result, err := streamer.StreamAnalysis(context.Background(), request)
	if err != nil {
		t.Fatalf("stream: %v", err)
	}
	if result.Model != "primary" {
		t.Fatalf("model = %q", result.Model)
	}
	if len(chunks) != 2 || chunks[0].Delta != "你" || chunks[1].Delta != "好" {
		t.Fatalf("chunks = %+v", chunks)
	}
	if chunks[1].FinishReason != "stop" {
		t.Fatalf("finish reason = %q", chunks[1].FinishReason)
	}
}

func TestAnalysisStreamResponsesSurfaceFallsBackToShortPath(t *testing.T) {
	var longPathCalls atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/responses":
			longPathCalls.Add(1)
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"error":{"message":"not found"}}`))
		case "/responses":
			w.Header().Set("Content-Type", "text/event-stream")
			fmt.Fprint(w, "data: {\"type\":\"response.output_text.delta\",\"delta\":\"hello\"}\n\n")
			fmt.Fprint(w, "data: {\"type\":\"response.completed\"}\n\n")
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	streamer := NewAnalysisStreamer(staticSettings{profiles: profileJSON(server.URL, "responses", nil)}, GatewayEnv{})
	var chunks []AnalysisStreamChunk
	request := streamRequest(&chunks)
	if _, err := streamer.StreamAnalysis(context.Background(), request); err != nil {
		t.Fatalf("stream: %v", err)
	}
	if longPathCalls.Load() != 1 {
		t.Fatalf("primary path calls = %d", longPathCalls.Load())
	}
	if len(chunks) != 2 || chunks[0].Delta != "hello" || chunks[1].FinishReason != "stop" {
		t.Fatalf("chunks = %+v", chunks)
	}
}

func TestAnalysisStreamFallsBackOnlyBeforeFirstChunk(t *testing.T) {
	var primaryCalls atomic.Int64
	var fallbackCalls atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload struct {
			Model string `json:"model"`
		}
		_ = json.NewDecoder(r.Body).Decode(&payload)
		if payload.Model == "primary" {
			primaryCalls.Add(1)
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`{"error":{"message":"primary down"}}`))
			return
		}
		fallbackCalls.Add(1)
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"fallback\"}}]}\n\n")
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer server.Close()

	streamer := NewAnalysisStreamer(staticSettings{profiles: profileJSON(server.URL, "chat_completions", []string{"fallback"})}, GatewayEnv{})
	var chunks []AnalysisStreamChunk
	request := streamRequest(&chunks)
	result, err := streamer.StreamAnalysis(context.Background(), request)
	if err != nil {
		t.Fatalf("stream: %v", err)
	}
	if result.Model != "fallback" || primaryCalls.Load() != 1 || fallbackCalls.Load() != 1 {
		t.Fatalf("model=%q primary=%d fallback=%d", result.Model, primaryCalls.Load(), fallbackCalls.Load())
	}
	if len(chunks) != 1 || chunks[0].Delta != "fallback" {
		t.Fatalf("chunks = %+v", chunks)
	}
}

func TestAnalysisStreamDoesNotSpliceModelsAfterFirstChunk(t *testing.T) {
	var primaryCalls atomic.Int64
	var fallbackCalls atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload struct {
			Model string `json:"model"`
		}
		_ = json.NewDecoder(r.Body).Decode(&payload)
		if payload.Model == "primary" {
			primaryCalls.Add(1)
			w.Header().Set("Content-Type", "text/event-stream")
			fmt.Fprint(w, "data: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n")
			fmt.Fprint(w, "data: {\"type\":\"response.error\",\"error\":{\"message\":\"upstream broke\"}}\n\n")
			return
		}
		fallbackCalls.Add(1)
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"type\":\"response.output_text.delta\",\"delta\":\"other\"}\n\n")
		fmt.Fprint(w, "data: {\"type\":\"response.completed\"}\n\n")
	}))
	defer server.Close()

	streamer := NewAnalysisStreamer(staticSettings{profiles: profileJSON(server.URL, "responses", []string{"fallback"})}, GatewayEnv{})
	var chunks []AnalysisStreamChunk
	request := streamRequest(&chunks)
	_, err := streamer.StreamAnalysis(context.Background(), request)
	if err == nil {
		t.Fatal("stream should fail after a yielded chunk")
	}
	if primaryCalls.Load() != 1 || fallbackCalls.Load() != 0 {
		t.Fatalf("primary=%d fallback=%d; fallback must not run after a chunk", primaryCalls.Load(), fallbackCalls.Load())
	}
	if len(chunks) != 1 || chunks[0].Delta != "partial" {
		t.Fatalf("chunks = %+v", chunks)
	}
}

func TestAnalysisStreamStopsOnGuardrailBody(t *testing.T) {
	var fallbackCalls atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload struct {
			Model string `json:"model"`
		}
		_ = json.NewDecoder(r.Body).Decode(&payload)
		if payload.Model == "primary" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"messages":[{"content":"blocked by policy"}]}`))
			return
		}
		fallbackCalls.Add(1)
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer server.Close()

	streamer := NewAnalysisStreamer(staticSettings{profiles: profileJSON(server.URL, "chat_completions", []string{"fallback"})}, GatewayEnv{})
	var chunks []AnalysisStreamChunk
	request := streamRequest(&chunks)
	_, err := streamer.StreamAnalysis(context.Background(), request)
	if err == nil {
		t.Fatal("guardrail body should fail")
	}
	var guardrail *AnalysisGuardrailError
	if !errors.As(err, &guardrail) {
		t.Fatalf("error = %T %v, want AnalysisGuardrailError", err, err)
	}
	if fallbackCalls.Load() != 0 {
		t.Fatal("guardrail refusal must stop the fallback chain")
	}
}

func TestAnalysisStreamNonSSEBodyIsNotTreatedAsSuccess(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"whole json"}}]}`))
	}))
	defer server.Close()

	streamer := NewAnalysisStreamer(staticSettings{profiles: profileJSON(server.URL, "chat_completions", nil)}, GatewayEnv{})
	var chunks []AnalysisStreamChunk
	request := streamRequest(&chunks)
	if _, err := streamer.StreamAnalysis(context.Background(), request); err == nil {
		t.Fatal("a whole JSON response must not be reported as a successful SSE stream")
	}
	if len(chunks) != 0 {
		t.Fatalf("chunks = %+v, want none", chunks)
	}
}

func TestAnalysisStreamObserverSeesOneAttemptPerModel(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload struct {
			Model string `json:"model"`
		}
		_ = json.NewDecoder(r.Body).Decode(&payload)
		if payload.Model == "primary" {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\n")
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer server.Close()

	observer := &analysisRecordingObserver{}
	streamer := NewAnalysisStreamer(staticSettings{profiles: profileJSON(server.URL, "chat_completions", []string{"fallback"})}, GatewayEnv{})
	var chunks []AnalysisStreamChunk
	request := streamRequest(&chunks)
	request.Observer = observer
	if _, err := streamer.StreamAnalysis(context.Background(), request); err != nil {
		t.Fatalf("stream: %v", err)
	}
	if len(observer.attempts) != 2 {
		t.Fatalf("observer attempts = %d, want 2", len(observer.attempts))
	}
	if observer.attempts[0].Success || !observer.attempts[1].Success {
		t.Fatalf("attempt outcomes = %+v", observer.attempts)
	}
	if observer.attempts[0].Model != "primary" || observer.attempts[1].Model != "fallback" {
		t.Fatalf("attempt models = %+v", observer.attempts)
	}
}

type analysisRecordingObserver struct {
	attempts []AnalysisStreamAttempt
}

func (o *analysisRecordingObserver) ObserveAnalysisStreamAttempt(_ context.Context, attempt AnalysisStreamAttempt) {
	o.attempts = append(o.attempts, attempt)
}
