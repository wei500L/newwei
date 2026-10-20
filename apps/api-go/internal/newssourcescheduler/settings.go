package newssourcescheduler

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/newssources"
)

// This file ports NewsSourceSchedulerSettingsService.getSettings and the
// resolveSeedRuntimeSettings clamp layer. The stored SystemSetting row is shared
// with NestJS: Go reads the same key, applies the same 30-second cache and the
// same defaults, so a source's discovery TTL, freshness window and RSS adaptive
// thresholds do not change when execution ownership flips.
//
// A stored value that NestJS rejects with
// NEWS_SOURCE_SCHEDULER_SETTINGS_INVALID is rejected here too: the tick fails
// and logs instead of silently running with clamped garbage.

const (
	seedRuntimeSettingsKey         = "news_source_scheduler_settings"
	seedRuntimeSettingsCacheTTL    = 30 * time.Second
	maxURLQueryParamAllowlistSize  = 64
	minSeedCacheTTLSettingSeconds  = 10
	maxSeedCacheTTLSettingSeconds  = 3_600
	minSeedFreshnessSettingDays    = 1
	maxSeedFreshnessSettingDays    = 3_650
	minRSSAdaptiveHitRatePercent   = 0
	maxRSSAdaptiveHitRatePercent   = 100
	minColdConsecutiveNoHitRuns    = 1
	maxColdConsecutiveNoHitRuns    = 24
	minRSSAdaptiveIntervalSetting  = 10
	maxRSSAdaptiveIntervalSetting  = 21_600
	minRSSAdaptiveDivisorSetting   = 1
	maxRSSAdaptiveDivisorSetting   = 8
	minRSSAdaptiveMultiplierSettin = 1
	maxRSSAdaptiveMultiplierSettin = 8
)

// errSeedRuntimeSettingsInvalid is the NestJS
// NEWS_SOURCE_SCHEDULER_SETTINGS_INVALID condition.
var errSeedRuntimeSettingsInvalid = errors.New("stored news source scheduler settings are invalid")

// seedRuntimeSettingsCache is the 30-second in-process cache.
type seedRuntimeSettingsCache struct {
	mutex    sync.Mutex
	value    *seedRuntimeSettings
	expires  time.Time
	inflight *seedRuntimeSettingsCall
}

// seedRuntimeSettingsCall collapses concurrent loads.
type seedRuntimeSettingsCall struct {
	done  chan struct{}
	value seedRuntimeSettings
	err   error
}

// loadSeedRuntimeSettings resolves the shared runtime settings.
func (s *Service) loadSeedRuntimeSettings(ctx context.Context) (seedRuntimeSettings, error) {
	cache := &s.settingsCache
	cache.mutex.Lock()
	if cache.value != nil && cache.expires.After(s.now()) {
		value := *cache.value
		cache.mutex.Unlock()
		return value, nil
	}
	if cache.inflight != nil {
		call := cache.inflight
		cache.mutex.Unlock()
		<-call.done
		return call.value, call.err
	}
	call := &seedRuntimeSettingsCall{done: make(chan struct{})}
	cache.inflight = call
	cache.mutex.Unlock()

	value, err := s.readSeedRuntimeSettings(ctx)

	cache.mutex.Lock()
	call.value = value
	call.err = err
	close(call.done)
	cache.inflight = nil
	if err == nil {
		copied := value
		cache.value = &copied
		cache.expires = s.now().Add(seedRuntimeSettingsCacheTTL)
	}
	cache.mutex.Unlock()
	return value, err
}

// readSeedRuntimeSettings reads and validates the stored row, then applies the
// resolveSeedRuntimeSettings clamps.
func (s *Service) readSeedRuntimeSettings(ctx context.Context) (seedRuntimeSettings, error) {
	stored, err := s.readStoredSeedRuntimeSettings(ctx)
	if err != nil {
		return seedRuntimeSettings{}, err
	}
	if stored == nil {
		return defaultSeedRuntimeSettings(), nil
	}
	settings, err := parseStoredSeedRuntimeSettings(stored)
	if err != nil {
		return seedRuntimeSettings{}, err
	}
	return clampSeedRuntimeSettings(settings), nil
}

// readStoredSeedRuntimeSettings returns the raw JSON value, or nil when the row
// does not exist.
func (s *Service) readStoredSeedRuntimeSettings(ctx context.Context) (json.RawMessage, error) {
	if s.db == nil {
		return nil, errors.New("newssourcescheduler: mysql is not configured")
	}
	var value []byte
	err := s.db.QueryRowContext(ctx,
		"SELECT value FROM SystemSetting WHERE `key` = ?", seedRuntimeSettingsKey).Scan(&value)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return json.RawMessage(value), nil
}

// storedSeedRuntimeSettings is the lenient projection used before validation.
type storedSeedRuntimeSettings struct {
	object jsonObject
}

// parseStoredSeedRuntimeSettings validates the persisted object exactly like the
// NestJS loader: every present field must be in range and the three cross-field
// rules must hold.
func parseStoredSeedRuntimeSettings(raw json.RawMessage) (*storedSeedRuntimeSettings, error) {
	trimmed := trimJS(string(raw))
	if trimmed == "" || trimmed == "null" {
		return nil, nil
	}
	object, ok := decodeObject(raw)
	if !ok {
		return nil, errSeedRuntimeSettingsInvalid
	}
	if _, err := strictSettingInt(object, "seedFreshnessWindowDays", minSeedFreshnessSettingDays, maxSeedFreshnessSettingDays, true); err != nil {
		return nil, err
	}
	if _, err := strictSettingInt(object, "seedCacheTtlSecondsSitemapRss", minSeedCacheTTLSettingSeconds, maxSeedCacheTTLSettingSeconds, false); err != nil {
		return nil, err
	}
	if _, err := strictSettingInt(object, "seedCacheTtlSecondsListDeep", minSeedCacheTTLSettingSeconds, maxSeedCacheTTLSettingSeconds, false); err != nil {
		return nil, err
	}
	if rawForce, present := object["seedCacheTtlForceGlobal"]; present && string(rawForce) != "null" {
		var value bool
		if err := json.Unmarshal(rawForce, &value); err != nil {
			return nil, errSeedRuntimeSettingsInvalid
		}
	}
	if rawAllowlist, present := object["seedUrlQueryParamAllowlist"]; present && string(rawAllowlist) != "null" {
		var entries []json.RawMessage
		if err := json.Unmarshal(rawAllowlist, &entries); err != nil {
			return nil, errSeedRuntimeSettingsInvalid
		}
		if len(entries) > maxURLQueryParamAllowlistSize {
			return nil, errSeedRuntimeSettingsInvalid
		}
		for _, entry := range entries {
			var text string
			if err := json.Unmarshal(entry, &text); err != nil {
				return nil, errSeedRuntimeSettingsInvalid
			}
			if len(normalizeSeedQueryParamAllowlist([]string{text})) == 0 {
				return nil, errSeedRuntimeSettingsInvalid
			}
		}
	}
	hotHitRate, err := strictSettingInt(object, "rssAdaptiveHotHitRatePercent", minRSSAdaptiveHitRatePercent, maxRSSAdaptiveHitRatePercent, false)
	if err != nil {
		return nil, err
	}
	warmHitRate, err := strictSettingInt(object, "rssAdaptiveWarmHitRatePercent", minRSSAdaptiveHitRatePercent, maxRSSAdaptiveHitRatePercent, false)
	if err != nil {
		return nil, err
	}
	if hotHitRate != nil && warmHitRate != nil && *warmHitRate > *hotHitRate {
		return nil, errSeedRuntimeSettingsInvalid
	}
	if _, err := strictSettingInt(object, "rssAdaptiveColdConsecutiveNoHitRuns", minColdConsecutiveNoHitRuns, maxColdConsecutiveNoHitRuns, false); err != nil {
		return nil, err
	}
	if _, err := strictSettingInt(object, "rssAdaptiveHotIntervalSeconds", minRSSAdaptiveIntervalSetting, maxRSSAdaptiveIntervalSetting, false); err != nil {
		return nil, err
	}
	if _, err := strictSettingInt(object, "rssAdaptiveWarmIntervalDivisor", minRSSAdaptiveDivisorSetting, maxRSSAdaptiveDivisorSetting, false); err != nil {
		return nil, err
	}
	warmMinInterval, err := strictSettingInt(object, "rssAdaptiveWarmMinIntervalSeconds", minRSSAdaptiveIntervalSetting, maxRSSAdaptiveIntervalSetting, false)
	if err != nil {
		return nil, err
	}
	if _, err := strictSettingInt(object, "rssAdaptiveColdIntervalMultiplier", minRSSAdaptiveMultiplierSettin, maxRSSAdaptiveMultiplierSettin, false); err != nil {
		return nil, err
	}
	coldMaxInterval, err := strictSettingInt(object, "rssAdaptiveColdMaxIntervalSeconds", minRSSAdaptiveIntervalSetting, maxRSSAdaptiveIntervalSetting, false)
	if err != nil {
		return nil, err
	}
	if warmMinInterval != nil && coldMaxInterval != nil && *coldMaxInterval < *warmMinInterval {
		return nil, errSeedRuntimeSettingsInvalid
	}
	hotCap, err := strictSettingInt(object, "rssAdaptiveHotDiscoveryCacheTtlCapSeconds", minSeedCacheTTLSettingSeconds, maxSeedCacheTTLSettingSeconds, false)
	if err != nil {
		return nil, err
	}
	warmCap, err := strictSettingInt(object, "rssAdaptiveWarmDiscoveryCacheTtlCapSeconds", minSeedCacheTTLSettingSeconds, maxSeedCacheTTLSettingSeconds, false)
	if err != nil {
		return nil, err
	}
	if hotCap != nil && warmCap != nil && *warmCap < *hotCap {
		return nil, errSeedRuntimeSettingsInvalid
	}
	return &storedSeedRuntimeSettings{object: object}, nil
}

// strictSettingInt reads an optional integer setting in [min, max].
func strictSettingInt(object jsonObject, key string, min, max int, required bool) (*int, error) {
	raw, present := object[key]
	if !present || trimJS(string(raw)) == "null" {
		if required {
			return nil, fmt.Errorf("%w: missing %s", errSeedRuntimeSettingsInvalid, key)
		}
		return nil, nil
	}
	var number float64
	strictDecode := json.Unmarshal(raw, &number)
	if strictDecode != nil {
		var text string
		if textErr := json.Unmarshal(raw, &text); textErr != nil {
			return nil, errSeedRuntimeSettingsInvalid
		}
		parsed, ok := parseStrictNumber(text)
		if !ok {
			return nil, errSeedRuntimeSettingsInvalid
		}
		number = parsed
	}
	rounded := jsRound(number)
	if rounded != number || rounded < float64(min) || rounded > float64(max) {
		return nil, errSeedRuntimeSettingsInvalid
	}
	value := int(rounded)
	return &value, nil
}

// parseStrictNumber parses the string form Number(value) accepts.
func parseStrictNumber(value string) (float64, bool) {
	trimmed := trimJS(value)
	if trimmed == "" {
		return 0, false
	}
	var parsed float64
	if err := json.Unmarshal([]byte(trimmed), &parsed); err != nil {
		return 0, false
	}
	return parsed, true
}

// clampSeedRuntimeSettings is resolveSeedRuntimeSettings applied to an already
// validated stored object.
func clampSeedRuntimeSettings(stored *storedSeedRuntimeSettings) seedRuntimeSettings {
	object := stored.object

	settings := seedRuntimeSettings{
		SeedFreshnessWindowDays: clampIntValue(intValue(object, "seedFreshnessWindowDays"), 1, maxSeedFreshnessWindowDays, defaultSeedFreshnessWindowDays),
		SeedCacheTTLSecondsSitemapRSS: clampIntValue(
			intValue(object, "seedCacheTtlSecondsSitemapRss"), minSeedCacheTTLSeconds, maxSeedCacheTTLSeconds,
			defaultSeedCacheTTLSecondsSitemap),
		SeedCacheTTLSecondsListDeep: clampIntValue(
			intValue(object, "seedCacheTtlSecondsListDeep"), minSeedCacheTTLSeconds, maxSeedCacheTTLSeconds,
			defaultSeedCacheTTLSecondsListDeep),
		SeedCacheTTLForceGlobal:    boolValue(object, "seedCacheTtlForceGlobal", defaultSeedCacheTTLForceGlobal),
		SeedURLQueryParamAllowlist: resolveSeedRuntimeAllowlist(object),
		RSSAdaptiveHotHitRatePercent: clampIntValue(
			intValue(object, "rssAdaptiveHotHitRatePercent"), 0, 100, defaultRSSAdaptiveHotHitRatePercent),
		RSSAdaptiveWarmHitRatePercent: clampIntValue(
			intValue(object, "rssAdaptiveWarmHitRatePercent"), 0, 100, defaultRSSAdaptiveWarmHitRatePercent),
		RSSAdaptiveColdConsecutiveNoHitRuns: clampIntValue(
			intValue(object, "rssAdaptiveColdConsecutiveNoHitRuns"), 1, 24, defaultRSSAdaptiveColdConsecutiveNoHitRuns),
		RSSAdaptiveHotIntervalSeconds: clampIntValue(
			intValue(object, "rssAdaptiveHotIntervalSeconds"), 10, 21_600, defaultRSSAdaptiveHotIntervalSeconds),
		RSSAdaptiveWarmIntervalDivisor: clampIntValue(
			intValue(object, "rssAdaptiveWarmIntervalDivisor"), 1, 8, defaultRSSAdaptiveWarmIntervalDivisor),
		RSSAdaptiveWarmMinIntervalSeconds: clampIntValue(
			intValue(object, "rssAdaptiveWarmMinIntervalSeconds"), 10, 21_600, defaultRSSAdaptiveWarmMinIntervalSeconds),
		RSSAdaptiveColdIntervalMultiplier: clampIntValue(
			intValue(object, "rssAdaptiveColdIntervalMultiplier"), 1, 8, defaultRSSAdaptiveColdIntervalMultiplier),
		RSSAdaptiveColdMaxIntervalSeconds: clampIntValue(
			intValue(object, "rssAdaptiveColdMaxIntervalSeconds"), 10, 21_600, defaultRSSAdaptiveColdMaxIntervalSeconds),
		RSSAdaptiveHotDiscoveryCacheTTLCapSeconds: clampIntValue(
			intValue(object, "rssAdaptiveHotDiscoveryCacheTtlCapSeconds"), 10, 3_600,
			defaultRSSAdaptiveHotDiscoveryCacheTTLCapSeconds),
		RSSAdaptiveWarmDiscoveryCacheTTLCapSeconds: clampIntValue(
			intValue(object, "rssAdaptiveWarmDiscoveryCacheTtlCapSeconds"), 10, 3_600,
			defaultRSSAdaptiveWarmDiscoveryCacheTTLCapSeconds),
	}
	settings.RSSAdaptiveWarmHitRatePercent = minIntValue(settings.RSSAdaptiveWarmHitRatePercent, settings.RSSAdaptiveHotHitRatePercent)
	settings.RSSAdaptiveColdMaxIntervalSeconds = maxIntValue(
		settings.RSSAdaptiveWarmMinIntervalSeconds, settings.RSSAdaptiveColdMaxIntervalSeconds)
	settings.RSSAdaptiveHotDiscoveryCacheTTLCapSeconds = minIntValue(
		settings.RSSAdaptiveHotDiscoveryCacheTTLCapSeconds, settings.RSSAdaptiveWarmDiscoveryCacheTTLCapSeconds)
	settings.RSSAdaptiveWarmDiscoveryCacheTTLCapSeconds = maxIntValue(
		settings.RSSAdaptiveWarmDiscoveryCacheTTLCapSeconds, settings.RSSAdaptiveHotDiscoveryCacheTTLCapSeconds)
	return settings
}

// resolveSeedRuntimeAllowlist ports the allowlist branch of the settings loader.
func resolveSeedRuntimeAllowlist(object jsonObject) []string {
	raw, present := object["seedUrlQueryParamAllowlist"]
	if !present || string(raw) == "null" {
		return defaultSeedRuntimeSettings().SeedURLQueryParamAllowlist
	}
	var entries []string
	if err := json.Unmarshal(raw, &entries); err != nil {
		return defaultSeedRuntimeSettings().SeedURLQueryParamAllowlist
	}
	return newssourcesNormalizeAllowlist(entries, defaultSeedRuntimeSettings().SeedURLQueryParamAllowlist)
}

// newssourcesNormalizeAllowlist keeps the newssources normalization in one
// place.
func newssourcesNormalizeAllowlist(value any, fallback []string) []string {
	return newssources.NormalizeURLQueryParamAllowlist(value, fallback)
}

// intValue reads an integer setting, or nil when absent.
func intValue(object jsonObject, key string) *int {
	number, ok := object.numberField(key)
	if !ok {
		return nil
	}
	value := int(jsRound(number))
	return &value
}

// boolValue reads a boolean setting with a fallback.
func boolValue(object jsonObject, key string, fallback bool) bool {
	value, ok := object.boolField(key)
	if !ok {
		return fallback
	}
	return value
}

// clampIntValue is clampInt.
func clampIntValue(value *int, min, max, fallback int) int {
	if value == nil {
		return fallback
	}
	clamped := *value
	if clamped < min {
		clamped = min
	}
	if clamped > max {
		clamped = max
	}
	return clamped
}

func minIntValue(left, right int) int {
	if left < right {
		return left
	}
	return right
}

func maxIntValue(left, right int) int {
	if left > right {
		return left
	}
	return right
}
