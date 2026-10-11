package userdigest

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

	"github.com/wei500L/newwei/apps/api-go/internal/personalnews"
)

// preferenceKey 与 USER_DIGEST_PREFERENCE_KEY 一致。Nest 迁移和 Prisma 都读这个 key。
const preferenceKey = "ai:digest:preference:v1"

// Preference 是 UserDigestPreferenceV1。字段顺序即 JSON 顺序。
type Preference struct {
	Version               int      `json:"version"`
	FocusEntities         []string `json:"focusEntities"`
	FocusTopics           []string `json:"focusTopics"`
	WindowDays            int      `json:"windowDays"`
	MaxEvents             int      `json:"maxEvents"`
	IncludeIndicators     bool     `json:"includeIndicators"`
	MaxIndicatorsPerEvent int      `json:"maxIndicatorsPerEvent"`
}

func defaultPreference() Preference {
	return Preference{
		Version:               1,
		FocusEntities:         []string{},
		FocusTopics:           []string{},
		WindowDays:            3,
		MaxEvents:             8,
		IncludeIndicators:     true,
		MaxIndicatorsPerEvent: 5,
	}
}

func (s *Service) GetPreference(ctx context.Context, orgID, userID string) (Preference, error) {
	stored, err := s.storedPreference(ctx, orgID, userID)
	if err != nil {
		return Preference{}, err
	}
	if err := s.requireSubs(); err != nil {
		return Preference{}, err
	}
	topics, entities, err := s.subs.GetDigestPreferenceValues(ctx, orgID, userID)
	if err != nil {
		return Preference{}, fmt.Errorf("%w: digest preference values: %v", errMySQL, err)
	}
	// GET 直接采用订阅表的展示值，不再走一遍 normalizeStringArray。
	stored.FocusTopics = nonNilStrings(topics)
	stored.FocusEntities = nonNilStrings(entities)
	return stored, nil
}

func (s *Service) UpdatePreference(ctx context.Context, orgID, userID string, patch preferencePatch) (Preference, error) {
	current, err := s.storedPreference(ctx, orgID, userID)
	if err != nil {
		return Preference{}, err
	}
	if err := s.requireSubs(); err != nil {
		return Preference{}, err
	}
	if patch.focusTopics != nil || patch.focusEntities != nil {
		if err := s.subs.ReplaceSubscriptionsFromDigestPreference(ctx, orgID, userID, patch.focusTopics, patch.focusEntities); err != nil {
			return Preference{}, fmt.Errorf("%w: replace digest subscriptions: %v", errMySQL, err)
		}
	}
	topics, entities, err := s.subs.GetDigestPreferenceValues(ctx, orgID, userID)
	if err != nil {
		return Preference{}, fmt.Errorf("%w: digest preference values: %v", errMySQL, err)
	}
	record := map[string]any{
		"focusEntities":         nonNilStrings(entities),
		"focusTopics":           nonNilStrings(topics),
		"windowDays":            current.WindowDays,
		"maxEvents":             current.MaxEvents,
		"includeIndicators":     current.IncludeIndicators,
		"maxIndicatorsPerEvent": current.MaxIndicatorsPerEvent,
	}
	if patch.windowDays != nil {
		record["windowDays"] = *patch.windowDays
	}
	if patch.maxEvents != nil {
		record["maxEvents"] = *patch.maxEvents
	}
	if patch.includeIndicators != nil {
		record["includeIndicators"] = *patch.includeIndicators
	}
	if patch.maxIndicatorsPerEvent != nil {
		record["maxIndicatorsPerEvent"] = *patch.maxIndicatorsPerEvent
	}
	merged := normalizePreference(record, current)
	if err := s.upsertPreference(ctx, orgID, userID, merged); err != nil {
		return Preference{}, err
	}
	return merged, nil
}

func (s *Service) storedPreference(ctx context.Context, orgID, userID string) (Preference, error) {
	if err := s.requireDB(); err != nil {
		return Preference{}, err
	}
	var raw []byte
	err := s.db.QueryRowContext(ctx,
		"SELECT value FROM UserSetting WHERE orgId = ? AND userId = ? AND `key` = ? LIMIT 1",
		orgID, userID, preferenceKey).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return defaultPreference(), nil
	}
	if err != nil {
		return Preference{}, fmt.Errorf("%w: read digest preference: %v", errMySQL, err)
	}
	return normalizePreferenceJSON(raw, defaultPreference()), nil
}

func (s *Service) upsertPreference(ctx context.Context, orgID, userID string, value Preference) error {
	if err := s.requireDB(); err != nil {
		return err
	}
	payload, err := marshalJSON(value)
	if err != nil {
		return fmt.Errorf("%w: encode digest preference: %v", errMySQL, err)
	}
	id, err := newRowID()
	if err != nil {
		return fmt.Errorf("%w: preference id: %v", errMySQL, err)
	}
	updatedAt := time.Now().UTC().Truncate(time.Millisecond)
	// id 只在 INSERT 时使用。ON DUPLICATE 不改 id / createdAt。
	// updatedAt 没有列默认值，必须显式写入，并截断到毫秒以对齐 DATETIME(3)。
	const query = "INSERT INTO UserSetting (id, orgId, userId, `key`, value, updatedAt) " +
		"VALUES (?, ?, ?, ?, ?, ?) AS new_row " +
		"ON DUPLICATE KEY UPDATE value = new_row.value, updatedAt = new_row.updatedAt"
	if _, err := s.db.ExecContext(ctx, query, id, orgID, userID, preferenceKey, string(payload), updatedAt); err != nil {
		return fmt.Errorf("%w: upsert digest preference: %v", errMySQL, err)
	}
	return nil
}

func normalizePreferenceJSON(raw []byte, fallback Preference) Preference {
	fallback = ensurePreference(fallback)
	if len(raw) == 0 {
		return fallback
	}
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return fallback
	}
	return normalizePreference(value, fallback)
}

func normalizePreference(value any, fallback Preference) Preference {
	fallback = ensurePreference(fallback)
	record, ok := value.(map[string]any)
	if !ok {
		return fallback
	}
	include := fallback.IncludeIndicators
	if typed, ok := record["includeIndicators"].(bool); ok {
		include = typed
	}
	return Preference{
		Version:               1,
		FocusEntities:         normalizeStringArray(record["focusEntities"], 50),
		FocusTopics:           normalizeStringArray(record["focusTopics"], 50),
		WindowDays:            clampInt(record["windowDays"], 1, 30, fallback.WindowDays),
		MaxEvents:             clampInt(record["maxEvents"], 1, 30, fallback.MaxEvents),
		IncludeIndicators:     include,
		MaxIndicatorsPerEvent: clampInt(record["maxIndicatorsPerEvent"], 0, 50, fallback.MaxIndicatorsPerEvent),
	}
}

func ensurePreference(value Preference) Preference {
	if value.Version == 0 {
		value.Version = 1
	}
	value.FocusEntities = nonNilStrings(value.FocusEntities)
	value.FocusTopics = nonNilStrings(value.FocusTopics)
	if value.WindowDays == 0 {
		value.WindowDays = 3
	}
	if value.MaxEvents == 0 {
		value.MaxEvents = 8
	}
	return value
}

func normalizeStringArray(value any, limit int) []string {
	var items []string
	switch typed := value.(type) {
	case []string:
		items = typed
	case []any:
		items = make([]string, 0, len(typed))
		for _, entry := range typed {
			text, ok := entry.(string)
			if !ok {
				continue
			}
			items = append(items, text)
		}
	default:
		return []string{}
	}
	raw := make([]string, 0, len(items))
	for _, entry := range items {
		trimmed := strings.TrimSpace(entry)
		if trimmed == "" {
			continue
		}
		raw = append(raw, jsSlice(trimmed, 128))
		if len(raw) >= limit {
			break
		}
	}
	return dedupeKeep(raw)
}

func clampInt(value any, min, max, fallback int) int {
	number, ok := finiteNumber(value)
	if !ok {
		return fallback
	}
	rounded := jsRound(number)
	if rounded < min {
		return min
	}
	if rounded > max {
		return max
	}
	return rounded
}

func finiteNumber(value any) (float64, bool) {
	switch typed := value.(type) {
	case float64:
		if !isFinite(typed) {
			return 0, false
		}
		return typed, true
	case float32:
		number := float64(typed)
		if !isFinite(number) {
			return 0, false
		}
		return number, true
	case int:
		return float64(typed), true
	case int64:
		return float64(typed), true
	case json.Number:
		number, err := typed.Float64()
		if err != nil || !isFinite(number) {
			return 0, false
		}
		return number, true
	case string:
		return jsParseStoredNumber(typed)
	default:
		return 0, false
	}
}

func isFinite(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0)
}

func jsParseStoredNumber(value string) (float64, bool) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return 0, false
	}
	number, err := strconv.ParseFloat(trimmed, 64)
	if err != nil || !isFinite(number) {
		return 0, false
	}
	return number, true
}

func nonNilStrings(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}

func (s *Service) subscriptionValues(ctx context.Context, orgID, userID string) (personalnews.DigestSubscriptionValues, error) {
	if err := s.requireSubs(); err != nil {
		return personalnews.DigestSubscriptionValues{}, err
	}
	values, err := s.subs.GetDigestSubscriptionValues(ctx, orgID, userID)
	if err != nil {
		return personalnews.DigestSubscriptionValues{}, fmt.Errorf("%w: digest subscriptions: %v", errMySQL, err)
	}
	values.FocusTopics = nonNilStrings(values.FocusTopics)
	values.FocusEntities = nonNilStrings(values.FocusEntities)
	values.FocusKeywords = nonNilStrings(values.FocusKeywords)
	if values.FocusSources == nil {
		values.FocusSources = []personalnews.DigestSource{}
	}
	if values.FocusGeos == nil {
		values.FocusGeos = []personalnews.DigestGeo{}
	}
	return values, nil
}
