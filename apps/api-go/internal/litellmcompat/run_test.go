package litellmcompat

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// countingServer records every requested model.
type countingServer struct {
	mu     sync.Mutex
	models []string
}

func (s *countingServer) record(r *http.Request) string {
	var body struct {
		Model string `json:"model"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	s.mu.Lock()
	s.models = append(s.models, body.Model)
	s.mu.Unlock()
	return body.Model
}

func (s *countingServer) calls() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.models...)
}

func runTestProfile(base string) Profile {
	return Profile{
		ID:             "p1",
		APIBase:        base,
		APIKey:         "key",
		Model:          "m1",
		FallbackModels: []string{"m2"},
		Timeout:        5 * time.Second,
		MaxRetries:     1,
		TopP:           0.9,
	}
}

func simpleBuild(model string) ([]byte, string, string, error) {
	body, err := json.Marshal(map[string]any{"model": model})
	return body, "/v1/chat/completions", "/chat/completions", err
}

func TestRunCompletionDisableFallbackStopsAfterPrimary(t *testing.T) {
	counter := &countingServer{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		counter.record(r)
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()

	client := NewSettingsClient(nil, nil, Config{}).WithHTTP(&http.Client{})
	plan := CompletionPlan{
		Models:          []string{"m1", "m2"},
		MaxRetries:      1,
		DisableFallback: true,
		Build:           simpleBuild,
		Parse: func(status int, header http.Header, raw []byte, model string) (CompletionResponse, error) {
			if status >= 300 {
				return CompletionResponse{}, errors.New("boom")
			}
			return CompletionResponse{Content: "ok", Model: model}, nil
		},
	}
	if _, err := client.RunCompletion(context.Background(), runTestProfile(server.URL), plan); err == nil {
		t.Fatal("expected an error")
	}
	if calls := counter.calls(); len(calls) != 1 || calls[0] != "m1" {
		t.Fatalf("calls = %v, want only the primary", calls)
	}
}

func TestRunCompletionObserverUsageAndHeaderCost(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("x-litellm-response-cost", "0.5")
		_, _ = w.Write([]byte(`{"usage":{"prompt_tokens":3,"completion_tokens":4}}`))
	}))
	defer server.Close()

	observer := &recordingAttemptObserver{}
	client := NewSettingsClient(nil, nil, Config{}).WithHTTP(&http.Client{})
	plan := CompletionPlan{
		Models:     []string{"m1"},
		MaxRetries: 1,
		Build:      simpleBuild,
		Parse: func(status int, header http.Header, raw []byte, model string) (CompletionResponse, error) {
			var doc struct {
				Usage struct {
					PromptTokens     *float64 `json:"prompt_tokens"`
					CompletionTokens *float64 `json:"completion_tokens"`
				} `json:"usage"`
			}
			_ = json.Unmarshal(raw, &doc)
			usage := Usage{PromptTokens: doc.Usage.PromptTokens, CompletionTokens: doc.Usage.CompletionTokens}
			if usage.PromptTokens != nil && usage.CompletionTokens != nil {
				total := *usage.PromptTokens + *usage.CompletionTokens
				usage.TotalTokens = &total
			}
			if rawCost := strings.TrimSpace(header.Get("x-litellm-response-cost")); rawCost != "" {
				if parsed, err := strconv.ParseFloat(rawCost, 64); err == nil {
					usage.CostUSD = &parsed
				}
			}
			return CompletionResponse{Content: "ok", Model: model, Usage: usage}, nil
		},
		Observer: observer,
	}
	if _, err := client.RunCompletion(context.Background(), runTestProfile(server.URL), plan); err != nil {
		t.Fatal(err)
	}
	if len(observer.attempts) != 1 {
		t.Fatalf("attempts = %d", len(observer.attempts))
	}
	attempt := observer.attempts[0]
	if !attempt.Success || attempt.ModelIndex != 1 {
		t.Fatalf("attempt = %+v", attempt)
	}
	if attempt.Usage.PromptTokens == nil || *attempt.Usage.PromptTokens != 3 {
		t.Fatalf("prompt = %v", attempt.Usage.PromptTokens)
	}
	if attempt.Usage.TotalTokens == nil || *attempt.Usage.TotalTokens != 7 {
		t.Fatalf("total = %v", attempt.Usage.TotalTokens)
	}
	if attempt.Usage.CostUSD == nil || *attempt.Usage.CostUSD != 0.5 {
		t.Fatalf("cost = %v", attempt.Usage.CostUSD)
	}
}

func TestRunCompletionStopErrorHaltsChainAndRetries(t *testing.T) {
	sentinel := errors.New("guardrail block")
	counter := &countingServer{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		counter.record(r)
		_, _ = w.Write([]byte(`{}`))
	}))
	defer server.Close()

	client := NewSettingsClient(nil, nil, Config{}).WithHTTP(&http.Client{})
	plan := CompletionPlan{
		Models:     []string{"m1", "m2"},
		MaxRetries: 3,
		Build:      simpleBuild,
		Parse: func(int, http.Header, []byte, string) (CompletionResponse, error) {
			return CompletionResponse{}, sentinel
		},
		Stop: func(err error) bool { return errors.Is(err, sentinel) },
	}
	_, err := client.RunCompletion(context.Background(), runTestProfile(server.URL), plan)
	if !errors.Is(err, sentinel) {
		t.Fatalf("err = %v", err)
	}
	if calls := counter.calls(); len(calls) != 1 {
		t.Fatalf("calls = %v, want the chain to stop after the first fatal error", calls)
	}
}

type recordingAttemptObserver struct {
	attempts []Attempt
}

func (o *recordingAttemptObserver) ObserveAttempt(_ context.Context, attempt Attempt) {
	o.attempts = append(o.attempts, attempt)
}
