package newsclassifier

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/wei500L/newwei/apps/api-go/internal/litellmcompat"
)

type fixedSettings struct{ settings Settings }

func (f fixedSettings) Get(context.Context, string) Settings { return f.settings }

type fixedPolicy struct {
	policy sourcePolicy
	err    error
}

func (f fixedPolicy) Get(context.Context, string) (sourcePolicy, error) { return f.policy, f.err }

type fakeModel struct {
	completion     func(litellmcompat.CompletionRequest) (litellmcompat.CompletionResponse, error)
	embedding      func(litellmcompat.EmbeddingRequest) (litellmcompat.EmbeddingResponse, error)
	rerank         func(litellmcompat.RerankRequest) (litellmcompat.RerankResponse, error)
	embeddingModel litellmcompat.RuntimeModel
	rerankModel    litellmcompat.RuntimeModel
}

func (f *fakeModel) RuntimeEmbeddingModel(context.Context) (litellmcompat.RuntimeModel, error) {
	return f.embeddingModel, nil
}
func (f *fakeModel) RuntimeRerankModel(context.Context) (litellmcompat.RuntimeModel, error) {
	return f.rerankModel, nil
}
func (f *fakeModel) Completion(_ context.Context, req litellmcompat.CompletionRequest) (litellmcompat.CompletionResponse, error) {
	return f.completion(req)
}
func (f *fakeModel) Embedding(_ context.Context, req litellmcompat.EmbeddingRequest) (litellmcompat.EmbeddingResponse, error) {
	return f.embedding(req)
}
func (f *fakeModel) Rerank(_ context.Context, req litellmcompat.RerankRequest) (litellmcompat.RerankResponse, error) {
	return f.rerank(req)
}

func testTaxonomy() []TaxonomyNode {
	return []TaxonomyNode{
		{Path: "a", DisplayName: "A", Description: "A node", LegacyCategory: "tech"},
		{Path: "b", DisplayName: "B", Description: "B node", LegacyCategory: "finance"},
	}
}

func baseSettings() Settings {
	return Settings{
		Enabled: true, StrictFail: true, EnableLlm: true, EnableEmbedding: true, EnableRerank: true,
		MinConfidence: 0.35, EmbeddingTopK: 12, RerankTopN: 6,
		TaxonomyVersion: "test-taxonomy", Taxonomy: testTaxonomy(),
	}
}

func approxEqual(left, right float64) bool {
	delta := left - right
	if delta < 0 {
		delta = -delta
	}
	return delta < 1e-9
}

func llmCandidates(candidates string) litellmcompat.CompletionResponse {
	return litellmcompat.CompletionResponse{Content: `{"candidates":[` + candidates + `],"rationale":"because"}`}
}

func TestClassifyFusesThreeLayers(t *testing.T) {
	model := &fakeModel{
		embeddingModel: litellmcompat.RuntimeModel{Model: "embed", Configured: true},
		rerankModel:    litellmcompat.RuntimeModel{Model: "rerank", Configured: true},
		completion: func(litellmcompat.CompletionRequest) (litellmcompat.CompletionResponse, error) {
			return llmCandidates(`{"path":"a","score":0.9,"reason":"llm reason"}`), nil
		},
		embedding: func(req litellmcompat.EmbeddingRequest) (litellmcompat.EmbeddingResponse, error) {
			if len(req.Input) != 3 {
				t.Fatalf("embedding input = %#v", req.Input)
			}
			return litellmcompat.EmbeddingResponse{Rows: []litellmcompat.EmbeddingRow{
				{Index: 0, Embedding: []float64{1, 0}},
				{Index: 1, Embedding: []float64{1, 0}},
				{Index: 2, Embedding: []float64{0, 1}},
			}}, nil
		},
		rerank: func(req litellmcompat.RerankRequest) (litellmcompat.RerankResponse, error) {
			return litellmcompat.RerankResponse{Results: []litellmcompat.RerankResult{
				{Index: 0, Score: 0.9},
				{Index: 1, Score: 0.1},
			}}, nil
		},
	}
	session := NewSession(Deps{Client: model, Settings: fixedSettings{baseSettings()}, SourcePolicies: fixedPolicy{}})
	result, err := session.Classify(context.Background(), "org", CleanedNews{Title: "article"}, Options{})
	if err != nil {
		t.Fatalf("classify: %v", err)
	}
	if result.CategoryPath == nil || *result.CategoryPath != "a" {
		t.Fatalf("path = %v", result.CategoryPath)
	}
	if result.Method != "llm+embedding+rerank" {
		t.Fatalf("method = %s", result.Method)
	}
	if result.Confidence == nil || !approxEqual(*result.Confidence, 0.95) {
		t.Fatalf("confidence = %v", result.Confidence)
	}
	if result.Reason == nil || *result.Reason != "llm reason" {
		t.Fatalf("reason = %v", result.Reason)
	}
	if strings.Join(result.Labels, "/") != "a" {
		t.Fatalf("labels = %v", result.Labels)
	}
	if len(result.Candidates) != 2 || result.Candidates[0].Path != "a" || result.Candidates[1].Path != "b" {
		t.Fatalf("candidates = %+v", result.Candidates)
	}
	if !approxEqual(result.Candidates[1].Score, 0.3) {
		t.Fatalf("b score = %v", result.Candidates[1].Score)
	}
}

func TestClassifyLowConfidenceFallsBackToRule(t *testing.T) {
	settings := baseSettings()
	settings.EnableEmbedding = false
	settings.EnableRerank = false
	settings.MinConfidence = 0.99
	model := &fakeModel{
		completion: func(litellmcompat.CompletionRequest) (litellmcompat.CompletionResponse, error) {
			return llmCandidates(`{"path":"a","score":0.4}`), nil
		},
	}
	session := NewSession(Deps{Client: model, Settings: fixedSettings{settings}, SourcePolicies: fixedPolicy{}})
	result, err := session.Classify(context.Background(), "org", CleanedNews{Title: "Fed raises rates"}, Options{})
	if err != nil {
		t.Fatalf("classify: %v", err)
	}
	if result.Method != "rule-fallback-low-confidence" {
		t.Fatalf("method = %s", result.Method)
	}
	if result.CategoryPath == nil || *result.CategoryPath != "finance/macro/monetary-policy" {
		t.Fatalf("fallback path = %v", result.CategoryPath)
	}
	if len(result.Candidates) != 1 || result.Candidates[0].Path != "a" || !approxEqual(result.Candidates[0].Score, 0.4) {
		t.Fatalf("candidates = %+v", result.Candidates)
	}
}

func TestClassifyEmptyWeightedFallsBackToRule(t *testing.T) {
	settings := baseSettings()
	settings.EnableLlm = false
	settings.EnableEmbedding = false
	settings.EnableRerank = false
	session := NewSession(Deps{Client: &fakeModel{}, Settings: fixedSettings{settings}, SourcePolicies: fixedPolicy{}})
	result, err := session.Classify(context.Background(), "org", CleanedNews{Title: "OpenAI model release"}, Options{})
	if err != nil {
		t.Fatalf("classify: %v", err)
	}
	if result.Method != "rule-fallback-empty" {
		t.Fatalf("method = %s", result.Method)
	}
	if result.LegacyCategory != "ai" || result.CategoryPath == nil || *result.CategoryPath != "tech/ai/model-release" {
		t.Fatalf("fallback = %+v", result)
	}
}

func TestClassifySourceCategoryAuthority(t *testing.T) {
	settings := baseSettings()
	settings.EnableEmbedding = false
	settings.EnableRerank = false
	model := &fakeModel{
		completion: func(litellmcompat.CompletionRequest) (litellmcompat.CompletionResponse, error) {
			return llmCandidates(`{"path":"a","score":0.5},{"path":"b","score":0.4}`), nil
		},
	}
	policy := sourcePolicy{
		AuthoritativeDomains: []string{"reuters.com"},
		CategoryAuthority: []categoryAuthorityRule{{
			CategoryPrefix: "a", AuthoritativeBoost: 0.1, MinConfidenceFloor: 0.9,
		}},
	}
	session := NewSession(Deps{Client: model, Settings: fixedSettings{settings}, SourcePolicies: fixedPolicy{policy: policy}})
	result, err := session.Classify(context.Background(), "org", CleanedNews{Title: "article"}, Options{
		SourceURL: "https://www.reuters.com/world/story",
	})
	if err != nil {
		t.Fatalf("classify: %v", err)
	}
	if len(result.Candidates) != 2 || result.Candidates[0].Path != "a" || result.Candidates[0].Score != 0.9 {
		t.Fatalf("candidates = %+v", result.Candidates)
	}
	if !approxEqual(result.Candidates[1].Score, 0.4) {
		t.Fatalf("b = %v", result.Candidates[1].Score)
	}
}

func TestRerankNormalizationEqualScores(t *testing.T) {
	model := &fakeModel{
		rerank: func(litellmcompat.RerankRequest) (litellmcompat.RerankResponse, error) {
			return litellmcompat.RerankResponse{Results: []litellmcompat.RerankResult{
				{Index: 0, Score: 0.42},
				{Index: 1, Score: 0.42},
			}}, nil
		},
	}
	session := NewSession(Deps{Client: model})
	taxonomy := testTaxonomy()
	scores, err := session.runRerankLayer(context.Background(), "org", "q", []string{"a", "b"}, map[string]TaxonomyNode{
		"a": taxonomy[0], "b": taxonomy[1],
	}, 6, "")
	if err != nil {
		t.Fatalf("rerank: %v", err)
	}
	if len(scores) != 2 || scores[0].Score != 1 || scores[1].Score != 1 {
		t.Fatalf("scores = %+v", scores)
	}
}

func TestRerankNormalizationMinMax(t *testing.T) {
	model := &fakeModel{
		rerank: func(litellmcompat.RerankRequest) (litellmcompat.RerankResponse, error) {
			return litellmcompat.RerankResponse{Results: []litellmcompat.RerankResult{
				{Index: 0, Score: 0.8},
				{Index: 1, Score: 0.2},
			}}, nil
		},
	}
	session := NewSession(Deps{Client: model})
	taxonomy := testTaxonomy()
	scores, err := session.runRerankLayer(context.Background(), "org", "q", []string{"a", "b"}, map[string]TaxonomyNode{
		"a": taxonomy[0], "b": taxonomy[1],
	}, 6, "")
	if err != nil {
		t.Fatalf("rerank: %v", err)
	}
	if scores[0].Score != 1 || scores[1].Score != 0 {
		t.Fatalf("scores = %+v", scores)
	}
}

func TestSafeJSONAndValidation(t *testing.T) {
	cases := []struct {
		name string
		text string
		ok   bool
	}{
		{name: "plain", text: `{"a":1}`, ok: true},
		{name: "fenced", text: "```json\n{\"a\":1}\n```", ok: true},
		{name: "leading text", text: `Here: {"a":1} trailing`, ok: true},
		{name: "array", text: `[{"a":1}]`, ok: true},
		{name: "truncated", text: `{"a":1`, ok: false},
		{name: "no json", text: `nothing`, ok: false},
	}
	for _, testCase := range cases {
		_, ok := SafeJSONParseFromText(testCase.text)
		if ok != testCase.ok {
			t.Fatalf("%s: ok = %v", testCase.name, ok)
		}
	}

	valid := `{"candidates":[{"path":"a","score":0.5,"reason":"r"}],"rationale":"why"}`
	if _, err := validateLLMClassificationResponse([]byte(valid)); err != nil {
		t.Fatalf("valid: %v", err)
	}
	for name, raw := range map[string]string{
		"missing path":       `{"candidates":[{"score":0.5}]}`,
		"score out of range": `{"candidates":[{"path":"a","score":1.5}]}`,
		"empty candidates":   `{"candidates":[]}`,
		"too many":           `{"candidates":[{"path":"a","score":0.1},{"path":"b","score":0.1},{"path":"c","score":0.1},{"path":"d","score":0.1},{"path":"e","score":0.1},{"path":"f","score":0.1},{"path":"g","score":0.1},{"path":"h","score":0.1},{"path":"i","score":0.1},{"path":"j","score":0.1},{"path":"k","score":0.1}]}`,
		"long reason":        `{"candidates":[{"path":"a","score":0.1,"reason":"` + strings.Repeat("x", 241) + `"}]}`,
	} {
		if _, err := validateLLMClassificationResponse([]byte(raw)); err == nil {
			t.Fatalf("%s: expected validation error", name)
		}
	}
}

func TestApplyToCleanedNewsPreservesUnknownMembers(t *testing.T) {
	raw := json.RawMessage(`{"title":"t","cleaned_markdown":"body","content_type":"news_fact","topics":["x"],"extension":{"keep":true},"category":"old"}`)
	cleaned, ok := ParseStoredCleanedNews(raw)
	if !ok {
		t.Fatal("parse failed")
	}
	confidence := 0.95
	path := "a"
	reason := "why"
	updated, err := cleaned.ApplyToCleanedNews(Result{
		LegacyCategory: "tech", CategoryPath: &path, Labels: []string{"a"}, Confidence: &confidence,
		Reason: &reason, Method: "llm", Candidates: []ClassificationCandidate{{
			Path: "a", Score: 0.95, LegacyCategory: "tech", Reason: &reason,
		}},
	})
	if err != nil {
		t.Fatalf("apply: %v", err)
	}
	var document map[string]json.RawMessage
	if err := json.Unmarshal(updated, &document); err != nil {
		t.Fatalf("updated json: %v", err)
	}
	if string(document["extension"]) != `{"keep":true}` {
		t.Fatalf("extension = %s", document["extension"])
	}
	for key, expected := range map[string]string{
		"category":        `"tech"`,
		"category_path":   `"a"`,
		"category_method": `"llm"`,
		"category_labels": `["a"]`,
		"content_type":    `"news_fact"`,
		"category_reason": `"why"`,
	} {
		if string(document[key]) != expected {
			t.Fatalf("%s = %s, want %s", key, document[key], expected)
		}
	}
	if got := HasLocation(updated); got {
		t.Fatal("hasLocation must be false")
	}
}

func TestSettingsTaxonomyNormalization(t *testing.T) {
	settings := normalizeSettings(rawSettings{Taxonomy: json.RawMessage(`[{"path":" B ","legacyCategory":"tech","displayName":"B","keywords":["k","k"]},{"path":"a","legacyCategory":"nope"}]`)}, fallbackSettings())
	if len(settings.Taxonomy) != 1 || settings.Taxonomy[0].Path != "b" {
		t.Fatalf("taxonomy = %+v", settings.Taxonomy)
	}
	if len(settings.Taxonomy[0].Keywords) != 1 {
		t.Fatalf("keywords = %+v", settings.Taxonomy[0].Keywords)
	}
}

func TestEmbeddingLayerReusesTaxonomyVectorsWithinOneTask(t *testing.T) {
	var inputs []int
	model := &fakeModel{
		embeddingModel: litellmcompat.RuntimeModel{Model: "embed", Configured: true},
		embedding: func(req litellmcompat.EmbeddingRequest) (litellmcompat.EmbeddingResponse, error) {
			inputs = append(inputs, len(req.Input))
			rows := make([]litellmcompat.EmbeddingRow, 0, len(req.Input))
			for index := range req.Input {
				rows = append(rows, litellmcompat.EmbeddingRow{Index: index, Embedding: []float64{1, float64(index)}})
			}
			return litellmcompat.EmbeddingResponse{Rows: rows}, nil
		},
	}
	session := NewSession(Deps{Client: model})
	taxonomy := testTaxonomy()
	if _, err := session.runEmbeddingLayer(context.Background(), "org", "query", taxonomy, 12, ""); err != nil {
		t.Fatalf("first: %v", err)
	}
	if _, err := session.runEmbeddingLayer(context.Background(), "org", "query", taxonomy, 12, ""); err != nil {
		t.Fatalf("second: %v", err)
	}
	if len(inputs) != 2 || inputs[0] != 3 || inputs[1] != 1 {
		t.Fatalf("embedding inputs = %v, want [3 1]", inputs)
	}
}
