package newsindicator

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"math"
	"strconv"
	"strings"
	"time"
)

// associationSettings 与 NestJS NewsIndicatorAssociationSettings 对齐。
type associationSettings struct {
	Enabled                     bool
	IngestionEnabled            bool
	WindowDays                  int
	MaxLagDays                  int
	MinSampleSize               int
	MinAbsCorrelation           float64
	MaxPValue                   float64
	TopEntities                 int
	TopTopics                   int
	MaxAssociationsPerIndicator int
	IndicatorSlugs              []string
	BacktestTriggerZScore       float64
	BacktestBaselineDays        int
	BacktestHoldoutDays         int
	CacheTTLSeconds             int
}

// recommendedSlugs 复制 packages/utils 的 NEWS_INDICATOR_RECOMMENDED_SLUGS。
var recommendedSlugs = []string{
	"gold_futures_main",
	"crude_oil_futures_main",
	"copper_futures_main",
	"gov_bond_futures_main",
	"natural_gas_futures_main",
	"platinum_spot_sge",
	"palladium_spot_sge",
	"china_treasury_yield_curve",
	"us_treasury_yield_curve",
	"shanghai_composite_index",
	"csi300_index",
	"sz_component_index",
	"csi1000_index",
	"sp500_index",
	"china_fx_mid_rates",
	"rmb_fx_cswap_curve",
}

const (
	settingsCacheKeyPrefix     = "newsIndicator:settings:"
	systemSettingKeyPrefix     = "news_indicator_association_settings:"
	settingsCacheTTLSeconds    = 60
	newsIndicatorSettingsLimit = 50
)

func fallbackSettings() associationSettings {
	return associationSettings{
		Enabled:                     false,
		IngestionEnabled:            false,
		WindowDays:                  180,
		MaxLagDays:                  7,
		MinSampleSize:               30,
		MinAbsCorrelation:           0.2,
		MaxPValue:                   0.2,
		TopEntities:                 50,
		TopTopics:                   50,
		MaxAssociationsPerIndicator: 60,
		IndicatorSlugs:              append([]string(nil), recommendedSlugs...),
		BacktestTriggerZScore:       2,
		BacktestBaselineDays:        30,
		BacktestHoldoutDays:         30,
		CacheTTLSeconds:             120,
	}
}

// settingsToMap 是 getSettings 写入 Redis 的对象形态（全字段，与 NestJS
// 缓存里 normalized settings 的键名一致）。
func settingsToMap(settings associationSettings) map[string]any {
	return map[string]any{
		"enabled":                     settings.Enabled,
		"ingestionEnabled":            settings.IngestionEnabled,
		"windowDays":                  settings.WindowDays,
		"maxLagDays":                  settings.MaxLagDays,
		"minSampleSize":               settings.MinSampleSize,
		"minAbsCorrelation":           settings.MinAbsCorrelation,
		"maxPValue":                   settings.MaxPValue,
		"topEntities":                 settings.TopEntities,
		"topTopics":                   settings.TopTopics,
		"maxAssociationsPerIndicator": settings.MaxAssociationsPerIndicator,
		"indicatorSlugs":              settings.IndicatorSlugs,
		"backtestTriggerZScore":       settings.BacktestTriggerZScore,
		"backtestBaselineDays":        settings.BacktestBaselineDays,
		"backtestHoldoutDays":         settings.BacktestHoldoutDays,
		"cacheTtlSeconds":             settings.CacheTTLSeconds,
	}
}

// normalizeSettings 与 NestJS normalizeSettings 逐段对齐。fallback 为 nil 时
// 用 getFallbackSettings 的默认值。
func normalizeSettings(value map[string]any, fallback *associationSettings) associationSettings {
	defaults := fallbackSettings()
	if fallback != nil {
		defaults = *fallback
	}
	if value == nil {
		value = map[string]any{}
	}

	slugs := defaults.IndicatorSlugs
	if raw, ok := value["indicatorSlugs"]; ok {
		if list, ok := asStringSlice(raw); ok {
			slugs = list
		}
	}
	// 与 NestJS 一致：先 trim/过滤并截到 50 条，再做稳定去重。
	trimmedSlugs := make([]string, 0, len(slugs))
	for _, entry := range slugs {
		trimmed := strings.TrimSpace(entry)
		if trimmed == "" {
			continue
		}
		trimmedSlugs = append(trimmedSlugs, trimmed)
		if len(trimmedSlugs) >= newsIndicatorSettingsLimit {
			break
		}
	}
	normalizedSlugs := make([]string, 0, len(trimmedSlugs))
	seen := map[string]bool{}
	for _, entry := range trimmedSlugs {
		if seen[entry] {
			continue
		}
		seen[entry] = true
		normalizedSlugs = append(normalizedSlugs, entry)
	}

	return associationSettings{
		Enabled:                     settingBool(value["enabled"], defaults.Enabled),
		IngestionEnabled:            settingBool(value["ingestionEnabled"], defaults.IngestionEnabled),
		WindowDays:                  clampIntSetting(value["windowDays"], 7, 3650, defaults.WindowDays),
		MaxLagDays:                  clampIntSetting(value["maxLagDays"], 0, 30, defaults.MaxLagDays),
		MinSampleSize:               clampIntSetting(value["minSampleSize"], 10, 2000, defaults.MinSampleSize),
		MinAbsCorrelation:           clampFloatSetting(value["minAbsCorrelation"], 0, 1, defaults.MinAbsCorrelation),
		MaxPValue:                   clampFloatSetting(value["maxPValue"], 0, 1, defaults.MaxPValue),
		TopEntities:                 clampIntSetting(value["topEntities"], 0, 500, defaults.TopEntities),
		TopTopics:                   clampIntSetting(value["topTopics"], 0, 500, defaults.TopTopics),
		MaxAssociationsPerIndicator: clampIntSetting(value["maxAssociationsPerIndicator"], 1, 1000, defaults.MaxAssociationsPerIndicator),
		IndicatorSlugs:              normalizedSlugs,
		BacktestTriggerZScore:       clampFloatSetting(value["backtestTriggerZScore"], 0, 10, defaults.BacktestTriggerZScore),
		BacktestBaselineDays:        clampIntSetting(value["backtestBaselineDays"], 5, 365, defaults.BacktestBaselineDays),
		BacktestHoldoutDays:         clampIntSetting(value["backtestHoldoutDays"], 0, 365, defaults.BacktestHoldoutDays),
		CacheTTLSeconds:             clampIntSetting(value["cacheTtlSeconds"], 0, 3600, defaults.CacheTTLSeconds),
	}
}

func asStringSlice(value any) ([]string, bool) {
	switch typed := value.(type) {
	case []string:
		return typed, true
	case []any:
		out := make([]string, 0, len(typed))
		for _, item := range typed {
			text, ok := item.(string)
			if !ok {
				return nil, false
			}
			out = append(out, text)
		}
		return out, true
	default:
		return nil, false
	}
}

func settingBool(value any, fallback bool) bool {
	if typed, ok := value.(bool); ok {
		return typed
	}
	return fallback
}

// settingToNumber 与 NestJS toNumber 对齐：数字必须有限；字符串 trim 后
// 可解析为有限数；其他一律返回 false。
func settingToNumber(value any) (float64, bool) {
	switch typed := value.(type) {
	case float64:
		if !isFinite(typed) {
			return 0, false
		}
		return typed, true
	case float32:
		converted := float64(typed)
		if !isFinite(converted) {
			return 0, false
		}
		return converted, true
	case int:
		return float64(typed), true
	case int64:
		return float64(typed), true
	case json.Number:
		parsed, err := typed.Float64()
		if err != nil || !isFinite(parsed) {
			return 0, false
		}
		return parsed, true
	case string:
		trimmed := strings.TrimSpace(typed)
		if trimmed == "" {
			return 0, false
		}
		parsed, err := strconv.ParseFloat(trimmed, 64)
		if err != nil || !isFinite(parsed) {
			return 0, false
		}
		return parsed, true
	default:
		return 0, false
	}
}

// jsRound 是 JavaScript Math.round（半值向 +∞）。
func jsRound(value float64) float64 {
	return math.Floor(value + 0.5)
}

func clampIntSetting(value any, min, max, fallback int) int {
	numeric, ok := settingToNumber(value)
	if !ok {
		return fallback
	}
	rounded := int(jsRound(numeric))
	if rounded < min {
		return min
	}
	if rounded > max {
		return max
	}
	return rounded
}

func clampFloatSetting(value any, min, max, fallback float64) float64 {
	numeric, ok := settingToNumber(value)
	if !ok {
		return fallback
	}
	if numeric < min {
		return min
	}
	if numeric > max {
		return max
	}
	return numeric
}

// loadSettings 与 NestJS getSettings 对齐：Redis 缓存优先，未命中读
// SystemSetting，再 normalizeSettings；DB/缓存失败都退回默认值。
func (s *Service) loadSettings(ctx context.Context, orgID string, q queryer) associationSettings {
	cacheKey := settingsCacheKeyPrefix + orgID
	if s != nil && s.redis != nil {
		if raw, err := s.redis.Get(ctx, cacheKey).Bytes(); err == nil && len(raw) > 0 {
			var parsed map[string]any
			if json.Unmarshal(raw, &parsed) == nil {
				return normalizeSettings(parsed, nil)
			}
		}
	}

	fallback := fallbackSettings()
	settings := fallback
	raw, found, err := settingValue(ctx, q, systemSettingKeyPrefix+orgID)
	if err != nil {
		settings = fallback
	} else if found {
		if parsed, ok := raw.(map[string]any); ok {
			settings = normalizeSettings(parsed, &fallback)
		} else {
			settings = normalizeSettings(map[string]any{}, &fallback)
		}
	} else {
		settings = normalizeSettings(map[string]any{}, &fallback)
	}

	if s != nil && s.redis != nil {
		if encoded, err := json.Marshal(settingsToMap(settings)); err == nil {
			_ = s.redis.Set(ctx, cacheKey, encoded, settingsCacheTTLSeconds*time.Second).Err()
		}
	}
	return settings
}

// settingValue 读 SystemSetting.value（key 是 MySQL 保留字，需反引号）。
func settingValue(ctx context.Context, q queryer, key string) (any, bool, error) {
	var raw []byte
	err := q.QueryRowContext(ctx, "SELECT value FROM SystemSetting WHERE `key` = ? LIMIT 1", key).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	if len(raw) == 0 {
		return nil, true, nil
	}
	var parsed any
	if json.Unmarshal(raw, &parsed) != nil {
		return nil, true, nil
	}
	return parsed, true, nil
}
