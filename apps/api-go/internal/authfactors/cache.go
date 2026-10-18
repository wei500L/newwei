package authfactors

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/redis/go-redis/v9"
)

// cacheGet reads one JSON cache entry. A missing key is reported as found=false
// rather than as an error; malformed JSON is an error so the caller can decide
// whether to fall back (NestJS JSON.parse throws in the same situation).
func (s *Service) cacheGet(ctx context.Context, key string) (json.RawMessage, bool, error) {
	if s == nil || s.redis == nil {
		return nil, false, errNoRedis
	}
	raw, err := s.redis.Get(ctx, key).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	if len(raw) == 0 || !json.Valid(raw) {
		return nil, false, fmt.Errorf("authfactors: cache entry %q is not valid json", key)
	}
	return json.RawMessage(raw), true, nil
}

// systemSecurityConfigured resolves the `secretEncryptionEnabled` tri-state the
// way AuthSecurityService.getStoredSettings does.
//
// The Redis entry is consulted first. CacheService.wrap only honours a cached
// value when JSON.parse yields a truthy value, so a cached `null` falls through
// to the database while any other JSON document (object, array, string,
// number, boolean) is used as-is — and a non-object document yields "not
// configured" rather than an explicit false. The second return value is false
// whenever the flag is not an exact JSON boolean.
func (s *Service) systemSecurityConfigured(ctx context.Context) (bool, bool) {
	if s == nil {
		return false, false
	}
	if raw, found, err := s.cacheGet(ctx, systemSecurityCacheKey); err != nil {
		logBackground("system security settings cache read failed", err)
	} else if found && !isJSONNull(raw) {
		return configuredFromRaw(raw)
	}

	raw, found, err := s.loadSystemSecuritySetting(ctx)
	if err != nil {
		logBackground("system security settings database read failed", err)
		return false, false
	}
	if !found {
		return false, false
	}
	return configuredFromRaw(raw)
}

// isJSONNull reports whether a cache entry is the JSON literal null, which
// JavaScript treats as falsy and therefore as a cache miss.
func isJSONNull(raw json.RawMessage) bool {
	return bytes.Equal(bytes.TrimSpace(raw), []byte("null"))
}

// systemSecuritySettings is the stored `system_security` value shape.
type systemSecuritySettings struct {
	SecretEncryptionEnabled *bool `json:"secretEncryptionEnabled"`
}

// configuredFromRaw extracts the secretEncryptionEnabled tri-state. The second
// return value is false whenever the stored value is not an object or the
// member is not a boolean, which is exactly the NestJS
// `typeof value === "boolean" ? value : null` rule: a non-boolean member means
// "not configured", never an explicit false. Treating it as false would
// silently downgrade an enabled encryption policy to plaintext storage.
func configuredFromRaw(raw json.RawMessage) (bool, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return false, false
	}
	var settings systemSecuritySettings
	if err := json.Unmarshal(trimmed, &settings); err != nil {
		return false, false
	}
	if settings.SecretEncryptionEnabled == nil {
		return false, false
	}
	return *settings.SecretEncryptionEnabled, true
}

// profileCacheKey builds the AuthService profile cache key. An empty
// organization segment becomes `default`, matching
// `profile:${userId}:${orgId ?? "default"}`.
func profileCacheKey(userID, orgID string) string {
	if orgID == "" {
		orgID = profileCacheDefaultOrg
	}
	return profileCacheKeyPrefix + userID + ":" + orgID
}

// invalidateProfileCache drops the cached authenticated profile for one user in
// every organization they belong to (AF3).
//
// `mfaEnabled` is part of the cached profile and the TOTP factor is a global
// user state, so the `default` entry and every membership organization entry
// must go. Only this user's keys are touched: no other user's cache and no
// other cache namespace is affected. The invalidation runs after the database
// commit and never replays it.
func (s *Service) invalidateProfileCache(ctx context.Context, userID string) error {
	if s == nil {
		return errNoRedis
	}
	if s.redis == nil {
		// Redis is a startup requirement of go mode, so a missing client only
		// happens in a mis-wired process or in a unit test. The database commit
		// already happened; skipping the eviction is logged and the transaction
		// is never replayed.
		logBackground("profile cache invalidation skipped: redis is not configured", nil)
		return nil
	}
	if err := s.redis.Del(ctx, profileCacheKey(userID, "")).Err(); err != nil {
		return err
	}
	orgIDs, err := s.membershipOrgIDs(ctx, userID)
	if err != nil {
		return err
	}
	for _, orgID := range orgIDs {
		if err := s.redis.Del(ctx, profileCacheKey(userID, orgID)).Err(); err != nil {
			return err
		}
	}
	return nil
}
