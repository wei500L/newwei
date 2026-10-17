package kgimpact

import (
	"context"
	"encoding/json"
	"log"
	"math"
	"strconv"
	"strings"
	"time"
)

const (
	kgSettingsCachePrefix = "knowledgeGraph:settings:"
	kgSettingsKeyPrefix   = "knowledge_graph_settings:"
	kgSettingsCacheTTL    = 60 * time.Second

	eigSettingsCachePrefix = "entityImpactGraph:settings:"
	eigSettingsKeyPrefix   = "entity_impact_graph_settings:"
	eigSettingsCacheTTL    = 60 * time.Second
)

// knowledgeGraphSettings mirrors KnowledgeGraphSettingsService. The whole
// object is normalized and cached so Nest can read a key this package wrote.
type knowledgeGraphSettings struct {
	Enabled                                    bool     `json:"enabled"`
	IngestionEnabled                           bool     `json:"ingestionEnabled"`
	MaxBatchSize                               int      `json:"maxBatchSize"`
	MaxRelationsPerArticle                     int      `json:"maxRelationsPerArticle"`
	MinEdgeConfidence                          float64  `json:"minEdgeConfidence"`
	DynamicEdgeConfidenceEnabled               bool     `json:"dynamicEdgeConfidenceEnabled"`
	DynamicEdgeConfidenceQuantile              float64  `json:"dynamicEdgeConfidenceQuantile"`
	MultiModelValidationEnabled                bool     `json:"multiModelValidationEnabled"`
	MultiModelValidationModels                 []string `json:"multiModelValidationModels"`
	MultiModelValidationModelCount             int      `json:"multiModelValidationModelCount"`
	MultiModelValidationMaxRelationsPerArticle int      `json:"multiModelValidationMaxRelationsPerArticle"`
	EntityDisambiguationEnabled                bool     `json:"entityDisambiguationEnabled"`
	EntityDisambiguationMaxCandidates          int      `json:"entityDisambiguationMaxCandidates"`
	CacheTTLSeconds                            int      `json:"cacheTtlSeconds"`
}

func kgFallbackSettings() knowledgeGraphSettings {
	return knowledgeGraphSettings{
		Enabled:                                    false,
		IngestionEnabled:                           false,
		MaxBatchSize:                               100,
		MaxRelationsPerArticle:                     20,
		MinEdgeConfidence:                          0.55,
		DynamicEdgeConfidenceEnabled:               true,
		DynamicEdgeConfidenceQuantile:              0.25,
		MultiModelValidationEnabled:                false,
		MultiModelValidationModels:                 []string{},
		MultiModelValidationModelCount:             3,
		MultiModelValidationMaxRelationsPerArticle: 5,
		EntityDisambiguationEnabled:                false,
		EntityDisambiguationMaxCandidates:          5,
		CacheTTLSeconds:                            60,
	}
}

func kgBootstrapSettings() knowledgeGraphSettings {
	settings := kgFallbackSettings()
	settings.Enabled = true
	settings.IngestionEnabled = true
	return settings
}

func normalizeKnowledgeGraphSettings(raw map[string]any, fallback knowledgeGraphSettings) knowledgeGraphSettings {
	out := fallback
	if raw == nil {
		return out
	}
	if value, ok := raw["enabled"].(bool); ok {
		out.Enabled = value
	}
	if value, ok := raw["ingestionEnabled"].(bool); ok {
		out.IngestionEnabled = value
	}
	out.MaxBatchSize = clampKgInt(raw["maxBatchSize"], 1, 500, fallback.MaxBatchSize)
	out.MaxRelationsPerArticle = clampKgInt(raw["maxRelationsPerArticle"], 0, 100, fallback.MaxRelationsPerArticle)
	out.MinEdgeConfidence = clampKgFloat(raw["minEdgeConfidence"], 0, 1, fallback.MinEdgeConfidence)
	if value, ok := raw["dynamicEdgeConfidenceEnabled"].(bool); ok {
		out.DynamicEdgeConfidenceEnabled = value
	}
	out.DynamicEdgeConfidenceQuantile = clampKgFloat(
		raw["dynamicEdgeConfidenceQuantile"], 0, 1, fallback.DynamicEdgeConfidenceQuantile,
	)
	if value, ok := raw["multiModelValidationEnabled"].(bool); ok {
		out.MultiModelValidationEnabled = value
	}
	out.MultiModelValidationModels = normalizeStringList(raw["multiModelValidationModels"], fallback.MultiModelValidationModels)
	out.MultiModelValidationModelCount = clampKgInt(raw["multiModelValidationModelCount"], 2, 3, fallback.MultiModelValidationModelCount)
	out.MultiModelValidationMaxRelationsPerArticle = clampKgInt(
		raw["multiModelValidationMaxRelationsPerArticle"], 0, 20, fallback.MultiModelValidationMaxRelationsPerArticle,
	)
	if value, ok := raw["entityDisambiguationEnabled"].(bool); ok {
		out.EntityDisambiguationEnabled = value
	}
	out.EntityDisambiguationMaxCandidates = clampKgInt(
		raw["entityDisambiguationMaxCandidates"], 2, 20, fallback.EntityDisambiguationMaxCandidates,
	)
	out.CacheTTLSeconds = clampKgInt(raw["cacheTtlSeconds"], 0, 3600, fallback.CacheTTLSeconds)
	return out
}

// clampKgFloat mirrors KnowledgeGraphSettingsService.clampFloat, including its
// stricter string handling (trim; the empty string is not a number).
func clampKgFloat(value any, min, max, fallback float64) float64 {
	numeric, ok := kgNumber(value)
	if !ok {
		return fallback
	}
	return clampFloat(numeric, min, max)
}

func clampKgInt(value any, min, max, fallback int) int {
	numeric, ok := kgNumber(value)
	if !ok {
		return fallback
	}
	return clampInt(int(jsRound(numeric)), min, max)
}

func kgNumber(value any) (float64, bool) {
	switch typed := value.(type) {
	case float64:
		if math.IsNaN(typed) || math.IsInf(typed, 0) {
			return 0, false
		}
		return typed, true
	case float32:
		return kgNumber(float64(typed))
	case int:
		return float64(typed), true
	case int32:
		return float64(typed), true
	case int64:
		return float64(typed), true
	case json.Number:
		parsed, err := typed.Float64()
		if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) {
			return 0, false
		}
		return parsed, true
	case string:
		trimmed := strings.TrimSpace(typed)
		if trimmed == "" {
			return 0, false
		}
		parsed, err := strconv.ParseFloat(trimmed, 64)
		if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) {
			return 0, false
		}
		return parsed, true
	default:
		return 0, false
	}
}

func normalizeStringList(value any, fallback []string) []string {
	list, _ := value.([]any)
	seen := map[string]struct{}{}
	out := make([]string, 0, len(list))
	for _, entry := range list {
		text, ok := entry.(string)
		if !ok {
			continue
		}
		trimmed := strings.TrimSpace(text)
		if trimmed == "" {
			continue
		}
		if _, exists := seen[trimmed]; exists {
			continue
		}
		seen[trimmed] = struct{}{}
		out = append(out, trimmed)
	}
	if len(out) > 10 {
		out = out[:10]
	}
	if len(out) == 0 {
		return fallback
	}
	return out
}

func clampFloat(value, min, max float64) float64 {
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}

func clampInt(value int, min, max int) int {
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}

// entityImpactGraphSettings mirrors EntityImpactGraphSettingsService.
type entityImpactGraphSettings struct {
	Enabled             bool     `json:"enabled"`
	MinEntityConfidence float64  `json:"minEntityConfidence"`
	MinCorrelation      float64  `json:"minCorrelation"`
	MinCoOccurrence     int      `json:"minCoOccurrence"`
	MaxNodes            int      `json:"maxNodes"`
	Categories          []string `json:"categories"`
	CacheTTLSeconds     int      `json:"cacheTtlSeconds"`
}

var allowedEntityImpactCategories = []string{"person", "organization", "stock", "commodity"}

func eigFallbackSettings() entityImpactGraphSettings {
	return entityImpactGraphSettings{
		Enabled:             true,
		MinEntityConfidence: 0.5,
		MinCorrelation:      0.3,
		MinCoOccurrence:     2,
		MaxNodes:            100,
		Categories:          []string{"person", "organization", "stock", "commodity"},
		CacheTTLSeconds:     60,
	}
}

func normalizeEigSettings(raw map[string]any, fallback entityImpactGraphSettings) entityImpactGraphSettings {
	out := fallback
	if raw == nil {
		return out
	}
	if value, ok := raw["enabled"].(bool); ok {
		out.Enabled = value
	}
	out.MinEntityConfidence = clampFloat(eigNumber(raw["minEntityConfidence"], fallback.MinEntityConfidence), 0, 1)
	out.MinCorrelation = clampFloat(eigNumber(raw["minCorrelation"], fallback.MinCorrelation), 0, 1)
	out.MinCoOccurrence = clampInt(int(jsRound(eigNumber(raw["minCoOccurrence"], float64(fallback.MinCoOccurrence)))), 1, 100)
	out.MaxNodes = clampInt(int(jsRound(eigNumber(raw["maxNodes"], float64(fallback.MaxNodes)))), 10, 500)
	if categories := normalizeEigCategoryInput(raw["categories"]); categories != nil {
		out.Categories = categories
	} else {
		out.Categories = fallback.Categories
	}
	out.CacheTTLSeconds = clampInt(int(jsRound(eigNumber(raw["cacheTtlSeconds"], float64(fallback.CacheTTLSeconds)))), 0, 3600)
	return out
}

// eigNumber mirrors EntityImpactGraphSettingsService.toNumber. Unlike the
// knowledge-graph service it does not reject an empty string (Number("") === 0).
func eigNumber(value any, fallback float64) float64 {
	switch typed := value.(type) {
	case float64:
		if math.IsNaN(typed) || math.IsInf(typed, 0) {
			return fallback
		}
		return typed
	case float32:
		return eigNumber(float64(typed), fallback)
	case int:
		return float64(typed)
	case int32:
		return float64(typed)
	case int64:
		return float64(typed)
	case json.Number:
		parsed, err := typed.Float64()
		if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) {
			return fallback
		}
		return parsed
	case string:
		// Number("") === 0 and Number("  ") === 0; a non-numeric string is NaN.
		trimmed := strings.TrimSpace(typed)
		if trimmed == "" {
			return 0
		}
		parsed, err := strconv.ParseFloat(trimmed, 64)
		if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) {
			return fallback
		}
		return parsed
	default:
		return fallback
	}
}

// normalizeEigCategoryInput mirrors EntityImpactGraphSettingsService.normalizeCategories:
// trim, lowercase, keep allowed entries, dedupe, preserve order; null when empty.
func normalizeEigCategoryInput(value any) []string {
	list, ok := value.([]any)
	if !ok {
		return nil
	}
	seen := map[string]struct{}{}
	out := make([]string, 0, len(list))
	for _, entry := range list {
		text, ok := entry.(string)
		if !ok {
			continue
		}
		normalized := strings.ToLower(strings.TrimSpace(text))
		if !containsString(allowedEntityImpactCategories, normalized) {
			continue
		}
		if _, exists := seen[normalized]; exists {
			continue
		}
		seen[normalized] = struct{}{}
		out = append(out, normalized)
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func (s *store) loadKnowledgeGraphSettings(ctx context.Context, orgID string) knowledgeGraphSettings {
	cacheKey := kgSettingsCachePrefix + orgID
	if raw, ok, err := redisGetBytes(ctx, s.redis, cacheKey); err == nil && ok {
		if doc := decodeSettings(raw); doc != nil {
			return normalizeKnowledgeGraphSettings(doc, kgFallbackSettings())
		}
	}
	settings := kgFallbackSettings()
	value, found, err := s.selectSystemSetting(ctx, kgSettingsKeyPrefix+orgID)
	switch {
	case err != nil:
		log.Printf("kgimpact: knowledge graph settings read failed for org %s: %v", orgID, err)
	case !found:
		bootstrap := kgBootstrapSettings()
		settings = bootstrap
		if err := s.insertSystemSettingIfAbsent(ctx, kgSettingsKeyPrefix+orgID, bootstrap, "Knowledge graph settings (org="+orgID+")"); err != nil {
			log.Printf("kgimpact: knowledge graph settings bootstrap failed for org %s: %v", orgID, err)
		}
	default:
		if doc := decodeSettings(value); doc != nil {
			settings = normalizeKnowledgeGraphSettings(doc, kgFallbackSettings())
		}
	}
	if err := redisSetJSON(ctx, s.redis, cacheKey, settings, kgSettingsCacheTTL); err != nil {
		log.Printf("kgimpact: knowledge graph settings cache write failed for org %s: %v", orgID, err)
	}
	return settings
}

func (s *store) loadEigSettings(ctx context.Context, orgID string) entityImpactGraphSettings {
	cacheKey := eigSettingsCachePrefix + orgID
	if raw, ok, err := redisGetBytes(ctx, s.redis, cacheKey); err == nil && ok {
		if doc := decodeSettings(raw); doc != nil {
			return normalizeEigSettings(doc, eigFallbackSettings())
		}
	}
	settings := eigFallbackSettings()
	value, found, err := s.selectSystemSetting(ctx, eigSettingsKeyPrefix+orgID)
	switch {
	case err != nil:
		log.Printf("kgimpact: entity impact graph settings read failed for org %s: %v", orgID, err)
	case found:
		if doc := decodeSettings(value); doc != nil {
			settings = normalizeEigSettings(doc, eigFallbackSettings())
		}
	}
	if err := redisSetJSON(ctx, s.redis, cacheKey, settings, eigSettingsCacheTTL); err != nil {
		log.Printf("kgimpact: entity impact graph settings cache write failed for org %s: %v", orgID, err)
	}
	return settings
}

func decodeSettings(raw []byte) map[string]any {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return nil
	}
	var doc map[string]any
	if err := json.Unmarshal([]byte(trimmed), &doc); err != nil {
		return nil
	}
	return doc
}
