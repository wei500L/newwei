package itemsreading

import (
	"math"
	"os"
	"strconv"
	"strings"
	"time"
)

// This file pins the relevance-ranking configuration and the scoring helpers
// ported from items-search.helpers.ts. The env names and defaults must stay in
// sync with EnvService.itemsSearchRankingConfig.

const (
	itemsSearchRecallMaxCandidatesDefault  = 120
	itemsSearchRerankMaxCandidatesDefault  = 40
	itemsSearchRerankTimeoutMsDefault      = 300
	itemsSearchRecencyHalfLifeHoursDefault = 48.0
	itemsSearchRerankMinTimeoutMs          = 100
)

// Default score weights of the final relevance blend. They are constants in
// NestJS (DEFAULT_WEIGHT_* in items.shared.ts) and intentionally not env
// configurable.
const (
	defaultWeightRerank      = 0.55
	defaultWeightRecency     = 0.25
	defaultWeightSourceTrust = 0.15
	defaultWeightQuality     = 0.05
	// defaultSourceTrustScore is the fallback when the source name is unknown.
	defaultSourceTrustScore = 0.6
)

// sourceTrustScoreMap is the named source trust table from items.shared.ts.
var sourceTrustScoreMap = []struct {
	needle string
	score  float64
}{
	{needle: "reuters", score: 0.96},
	{needle: "bloomberg", score: 0.95},
	{needle: "financial times", score: 0.94},
	{needle: "wall street journal", score: 0.94},
	{needle: "wsj", score: 0.94},
	{needle: "associated press", score: 0.93},
	{needle: "ap news", score: 0.93},
	{needle: "cnbc", score: 0.9},
	{needle: "marketwatch", score: 0.86},
	{needle: "nikkei", score: 0.9},
	{needle: "xinhua", score: 0.9},
}

// itemsSearchRankingConfig is the typed ranking configuration.
type itemsSearchRankingConfig struct {
	RecallMaxCandidates  int
	RerankMaxCandidates  int
	RerankEnabled        bool
	RerankTimeoutMs      int
	RecencyHalfLifeHours float64
}

// loadRankingConfigFromEnv reads the same variables with the same defaults as
// EnvService.itemsSearchRankingConfig. The rerank cap is clamped to the recall
// cap there and here, so the rerank stage can never see more documents than the
// recall stage produced.
func loadRankingConfigFromEnv() itemsSearchRankingConfig {
	recall := positiveIntEnv("ITEMS_SEARCH_RECALL_MAX_CANDIDATES", itemsSearchRecallMaxCandidatesDefault)
	rerank := positiveIntEnv("ITEMS_SEARCH_RERANK_MAX_CANDIDATES", itemsSearchRerankMaxCandidatesDefault)
	if rerank > recall {
		rerank = recall
	}
	return itemsSearchRankingConfig{
		RecallMaxCandidates:  recall,
		RerankMaxCandidates:  rerank,
		RerankEnabled:        boolEnvDefault("ITEMS_SEARCH_RERANK_ENABLED", true),
		RerankTimeoutMs:      positiveIntEnv("ITEMS_SEARCH_RERANK_TIMEOUT_MS", itemsSearchRerankTimeoutMsDefault),
		RecencyHalfLifeHours: positiveFloatEnv("ITEMS_SEARCH_RECENCY_HALFLIFE_HOURS", itemsSearchRecencyHalfLifeHoursDefault),
	}
}

// positiveIntEnv reads a positive integer, falling back on an absent or invalid
// value.
func positiveIntEnv(name string, fallback int) int {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value <= 0 {
		return fallback
	}
	return value
}

// positiveFloatEnv reads a positive float, falling back on an absent or invalid
// value.
func positiveFloatEnv(name string, fallback float64) float64 {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback
	}
	value, err := strconv.ParseFloat(raw, 64)
	if err != nil || math.IsNaN(value) || math.IsInf(value, 0) || value <= 0 {
		return fallback
	}
	return value
}

// boolEnvDefault mirrors NestJS env boolean parsing for a value that defaults
// to true: only an explicit falsy token disables it.
func boolEnvDefault(name string, fallback bool) bool {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback
	}
	switch strings.ToLower(raw) {
	case "0", "false", "no", "off":
		return false
	case "1", "true", "yes", "on":
		return true
	default:
		return fallback
	}
}

// clamp01 ports clamp01.
func clamp01(value float64) float64 {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return 0
	}
	if value <= 0 {
		return 0
	}
	if value >= 1 {
		return 1
	}
	return value
}

// computeLexicalScore ports computeLexicalScore: an exact substring hit scores
// 1, otherwise the token overlap ratio.
func computeLexicalScore(query string, document string) float64 {
	normalizedQuery := strings.ToLower(strings.TrimSpace(query))
	if normalizedQuery == "" {
		return 0
	}
	normalizedDoc := strings.ToLower(strings.TrimSpace(document))
	if normalizedDoc == "" {
		return 0
	}
	if strings.Contains(normalizedDoc, normalizedQuery) {
		return 1
	}
	tokens := TokenizeSearch(normalizedQuery, MongoMinTokenLength)
	if len(tokens) == 0 {
		return 0
	}
	matched := 0
	for _, token := range tokens {
		if strings.Contains(normalizedDoc, strings.ToLower(token)) {
			matched++
		}
	}
	return clamp01(float64(matched) / float64(len(tokens)))
}

// computeRecencyScore ports computeRecencyScore: an exponential half-life decay
// over the row's sortAt. This is the relevance-side recency; the personalized
// ordering uses its own 36-hour formula and must not share this one.
func computeRecencyScore(timestamp time.Time, halfLifeHours float64) float64 {
	if timestamp.IsZero() {
		return 0
	}
	if halfLifeHours < 1 {
		halfLifeHours = 1
	}
	halfLifeMs := halfLifeHours * 60 * 60 * 1000
	ageMs := time.Since(timestamp).Milliseconds()
	if ageMs < 0 {
		ageMs = 0
	}
	decay := math.Exp((-math.Log(2) * float64(ageMs)) / halfLifeMs)
	return clamp01(decay)
}

// computeSourceTrustScore ports computeSourceTrustScore: the first table entry
// contained in the lowercased source name wins, otherwise the default.
func computeSourceTrustScore(source *string) float64 {
	normalized := ""
	if source != nil {
		normalized = strings.ToLower(strings.TrimSpace(*source))
	}
	if normalized == "" {
		return defaultSourceTrustScore
	}
	for _, entry := range sourceTrustScoreMap {
		if strings.Contains(normalized, entry.needle) {
			return entry.score
		}
	}
	return defaultSourceTrustScore
}
