package crawlfrontierllm

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func testClient(t *testing.T, server *httptest.Server) *LLMClient {
	t.Helper()
	profile := gatewayProfile{
		ID: "profile-1", APIBase: server.URL,
		Model: "primary", FallbackModels: []string{"fallback"},
		RerankModel: "reranker", RerankFallbacks: []string{"reranker-fallback"},
		Timeout: 5 * time.Second, MaxRetries: 1, SendMetadata: true,
		ResponseFormatMode: "json_schema", APISurface: "chat_completions", TopP: 0.9,
	}
	return NewLLMClient(LLMClientOptions{
		Now: time.Now,
		ResolveProfile: func(ctx context.Context, kind string) (gatewayProfile, error) {
			return profile, nil
		},
	})
}

func judgeInput() JudgeInput {
	config, _ := ParseObject([]byte(`{"llmAssist":{"enabled":true},"urlPatterns":{},"pageTypeSignals":{},"priorityKeywords":["news"],"keywords":["world"]}`))
	return JudgeInput{
		OrgID: "org-1", RunID: "run-1", NodeID: "node-1", ProfileID: stringPointer("profile-1"),
		SeedURL: "https://example.com", ParentURL: "https://example.com/news",
		ParentPageType: "list", Config: config,
		Candidates: []Candidate{
			{URL: "https://example.com/a", PageType: "article", Score: 0.5, FreshnessScore: 1, Metadata: json.RawMessage(`{}`)},
			{URL: "https://example.com/b", PageType: "article", Score: 0.4, FreshnessScore: 0.75, Metadata: json.RawMessage(`{"linkText":"B"}`)},
			{URL: "https://example.com/c", PageType: "category", Score: 0.3, FreshnessScore: 0.4, Metadata: json.RawMessage(`{}`)},
		},
	}
}

func TestJudgeRequestShapeAndDecisions(t *testing.T) {
	var captured map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/rerank", "/rerank":
			http.NotFound(w, r)
		case "/v1/chat/completions":
			if err := json.NewDecoder(r.Body).Decode(&captured); err != nil {
				t.Errorf("decode payload: %v", err)
			}
			content := `{"decisions":[{"url":"https://example.com/a","action":"drop","pageType":"article","confidence":0.9},{"url":"https://example.com/c","action":"expand","pageType":"list","confidence":0.8,"reason":"hub"}],"rationale":"ok"}`
			response := map[string]any{
				"model":   "primary",
				"choices": []any{map[string]any{"message": map[string]any{"role": "assistant", "content": content}}},
				"usage":   map[string]any{"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
			}
			_ = json.NewEncoder(w).Encode(response)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	client := testClient(t, server)
	result, err := client.JudgeCandidates(context.Background(), judgeInput())
	if err != nil {
		t.Fatalf("JudgeCandidates error = %v", err)
	}
	if captured["model"] != "primary" || captured["temperature"] != 0.1 || captured["max_tokens"] != float64(1600) {
		t.Fatalf("payload = %v", captured)
	}
	if captured["top_p"] != 0.9 {
		t.Fatalf("top_p = %v", captured["top_p"])
	}
	format, _ := captured["response_format"].(map[string]any)
	if format["type"] != "json_schema" {
		t.Fatalf("response_format = %v", format)
	}
	jsonSchema, _ := format["json_schema"].(map[string]any)
	if jsonSchema["name"] != "crawl_frontier_judge" {
		t.Fatalf("schema name = %v", jsonSchema["name"])
	}
	if _, exists := captured["guardrails"]; exists {
		t.Fatal("guardrails must be omitted for the frontier metadata")
	}
	metadata, _ := captured["metadata"].(map[string]any)
	if metadata["feature"] != "crawl_frontier_judge" || metadata["frontierNodeId"] != "node-1" {
		t.Fatalf("metadata = %v", metadata)
	}
	messages, _ := captured["messages"].([]any)
	if len(messages) != 2 {
		t.Fatalf("messages = %v", messages)
	}
	userMessage, _ := messages[1].(map[string]any)
	content, _ := userMessage["content"].(string)
	if !strings.Contains(content, "\n  \"seedUrl\": \"https://example.com\"") {
		t.Fatalf("user content is not pretty-printed JSON: %q", content)
	}
	var userPayload *Object
	userPayload, ok := ParseObject(json.RawMessage(content))
	if !ok {
		t.Fatalf("user content is not JSON: %v", content)
	}
	if value, _ := userPayload.String("parentPageType"); value != "list" {
		t.Fatalf("parentPageType = %q", value)
	}

	if len(result.Candidates) != 2 {
		t.Fatalf("candidates = %v", result.Candidates)
	}
	if result.Candidates[0].URL != "https://example.com/b" {
		t.Fatalf("first candidate = %q", result.Candidates[0].URL)
	}
	if result.Candidates[1].PageType != "list" {
		t.Fatalf("retyped candidate = %+v", result.Candidates[1])
	}
	dropped, _ := result.Diagnostics.Number("llmJudgeDropped")
	if dropped != 1 {
		t.Fatalf("llmJudgeDropped = %v", dropped)
	}
	decisions, ok := result.Diagnostics.Raw("llmJudgeDecisions")
	if !ok || !strings.Contains(string(decisions), `"appliedDrop":true`) {
		t.Fatalf("llmJudgeDecisions = %s", decisions)
	}
}

func TestJudgeRerankOrdering(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/rerank":
			var payload map[string]any
			_ = json.NewDecoder(r.Body).Decode(&payload)
			if payload["model"] != "reranker" || payload["top_n"] != float64(3) {
				t.Errorf("rerank payload = %v", payload)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"model":   "reranker",
				"results": []any{map[string]any{"index": 2, "score": 0.9}, map[string]any{"index": 0, "score": 0.5}, map[string]any{"index": 1, "score": 0.1}},
			})
		case "/v1/chat/completions":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"model":   "primary",
				"choices": []any{map[string]any{"message": map[string]any{"role": "assistant", "content": `{}`}}},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	client := testClient(t, server)
	result, err := client.JudgeCandidates(context.Background(), judgeInput())
	if err != nil {
		t.Fatalf("JudgeCandidates error = %v", err)
	}
	want := []string{"https://example.com/c", "https://example.com/a", "https://example.com/b"}
	if len(result.Candidates) != len(want) {
		t.Fatalf("candidates = %v", result.Candidates)
	}
	for index := range want {
		if result.Candidates[index].URL != want[index] {
			t.Fatalf("candidates = %v, want %v", result.Candidates, want)
		}
	}
	applied, _ := result.Diagnostics.Bool("llmRerankApplied")
	if !applied {
		t.Fatal("llmRerankApplied must be true")
	}
}

func TestJudgeFallsBackToSecondModel(t *testing.T) {
	var mu sync.Mutex
	models := []string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			http.NotFound(w, r)
			return
		}
		var payload map[string]any
		_ = json.NewDecoder(r.Body).Decode(&payload)
		model, _ := payload["model"].(string)
		mu.Lock()
		models = append(models, model)
		mu.Unlock()
		if model == "primary" {
			http.Error(w, "upstream boom", http.StatusInternalServerError)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"model":   model,
			"choices": []any{map[string]any{"message": map[string]any{"role": "assistant", "content": `{}`}}},
		})
	}))
	defer server.Close()

	client := testClient(t, server)
	if _, err := client.JudgeCandidates(context.Background(), judgeInput()); err != nil {
		t.Fatalf("JudgeCandidates error = %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(models) != 2 || models[0] != "primary" || models[1] != "fallback" {
		t.Fatalf("models = %v", models)
	}
}

func TestJudgeGuardrailBlocksFallback(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			http.NotFound(w, r)
			return
		}
		calls++
		_ = json.NewEncoder(w).Encode(map[string]any{
			"model":    "primary",
			"messages": []any{map[string]any{"role": "assistant", "content": "blocked by guardrail"}},
		})
	}))
	defer server.Close()

	client := testClient(t, server)
	_, err := client.JudgeCandidates(context.Background(), judgeInput())
	if !errors.Is(err, errGuardrailBlocked) {
		t.Fatalf("error = %v, want guardrail block", err)
	}
	if calls != 1 {
		t.Fatalf("calls = %d, want 1 (guardrail must stop the fallback chain)", calls)
	}
}

func TestSafeJSONParseFromTextAndJudgeValidation(t *testing.T) {
	fenced := "```json\n{\"decisions\":[]}\n```"
	raw, ok := safeJSONParseFromText(fenced)
	if !ok || string(raw) != `{"decisions":[]}` {
		t.Fatalf("parse = %s, %v", raw, ok)
	}
	if _, ok := safeJSONParseFromText("no json here"); ok {
		t.Fatal("text without JSON must not parse")
	}
	invalid, _ := ParseObject([]byte(`{"decisions":[{"url":"not-a-url","action":"drop","pageType":"article","confidence":0.9}]}`))
	if _, ok := validateJudgeResponse(mustJSON(invalid)); ok {
		t.Fatal("invalid url must fail validation")
	}
	valid, _ := ParseObject([]byte(`{"decisions":[],"rationale":"fine"}`))
	parsed, ok := validateJudgeResponse(mustJSON(valid))
	if !ok || len(parsed.Decisions) != 0 || parsed.Rationale == nil {
		t.Fatalf("valid response = %+v, %v", parsed, ok)
	}
}

func TestLearnShadowProfileRequestAndValidation(t *testing.T) {
	var captured map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			http.NotFound(w, r)
			return
		}
		_ = json.NewDecoder(r.Body).Decode(&captured)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"model": "primary",
			"choices": []any{map[string]any{"message": map[string]any{
				"role": "assistant", "content": `{"confidence":0.8,"rationale":"better","profilePatch":{"sourceTier":"tier1"}}`,
			}}},
		})
	}))
	defer server.Close()

	config, _ := ParseObject([]byte(`{"llmAssist":{"enabled":true},"priorityKeywords":["news"]}`))
	profile := ProfileRecord{ID: "profile-1", OrgID: "org-1", Name: "Example", MatchHost: "example.com", ExecutionMode: "layered", Config: config}
	client := testClient(t, server)
	suggestion, err := client.LearnShadowProfile(context.Background(), LearnInput{
		OrgID: "org-1", Profile: profile,
		Run:   LearnRun{ID: "run-1", SeedURL: "https://example.com", Status: "completed", ArticleCount: 1, PageCount: 2},
		Nodes: []NodeRecord{{URL: "https://example.com/a", PageType: "article", Status: "completed"}},
	})
	if err != nil {
		t.Fatalf("LearnShadowProfile error = %v", err)
	}
	if suggestion == nil || suggestion.Confidence != 0.8 {
		t.Fatalf("suggestion = %+v", suggestion)
	}
	if captured["temperature"] != 0.15 || captured["max_tokens"] != float64(1800) {
		t.Fatalf("payload = %v", captured)
	}
	format, _ := captured["response_format"].(map[string]any)
	jsonSchema, _ := format["json_schema"].(map[string]any)
	if jsonSchema["name"] != "crawl_frontier_learn" {
		t.Fatalf("schema = %v", jsonSchema)
	}
	metadata, _ := captured["metadata"].(map[string]any)
	if metadata["feature"] != "crawl_frontier_learn" || metadata["crawlSiteProfileId"] != "profile-1" {
		t.Fatalf("metadata = %v", metadata)
	}
	if suggestion.ProfilePatch == nil {
		t.Fatal("profilePatch must be kept")
	}
	if tier, _ := suggestion.ProfilePatch.String("sourceTier"); tier != "tier1" {
		t.Fatalf("sourceTier = %q", tier)
	}
}

func TestLearnParseFailureRaisesParseError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"model":   "primary",
			"choices": []any{map[string]any{"message": map[string]any{"role": "assistant", "content": "not json"}}},
		})
	}))
	defer server.Close()
	config, _ := ParseObject([]byte(`{"llmAssist":{"enabled":true}}`))
	profile := ProfileRecord{ID: "p", Config: config}
	client := testClient(t, server)
	_, err := client.LearnShadowProfile(context.Background(), LearnInput{OrgID: "o", Profile: profile})
	if err == nil || err.Error() != "llm_learn_parse_failed" {
		t.Fatalf("error = %v", err)
	}
}
