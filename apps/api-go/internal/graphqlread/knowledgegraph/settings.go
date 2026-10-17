package knowledgegraph

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"
)

const (
	settingsCacheTTLSeconds = 60
	settingsCachePrefix     = "knowledgeGraph:settings:"
	systemSettingKeyPrefix  = "knowledge_graph_settings:"
)

// settings mirrors KnowledgeGraphSettings. Only Enabled and CacheTTLSeconds
// affect the read queries, but every field is normalized and cached so the Go
// and Nest settings payloads stay byte-compatible.
type settings struct {
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

func fallbackSettings() settings {
	return settings{
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

func bootstrapSettings() settings {
	out := fallbackSettings()
	out.Enabled = true
	out.IngestionEnabled = true
	return out
}

// getSettings reads Redis first, then MySQL. A missing SystemSetting row is
// bootstrapped to enabled; only a database error falls back to disabled.
func (s *service) getSettings(ctx context.Context, orgID string) settings {
	cacheKey := settingsCachePrefix + orgID
	if s != nil && s.redis != nil {
		if raw, err := s.redis.Get(ctx, cacheKey).Bytes(); err == nil && len(raw) > 0 {
			var doc map[string]any
			if json.Unmarshal(raw, &doc) == nil && doc != nil {
				return normalizeSettings(doc, nil)
			}
		}
	}

	loaded, err := s.loadSettings(ctx, orgID)
	if err != nil {
		loaded = fallbackSettings()
	}

	if s != nil && s.redis != nil {
		if encoded, marshalErr := json.Marshal(loaded); marshalErr == nil {
			_ = s.redis.Set(ctx, cacheKey, encoded, settingsCacheTTLSeconds*time.Second).Err()
		}
	}
	return loaded
}

func (s *service) loadSettings(ctx context.Context, orgID string) (settings, error) {
	if s == nil || s.db == nil {
		return settings{}, fmt.Errorf("knowledge graph settings database is not configured")
	}
	fallback := fallbackSettings()
	key := systemSettingKeyPrefix + orgID

	var raw []byte
	err := s.db.QueryRowContext(ctx, "SELECT `value` FROM `SystemSetting` WHERE `key` = ? LIMIT 1", key).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		bootstrap := bootstrapSettings()
		encoded, marshalErr := json.Marshal(bootstrap)
		if marshalErr != nil {
			return normalizeSettings(nil, &fallback), nil
		}
		_, insertErr := s.db.ExecContext(ctx,
			"INSERT IGNORE INTO `SystemSetting` (`key`, `value`, `isPublic`, `description`, `createdAt`, `updatedAt`) VALUES (?, CAST(? AS JSON), 0, ?, NOW(3), NOW(3))",
			key, string(encoded), "Knowledge graph settings (org="+orgID+")",
		)
		if insertErr != nil {
			return settings{}, insertErr
		}
		var persisted []byte
		if selectErr := s.db.QueryRowContext(ctx, "SELECT `value` FROM `SystemSetting` WHERE `key` = ? LIMIT 1", key).Scan(&persisted); selectErr != nil || len(persisted) == 0 {
			return normalizeSettings(settingsToMap(bootstrap), &fallback), nil
		}
		var doc map[string]any
		if json.Unmarshal(persisted, &doc) != nil {
			doc = nil
		}
		return normalizeSettings(doc, &fallback), nil
	}
	if err != nil {
		return settings{}, err
	}

	var doc map[string]any
	if json.Unmarshal(raw, &doc) != nil {
		doc = nil
	}
	return normalizeSettings(doc, &fallback), nil
}

func settingsToMap(value settings) map[string]any {
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil
	}
	var doc map[string]any
	if json.Unmarshal(encoded, &doc) != nil {
		return nil
	}
	return doc
}

func normalizeSettings(value map[string]any, fallback *settings) settings {
	defaults := fallbackSettings()
	if fallback != nil {
		defaults = *fallback
	}
	out := settings{
		Enabled:                                    boolSetting(value, "enabled", defaults.Enabled),
		IngestionEnabled:                           boolSetting(value, "ingestionEnabled", defaults.IngestionEnabled),
		MaxBatchSize:                               clampIntSetting(value["maxBatchSize"], 1, 500, defaults.MaxBatchSize),
		MaxRelationsPerArticle:                     clampIntSetting(value["maxRelationsPerArticle"], 0, 100, defaults.MaxRelationsPerArticle),
		MinEdgeConfidence:                          clampFloatSetting(value["minEdgeConfidence"], 0, 1, defaults.MinEdgeConfidence),
		DynamicEdgeConfidenceEnabled:               boolSetting(value, "dynamicEdgeConfidenceEnabled", defaults.DynamicEdgeConfidenceEnabled),
		DynamicEdgeConfidenceQuantile:              clampFloatSetting(value["dynamicEdgeConfidenceQuantile"], 0, 1, defaults.DynamicEdgeConfidenceQuantile),
		MultiModelValidationEnabled:                boolSetting(value, "multiModelValidationEnabled", defaults.MultiModelValidationEnabled),
		MultiModelValidationModels:                 stringListSetting(value["multiModelValidationModels"], defaults.MultiModelValidationModels),
		MultiModelValidationModelCount:             clampIntSetting(value["multiModelValidationModelCount"], 2, 3, defaults.MultiModelValidationModelCount),
		MultiModelValidationMaxRelationsPerArticle: clampIntSetting(value["multiModelValidationMaxRelationsPerArticle"], 0, 20, defaults.MultiModelValidationMaxRelationsPerArticle),
		EntityDisambiguationEnabled:                boolSetting(value, "entityDisambiguationEnabled", defaults.EntityDisambiguationEnabled),
		EntityDisambiguationMaxCandidates:          clampIntSetting(value["entityDisambiguationMaxCandidates"], 2, 20, defaults.EntityDisambiguationMaxCandidates),
		CacheTTLSeconds:                            clampIntSetting(value["cacheTtlSeconds"], 0, 3600, defaults.CacheTTLSeconds),
	}
	return out
}

func boolSetting(value map[string]any, key string, fallback bool) bool {
	if value != nil {
		if typed, ok := value[key].(bool); ok {
			return typed
		}
	}
	return fallback
}

func settingNumber(value any) (float64, bool) {
	switch typed := value.(type) {
	case float64:
		if math.IsNaN(typed) || math.IsInf(typed, 0) {
			return 0, false
		}
		return typed, true
	case float32:
		return settingNumber(float64(typed))
	case int:
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

func clampIntSetting(value any, minimum, maximum, fallback int) int {
	number, ok := settingNumber(value)
	if !ok {
		return fallback
	}
	rounded := int(jsRound(number))
	if rounded < minimum {
		return minimum
	}
	if rounded > maximum {
		return maximum
	}
	return rounded
}

func clampFloatSetting(value any, minimum, maximum, fallback float64) float64 {
	number, ok := settingNumber(value)
	if !ok {
		return fallback
	}
	if number < minimum {
		return minimum
	}
	if number > maximum {
		return maximum
	}
	return number
}

func stringListSetting(value any, fallback []string) []string {
	list, _ := value.([]any)
	seen := map[string]bool{}
	out := make([]string, 0, len(list))
	for _, entry := range list {
		text, ok := entry.(string)
		if !ok {
			continue
		}
		trimmed := strings.TrimSpace(text)
		if trimmed == "" || seen[trimmed] {
			continue
		}
		seen[trimmed] = true
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
