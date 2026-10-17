package runtimesettings

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"math"
)

// Global rate limit bucket bounds, copied from rate-limit-config.service.ts.
const (
	rateLimitMinLimit         = 1
	rateLimitMaxLimit         = 1000
	rateLimitMinWindowSeconds = 5
	rateLimitMaxWindowSeconds = 86400
)

// rateLimitBucketConfig is one bucket payload: { limit, windowSeconds }. The
// field order is the JSON key order NestJS produces.
type rateLimitBucketConfig struct {
	Limit         int `json:"limit"`
	WindowSeconds int `json:"windowSeconds"`
}

// rateLimitSettings is the GET/PUT response and the Redis payload. It has
// exactly three keys in this order.
type rateLimitSettings struct {
	Login       rateLimitBucketConfig `json:"login"`
	CrawlCreate rateLimitBucketConfig `json:"crawlCreate"`
	RbacWrite   rateLimitBucketConfig `json:"rbacWrite"`
}

// rateLimitBucketRequest is one nested bucket in the PUT body.
type rateLimitBucketRequest struct {
	Limit         json.RawMessage `json:"limit"`
	WindowSeconds json.RawMessage `json:"windowSeconds"`
}

// rateLimitSettingsRequest mirrors UpdateRateLimitSettingsDto. The three nested
// buckets are optional: @ValidateNested() does not run on absent values, so an
// omitted bucket falls back to the raw environment default exactly like NestJS.
type rateLimitSettingsRequest struct {
	Login       *rateLimitBucketRequest `json:"login"`
	CrawlCreate *rateLimitBucketRequest `json:"crawlCreate"`
	RbacWrite   *rateLimitBucketRequest `json:"rbacWrite"`
}

// storedBucketConfig is the typed view of a SystemSetting bucket value.
type storedBucketConfig struct {
	Limit         json.RawMessage `json:"limit"`
	WindowSeconds json.RawMessage `json:"windowSeconds"`
}

// fallbackRateLimitSettings mirrors getFallbackSettings: raw (unclamped,
// unfloored) values straight from the environment.
func (s *Service) fallbackRateLimitSettings() rateLimitSettings {
	return rateLimitSettings{
		Login: rateLimitBucketConfig{
			Limit:         s.cfg.RateLimitLogin,
			WindowSeconds: s.cfg.RateLimitLoginWindow,
		},
		CrawlCreate: rateLimitBucketConfig{
			Limit:         s.cfg.RateLimitCrawlTaskCreate,
			WindowSeconds: s.cfg.RateLimitCrawlTaskCreateWindow,
		},
		RbacWrite: rateLimitBucketConfig{
			Limit:         s.cfg.RateLimitRbacWrite,
			WindowSeconds: s.cfg.RateLimitRbacWriteWindow,
		},
	}
}

// rateLimitSettingsCacheTTL resolves the cache TTL, defaulting to 60 seconds
// when the environment value is missing.
func (s *Service) rateLimitSettingsCacheTTL() int {
	if s.cfg.RateLimitSettingsCacheTTLSeconds > 0 {
		return s.cfg.RateLimitSettingsCacheTTLSeconds
	}
	return 60
}

// normalizeBucket mirrors normalizeBucket(value, fallback): a falsy or non
// object value keeps the fallback untouched; any object or array goes through
// Number() coercion, Math.floor and the [1,1000] / [5,86400] clamp.
func normalizeBucket(raw json.RawMessage, fallback rateLimitBucketConfig) rateLimitBucketConfig {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return fallback
	}
	switch trimmed[0] {
	case '{':
	case '[':
		// Arrays are objects in JavaScript but have no limit/windowSeconds
		// properties, so both become NaN and clamp to the minimum.
		return rateLimitBucketConfig{Limit: rateLimitMinLimit, WindowSeconds: rateLimitMinWindowSeconds}
	default:
		return fallback
	}
	var record storedBucketConfig
	if err := json.Unmarshal(trimmed, &record); err != nil {
		return fallback
	}
	limitValue := math.NaN()
	if value, ok := jsNumberFromJSON(record.Limit); ok {
		limitValue = value
	}
	windowValue := math.NaN()
	if value, ok := jsNumberFromJSON(record.WindowSeconds); ok {
		windowValue = value
	}
	return rateLimitBucketConfig{
		Limit:         jsClamp(math.Floor(limitValue), rateLimitMinLimit, rateLimitMaxLimit),
		WindowSeconds: jsClamp(math.Floor(windowValue), rateLimitMinWindowSeconds, rateLimitMaxWindowSeconds),
	}
}

// cachedRateLimitSettings is the typed view of the Redis payload. Pointer
// buckets keep "key absent" distinguishable from a zero-valued bucket, which
// matters because an absent bucket must keep the raw environment fallback.
type cachedRateLimitSettings struct {
	Login       *rateLimitBucketConfig `json:"login"`
	CrawlCreate *rateLimitBucketConfig `json:"crawlCreate"`
	RbacWrite   *rateLimitBucketConfig `json:"rbacWrite"`
}

// normalizeRequestSettings mirrors normalizeSettings for a PUT body: an absent
// bucket keeps the raw (unclamped) environment fallback, exactly like
// normalizeBucket(undefined, fallback).
func normalizeRequestSettings(dto rateLimitSettingsRequest, fallback rateLimitSettings) rateLimitSettings {
	return rateLimitSettings{
		Login:       normalizeRequestBucket(dto.Login, fallback.Login),
		CrawlCreate: normalizeRequestBucket(dto.CrawlCreate, fallback.CrawlCreate),
		RbacWrite:   normalizeRequestBucket(dto.RbacWrite, fallback.RbacWrite),
	}
}

// normalizeRequestBucket normalizes one submitted bucket with the same
// Number() -> Math.floor -> clamp pipeline the NestJS service uses.
func normalizeRequestBucket(bucket *rateLimitBucketRequest, fallback rateLimitBucketConfig) rateLimitBucketConfig {
	if bucket == nil {
		return fallback
	}
	return rateLimitBucketConfig{
		Limit:         jsClamp(math.Floor(bucketCoerce(bucket.Limit)), rateLimitMinLimit, rateLimitMaxLimit),
		WindowSeconds: jsClamp(math.Floor(bucketCoerce(bucket.WindowSeconds)), rateLimitMinWindowSeconds, rateLimitMaxWindowSeconds),
	}
}

// bucketCoerce mirrors Number(value) for one raw bucket field. An absent key
// yields NaN, which the clamp maps to the minimum (the JavaScript contract).
func bucketCoerce(raw json.RawMessage) float64 {
	value, ok := jsNumberFromJSON(raw)
	if !ok {
		return math.NaN()
	}
	return value
}

// normalizeCachedSettings mirrors normalizeSettings for a cache hit.
func normalizeCachedSettings(cached cachedRateLimitSettings, fallback rateLimitSettings) rateLimitSettings {
	return rateLimitSettings{
		Login:       normalizeCachedBucket(cached.Login, fallback.Login),
		CrawlCreate: normalizeCachedBucket(cached.CrawlCreate, fallback.CrawlCreate),
		RbacWrite:   normalizeCachedBucket(cached.RbacWrite, fallback.RbacWrite),
	}
}

// normalizeCachedBucket clamps one cached bucket; a missing key keeps the raw
// environment fallback.
func normalizeCachedBucket(bucket *rateLimitBucketConfig, fallback rateLimitBucketConfig) rateLimitBucketConfig {
	if bucket == nil {
		return fallback
	}
	return rateLimitBucketConfig{
		Limit:         jsClamp(float64(bucket.Limit), rateLimitMinLimit, rateLimitMaxLimit),
		WindowSeconds: jsClamp(float64(bucket.WindowSeconds), rateLimitMinWindowSeconds, rateLimitMaxWindowSeconds),
	}
}

// parseUpdateRateLimitSettings validates the PUT body.
func parseUpdateRateLimitSettings(body []byte) (rateLimitSettingsRequest, error) {
	var dto rateLimitSettingsRequest
	if err := decodeBodyError(newStrictDecoder(body).Decode(&dto)); err != nil {
		return rateLimitSettingsRequest{}, err
	}
	problems := validationErrors{}
	validateRateLimitBucket(&problems, dto.Login)
	validateRateLimitBucket(&problems, dto.CrawlCreate)
	validateRateLimitBucket(&problems, dto.RbacWrite)
	if err := problems.err(); err != nil {
		return rateLimitSettingsRequest{}, err
	}
	return dto, nil
}

// validateRateLimitBucket validates one nested RateLimitBucketDto. Absent or
// null buckets are skipped, exactly like @ValidateNested(). The emitted
// messages use the nested property names ("limit", "windowSeconds"), which is
// what class-validator's default messages resolve to for nested objects.
func validateRateLimitBucket(problems *validationErrors, bucket *rateLimitBucketRequest) {
	if bucket == nil {
		return
	}
	numberField(problems, bucket.Limit, "limit", true, rateLimitMinLimit, rateLimitMaxLimit)
	numberField(problems, bucket.WindowSeconds, "windowSeconds", true, rateLimitMinWindowSeconds, rateLimitMaxWindowSeconds)
}

// loadRateLimitSettings mirrors loadSettings: read the three rows in one query
// and normalize each stored value against the raw environment fallback.
func (s *Service) loadRateLimitSettings(ctx context.Context) (rateLimitSettings, error) {
	if s == nil || s.db == nil {
		return rateLimitSettings{}, errNoDatabase
	}
	fallback := s.fallbackRateLimitSettings()
	rows, err := s.db.QueryContext(ctx,
		"SELECT `key`, value FROM SystemSetting WHERE `key` IN (?, ?, ?)",
		settingKeyRateLimitLogin, settingKeyRateLimitCrawlCreate, settingKeyRateLimitRbacWrite)
	if err != nil {
		return rateLimitSettings{}, err
	}
	defer rows.Close()

	settings := rateLimitSettings{Login: fallback.Login, CrawlCreate: fallback.CrawlCreate, RbacWrite: fallback.RbacWrite}
	for rows.Next() {
		var key string
		var value []byte
		if err := rows.Scan(&key, &value); err != nil {
			return rateLimitSettings{}, err
		}
		switch key {
		case settingKeyRateLimitLogin:
			settings.Login = normalizeBucket(value, fallback.Login)
		case settingKeyRateLimitCrawlCreate:
			settings.CrawlCreate = normalizeBucket(value, fallback.CrawlCreate)
		case settingKeyRateLimitRbacWrite:
			settings.RbacWrite = normalizeBucket(value, fallback.RbacWrite)
		}
	}
	return settings, rows.Err()
}

// getRateLimitSettings mirrors getRateLimitSettings: cache hit re-normalizes and
// returns without touching MySQL; a cache miss loads, writes the cache
// best-effort and returns the loaded (possibly raw-fallback) value. A database
// failure serves the raw environment defaults and never fails the request.
func (s *Service) getRateLimitSettings(ctx context.Context) (rateLimitSettings, error) {
	if raw, found, cacheErr := s.cacheGet(ctx, rateLimitSettingsCacheKey); cacheErr != nil {
		logCacheFailure("rate limit settings", rateLimitSettingsCacheKey, cacheErr)
	} else if found {
		var cached cachedRateLimitSettings
		if err := json.Unmarshal(raw, &cached); err == nil {
			return normalizeCachedSettings(cached, s.fallbackRateLimitSettings()), nil
		}
		logCacheFailure("rate limit settings", rateLimitSettingsCacheKey, errors.New("cache entry is not a settings document"))
	}

	settings, err := s.loadRateLimitSettings(ctx)
	if err != nil {
		settings = s.fallbackRateLimitSettings()
	}
	if encoded, encodeErr := json.Marshal(settings); encodeErr == nil {
		if cacheErr := s.cacheSet(ctx, rateLimitSettingsCacheKey, encoded, s.rateLimitSettingsCacheTTL()); cacheErr != nil {
			logCacheFailure("rate limit settings", rateLimitSettingsCacheKey, cacheErr)
		}
	}
	return settings, nil
}

// updateRateLimitSettings mirrors updateRateLimitSettings: one transaction for
// the three upserts, then the audit row, then the cache refresh.
func (s *Service) updateRateLimitSettings(ctx context.Context, orgID, actorID string, dto rateLimitSettingsRequest) (rateLimitSettings, error) {
	if s == nil || s.db == nil {
		return rateLimitSettings{}, errNoDatabase
	}
	fallback := s.fallbackRateLimitSettings()
	normalized := normalizeRequestSettings(dto, fallback)

	updatedByID := nullableActorID(actorID)
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return rateLimitSettings{}, err
	}
	buckets := []struct {
		key         string
		description string
		value       rateLimitBucketConfig
	}{
		{settingKeyRateLimitLogin, descriptionRateLimitLogin, normalized.Login},
		{settingKeyRateLimitCrawlCreate, descriptionRateLimitCrawlCreate, normalized.CrawlCreate},
		{settingKeyRateLimitRbacWrite, descriptionRateLimitRbacWrite, normalized.RbacWrite},
	}
	for _, bucket := range buckets {
		encoded, encodeErr := json.Marshal(bucket.value)
		if encodeErr != nil {
			_ = tx.Rollback()
			return rateLimitSettings{}, encodeErr
		}
		if execErr := upsertSettingTx(ctx, tx, bucket.key, encoded, bucket.description, updatedByID); execErr != nil {
			_ = tx.Rollback()
			return rateLimitSettings{}, execErr
		}
	}
	if err := tx.Commit(); err != nil {
		return rateLimitSettings{}, err
	}

	if metadata, marshalErr := json.Marshal(normalized); marshalErr == nil {
		s.writeAuditLogBestEffort(ctx, orgID, actorID, "rate_limit_update", metadata)
	}
	encoded, err := json.Marshal(normalized)
	if err != nil {
		return rateLimitSettings{}, err
	}
	if err := s.cacheSet(ctx, rateLimitSettingsCacheKey, encoded, s.rateLimitSettingsCacheTTL()); err != nil {
		return rateLimitSettings{}, err
	}
	return normalized, nil
}
