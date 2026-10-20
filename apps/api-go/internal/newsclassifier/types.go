// Package newsclassifier is the Go port of NewsClassifierService for the archive
// preparation display-signal backfill.
//
// It owns classification settings and taxonomy loading, rule-only
// classification, the LLM/embedding/rerank layers, score fusion, source-category
// authority, low-confidence fallback, method resolution and the
// applyToCleanedNews field projection. The news pipeline itself keeps calling
// the NestJS classifier; this package only serves the migrated archive worker.
//
// One Session owns the per-task taxonomy embedding cache (O2). A new Session is
// created per preparation job, so taxonomy vectors are reused across the
// classifications in one job and never across jobs.
package newsclassifier

import "time"

// TaxonomyNode is one NewsClassificationTaxonomyNode.
type TaxonomyNode struct {
	Path           string   `json:"path"`
	DisplayName    string   `json:"displayName"`
	Description    string   `json:"description"`
	LegacyCategory string   `json:"legacyCategory"`
	Keywords       []string `json:"keywords"`
	Synonyms       []string `json:"synonyms"`
}

// Settings is the normalized NewsClassificationSettings document.
type Settings struct {
	Enabled         bool
	StrictFail      bool
	EnableLlm       bool
	EnableEmbedding bool
	EnableRerank    bool
	LLMModel        string
	MinConfidence   float64
	EmbeddingTopK   int
	RerankTopN      int
	CacheTTLSeconds int
	TaxonomyVersion string
	Taxonomy        []TaxonomyNode
}

// CleanedNews is the classification input projection of a stored
// ProcessedItem.result document.
type CleanedNews struct {
	Title     string
	Subtitle  string
	Summary   string
	Source    string
	Language  string
	Topics    []string
	KeyPoints []string
}

// ClassificationCandidate is one weighted candidate.
type ClassificationCandidate struct {
	Path           string
	Score          float64
	LegacyCategory string
	Reason         *string
}

// LayerSuccess reports which layers completed.
type LayerSuccess struct {
	LLM       bool
	Embedding bool
	Rerank    bool
}

// Metrics is the classification metric block.
type Metrics struct {
	TaxonomyVersion    string
	LLMLatencyMs       *int64
	EmbeddingLatencyMs *int64
	RerankLatencyMs    *int64
	CandidateCount     int
	LayerSuccess       LayerSuccess
}

// Result is the NewsClassificationResult projection.
type Result struct {
	LegacyCategory string
	CategoryPath   *string
	Labels         []string
	Confidence     *float64
	Reason         *string
	Method         string
	Candidates     []ClassificationCandidate
	Metrics        Metrics
}

// Options is the per-classification context.
type Options struct {
	JobID       string
	SourceID    string
	SourceURL   string
	SourceLabel string
}

// nowMillis is the JS Date.now() equivalent used for latencies.
func nowMillis(now func() time.Time) int64 {
	return now().UnixMilli()
}
