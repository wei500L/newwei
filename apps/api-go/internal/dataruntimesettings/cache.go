package dataruntimesettings

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

// ---- generic Redis primitives ----

// cacheGet reads a JSON cache entry. A missing key is reported as found=false
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
		return nil, false, fmt.Errorf("dataruntimesettings: cache entry %q is not valid json", key)
	}
	return json.RawMessage(raw), true, nil
}

// cacheSet writes a JSON cache entry with an expiry, mirroring CacheService.set.
func (s *Service) cacheSet(ctx context.Context, key string, payload json.RawMessage, ttlSeconds int) error {
	if s == nil || s.redis == nil {
		return errNoRedis
	}
	return s.redis.Set(ctx, key, []byte(payload), time.Duration(ttlSeconds)*time.Second).Err()
}

// cacheDel removes a cache entry, mirroring CacheService.del. Failure is
// tolerated by the callers (NestJS logs and continues), because a stale entry is
// never a reason to fail a settings write that already committed.
func (s *Service) cacheDel(ctx context.Context, key string) error {
	if s == nil || s.redis == nil {
		return errNoRedis
	}
	return s.redis.Del(ctx, key).Err()
}

// zcard mirrors CacheService.zcard.
func (s *Service) zcard(ctx context.Context, key string) (int64, error) {
	if s == nil || s.redis == nil {
		return 0, errNoRedis
	}
	return s.redis.ZCard(ctx, key).Result()
}

// zrange mirrors CacheService.zrange (inclusive stop index, ascending score
// order, Redis lexicographic order for equal scores).
func (s *Service) zrange(ctx context.Context, key string, start, stop int64) ([]string, error) {
	if s == nil || s.redis == nil {
		return nil, errNoRedis
	}
	return s.redis.ZRange(ctx, key, start, stop).Result()
}

// mget mirrors CacheService.getMany: one MGET in the caller's key order, with a
// nil slot for every missing or expired member.
func (s *Service) mget(ctx context.Context, keys []string) ([]json.RawMessage, error) {
	if s == nil || s.redis == nil {
		return nil, errNoRedis
	}
	if len(keys) == 0 {
		return nil, nil
	}
	values, err := s.redis.MGet(ctx, keys...).Result()
	if err != nil {
		return nil, err
	}
	out := make([]json.RawMessage, len(values))
	for index, value := range values {
		if value == nil {
			continue
		}
		text, ok := value.(string)
		if !ok {
			return nil, fmt.Errorf("dataruntimesettings: cache member %d is not a string", index)
		}
		if len(text) == 0 || !json.Valid([]byte(text)) {
			// A member that is not valid JSON is treated as absent, which is
			// what NestJS's `record == null` filter does after a parse failure
			// is impossible here: an unparseable member is skipped, never
			// counted as a state.
			continue
		}
		out[index] = json.RawMessage(text)
	}
	return out, nil
}

// ---- realtime signals settings cache ({exists,value} envelope) ----

// cachedRealtimeSettings is the `realtime-signals:settings` envelope. An
// exists/value wrapper is used so a "no row yet" result is cached too, and the
// value member is omitted (not written as null) when the row is absent, which
// preserves the NestJS `value?: StoredRealtimeSignalsSettings` semantics.
type cachedRealtimeSettings struct {
	Exists bool            `json:"exists"`
	Value  json.RawMessage `json:"value,omitempty"`
}

// loadRealtimeSettingsCache reads the Redis envelope. A cache failure is logged
// and treated as a miss, matching the NestJS try/catch around cache.get.
func (s *Service) loadRealtimeSettingsCache(ctx context.Context) (found bool, settings *storedRealtimeSettings) {
	raw, hit, err := s.cacheGet(ctx, cacheKeyRealtime)
	if err != nil {
		logBackground("realtime signals settings cache read failed", err)
		return false, nil
	}
	if !hit {
		return false, nil
	}
	var cached cachedRealtimeSettings
	if err := json.Unmarshal(raw, &cached); err != nil {
		logBackground("realtime signals settings cache entry is not valid", err)
		return false, nil
	}
	if !cached.Exists {
		return true, nil
	}
	return true, parseStoredRealtimeSettings(cached.Value)
}

// writeRealtimeSettingsCache stores the envelope, tolerating a write failure.
func (s *Service) writeRealtimeSettingsCache(ctx context.Context, settings *storedRealtimeSettings) {
	envelope := cachedRealtimeSettings{Exists: settings != nil}
	if settings != nil {
		encoded, err := json.Marshal(settings)
		if err != nil {
			logBackground("realtime signals settings cache encode failed", err)
			return
		}
		envelope.Value = encoded
	}
	payload, err := json.Marshal(envelope)
	if err != nil {
		logBackground("realtime signals settings cache envelope failed", err)
		return
	}
	if err := s.cacheSet(ctx, cacheKeyRealtime, payload, realtimeCacheTTLSeconds); err != nil {
		logBackground("realtime signals settings cache write failed", err)
	}
}

// ---- ACLED auth state cache ({exists,value} envelope, delete-only) ----

// invalidateAcledAuthStateCache drops the derived OAuth state cache entry. The
// state itself is never read: ACLED stays disabled, so no response can depend on
// it.
func (s *Service) invalidateAcledAuthStateCache(ctx context.Context) {
	if err := s.cacheDel(ctx, cacheKeyAcledAuthState); err != nil {
		logBackground("failed to invalidate ACLED auth state cache", err)
	}
}

// ---- archive preparation settings cache ----
//
// The `archive_preparation:settings` helpers live in archive_settings.go: the
// cached payload is the raw settings value (or the JSON literal null), never an
// {exists,value} envelope, so decoding it needs the JavaScript truthiness rule
// that only that file owns.

// ---- system_security cache ({exists,value} envelope, read-only) ----

// cachedSystemSecuritySettings is the `system_security:settings` envelope.
type cachedSystemSecuritySettings struct {
	Exists bool            `json:"exists"`
	Value  json.RawMessage `json:"value,omitempty"`
}

// systemSecuritySettings is the stored `system_security` value shape.
type systemSecuritySettings struct {
	SecretEncryptionEnabled *bool `json:"secretEncryptionEnabled"`
}
