package platformgovernance

import (
	"bytes"
	"context"
	"encoding/json"
)

// storedCacheEntry is the Redis envelope the security, assistant-quota and
// assistant-safety services write:
//
//	{"exists":true,"value":<stored object>}
//	{"exists":false}
//
// NestJS writes `value: settings ?? undefined`, so the key is omitted when the
// row exists but its JSON is not an object, and when no row exists. The field is
// therefore omitempty and carries the DB bytes verbatim for byte-level parity
// across implementations.
type storedCacheEntry struct {
	Exists bool            `json:"exists"`
	Value  json.RawMessage `json:"value,omitempty"`
}

// cachedStoredValue is the outcome of one cache lookup.
type cachedStoredValue struct {
	// hit reports that the cache held a usable entry, so the caller must NOT
	// fall back to MySQL (mirroring the NestJS `if (cached)` branch).
	hit bool
	// exists reports entry.exists; only meaningful when hit is true.
	exists bool
	// value is the stored object bytes; nil when the row exists but was not an
	// object (or when exists is false).
	value json.RawMessage
}

// loadCachedStored reproduces the NestJS loadStoredSettings cache prologue:
// a Redis failure or an unparseable entry is logged and treated as a miss, and
// an entry without `exists:true` resolves to "no stored settings".
func (s *Service) loadCachedStored(ctx context.Context, cacheKey string) cachedStoredValue {
	raw, found, err := s.cacheGet(ctx, cacheKey)
	if err != nil {
		logCacheFailure("read", cacheKey, err)
		return cachedStoredValue{}
	}
	if !found {
		return cachedStoredValue{}
	}
	trimmed := bytes.TrimSpace(raw)
	// A literal JSON null is falsy in JavaScript, so NestJS falls through to the
	// database; do the same instead of treating it as "no row".
	if bytes.Equal(trimmed, []byte("null")) {
		return cachedStoredValue{}
	}
	var entry storedCacheEntry
	if err := json.Unmarshal(trimmed, &entry); err != nil {
		logCacheFailure("decode", cacheKey, err)
		return cachedStoredValue{}
	}
	if !entry.Exists {
		return cachedStoredValue{hit: true}
	}
	if len(bytes.TrimSpace(entry.Value)) == 0 {
		return cachedStoredValue{hit: true, exists: true}
	}
	return cachedStoredValue{hit: true, exists: true, value: entry.Value}
}

// writeStoredCache writes the envelope NestJS produces. A Redis failure is
// logged and ignored, exactly like the NestJS best-effort cache write.
func (s *Service) writeStoredCache(ctx context.Context, cacheKey string, rowExists bool, value json.RawMessage, ttlSeconds int) {
	entry := storedCacheEntry{Exists: rowExists}
	if rowExists {
		if objectBytes, ok := storedValueIsObjectLike(value); ok {
			entry.Value = objectBytes
		}
	}
	payload, err := json.Marshal(entry)
	if err != nil {
		logCacheFailure("encode", cacheKey, err)
		return
	}
	if err := s.cacheSet(ctx, cacheKey, payload, ttlSeconds); err != nil {
		logCacheFailure("write", cacheKey, err)
	}
}

// loadStoredWithCache is the complete NestJS read prologue shared by the
// security, assistant-quota and assistant-safety services: consult the cache,
// fall back to MySQL on a miss, then repopulate the cache (best effort).
//
// It returns the bytes to decode into a named struct plus whether a row exists.
// A stored array yields nil bytes with present=true.
func (s *Service) loadStoredWithCache(ctx context.Context, settingKey, cacheKey string, ttlSeconds int) (json.RawMessage, bool, error) {
	cached := s.loadCachedStored(ctx, cacheKey)
	if cached.hit {
		if !cached.exists {
			return nil, false, nil
		}
		stored, present := storedValueForStruct(cached.value)
		if !present {
			return nil, false, nil
		}
		return stored, true, nil
	}

	raw, found, err := s.loadSetting(ctx, settingKey)
	if err != nil {
		return nil, false, err
	}
	stored, present := storedValueForStruct(raw)
	s.writeStoredCache(ctx, cacheKey, found, raw, ttlSeconds)
	if !present {
		return nil, false, nil
	}
	return stored, true, nil
}

// invalidateStoredCache removes one settings cache key, tolerating Redis
// failures with a warning (the NestJS invalidateCache helpers do the same).
func (s *Service) invalidateStoredCache(ctx context.Context, cacheKey string) {
	if err := s.cacheDel(ctx, cacheKey); err != nil {
		logCacheFailure("delete", cacheKey, err)
	}
}
