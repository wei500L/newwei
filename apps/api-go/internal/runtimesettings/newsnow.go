package runtimesettings

import (
	"context"
	"encoding/json"
	"log"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// NewsNow personalization bounds, copied from newsnow-personalization-settings.service.ts.
const (
	newsNowMinCacheTTLMs               = 0
	newsNowMaxCacheTTLMs               = 300000
	newsNowMinCacheEntries             = 100
	newsNowMaxCacheEntries             = 20000
	newsNowMinThrottleWindowMs         = 1000
	newsNowMaxThrottleWindowMs         = 600000
	newsNowMinRequestsPerWindowPerUser = 1
	newsNowMaxRequestsPerWindowPerUser = 500
	newsNowMinAffinitySourceWeight     = 0
	newsNowMaxAffinitySourceWeight     = 5
	newsNowMinBehaviorSourceWeight     = 0
	newsNowMaxBehaviorSourceWeight     = 5
	newsNowMinFocusSourceBonus         = 0
	newsNowMaxFocusSourceBonus         = 20
	newsNowMinStaleTTLMultiplier       = 1
	newsNowMaxStaleTTLMultiplier       = 20
	newsNowMinStaleTTLFixedMs          = 1000
	newsNowMaxStaleTTLFixedMs          = 3600000
	newsNowMetricsDefaultWindowDays    = 7
	newsNowMetricsMaxWindowDays        = 90
)

// NewsNow invalid-stored-value payload, copied from the service.
const (
	newsNowInvalidCode   = "NEWSNOW_PERSONALIZATION_SETTINGS_INVALID"
	newsNowInvalidError  = "Stored NewsNow personalization settings are invalid."
	newsNowInvalidDetail = "Expected valid values for cacheTtlMs/maxCacheEntries/throttleWindowMs/" +
		"maxRequestsPerWindowPerUser/affinitySourceWeight/behaviorSourceWeight/focusSourceBonus/" +
		"staleTtlStrategy/staleTtlMultiplier/staleTtlFixedMs."
)

// staleTtlStrategy is the closed set of accepted stale-TTL strategies. It is a
// named string type with constants instead of a bare string.
type staleTtlStrategy string

const (
	// staleTtlStrategyMultiplier scales the base TTL by staleTtlMultiplier.
	staleTtlStrategyMultiplier staleTtlStrategy = "multiplier"
	// staleTtlStrategyFixed uses staleTtlFixedMs verbatim.
	staleTtlStrategyFixed staleTtlStrategy = "fixed"
)

// newsNowStaleTtlStrategies is the accepted strategy list in DTO order.
var newsNowStaleTtlStrategies = []staleTtlStrategy{staleTtlStrategyMultiplier, staleTtlStrategyFixed}

// newsNowPersonalizationValues is the persisted/audited payload: ten values in
// the exact key order the service writes. It has no `source` key.
type newsNowPersonalizationValues struct {
	CacheTTLMs                  int              `json:"cacheTtlMs"`
	MaxCacheEntries             int              `json:"maxCacheEntries"`
	ThrottleWindowMs            int              `json:"throttleWindowMs"`
	MaxRequestsPerWindowPerUser int              `json:"maxRequestsPerWindowPerUser"`
	AffinitySourceWeight        float64          `json:"affinitySourceWeight"`
	BehaviorSourceWeight        float64          `json:"behaviorSourceWeight"`
	FocusSourceBonus            float64          `json:"focusSourceBonus"`
	StaleTTLStrategy            staleTtlStrategy `json:"staleTtlStrategy"`
	StaleTTLMultiplier          int              `json:"staleTtlMultiplier"`
	StaleTTLFixedMs             int              `json:"staleTtlFixedMs"`
}

// newsNowPersonalizationSettings is the public GET/PUT response.
type newsNowPersonalizationSettings struct {
	Source SettingSource `json:"source"`
	newsNowPersonalizationValues
}

// newsNowPersonalizationRequest mirrors UpdateNewsnowPersonalizationSettingsDto.
type newsNowPersonalizationRequest struct {
	CacheTTLMs                  json.RawMessage `json:"cacheTtlMs"`
	MaxCacheEntries             json.RawMessage `json:"maxCacheEntries"`
	ThrottleWindowMs            json.RawMessage `json:"throttleWindowMs"`
	MaxRequestsPerWindowPerUser json.RawMessage `json:"maxRequestsPerWindowPerUser"`
	AffinitySourceWeight        json.RawMessage `json:"affinitySourceWeight"`
	BehaviorSourceWeight        json.RawMessage `json:"behaviorSourceWeight"`
	FocusSourceBonus            json.RawMessage `json:"focusSourceBonus"`
	StaleTTLStrategy            json.RawMessage `json:"staleTtlStrategy"`
	StaleTTLMultiplier          json.RawMessage `json:"staleTtlMultiplier"`
	StaleTTLFixedMs             json.RawMessage `json:"staleTtlFixedMs"`
}

// newsNowPersonalizationStoredValue is the typed view of the stored JSON object.
type newsNowPersonalizationStoredValue struct {
	CacheTTLMs                  json.RawMessage `json:"cacheTtlMs"`
	MaxCacheEntries             json.RawMessage `json:"maxCacheEntries"`
	ThrottleWindowMs            json.RawMessage `json:"throttleWindowMs"`
	MaxRequestsPerWindowPerUser json.RawMessage `json:"maxRequestsPerWindowPerUser"`
	AffinitySourceWeight        json.RawMessage `json:"affinitySourceWeight"`
	BehaviorSourceWeight        json.RawMessage `json:"behaviorSourceWeight"`
	FocusSourceBonus            json.RawMessage `json:"focusSourceBonus"`
	StaleTTLStrategy            json.RawMessage `json:"staleTtlStrategy"`
	StaleTTLMultiplier          json.RawMessage `json:"staleTtlMultiplier"`
	StaleTTLFixedMs             json.RawMessage `json:"staleTtlFixedMs"`
}

// newsNowMetricsTotals is the metrics accumulator and the `totals` object: ten
// integer/ratio keys, no `date`.
type newsNowMetricsTotals struct {
	RequestCount          int     `json:"requestCount"`
	CacheHitFreshCount    int     `json:"cacheHitFreshCount"`
	CacheHitStaleCount    int     `json:"cacheHitStaleCount"`
	CacheHitTotalCount    int     `json:"cacheHitTotalCount"`
	CacheHitRate          float64 `json:"cacheHitRate"`
	ThrottleLimitedCount  int     `json:"throttleLimitedCount"`
	ThrottleRejectedCount int     `json:"throttleRejectedCount"`
	ThrottleRate          float64 `json:"throttleRate"`
	TrimCount             int     `json:"trimCount"`
	TrimEvictedCount      int     `json:"trimEvictedCount"`
}

// newsNowMetricsRow is one day of the metrics window: `date` first, then the ten
// keys inlined from the totals accumulator.
type newsNowMetricsRow struct {
	Date string `json:"date"`
	newsNowMetricsTotals
}

// newsNowMetricsSnapshot is the metrics response: from, to, windowDays, totals,
// rows (ascending date order, oldest first).
type newsNowMetricsSnapshot struct {
	From       string               `json:"from"`
	To         string               `json:"to"`
	WindowDays int                  `json:"windowDays"`
	Totals     newsNowMetricsTotals `json:"totals"`
	Rows       []newsNowMetricsRow  `json:"rows"`
}

// defaultNewsNowPersonalizationValues mirrors DEFAULT_SETTINGS.
func defaultNewsNowPersonalizationValues() newsNowPersonalizationValues {
	return newsNowPersonalizationValues{
		CacheTTLMs:                  20000,
		MaxCacheEntries:             2000,
		ThrottleWindowMs:            10000,
		MaxRequestsPerWindowPerUser: 40,
		AffinitySourceWeight:        0.42,
		BehaviorSourceWeight:        0.58,
		FocusSourceBonus:            0.35,
		StaleTTLStrategy:            staleTtlStrategyMultiplier,
		StaleTTLMultiplier:          3,
		StaleTTLFixedMs:             60000,
	}
}

// invalidNewsNowSettings builds the 409 for an unusable stored row.
func invalidNewsNowSettings() error {
	return &httpError{
		status:  http.StatusConflict,
		message: newsNowInvalidError,
		code:    newsNowInvalidCode,
		detail:  newsNowInvalidDetail,
	}
}

// newsNowStrictInt mirrors toStrictInt: a finite JSON number (or numeric
// string), integral and inside [min,max].
func newsNowStrictInt(raw json.RawMessage, min, max int) (int, bool) {
	value, ok := storedNumber(raw)
	if !ok || !jsIsInteger(value) || value < float64(min) || value > float64(max) {
		return 0, false
	}
	return int(value), true
}

// newsNowStrictFloat mirrors toStrictFloat, including the 4 decimal place
// rounding applied by Number(parsed.toFixed(4)).
func newsNowStrictFloat(raw json.RawMessage, min, max float64) (float64, bool) {
	value, ok := storedNumber(raw)
	if !ok || math.IsNaN(value) || math.IsInf(value, 0) || value < min || value > max {
		return 0, false
	}
	return jsRoundTo4(value), true
}

// newsNowStaleTTLStrategy mirrors toStaleTtlStrategy: the value must be a string
// whose trimmed form is one of the accepted strategies.
func newsNowStaleTTLStrategy(raw json.RawMessage) (staleTtlStrategy, bool) {
	if !present(raw) || isNull(raw) || !strings.HasPrefix(strings.TrimSpace(string(raw)), "\"") {
		return "", false
	}
	var text string
	if err := json.Unmarshal([]byte(strings.TrimSpace(string(raw))), &text); err != nil {
		return "", false
	}
	trimmed := staleTtlStrategy(strings.TrimSpace(text))
	for _, candidate := range newsNowStaleTtlStrategies {
		if trimmed == candidate {
			return trimmed, true
		}
	}
	return "", false
}

// requireNewsNowInt raises the service's flat 400 for a missing or invalid int.
func requireNewsNowInt(raw json.RawMessage, field string, min, max int) (int, error) {
	value, ok := newsNowStrictInt(raw, min, max)
	if !ok {
		return 0, &httpError{
			status:  http.StatusBadRequest,
			message: field + " must be an integer between " + strconv.Itoa(min) + " and " + strconv.Itoa(max),
		}
	}
	return value, nil
}

// parseNewsNowPersonalizationRequest validates the PUT body. The DTO layer runs
// first (class-validator messages), then the service layer reproduces the
// normalizeInputOrThrow flat 400s and the weight cross-field rule.
func parseNewsNowPersonalizationRequest(body []byte) (newsNowPersonalizationValues, error) {
	var dto newsNowPersonalizationRequest
	if err := decodeBodyError(newStrictDecoder(body).Decode(&dto)); err != nil {
		return newsNowPersonalizationValues{}, err
	}
	problems := validationErrors{}
	numberField(&problems, dto.CacheTTLMs, "cacheTtlMs", true, newsNowMinCacheTTLMs, newsNowMaxCacheTTLMs)
	numberField(&problems, dto.MaxCacheEntries, "maxCacheEntries", true, newsNowMinCacheEntries, newsNowMaxCacheEntries)
	numberField(&problems, dto.ThrottleWindowMs, "throttleWindowMs", true, newsNowMinThrottleWindowMs, newsNowMaxThrottleWindowMs)
	numberField(&problems, dto.MaxRequestsPerWindowPerUser, "maxRequestsPerWindowPerUser", true, newsNowMinRequestsPerWindowPerUser, newsNowMaxRequestsPerWindowPerUser)
	floatField(&problems, dto.AffinitySourceWeight, "affinitySourceWeight", false, newsNowMinAffinitySourceWeight, newsNowMaxAffinitySourceWeight, 4)
	floatField(&problems, dto.BehaviorSourceWeight, "behaviorSourceWeight", false, newsNowMinBehaviorSourceWeight, newsNowMaxBehaviorSourceWeight, 4)
	floatField(&problems, dto.FocusSourceBonus, "focusSourceBonus", false, newsNowMinFocusSourceBonus, newsNowMaxFocusSourceBonus, 4)
	enumField(&problems, dto.StaleTTLStrategy, "staleTtlStrategy", []string{string(staleTtlStrategyMultiplier), string(staleTtlStrategyFixed)})
	numberField(&problems, dto.StaleTTLMultiplier, "staleTtlMultiplier", true, newsNowMinStaleTTLMultiplier, newsNowMaxStaleTTLMultiplier)
	numberField(&problems, dto.StaleTTLFixedMs, "staleTtlFixedMs", true, newsNowMinStaleTTLFixedMs, newsNowMaxStaleTTLFixedMs)
	if err := problems.err(); err != nil {
		return newsNowPersonalizationValues{}, err
	}

	values := defaultNewsNowPersonalizationValues()
	cacheTTLMs, err := requireNewsNowInt(dto.CacheTTLMs, "cacheTtlMs", newsNowMinCacheTTLMs, newsNowMaxCacheTTLMs)
	if err != nil {
		return newsNowPersonalizationValues{}, err
	}
	maxCacheEntries, err := requireNewsNowInt(dto.MaxCacheEntries, "maxCacheEntries", newsNowMinCacheEntries, newsNowMaxCacheEntries)
	if err != nil {
		return newsNowPersonalizationValues{}, err
	}
	throttleWindowMs, err := requireNewsNowInt(dto.ThrottleWindowMs, "throttleWindowMs", newsNowMinThrottleWindowMs, newsNowMaxThrottleWindowMs)
	if err != nil {
		return newsNowPersonalizationValues{}, err
	}
	maxRequestsPerWindowPerUser, err := requireNewsNowInt(dto.MaxRequestsPerWindowPerUser, "maxRequestsPerWindowPerUser", newsNowMinRequestsPerWindowPerUser, newsNowMaxRequestsPerWindowPerUser)
	if err != nil {
		return newsNowPersonalizationValues{}, err
	}
	values.CacheTTLMs = cacheTTLMs
	values.MaxCacheEntries = maxCacheEntries
	values.ThrottleWindowMs = throttleWindowMs
	values.MaxRequestsPerWindowPerUser = maxRequestsPerWindowPerUser

	affinity, err := optionalNewsNowFloat(dto.AffinitySourceWeight, "affinitySourceWeight", newsNowMinAffinitySourceWeight, newsNowMaxAffinitySourceWeight, values.AffinitySourceWeight)
	if err != nil {
		return newsNowPersonalizationValues{}, err
	}
	behavior, err := optionalNewsNowFloat(dto.BehaviorSourceWeight, "behaviorSourceWeight", newsNowMinBehaviorSourceWeight, newsNowMaxBehaviorSourceWeight, values.BehaviorSourceWeight)
	if err != nil {
		return newsNowPersonalizationValues{}, err
	}
	if affinity+behavior <= 0 {
		return newsNowPersonalizationValues{}, &httpError{
			status:  http.StatusBadRequest,
			message: "affinitySourceWeight + behaviorSourceWeight must be greater than 0",
		}
	}
	values.AffinitySourceWeight = affinity
	values.BehaviorSourceWeight = behavior

	focusBonus, err := optionalNewsNowFloat(dto.FocusSourceBonus, "focusSourceBonus", newsNowMinFocusSourceBonus, newsNowMaxFocusSourceBonus, values.FocusSourceBonus)
	if err != nil {
		return newsNowPersonalizationValues{}, err
	}
	values.FocusSourceBonus = focusBonus

	if present(dto.StaleTTLStrategy) {
		strategy, ok := newsNowStaleTTLStrategy(dto.StaleTTLStrategy)
		if !ok {
			return newsNowPersonalizationValues{}, &httpError{
				status:  http.StatusBadRequest,
				message: "staleTtlStrategy must be one of multiplier, fixed",
			}
		}
		values.StaleTTLStrategy = strategy
	}
	staleTTLMultiplier, err := requireNewsNowInt(dto.StaleTTLMultiplier, "staleTtlMultiplier", newsNowMinStaleTTLMultiplier, newsNowMaxStaleTTLMultiplier)
	if err != nil {
		return newsNowPersonalizationValues{}, err
	}
	staleTTLFixedMs, err := requireNewsNowInt(dto.StaleTTLFixedMs, "staleTtlFixedMs", newsNowMinStaleTTLFixedMs, newsNowMaxStaleTTLFixedMs)
	if err != nil {
		return newsNowPersonalizationValues{}, err
	}
	values.StaleTTLMultiplier = staleTTLMultiplier
	values.StaleTTLFixedMs = staleTTLFixedMs
	return values, nil
}

// optionalNewsNowFloat applies the service rule for an optional float: an absent
// key keeps the default, a present but invalid value raises the flat 400.
func optionalNewsNowFloat(raw json.RawMessage, field string, min, max float64, fallback float64) (float64, error) {
	if !present(raw) {
		return fallback, nil
	}
	value, ok := newsNowStrictFloat(raw, min, max)
	if !ok {
		return 0, &httpError{
			status:  http.StatusBadRequest,
			message: field + " must be a number between " + strconv.Itoa(int(min)) + " and " + strconv.Itoa(int(max)),
		}
	}
	return value, nil
}

// readNewsNowPersonalizationSettings mirrors normalizeStoredSettings: an absent
// row returns the defaults; a present row must satisfy every field rule and the
// weight constraint, otherwise the read fails with 409.
func (s *Service) readNewsNowPersonalizationSettings(ctx context.Context) (newsNowPersonalizationSettings, error) {
	defaults := defaultNewsNowPersonalizationValues()
	raw, found, err := s.loadSetting(ctx, settingKeyNewsNowPersonalization)
	if err != nil {
		return newsNowPersonalizationSettings{}, err
	}
	if !found {
		return newsNowPersonalizationSettings{Source: SourceDefault, newsNowPersonalizationValues: defaults}, nil
	}
	var stored newsNowPersonalizationStoredValue
	if err := json.Unmarshal(raw, &stored); err != nil {
		return newsNowPersonalizationSettings{}, invalidNewsNowSettings()
	}

	cacheTTLMs, ok := newsNowStrictInt(stored.CacheTTLMs, newsNowMinCacheTTLMs, newsNowMaxCacheTTLMs)
	if !ok {
		return newsNowPersonalizationSettings{}, invalidNewsNowSettings()
	}
	maxCacheEntries, ok := newsNowStrictInt(stored.MaxCacheEntries, newsNowMinCacheEntries, newsNowMaxCacheEntries)
	if !ok {
		return newsNowPersonalizationSettings{}, invalidNewsNowSettings()
	}
	throttleWindowMs, ok := newsNowStrictInt(stored.ThrottleWindowMs, newsNowMinThrottleWindowMs, newsNowMaxThrottleWindowMs)
	if !ok {
		return newsNowPersonalizationSettings{}, invalidNewsNowSettings()
	}
	maxRequests, ok := newsNowStrictInt(stored.MaxRequestsPerWindowPerUser, newsNowMinRequestsPerWindowPerUser, newsNowMaxRequestsPerWindowPerUser)
	if !ok {
		return newsNowPersonalizationSettings{}, invalidNewsNowSettings()
	}

	// Optional fields: absent stays absent; present but invalid invalidates the
	// whole record.
	affinity, presentAffinity, valid := optionalStoredNewsNowFloat(stored.AffinitySourceWeight, newsNowMinAffinitySourceWeight, newsNowMaxAffinitySourceWeight)
	if !valid {
		return newsNowPersonalizationSettings{}, invalidNewsNowSettings()
	}
	behavior, presentBehavior, valid := optionalStoredNewsNowFloat(stored.BehaviorSourceWeight, newsNowMinBehaviorSourceWeight, newsNowMaxBehaviorSourceWeight)
	if !valid {
		return newsNowPersonalizationSettings{}, invalidNewsNowSettings()
	}
	focusBonus, presentFocus, valid := optionalStoredNewsNowFloat(stored.FocusSourceBonus, newsNowMinFocusSourceBonus, newsNowMaxFocusSourceBonus)
	if !valid {
		return newsNowPersonalizationSettings{}, invalidNewsNowSettings()
	}
	strategy := defaults.StaleTTLStrategy
	if present(stored.StaleTTLStrategy) {
		parsed, strategyOK := newsNowStaleTTLStrategy(stored.StaleTTLStrategy)
		if !strategyOK {
			return newsNowPersonalizationSettings{}, invalidNewsNowSettings()
		}
		strategy = parsed
	}
	staleTTLMultiplier := defaults.StaleTTLMultiplier
	if present(stored.StaleTTLMultiplier) {
		parsed, multiplierOK := newsNowStrictInt(stored.StaleTTLMultiplier, newsNowMinStaleTTLMultiplier, newsNowMaxStaleTTLMultiplier)
		if !multiplierOK {
			return newsNowPersonalizationSettings{}, invalidNewsNowSettings()
		}
		staleTTLMultiplier = parsed
	}
	staleTTLFixedMs := defaults.StaleTTLFixedMs
	if present(stored.StaleTTLFixedMs) {
		parsed, fixedOK := newsNowStrictInt(stored.StaleTTLFixedMs, newsNowMinStaleTTLFixedMs, newsNowMaxStaleTTLFixedMs)
		if !fixedOK {
			return newsNowPersonalizationSettings{}, invalidNewsNowSettings()
		}
		staleTTLFixedMs = parsed
	}

	normalizedAffinity := defaults.AffinitySourceWeight
	if presentAffinity {
		normalizedAffinity = affinity
	}
	normalizedBehavior := defaults.BehaviorSourceWeight
	if presentBehavior {
		normalizedBehavior = behavior
	}
	if normalizedAffinity+normalizedBehavior <= 0 {
		return newsNowPersonalizationSettings{}, invalidNewsNowSettings()
	}
	normalizedFocus := defaults.FocusSourceBonus
	if presentFocus {
		normalizedFocus = focusBonus
	}

	return newsNowPersonalizationSettings{
		Source: SourceDB,
		newsNowPersonalizationValues: newsNowPersonalizationValues{
			CacheTTLMs:                  cacheTTLMs,
			MaxCacheEntries:             maxCacheEntries,
			ThrottleWindowMs:            throttleWindowMs,
			MaxRequestsPerWindowPerUser: maxRequests,
			AffinitySourceWeight:        normalizedAffinity,
			BehaviorSourceWeight:        normalizedBehavior,
			FocusSourceBonus:            normalizedFocus,
			StaleTTLStrategy:            strategy,
			StaleTTLMultiplier:          staleTTLMultiplier,
			StaleTTLFixedMs:             staleTTLFixedMs,
		},
	}, nil
}

// optionalStoredNewsNowFloat distinguishes absent (found=false, ok=true) from
// present-but-invalid (ok=false).
func optionalStoredNewsNowFloat(raw json.RawMessage, min, max float64) (value float64, found bool, ok bool) {
	if !present(raw) {
		return 0, false, true
	}
	parsed, valid := newsNowStrictFloat(raw, min, max)
	if !valid {
		return 0, true, false
	}
	return parsed, true, true
}

// updateNewsNowPersonalizationSettings mirrors updateSettings: a description
// overwriting upsert, the audit row and a source:"db" response.
func (s *Service) updateNewsNowPersonalizationSettings(ctx context.Context, orgID, actorID string, values newsNowPersonalizationValues) (newsNowPersonalizationSettings, error) {
	if s == nil || s.db == nil {
		return newsNowPersonalizationSettings{}, errNoDatabase
	}
	encoded, err := json.Marshal(values)
	if err != nil {
		return newsNowPersonalizationSettings{}, err
	}
	if err := s.upsertSettingForceDescription(ctx, settingKeyNewsNowPersonalization, encoded,
		descriptionNewsNowPersonalization, nullableActorID(actorID)); err != nil {
		return newsNowPersonalizationSettings{}, err
	}
	s.writeAuditLogBestEffort(ctx, orgID, actorID, "newsnow_personalization_settings_update", encoded)
	return newsNowPersonalizationSettings{Source: SourceDB, newsNowPersonalizationValues: values}, nil
}

// metricsWindowDays mirrors the controller's Number() guard plus the service's
// normalizeMetricsWindowDays. multipleValues reports that the query string
// repeated the parameter (Express yields an array, Number() yields NaN).
func metricsWindowDays(raw string, presentFlag, multipleValues bool) int {
	if !presentFlag || multipleValues {
		return newsNowMetricsDefaultWindowDays
	}
	parsed := jsStringToNumber(raw)
	if math.IsNaN(parsed) || math.IsInf(parsed, 0) {
		return newsNowMetricsDefaultWindowDays
	}
	normalized := int(math.Floor(parsed))
	if normalized < 1 {
		return 1
	}
	if normalized > newsNowMetricsMaxWindowDays {
		return newsNowMetricsMaxWindowDays
	}
	return normalized
}

// toPositiveInt mirrors toPositiveInt: floor, and anything non-numeric or not
// strictly positive becomes 0.
func toPositiveInt(value string) int {
	parsed := jsStringToNumber(value)
	if math.IsNaN(parsed) || math.IsInf(parsed, 0) {
		return 0
	}
	rounded := int(math.Floor(parsed))
	if rounded > 0 {
		return rounded
	}
	return 0
}

// safeRatio mirrors safeRatio: zero when the denominator is not positive, else a
// non-negative ratio rounded to four decimal places.
func safeRatio(numerator, denominator int) float64 {
	if denominator <= 0 {
		return 0
	}
	value := float64(numerator)
	if value < 0 {
		value = 0
	}
	return jsRoundTo4(value / float64(denominator))
}

// metricsRowFromRecord mirrors metricsRowFromRecord for one Redis hash.
func metricsRowFromRecord(date string, record map[string]string) newsNowMetricsRow {
	row := newsNowMetricsRow{Date: date}
	row.RequestCount = toPositiveInt(record["requestCount"])
	row.CacheHitFreshCount = toPositiveInt(record["cacheHitFreshCount"])
	row.CacheHitStaleCount = toPositiveInt(record["cacheHitStaleCount"])
	row.CacheHitTotalCount = row.CacheHitFreshCount + row.CacheHitStaleCount
	row.ThrottleLimitedCount = toPositiveInt(record["throttleLimitedCount"])
	row.ThrottleRejectedCount = toPositiveInt(record["throttleRejectedCount"])
	row.TrimCount = toPositiveInt(record["trimCount"])
	row.TrimEvictedCount = toPositiveInt(record["trimEvictedCount"])
	row.CacheHitRate = safeRatio(row.CacheHitTotalCount, row.RequestCount)
	row.ThrottleRate = safeRatio(row.ThrottleLimitedCount, row.RequestCount)
	return row
}

// getNewsNowMetricsSnapshot mirrors getRuntimeMetricsSnapshot: one Redis hash
// per UTC day, oldest first, always windowDays rows. A per-day Redis failure is
// logged and yields an all-zero row instead of failing the request.
func (s *Service) getNewsNowMetricsSnapshot(ctx context.Context, windowDays int) newsNowMetricsSnapshot {
	today := time.Now().UTC().Truncate(24 * time.Hour)
	start := today.AddDate(0, 0, -(windowDays - 1))
	rows := make([]newsNowMetricsRow, 0, windowDays)
	totals := newsNowMetricsTotals{}

	for index := 0; index < windowDays; index++ {
		day := start.AddDate(0, 0, index)
		date := day.Format("2006-01-02")
		record := map[string]string{}
		if s != nil && s.redis != nil {
			fetched, err := s.redis.HGetAll(ctx, newsNowMetricsKeyPrefix+date).Result()
			if err != nil {
				log.Printf("runtimesettings: failed to read NewsNow personalization metrics bucket %q: %v", date, err)
			} else {
				record = fetched
			}
		}
		row := metricsRowFromRecord(date, record)
		rows = append(rows, row)
		totals.RequestCount += row.RequestCount
		totals.CacheHitFreshCount += row.CacheHitFreshCount
		totals.CacheHitStaleCount += row.CacheHitStaleCount
		totals.CacheHitTotalCount += row.CacheHitTotalCount
		totals.ThrottleLimitedCount += row.ThrottleLimitedCount
		totals.ThrottleRejectedCount += row.ThrottleRejectedCount
		totals.TrimCount += row.TrimCount
		totals.TrimEvictedCount += row.TrimEvictedCount
	}
	totals.CacheHitRate = safeRatio(totals.CacheHitTotalCount, totals.RequestCount)
	totals.ThrottleRate = safeRatio(totals.ThrottleLimitedCount, totals.RequestCount)

	return newsNowMetricsSnapshot{
		From:       start.Format("2006-01-02"),
		To:         today.Format("2006-01-02"),
		WindowDays: windowDays,
		Totals:     totals,
		Rows:       rows,
	}
}
