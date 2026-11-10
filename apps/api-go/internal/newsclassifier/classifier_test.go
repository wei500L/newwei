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
	if result.Confidence == nil || !approxEqual(*result.Confidence, 0.93) {
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
	if !approxEqual(result.Candidates[1].Score, 0.02) {
		t.Fatalf("b score = %v", result.Candidates[1].Score)
	}
}

func TestClassifyLowConfidenceFallsBackToRule(t *testing.T) {
	settings := baseSettings()
	settings.EnableEmbedding = false
	settings.EnableRerank = false
	settings.MinConfidence = 0.99
	// The rule fallback must find its path in the org taxonomy, so this custom
	// taxonomy keeps the LLM candidate path and the finance rule path.
	settings.Taxonomy = []TaxonomyNode{
		{Path: "a", DisplayName: "A", Description: "A node", LegacyCategory: "tech"},
		{Path: "finance/macro/monetary-policy", DisplayName: "Monetary Policy", Description: "mp", LegacyCategory: "finance"},
	}
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
	// Rule fallback path must exist in the taxonomy, so use the default taxonomy
	// which contains tech/ai/model-release.
	settings.Taxonomy = defaultTaxonomy
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

// L3: rerank scores are used raw, so two equal upstream scores stay equal and
// are not collapsed to 1.0.
func TestRerankPreservesUpstreamScoreWhenEqual(t *testing.T) {
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
	if len(scores) != 2 || !approxEqual(scores[0].Score, 0.42) || !approxEqual(scores[1].Score, 0.42) {
		t.Fatalf("scores = %+v", scores)
	}
}

// L3: no min-max normalization, so 0.8/0.2 keep their absolute relevance instead
// of becoming 1/0.
func TestRerankUsesAbsoluteUpstreamScores(t *testing.T) {
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
	if len(scores) != 2 || !approxEqual(scores[0].Score, 0.8) || !approxEqual(scores[1].Score, 0.2) {
		t.Fatalf("scores = %+v", scores)
	}
}

// L3: a single rerank hit with score 0.2 must stay 0.2, not become 1.0.
func TestRerankSingleResultKeepsRawScore(t *testing.T) {
	model := &fakeModel{
		rerank: func(litellmcompat.RerankRequest) (litellmcompat.RerankResponse, error) {
			return litellmcompat.RerankResponse{Results: []litellmcompat.RerankResult{
				{Index: 0, Score: 0.2},
			}}, nil
		},
	}
	session := NewSession(Deps{Client: model})
	taxonomy := testTaxonomy()
	scores, err := session.runRerankLayer(context.Background(), "org", "q", []string{"a"}, map[string]TaxonomyNode{
		"a": taxonomy[0],
	}, 6, "")
	if err != nil {
		t.Fatalf("rerank: %v", err)
	}
	if len(scores) != 1 || !approxEqual(scores[0].Score, 0.2) {
		t.Fatalf("scores = %+v", scores)
	}
}

// L3: an out-of-range logit score is mapped through the logistic function
// instead of being clamped or min-maxed.
func TestRerankLogitScoreUsesSigmoid(t *testing.T) {
	model := &fakeModel{
		rerank: func(litellmcompat.RerankRequest) (litellmcompat.RerankResponse, error) {
			return litellmcompat.RerankResponse{Results: []litellmcompat.RerankResult{
				{Index: 0, Score: 2.0},
			}}, nil
		},
	}
	session := NewSession(Deps{Client: model})
	taxonomy := testTaxonomy()
	scores, err := session.runRerankLayer(context.Background(), "org", "q", []string{"a"}, map[string]TaxonomyNode{
		"a": taxonomy[0],
	}, 6, "")
	if err != nil {
		t.Fatalf("rerank: %v", err)
	}
	// sigmoid(2.0) = 0.8807970779778823
	if len(scores) != 1 || !approxEqual(scores[0].Score, 0.8807970779778823) {
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

// L2: when neither LLM nor embedding produced candidates, rerank must score the
// full leaf set instead of an arbitrary prefix of the declared taxonomy.
func TestRerankWithoutCandidatesUsesAllLeafNodes(t *testing.T) {
	taxonomy := []TaxonomyNode{
		{Path: "tech", DisplayName: "Tech", Description: "tech", LegacyCategory: "tech"},
		{Path: "tech/ai/model-release", DisplayName: "AI", Description: "ai", LegacyCategory: "ai"},
		{Path: "tech/cyber/security-incident", DisplayName: "Cyber", Description: "cyber", LegacyCategory: "intel"},
		{Path: "finance/markets/equities", DisplayName: "Equities", Description: "eq", LegacyCategory: "finance"},
	}
	var documentCount int
	model := &fakeModel{
		rerank: func(req litellmcompat.RerankRequest) (litellmcompat.RerankResponse, error) {
			documentCount = len(req.Documents)
			results := make([]litellmcompat.RerankResult, 0, len(req.Documents))
			for index := range req.Documents {
				results = append(results, litellmcompat.RerankResult{Index: index, Score: 0.1 * float64(index+1)})
			}
			return litellmcompat.RerankResponse{Results: results}, nil
		},
	}
	settings := baseSettings()
	settings.EnableLlm = false
	settings.EnableEmbedding = false
	settings.EnableRerank = true
	settings.MinConfidence = 0
	settings.RerankTopN = 10
	settings.Taxonomy = taxonomy
	session := NewSession(Deps{Client: model, Settings: fixedSettings{settings}, SourcePolicies: fixedPolicy{}})
	result, err := session.Classify(context.Background(), "org", CleanedNews{Title: "an article"}, Options{})
	if err != nil {
		t.Fatalf("classify: %v", err)
	}
	if documentCount != 3 {
		t.Fatalf("rerank documents = %d, want 3 leaf nodes (parent excluded)", documentCount)
	}
	// Leaf order is [tech/ai/model-release, tech/cyber/security-incident,
	// finance/markets/equities]; the highest score lands on the last leaf.
	if result.CategoryPath == nil || *result.CategoryPath != "finance/markets/equities" {
		t.Fatalf("path = %v", result.CategoryPath)
	}
}

func TestTaxonomyLeafPathsExcludeParents(t *testing.T) {
	taxonomy := []TaxonomyNode{
		{Path: "tech", LegacyCategory: "tech"},
		{Path: "tech/ai/model-release", LegacyCategory: "ai"},
		{Path: "tech/cyber/security-incident", LegacyCategory: "intel"},
		{Path: "finance/markets/equities", LegacyCategory: "finance"},
	}
	got := taxonomyLeafPaths(taxonomy)
	want := []string{"tech/ai/model-release", "tech/cyber/security-incident", "finance/markets/equities"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("leaves = %v, want %v", got, want)
	}
}

// L4: a candidate seen by only one layer must not beat an explicit higher LLM
// score merely because its denominator is smaller, and embedding uses the raw
// cosine rather than (cos+1)/2.
func TestAbsentLayerScoresZeroInFusion(t *testing.T) {
	taxonomy := []TaxonomyNode{
		{Path: "topic/a", DisplayName: "A", Description: "a", LegacyCategory: "tech"},
		{Path: "topic/b", DisplayName: "B", Description: "b", LegacyCategory: "finance"},
	}
	model := &fakeModel{
		embeddingModel: litellmcompat.RuntimeModel{Model: "embed", Configured: true},
		completion: func(litellmcompat.CompletionRequest) (litellmcompat.CompletionResponse, error) {
			return llmCandidates(`{"path":"topic/a","score":0.6}`), nil
		},
		embedding: func(req litellmcompat.EmbeddingRequest) (litellmcompat.EmbeddingResponse, error) {
			// Request input order is [query, topic/a doc, topic/b doc].
			return litellmcompat.EmbeddingResponse{Rows: []litellmcompat.EmbeddingRow{
				{Index: 0, Embedding: []float64{1, 0}},
				{Index: 1, Embedding: []float64{0, 1}},
				{Index: 2, Embedding: []float64{0.5, 0.8660254037844386}},
			}}, nil
		},
	}
	settings := baseSettings()
	settings.EnableRerank = false
	settings.EnableLlm = true
	settings.EnableEmbedding = true
	settings.EmbeddingTopK = 1
	settings.MinConfidence = 0
	settings.Taxonomy = taxonomy
	session := NewSession(Deps{Client: model, Settings: fixedSettings{settings}, SourcePolicies: fixedPolicy{}})
	result, err := session.Classify(context.Background(), "org", CleanedNews{Title: "article"}, Options{})
	if err != nil {
		t.Fatalf("classify: %v", err)
	}
	if result.CategoryPath == nil || *result.CategoryPath != "topic/a" {
		t.Fatalf("path = %v, want topic/a", result.CategoryPath)
	}
	// topic/a = 0.6*0.5/0.8 = 0.375; topic/b = 0.5*0.3/0.8 = 0.1875.
	if !approxEqual(result.Candidates[0].Score, 0.375) {
		t.Fatalf("a score = %v", result.Candidates[0].Score)
	}
	if len(result.Candidates) != 2 || !approxEqual(result.Candidates[1].Score, 0.1875) {
		t.Fatalf("candidates = %+v", result.Candidates)
	}
}

// L5: Chinese titles must match the rule fallback, and a rule whose path is not
// in the org taxonomy must be treated as no hit.
func TestRuleFallbackMatchesChineseFinance(t *testing.T) {
	result := classifyByRule(CleanedNews{Title: "美联储宣布加息"}, "v", defaultTaxonomy)
	if result.LegacyCategory != "finance" || result.CategoryPath == nil || *result.CategoryPath != "finance/macro/monetary-policy" {
		t.Fatalf("fallback = %+v", result)
	}
}

func TestRuleFallbackRequiresPathInTaxonomy(t *testing.T) {
	custom := []TaxonomyNode{{Path: "tech/ai/model-release", DisplayName: "AI", Description: "ai", LegacyCategory: "ai"}}
	result := classifyByRule(CleanedNews{Title: "美联储宣布加息"}, "v", custom)
	if result.CategoryPath != nil || result.LegacyCategory != "" {
		t.Fatalf("expected no match, got %+v", result)
	}
	if result.Reason == nil || *result.Reason != "no-classification-match" {
		t.Fatalf("reason = %v", result.Reason)
	}
	// With no taxonomy (classifier disabled / empty) the legacy hard-coded path
	// is preserved.
	legacy := classifyByRule(CleanedNews{Title: "美联储宣布加息"}, "v", nil)
	if legacy.CategoryPath == nil || *legacy.CategoryPath != "finance/macro/monetary-policy" {
		t.Fatalf("legacy fallback = %+v", legacy)
	}
}

// L7: the shared query text must not contain the source label or language code.
func TestBuildQueryTextExcludesSourceAndLanguage(t *testing.T) {
	text := buildQueryText(CleanedNews{
		Title: "Fed raises rates", Source: "Reuters", Language: "en",
		Topics: []string{"macro"},
	})
	for _, line := range strings.Split(text, "\n") {
		if line == "Reuters" || line == "en" {
			t.Fatalf("query text must not include source/language: %q", text)
		}
	}
	if !strings.Contains(text, "Fed raises rates") || !strings.Contains(text, "macro") {
		t.Fatalf("query text missing content: %q", text)
	}
}
