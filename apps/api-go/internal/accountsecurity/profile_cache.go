package accountsecurity

import (
	"bytes"
	"context"
	"encoding/json"
	"log"
	"math"
	"time"
)

// This file reproduces AuthCacheSettingsService.getSettings and
// CacheService.wrap/invalidateProfileCache for the profile cache. The cached
// value is the base profile built by buildAuthenticatedUser: it never contains
// the request's jti/exp, a password hash or a token.

const (
	profileCacheKeyPrefix          = "profile:"
	profileCacheDefaultOrgKey      = "default"
	authCacheSettingsKey           = "auth_profile_cache_settings"
	authCacheSettingsCacheKey      = "auth_cache:settings"
	authCacheSettingsCacheTTL      = 60
	authCacheMinProfileTTLSeconds  = 60
	authCacheMaxProfileTTLSeconds  = 86400
	authCacheMinLockTTLMs          = 100
	authCacheMaxLockTTLMs          = 60000
	authCacheMinRetryDelayMs       = 10
	authCacheMaxRetryDelayMs       = 1000
	authCacheMinMaxWaitMs          = 50
	authCacheMaxMaxWaitMs          = 120000
	authCacheMinRenewIntervalMs    = 1000
	profileCacheLockPrefix         = "lock:"
	refreshTokenBlacklistKeyPrefix = "refresh-token:blacklist:"
	accessTokenBlacklistKeyPrefix  = "access-token:blacklist:"
)

// authCacheSettings is the public shape of the auth profile cache settings; the
// field order is the JSON key order NestJS returns and caches.
type authCacheSettings struct {
	ProfileTTLSeconds int `json:"profileTtlSeconds"`
	LockTTLMs         int `json:"lockTtlMs"`
	MaxWaitMs         int `json:"maxWaitMs"`
	RetryDelayMs      int `json:"retryDelayMs"`
}

// authCacheStoredValue is the raw view of a stored/cached settings object.
type authCacheStoredValue struct {
	ProfileTTLSeconds json.RawMessage `json:"profileTtlSeconds"`
	LockTTLMs         json.RawMessage `json:"lockTtlMs"`
	MaxWaitMs         json.RawMessage `json:"maxWaitMs"`
	RetryDelayMs      json.RawMessage `json:"retryDelayMs"`
}

// profileCacheOptions is the wrap() timing configuration.
type profileCacheOptions struct {
	LockTTLMs    int
	RetryDelayMs int
	MaxWaitMs    int
}

// profileCacheKey mirrors `profile:${userId}:${orgId ?? "default"}`.
func profileCacheKey(userID, orgID string) string {
	key := profileCacheDefaultOrgKey
	if orgID != "" {
		key = orgID
	}
	return profileCacheKeyPrefix + userID + ":" + key
}

// fallbackAuthCacheSettings mirrors getFallbackSettings: the raw environment
// values, which the row-absent path returns without clamping.
func (s *Service) fallbackAuthCacheSettings() authCacheSettings {
	return authCacheSettings{
		ProfileTTLSeconds: s.cfg.AuthProfileCacheTTLSeconds,
		LockTTLMs:         s.cfg.AuthProfileCacheLockTTLMs,
		MaxWaitMs:         s.cfg.AuthProfileCacheMaxWaitMs,
		RetryDelayMs:      s.cfg.AuthProfileCacheRetryDelayMs,
	}
}

// authCacheToInt mirrors the service toInt: only a finite JSON number is
// accepted (numeric strings are NOT coerced) and it is floored; anything else
// falls back to the environment default.
func authCacheToInt(raw json.RawMessage, fallback int) int {
	value, ok := jsIsFiniteNumber(raw)
	if !ok {
		return fallback
	}
	return int(math.Floor(value))
}

// normalizeAuthCacheSettings mirrors the service normalize. The maxWaitMs clamp
// depends on the already clamped retryDelayMs, so the order is load-bearing.
func normalizeAuthCacheSettings(input authCacheSettings) authCacheSettings {
	profileTTLSeconds := clamp(input.ProfileTTLSeconds, authCacheMinProfileTTLSeconds, authCacheMaxProfileTTLSeconds)
	lockTTLMs := clamp(input.LockTTLMs, authCacheMinLockTTLMs, authCacheMaxLockTTLMs)
	retryDelayMs := clamp(input.RetryDelayMs, authCacheMinRetryDelayMs, authCacheMaxRetryDelayMs)
	maxWaitMs := clamp(maxInt(input.MaxWaitMs, retryDelayMs, authCacheMinMaxWaitMs), authCacheMinMaxWaitMs, authCacheMaxMaxWaitMs)
	return authCacheSettings{
		ProfileTTLSeconds: profileTTLSeconds,
		LockTTLMs:         lockTTLMs,
		MaxWaitMs:         maxWaitMs,
		RetryDelayMs:      retryDelayMs,
	}
}

// normalizeStoredAuthCache applies the `{ ...fallback, ...value }` spread
// followed by normalize, which is what the row-present and cache-hit paths do.
// A non-object value spreads to an empty object, matching JavaScript.
func (s *Service) normalizeStoredAuthCache(raw json.RawMessage) authCacheSettings {
	fallback := s.fallbackAuthCacheSettings()
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return normalizeAuthCacheSettings(fallback)
	}
	var stored authCacheStoredValue
	if err := json.Unmarshal(trimmed, &stored); err != nil {
		return normalizeAuthCacheSettings(fallback)
	}
	merged := authCacheSettings{
		ProfileTTLSeconds: authCacheToInt(stored.ProfileTTLSeconds, fallback.ProfileTTLSeconds),
		LockTTLMs:         authCacheToInt(stored.LockTTLMs, fallback.LockTTLMs),
		MaxWaitMs:         authCacheToInt(stored.MaxWaitMs, fallback.MaxWaitMs),
		RetryDelayMs:      authCacheToInt(stored.RetryDelayMs, fallback.RetryDelayMs),
	}
	return normalizeAuthCacheSettings(merged)
}

// getAuthCacheSettings mirrors getSettings: a cache hit re-normalizes; a miss
// loads from MySQL (the raw environment defaults when the row is absent), writes
// the cache and returns. There is no error tolerance here: Redis and MySQL
// failures propagate to the filter.
func (s *Service) getAuthCacheSettings(ctx context.Context) (authCacheSettings, error) {
	if raw, found, err := s.cacheGetJSON(ctx, authCacheSettingsCacheKey); err != nil {
		return authCacheSettings{}, err
	} else if found {
		return s.normalizeStoredAuthCache(raw), nil
	}

	raw, found, err := s.loadSetting(ctx, authCacheSettingsKey)
	if err != nil {
		return authCacheSettings{}, err
	}
	if !found {
		return s.fallbackAuthCacheSettings(), nil
	}
	settings := s.normalizeStoredAuthCache(raw)
	encoded, err := json.Marshal(settings)
	if err != nil {
		return authCacheSettings{}, err
	}
	if err := s.cacheSet(ctx, authCacheSettingsCacheKey, encoded, authCacheSettingsCacheTTL); err != nil {
		return authCacheSettings{}, err
	}
	return settings, nil
}

// jsTruthyJSON reproduces `if (cached)` for a parsed JSON cache value: the
// literals false/null/0/""/[] are falsy, everything else is truthy.
func jsTruthyJSON(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	switch {
	case len(trimmed) == 0:
		return false
	case bytes.Equal(trimmed, []byte("null")),
		bytes.Equal(trimmed, []byte("false")),
		bytes.Equal(trimmed, []byte("0")),
		bytes.Equal(trimmed, []byte(`""`)):
		return false
	case trimmed[0] == '[':
		return len(trimmed) > 2
	default:
		return true
	}
}

// decodeCachedProfile turns a cached JSON value into a profile. A value that
// does not decode is treated as a cache miss, so a corrupted entry can never
// masquerade as a valid profile.
func decodeCachedProfile(raw json.RawMessage) (profileResponse, bool) {
	if !jsTruthyJSON(raw) {
		return profileResponse{}, false
	}
	var profile profileResponse
	if err := json.Unmarshal(raw, &profile); err != nil {
		return profileResponse{}, false
	}
	return profile, true
}

// profileCacheWrap mirrors CacheService.wrap for the profile loader: cache hit,
// owner-token lock with renewal, bounded retry while another request loads, and
// the final cache check/loader fallback when no lock was ever acquired.
func (s *Service) profileCacheWrap(
	ctx context.Context,
	key string,
	ttlSeconds int,
	loader func(context.Context) (profileResponse, error),
	options profileCacheOptions,
) (profileResponse, error) {
	if cached, found, err := s.cacheGetJSON(ctx, key); err != nil {
		return profileResponse{}, err
	} else if found {
		if profile, ok := decodeCachedProfile(cached); ok {
			return profile, nil
		}
	}

	lockKey := profileCacheLockPrefix + key
	lockToken, err := s.acquireLock(ctx, lockKey, options.LockTTLMs)
	if err != nil {
		return profileResponse{}, err
	}

	if lockToken == "" {
		deadline := time.Now().Add(time.Duration(options.MaxWaitMs) * time.Millisecond)
		for time.Now().Before(deadline) {
			if sleepErr := sleepContext(ctx, time.Duration(options.RetryDelayMs)*time.Millisecond); sleepErr != nil {
				return profileResponse{}, sleepErr
			}
			if cached, found, err := s.cacheGetJSON(ctx, key); err != nil {
				return profileResponse{}, err
			} else if found {
				if profile, ok := decodeCachedProfile(cached); ok {
					return profile, nil
				}
			}
			lockToken, err = s.acquireLock(ctx, lockKey, options.LockTTLMs)
			if err != nil {
				return profileResponse{}, err
			}
			if lockToken != "" {
				break
			}
		}
	}

	if lockToken != "" {
		releaseCtx := context.WithoutCancel(ctx)
		stop := make(chan struct{})
		defer close(stop)
		defer func() {
			if releaseErr := s.releaseLock(releaseCtx, lockKey, lockToken); releaseErr != nil {
				log.Printf("accountsecurity: profile cache lock release failed: %v", releaseErr)
			}
		}()
		go s.renewProfileLock(ctx, lockKey, lockToken, options.LockTTLMs, stop)

		value, loadErr := loader(ctx)
		if loadErr != nil {
			return profileResponse{}, loadErr
		}
		if setErr := s.storeProfileCache(ctx, key, ttlSeconds, value); setErr != nil {
			return profileResponse{}, setErr
		}
		return value, nil
	}

	if cached, found, err := s.cacheGetJSON(ctx, key); err != nil {
		return profileResponse{}, err
	} else if found {
		if profile, ok := decodeCachedProfile(cached); ok {
			return profile, nil
		}
	}

	value, err := loader(ctx)
	if err != nil {
		return profileResponse{}, err
	}
	if err := s.storeProfileCache(ctx, key, ttlSeconds, value); err != nil {
		return profileResponse{}, err
	}
	return value, nil
}

// renewProfileLock extends the lock periodically while the loader runs. The
// Lua compare ensures an expired-and-reacquired lock is never extended by the
// previous owner. Failure is best-effort, exactly like the NestJS interval.
func (s *Service) renewProfileLock(ctx context.Context, lockKey, lockToken string, lockTTLMs int, stop <-chan struct{}) {
	renewInterval := time.Duration(maxInt(authCacheMinRenewIntervalMs, lockTTLMs/2)) * time.Millisecond
	ticker := time.NewTicker(renewInterval)
	defer ticker.Stop()
	for {
		select {
		case <-stop:
			return
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := s.extendLock(context.WithoutCancel(ctx), lockKey, lockToken, lockTTLMs); err != nil {
				log.Printf("accountsecurity: profile cache lock renew failed: %v", err)
			}
		}
	}
}

// storeProfileCache serializes and stores the base profile.
func (s *Service) storeProfileCache(ctx context.Context, key string, ttlSeconds int, value profileResponse) error {
	payload, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return s.cacheSet(ctx, key, payload, ttlSeconds)
}

// invalidateProfileCache mirrors invalidateProfileCache: delete the current
// request key, then delete one key per membership organization. It never scans
// Redis and never touches another user's keys.
func (s *Service) invalidateProfileCache(ctx context.Context, userID, orgID string) error {
	if err := s.cacheDel(ctx, profileCacheKey(userID, orgID)); err != nil {
		return err
	}
	orgIDs, err := s.membershipOrgIDs(ctx, userID)
	if err != nil {
		return err
	}
	for _, memberOrgID := range orgIDs {
		if err := s.cacheDel(ctx, profileCacheKey(userID, memberOrgID)); err != nil {
			return err
		}
	}
	return nil
}

// sleepContext waits for the retry delay or the request cancellation.
func sleepContext(ctx context.Context, delay time.Duration) error {
	if delay <= 0 {
		return nil
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
