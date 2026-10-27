package situationmonitors

import (
	"context"
	"database/sql"
	"encoding/json"
	"testing"

	"github.com/wei500L/newwei/apps/api-go/internal/llmembed"
	"github.com/wei500L/newwei/apps/api-go/internal/personalnews"
)

// fakeGateway is a modelGateway that never reaches a real gateway.
type fakeGateway struct {
	embedding   [][]float64
	model       string
	rerank      []llmembed.Hit
	rerankModel string
	hasRerank   bool
	rerankCalls int
}

func (f *fakeGateway) Embed(_ context.Context, _ string, _ []string) ([][]float64, string, error) {
	return f.embedding, f.model, nil
}

func (f *fakeGateway) Rerank(_ context.Context, _, _ string, _ []string) ([]llmembed.Hit, error) {
	f.rerankCalls++
	return f.rerank, nil
}

func (f *fakeGateway) RuntimeRerankModel(_ context.Context) (string, bool) {
	return f.rerankModel, f.hasRerank
}

func TestPreviewModelInfoReportsConfiguredRerankModel(t *testing.T) {
	ctx := context.Background()

	withRerank := previewModelInfo(ctx, &fakeGateway{rerankModel: "bge-reranker-v2", hasRerank: true}, "text-embedding-3-small")
	if withRerank.EmbeddingModel != "text-embedding-3-small" || withRerank.RerankModel != "bge-reranker-v2" {
		t.Fatalf("model info = %+v", withRerank)
	}

	// NestJS omits rerankModel when no rerank model is configured.
	withoutRerank := previewModelInfo(ctx, &fakeGateway{}, "text-embedding-3-small")
	encoded, err := json.Marshal(withoutRerank)
	if err != nil {
		t.Fatal(err)
	}
	if string(encoded) != `{"embeddingModel":"text-embedding-3-small"}` {
		t.Fatalf("model info json = %s", encoded)
	}

	// A missing gateway must not produce a rerank model out of thin air.
	if info := previewModelInfo(ctx, nil, ""); info.RerankModel != "" {
		t.Fatalf("nil gateway rerank = %q", info.RerankModel)
	}
}

func TestTaxonomyLabelsSkipsNonPaths(t *testing.T) {
	labels := taxonomyLabels(personalnews.TaxonomyView{
		ByPath: map[string]personalnews.TaxonomyNode{
			"tech/ai/model-release": {Path: "tech/ai/model-release", DisplayName: "AI Model Release"},
			"   ":                   {Path: "   ", DisplayName: "blank"},
		},
	})
	if labels["tech/ai/model-release"] != "AI Model Release" {
		t.Fatalf("labels = %v", labels)
	}
	if _, ok := labels["   "]; ok {
		t.Fatalf("blank path kept: %v", labels)
	}
}

func TestFilterSuggestionsUsesDefaultTaxonomyLabel(t *testing.T) {
	path := "tech/ai/model-release"
	entries := []scoredCatalog{{
		row:    catalogRow{kind: "topic", normalized: "ai model release", display: "AI Model Release", count: 4, taxonomy: sql.NullString{String: path, Valid: true}},
		score:  0.5,
		reason: "lexical",
	}}

	withLabels := onlyCatalogSuggestion(t, filterSuggestions(entries, "topic", nil, []string{"model"}, "AI", map[string]string{path: "AI Model Release"}))
	if withLabels.TaxonomyDisplayName == nil || *withLabels.TaxonomyDisplayName != "AI Model Release" {
		t.Fatalf("labelled suggestion = %+v", withLabels)
	}

	// Without the merged taxonomy labels the raw path is the fallback, exactly
	// like NestJS taxonomyDisplayName().
	withoutLabels := onlyCatalogSuggestion(t, filterSuggestions(entries, "topic", nil, []string{"model"}, "AI", nil))
	if withoutLabels.TaxonomyDisplayName == nil || *withoutLabels.TaxonomyDisplayName != path {
		t.Fatalf("raw path suggestion = %+v", withoutLabels)
	}
}

// onlyCatalogSuggestion unwraps the single suggestion filterSuggestions returns.
// The response field is still an untyped slice because suggestedLexicalTerms
// mixes keyword-derived and catalog-derived entries.
func onlyCatalogSuggestion(t *testing.T, values []any) catalogSuggestion {
	t.Helper()
	if len(values) != 1 {
		t.Fatalf("suggestions = %+v", values)
	}
	suggestion, ok := values[0].(catalogSuggestion)
	if !ok {
		t.Fatalf("suggestion type = %T", values[0])
	}
	return suggestion
}

func TestOrderCandidatesIsDeterministicOnTies(t *testing.T) {
	merged := map[string]scoredCatalog{}
	for _, row := range []catalogRow{
		{kind: "topic", normalized: "delta", display: "Delta", count: 2},
		{kind: "topic", normalized: "bravo", display: "Bravo", count: 2},
		{kind: "entity", normalized: "charlie", display: "Charlie", count: 2},
		{kind: "entity", normalized: "alpha", display: "Alpha", count: 2},
		{kind: "geo", normalized: "echo", display: "Echo", count: 2},
	} {
		merged[subscriptionKey(row.kind, row.normalized)] = scoredCatalog{row: row, score: 0.5, reason: "lexical"}
	}

	want := []string{"entity:alpha", "entity:charlie", "geo:echo", "topic:bravo", "topic:delta"}
	for attempt := 0; attempt < 5; attempt++ {
		ordered := orderCandidates(merged)
		got := make([]string, 0, len(ordered))
		for _, entry := range ordered {
			got = append(got, subscriptionKey(entry.row.kind, entry.row.normalized))
		}
		if len(got) != len(want) {
			t.Fatalf("order = %v", got)
		}
		for index := range want {
			if got[index] != want[index] {
				t.Fatalf("attempt %d order = %v, want %v", attempt, got, want)
			}
		}
	}
}
