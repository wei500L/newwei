package litellmcompat

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func streamTestProfile(base string, surface APISurface) Profile {
	profile := runTestProfile(base)
	profile.APISurface = surface
	return profile
}

func streamBuild(model string) ([]byte, string, string, error) {
	body, err := json.Marshal(map[string]any{"model": model})
	if err != nil {
		return nil, "", "", err
	}
	primary, fallback := "/v1/chat/completions", "/chat/completions"
	return body, primary, fallback, nil
}

func collectEvents(target *[]string) func(StreamEvent) error {
	return func(event StreamEvent) error {
		if event.Delta != "" {
			*target = append(*target, event.Delta)
		}
		return nil
	}
}

func TestCompletionStreamDisableFallbackStopsAfterPrimary(t *testing.T) {
	counter := &countingServer{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		counter.record(r)
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()

	client := NewSettingsClient(nil, nil, Config{}).WithHTTP(&http.Client{})
	plan := StreamPlan{
		Models:          []string{"m1", "m2"},
		MaxRetries:      1,
		DisableFallback: true,
		Build:           streamBuild,
		ClassifyStatus: func(_ Profile, _ string, _ int, _ http.Header, _ []byte) error {
			return errors.New("boom")
		},
		ClassifyNonSSE: func(Profile, string, int, http.Header, []byte) error { return errors.New("nonsse") },
	}
	if _, err := client.CompletionStream(context.Background(), streamTestProfile(server.URL, APISurfaceChat), plan); err == nil {
		t.Fatal("expected an error")
	}
	if calls := counter.calls(); len(calls) != 1 || calls[0] != "m1" {
		t.Fatalf("calls = %v, want only the primary", calls)
	}
}

func TestCompletionStreamFallsBackBeforeFirstEvent(t *testing.T) {
	counter := &countingServer{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		model := counter.record(r)
		if model == "m1" {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"fallback\"}}]}\n\n")
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer server.Close()

	var deltas []string
	client := NewSettingsClient(nil, nil, Config{}).WithHTTP(&http.Client{})
	plan := StreamPlan{
		Models:     []string{"m1", "m2"},
		MaxRetries: 1,
		Build:      streamBuild,
		ClassifyStatus: func(_ Profile, _ string, _ int, _ http.Header, _ []byte) error {
			return errors.New("boom")
		},
		ClassifyNonSSE: func(Profile, string, int, http.Header, []byte) error { return errors.New("nonsse") },
		OnEvent:        collectEvents(&deltas),
	}
	result, err := client.CompletionStream(context.Background(), streamTestProfile(server.URL, APISurfaceChat), plan)
	if err != nil {
		t.Fatalf("stream: %v", err)
	}
	if result.Model != "m2" || len(deltas) != 1 || deltas[0] != "fallback" {
		t.Fatalf("result=%+v deltas=%v", result, deltas)
	}
	if calls := counter.calls(); len(calls) != 2 {
		t.Fatalf("calls = %v", calls)
	}
}

func TestCompletionStreamNoFallbackAfterOutput(t *testing.T) {
	counter := &countingServer{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		counter.record(r)
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n")
		fmt.Fprint(w, "data: {\"type\":\"response.error\",\"error\":{\"message\":\"upstream broke\"}}\n\n")
	}))
	defer server.Close()

	var deltas []string
	client := NewSettingsClient(nil, nil, Config{}).WithHTTP(&http.Client{})
	plan := StreamPlan{
		Models:     []string{"m1", "m2"},
		MaxRetries: 1,
		Build:      streamBuild,
		ClassifyStatus: func(_ Profile, _ string, _ int, _ http.Header, _ []byte) error {
			return errors.New("boom")
		},
		ClassifyNonSSE: func(Profile, string, int, http.Header, []byte) error { return errors.New("nonsse") },
		OnEvent:        collectEvents(&deltas),
	}
	if _, err := client.CompletionStream(context.Background(), streamTestProfile(server.URL, APISurfaceResponses), plan); err == nil {
		t.Fatal("stream should fail after a yielded chunk")
	}
	if calls := counter.calls(); len(calls) != 1 {
		t.Fatalf("calls = %v, want no fallback after output", calls)
	}
	if len(deltas) != 1 || deltas[0] != "partial" {
		t.Fatalf("deltas = %v", deltas)
	}
}

func TestCompletionStreamStopErrorHaltsFallback(t *testing.T) {
	sentinel := errors.New("guardrail block")
	counter := &countingServer{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		counter.record(r)
		w.WriteHeader(http.StatusForbidden)
	}))
	defer server.Close()

	client := NewSettingsClient(nil, nil, Config{}).WithHTTP(&http.Client{})
	plan := StreamPlan{
		Models:     []string{"m1", "m2"},
		MaxRetries: 1,
		Build:      streamBuild,
		ClassifyStatus: func(Profile, string, int, http.Header, []byte) error {
			return sentinel
		},
		ClassifyNonSSE: func(Profile, string, int, http.Header, []byte) error { return errors.New("nonsse") },
		Stop:           func(err error) bool { return errors.Is(err, sentinel) },
	}
	_, err := client.CompletionStream(context.Background(), streamTestProfile(server.URL, APISurfaceChat), plan)
	if !errors.Is(err, sentinel) {
		t.Fatalf("err = %v", err)
	}
	if calls := counter.calls(); len(calls) != 1 {
		t.Fatalf("calls = %v, want the guardrail to stop the chain", calls)
	}
}

func TestCompletionStreamObserverUsageAndCost(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("x-litellm-response-cost", "0.25")
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"a\"}}],\"usage\":{\"prompt_tokens\":2,\"completion_tokens\":3}}\n\n")
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer server.Close()

	var deltas []string
	observer := &recordingAttemptObserver{}
	client := NewSettingsClient(nil, nil, Config{}).WithHTTP(&http.Client{})
	plan := StreamPlan{
		Models:          []string{"m1"},
		MaxRetries:      1,
		Build:           streamBuild,
		ClassifyStatus:  func(Profile, string, int, http.Header, []byte) error { return errors.New("boom") },
		ClassifyNonSSE:  func(Profile, string, int, http.Header, []byte) error { return errors.New("nonsse") },
		OnEvent:         collectEvents(&deltas),
		Observer:        observer,
		ApplyCostHeader: true,
	}
	if _, err := client.CompletionStream(context.Background(), streamTestProfile(server.URL, APISurfaceChat), plan); err != nil {
		t.Fatalf("stream: %v", err)
	}
	if len(observer.attempts) != 1 {
		t.Fatalf("attempts = %d", len(observer.attempts))
	}
	attempt := observer.attempts[0]
	if !attempt.Success || attempt.Usage.TotalTokens == nil || *attempt.Usage.TotalTokens != 5 {
		t.Fatalf("attempt usage = %+v", attempt.Usage)
	}
	if attempt.Usage.CostUSD == nil || *attempt.Usage.CostUSD != 0.25 {
		t.Fatalf("cost = %v", attempt.Usage.CostUSD)
	}
	if len(deltas) != 1 || deltas[0] != "a" {
		t.Fatalf("deltas = %v", deltas)
	}
}

func TestCompletionStreamStopsOnContextCancel(t *testing.T) {
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		flusher, _ := w.(http.Flusher)
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"a\"}}]}\n\n")
		if flusher != nil {
			flusher.Flush()
		}
		select {
		case <-r.Context().Done():
		case <-release:
		}
	}))
	defer server.Close()
	defer close(release)

	ctx, cancel := context.WithCancel(context.Background())
	client := NewSettingsClient(nil, nil, Config{}).WithHTTP(&http.Client{})
	plan := StreamPlan{
		Models:         []string{"m1"},
		MaxRetries:     1,
		Build:          streamBuild,
		ClassifyStatus: func(Profile, string, int, http.Header, []byte) error { return errors.New("boom") },
		ClassifyNonSSE: func(Profile, string, int, http.Header, []byte) error { return errors.New("nonsse") },
		OnEvent: func(StreamEvent) error {
			cancel()
			return nil
		},
	}
	done := make(chan error, 1)
	go func() {
		_, err := client.CompletionStream(ctx, streamTestProfile(server.URL, APISurfaceChat), plan)
		done <- err
	}()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("err = %v, want context.Canceled", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("CompletionStream did not stop after context cancellation")
	}
}
