package runtimesettings

import (
	"context"
	"encoding/json"
	"math"
)

// Auth profile cache bounds, copied from auth-cache-settings.service.ts.
const (
	authCacheMinProfileTTLSeconds = 60
	authCacheMaxProfileTTLSeconds = 86400
	authCacheMinLockTTLMs         = 100
	authCacheMaxLockTTLMs         = 60000
	authCacheMinRetryDelayMs      = 10
	authCacheMaxRetryDelayMs      = 1000
	authCacheMinMaxWaitMs         = 50
	authCacheMaxMaxWaitMs         = 120000
)

// authCacheSettings is the public shape of the auth profile cache settings. The
// field order is the JSON key order NestJS returns and caches.
type authCacheSettings struct {
	ProfileTTLSeconds int `json:"profileTtlSeconds"`
	LockTTLMs         int `json:"lockTtlMs"`
	MaxWaitMs         int `json:"maxWaitMs"`
	RetryDelayMs      int `json:"retryDelayMs"`
}

// authCacheSettingsRequest mirrors UpdateAuthCacheSettingsDto: all four fields
// are required and must be integers inside their own bounds.
type authCacheSettingsRequest struct {
	ProfileTTLSeconds json.RawMessage `json:"profileTtlSeconds"`
	LockTTLMs         json.RawMessage `json:"lockTtlMs"`
	MaxWaitMs         json.RawMessage `json:"maxWaitMs"`
	RetryDelayMs      json.RawMessage `json:"retryDelayMs"`
}

// authCacheStoredValue is the typed view of the stored SystemSetting.value.
type authCacheStoredValue struct {
	ProfileTTLSeconds json.RawMessage `json:"profileTtlSeconds"`
	LockTTLMs         json.RawMessage `json:"lockTtlMs"`
	MaxWaitMs         json.RawMessage `json:"maxWaitMs"`
	RetryDelayMs      json.RawMessage `json:"retryDelayMs"`
}

// fallbackAuthCacheSettings mirrors getFallbackSettings: raw environment values,
// which the row-absent path returns without clamping.
func (s *Service) fallbackAuthCacheSettings() authCacheSettings {
	return authCacheSettings{
		ProfileTTLSeconds: s.cfg.AuthProfileCacheTTLSeconds,
		LockTTLMs:         s.cfg.AuthProfileCacheLockTTLMs,
		MaxWaitMs:         s.cfg.AuthProfileCacheMaxWaitMs,
		RetryDelayMs:      s.cfg.AuthProfileCacheRetryDelayMs,
	}
}

// parseUpdateAuthCacheSettings validates the PUT body.
func parseUpdateAuthCacheSettings(body []byte) (authCacheSettingsRequest, error) {
	var dto authCacheSettingsRequest
	if err := decodeBodyError(newStrictDecoder(body).Decode(&dto)); err != nil {
		return authCacheSettingsRequest{}, err
	}
	problems := validationErrors{}
	numberField(&problems, dto.ProfileTTLSeconds, "profileTtlSeconds", true, authCacheMinProfileTTLSeconds, authCacheMaxProfileTTLSeconds)
	numberField(&problems, dto.LockTTLMs, "lockTtlMs", true, authCacheMinLockTTLMs, authCacheMaxLockTTLMs)
	numberField(&problems, dto.MaxWaitMs, "maxWaitMs", true, authCacheMinMaxWaitMs, authCacheMaxMaxWaitMs)
	numberField(&problems, dto.RetryDelayMs, "retryDelayMs", true, authCacheMinRetryDelayMs, authCacheMaxRetryDelayMs)
	if err := problems.err(); err != nil {
		return authCacheSettingsRequest{}, err
	}
	return dto, nil
}

// requestAuthCacheSettings converts the validated body into the typed input.
// The values already passed @IsInt, so they only need the bounds check.
func requestAuthCacheSettings(dto authCacheSettingsRequest) authCacheSettings {
	profileTTLSeconds, _ := numberField(&validationErrors{}, dto.ProfileTTLSeconds, "profileTtlSeconds", true, authCacheMinProfileTTLSeconds, authCacheMaxProfileTTLSeconds)
	lockTTLMs, _ := numberField(&validationErrors{}, dto.LockTTLMs, "lockTtlMs", true, authCacheMinLockTTLMs, authCacheMaxLockTTLMs)
	maxWaitMs, _ := numberField(&validationErrors{}, dto.MaxWaitMs, "maxWaitMs", true, authCacheMinMaxWaitMs, authCacheMaxMaxWaitMs)
	retryDelayMs, _ := numberField(&validationErrors{}, dto.RetryDelayMs, "retryDelayMs", true, authCacheMinRetryDelayMs, authCacheMaxRetryDelayMs)
	return authCacheSettings{
		ProfileTTLSeconds: profileTTLSeconds,
		LockTTLMs:         lockTTLMs,
		MaxWaitMs:         maxWaitMs,
		RetryDelayMs:      retryDelayMs,
	}
}

// authCacheToInt mirrors the service toInt: only a finite JSON number is
// accepted (numeric strings are NOT coerced) and it is floored; anything else
// falls back to the environment default.
func authCacheToInt(raw json.RawMessage, fallback int) int {
	if !present(raw) || isNull(raw) || !isJSONNumber(raw) {
		return fallback
	}
	value, err := parseJSONFloat(raw)
	if err != nil || math.IsNaN(value) || math.IsInf(value, 0) {
		return fallback
	}
	return int(math.Floor(value))
}

// normalizeAuthCacheSettings mirrors the service normalize. It takes resolved
// numbers (either validated request input or stored values already passed
// through authCacheToInt) and clamps them. maxWaitMs depends on the already
// clamped retryDelayMs, so the order below is load-bearing.
func normalizeAuthCacheSettings(input authCacheSettings, fallback authCacheSettings) authCacheSettings {
	profileTTLSeconds := authClamp(input.ProfileTTLSeconds, authCacheMinProfileTTLSeconds, authCacheMaxProfileTTLSeconds)
	lockTTLMs := authClamp(input.LockTTLMs, authCacheMinLockTTLMs, authCacheMaxLockTTLMs)
	retryDelayMs := authClamp(input.RetryDelayMs, authCacheMinRetryDelayMs, authCacheMaxRetryDelayMs)
	maxWaitMs := authClamp(maxInt(input.MaxWaitMs, retryDelayMs, authCacheMinMaxWaitMs), authCacheMinMaxWaitMs, authCacheMaxMaxWaitMs)
	return authCacheSettings{
		ProfileTTLSeconds: profileTTLSeconds,
		LockTTLMs:         lockTTLMs,
		MaxWaitMs:         maxWaitMs,
		RetryDelayMs:      retryDelayMs,
	}
}

// normalizeStoredAuthCacheSettings applies the `{ ...fallback, ...value }`
// spread followed by normalize, which is what the row-present read path does.
func normalizeStoredAuthCacheSettings(stored authCacheStoredValue, fallback authCacheSettings) authCacheSettings {
	merged := authCacheSettings{
		ProfileTTLSeconds: authCacheToInt(stored.ProfileTTLSeconds, fallback.ProfileTTLSeconds),
		LockTTLMs:         authCacheToInt(stored.LockTTLMs, fallback.LockTTLMs),
		MaxWaitMs:         authCacheToInt(stored.MaxWaitMs, fallback.MaxWaitMs),
		RetryDelayMs:      authCacheToInt(stored.RetryDelayMs, fallback.RetryDelayMs),
	}
	return normalizeAuthCacheSettings(merged, fallback)
}

// authClamp mirrors the service clamp helper.
func authClamp(value, min, max int) int {
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}

// maxInt returns the largest of the given integers.
func maxInt(values ...int) int {
	result := values[0]
	for _, value := range values[1:] {
		if value > result {
			result = value
		}
	}
	return result
}

// getAuthCacheSettings mirrors getSettings: cache hit re-normalizes; a miss
// loads from MySQL (raw environment defaults when the row is absent), writes the
// cache and returns. This path has no error tolerance: Redis and MySQL failures
// propagate to the filter.
func (s *Service) getAuthCacheSettings(ctx context.Context) (authCacheSettings, error) {
	if raw, found, cacheErr := s.cacheGet(ctx, authCacheSettingsCacheKey); cacheErr != nil {
		return authCacheSettings{}, cacheErr
	} else if found {
		var cached authCacheSettings
		if err := json.Unmarshal(raw, &cached); err != nil {
			return authCacheSettings{}, err
		}
		return normalizeAuthCacheSettings(cached, s.fallbackAuthCacheSettings()), nil
	}

	settings, err := s.loadAuthCacheSettings(ctx)
	if err != nil {
		return authCacheSettings{}, err
	}
	encoded, err := json.Marshal(settings)
	if err != nil {
		return authCacheSettings{}, err
	}
	if err := s.cacheSet(ctx, authCacheSettingsCacheKey, encoded, authCacheSettingsCacheTTLSeconds); err != nil {
		return authCacheSettings{}, err
	}
	return settings, nil
}

// loadAuthCacheSettings mirrors loadSettings: an absent row returns the raw
// environment defaults; a present row is spread over the fallback and
// normalized.
//
// A stored value that is not a JSON object (array, string, number, boolean)
// degrades to the environment defaults instead of failing the request. NestJS
// spreads the stored value over the fallback (`{ ...fallback, ...value }`), and
// a spread of any non-object contributes no profileTtlSeconds/lockTtlMs/
// maxWaitMs/retryDelayMs key, so every field resolves from the fallback and the
// endpoint still answers 200. Returning an error here would turn a corrupt row
// into a 500 that NestJS never produced.
func (s *Service) loadAuthCacheSettings(ctx context.Context) (authCacheSettings, error) {
	fallback := s.fallbackAuthCacheSettings()
	raw, found, err := s.loadSetting(ctx, settingKeyAuthProfileCache)
	if err != nil {
		return authCacheSettings{}, err
	}
	if !found {
		return fallback, nil
	}
	return storedAuthCacheSettings(raw, fallback), nil
}

// storedAuthCacheSettings resolves a present SystemSetting.value row. A stored
// document that is not a JSON object contributes no field to the NestJS spread
// `{ ...fallback, ...value }`, so every field resolves from the fallback.
func storedAuthCacheSettings(raw json.RawMessage, fallback authCacheSettings) authCacheSettings {
	if !objectLikeJSON(raw) {
		return fallback
	}
	var stored authCacheStoredValue
	if err := json.Unmarshal(raw, &stored); err != nil {
		return fallback
	}
	return normalizeStoredAuthCacheSettings(stored, fallback)
}

// updateAuthCacheSettings mirrors updateSettings: one upsert, a best-effort
// audit row and an awaited cache refresh.
func (s *Service) updateAuthCacheSettings(ctx context.Context, orgID, actorID string, dto authCacheSettingsRequest) (authCacheSettings, error) {
	if s == nil || s.db == nil {
		return authCacheSettings{}, errNoDatabase
	}
	normalized := normalizeAuthCacheSettings(requestAuthCacheSettings(dto), s.fallbackAuthCacheSettings())
	encoded, err := json.Marshal(normalized)
	if err != nil {
		return authCacheSettings{}, err
	}
	if err := s.upsertSetting(ctx, settingKeyAuthProfileCache, encoded, descriptionAuthProfileCache, nullableActorID(actorID)); err != nil {
		return authCacheSettings{}, err
	}
	s.writeAuditLogBestEffort(ctx, orgID, actorID, "auth_cache_settings_update", encoded)
	if err := s.cacheSet(ctx, authCacheSettingsCacheKey, encoded, authCacheSettingsCacheTTLSeconds); err != nil {
		return authCacheSettings{}, err
	}
	return normalized, nil
}
