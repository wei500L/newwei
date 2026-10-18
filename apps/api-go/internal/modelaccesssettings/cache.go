package modelaccesssettings

import (
	"context"
	"encoding/json"
)

// This file holds the read-through cache contract shared by the four settings
// rows. Reads keep the original 30 second best-effort Redis envelope semantics;
// WRITE paths must use the Authoritative readers instead, because a stale
// envelope must never become a read-modify-write baseline (MA2/MA3).

// readModelServiceRecordCached mirrors ModelServiceSettingsService
// .loadStoredSettings: a 30 second best-effort Redis envelope first, then MySQL,
// then the envelope is refreshed. Failure to read or write the cache only logs a
// warning and falls back to the database.
func (s *Service) readModelServiceRecordCached(ctx context.Context) (modelServiceRecord, error) {
	cached, found, err := s.cacheGet(ctx, cacheKeyModelService)
	if err != nil {
		logCacheFailure("model service settings cache read", cacheKeyModelService, err)
	}
	if found {
		return decodeCachedModelServiceEnvelope(cached)
	}

	raw, exists, err := s.loadSetting(ctx, settingKeyModelService)
	if err != nil {
		return modelServiceRecord{}, err
	}
	record, err := decodeModelServiceRecord(raw)
	if err != nil {
		return modelServiceRecord{}, err
	}
	s.writeCacheEnvelope(ctx, cacheKeyModelService, exists, raw, settingsCacheTTLSeconds)
	return record, nil
}

// readModelServiceRecordAuthoritative reads the row straight from MySQL. Every
// write path MUST use this: the cached reader can return a token that was already
// rotated in the database (MA3).
func (s *Service) readModelServiceRecordAuthoritative(ctx context.Context) (modelServiceRecord, error) {
	raw, _, err := s.loadSetting(ctx, settingKeyModelService)
	if err != nil {
		return modelServiceRecord{}, err
	}
	return decodeModelServiceRecord(raw)
}

// readOpenAiKeysRecordCached mirrors OpenAiKeysSettingsService.loadStoredSettings.
func (s *Service) readOpenAiKeysRecordCached(ctx context.Context) (openAiKeysRecord, error) {
	cached, found, err := s.cacheGet(ctx, cacheKeyOpenAiKeys)
	if err != nil {
		logCacheFailure("openai keys settings cache read", cacheKeyOpenAiKeys, err)
	}
	if found {
		return decodeCachedOpenAiKeysEnvelope(cached)
	}

	raw, exists, err := s.loadSetting(ctx, settingKeyOpenAiKeys)
	if err != nil {
		return openAiKeysRecord{}, err
	}
	record, err := decodeOpenAiKeysRecord(raw)
	if err != nil {
		return openAiKeysRecord{}, err
	}
	s.writeCacheEnvelope(ctx, cacheKeyOpenAiKeys, exists, raw, settingsCacheTTLSeconds)
	return record, nil
}

// readOpenAiKeysRecordAuthoritative reads the row straight from MySQL. Every key
// write MUST use this as its read-modify-write baseline (MA2).
func (s *Service) readOpenAiKeysRecordAuthoritative(ctx context.Context) (openAiKeysRecord, error) {
	raw, _, err := s.loadSetting(ctx, settingKeyOpenAiKeys)
	if err != nil {
		return openAiKeysRecord{}, err
	}
	return decodeOpenAiKeysRecord(raw)
}

// readAppliedStatusCached mirrors OpenAiKeysSettingsService.loadAppliedStatus.
func (s *Service) readAppliedStatusCached(ctx context.Context) (appliedStatusRecord, error) {
	cached, found, err := s.cacheGet(ctx, cacheKeyAppliedStatus)
	if err != nil {
		logCacheFailure("openai keys applied status cache read", cacheKeyAppliedStatus, err)
	}
	if found {
		return decodeCachedAppliedStatusEnvelope(cached)
	}

	raw, exists, err := s.loadSetting(ctx, settingKeyAppliedStatus)
	if err != nil {
		return appliedStatusRecord{}, err
	}
	record, err := decodeAppliedStatusRecord(raw)
	if err != nil {
		return appliedStatusRecord{}, err
	}
	s.writeCacheEnvelope(ctx, cacheKeyAppliedStatus, exists, raw, appliedCacheTTLSeconds)
	return record, nil
}

// readAppliedStatusAuthoritative reads the applied-status row straight from MySQL;
// the write responses project this value instead of the pre-write cache envelope.
func (s *Service) readAppliedStatusAuthoritative(ctx context.Context) (appliedStatusRecord, error) {
	raw, _, err := s.loadSetting(ctx, settingKeyAppliedStatus)
	if err != nil {
		return appliedStatusRecord{}, err
	}
	return decodeAppliedStatusRecord(raw)
}

// readProxyLoadBalancingRecordCached mirrors
// LiteLlmProxyLoadBalancingSettingsService.loadStoredSettings.
func (s *Service) readProxyLoadBalancingRecordCached(ctx context.Context) (proxyLoadBalancingRecord, error) {
	cached, found, err := s.cacheGet(ctx, cacheKeyProxyLoadBalancing)
	if err != nil {
		logCacheFailure("proxy load balancing settings cache read", cacheKeyProxyLoadBalancing, err)
	}
	if found {
		return decodeCachedProxyLoadBalancingEnvelope(cached)
	}

	raw, exists, err := s.loadSetting(ctx, settingKeyProxyLoadBalancing)
	if err != nil {
		return proxyLoadBalancingRecord{}, err
	}
	record, err := decodeProxyLoadBalancingRecord(raw)
	if err != nil {
		return proxyLoadBalancingRecord{}, err
	}
	s.writeCacheEnvelope(ctx, cacheKeyProxyLoadBalancing, exists, raw, settingsCacheTTLSeconds)
	return record, nil
}

// readProxyLoadBalancingRecordAuthoritative reads the row straight from MySQL.
// Every load balancing write MUST use this as its read-modify-write baseline:
// the cached reader may still hold the pre-write configuration.
func (s *Service) readProxyLoadBalancingRecordAuthoritative(ctx context.Context) (proxyLoadBalancingRecord, error) {
	raw, _, err := s.loadSetting(ctx, settingKeyProxyLoadBalancing)
	if err != nil {
		return proxyLoadBalancingRecord{}, err
	}
	return decodeProxyLoadBalancingRecord(raw)
}

// readSystemSecurityRecordCached reads the system_security row through its own
// cache envelope. The read is READ-ONLY: this package never writes
// system_security or its cache (SystemSecuritySettingsService owns both), it only
// projects secretEncryptionEnabled. That envelope's TTL is 60s
// (systemSecurityCacheTTL), not the 30s the other three use.
func (s *Service) readSystemSecurityRecordCached(ctx context.Context) (systemSecurityRecord, error) {
	cached, found, err := s.cacheGet(ctx, cacheKeySystemSecurity)
	if err != nil {
		logCacheFailure("system security settings cache read", cacheKeySystemSecurity, err)
	}
	if found {
		var envelope cacheEnvelope
		if err := json.Unmarshal(cached, &envelope); err != nil {
			return systemSecurityRecord{}, nil
		}
		if !envelope.Exists {
			return systemSecurityRecord{}, nil
		}
		record, err := decodeSystemSecurityRecord(envelope.Value)
		if err != nil {
			return systemSecurityRecord{}, nil
		}
		return record, nil
	}

	raw, _, err := s.loadSetting(ctx, settingKeySystemSecurity)
	if err != nil {
		return systemSecurityRecord{}, err
	}
	return decodeSystemSecurityRecord(raw)
}

// writeCacheEnvelope stores a {"exists":bool,"value":...} envelope. The write is
// best-effort: a Redis failure is logged and the caller keeps the database value.
//
// `exists` mirrors Boolean(record): true whenever the ROW exists, even when its
// value is not an object. `value` carries the raw stored bytes so the envelope
// reproduces JSON.stringify's shape, including omitting `value` for a non-object
// row (JSON.stringify drops undefined).
func (s *Service) writeCacheEnvelope(ctx context.Context, key string, exists bool, raw json.RawMessage, ttlSeconds int) {
	envelope := cacheEnvelope{Exists: exists}
	if exists {
		if trimmed := trimJSON(raw); len(trimmed) > 0 && (trimmed[0] == '{' || trimmed[0] == '[') {
			envelope.Value = trimmed
		}
	}
	payload, err := json.Marshal(envelope)
	if err != nil {
		logCacheFailure("cache encode", key, err)
		return
	}
	if err := s.cacheSet(ctx, key, payload, ttlSeconds); err != nil {
		logCacheFailure("cache write", key, err)
	}
}

// invalidateCache deletes one cache key, best-effort like CacheService.del inside
// the NestJS try/catch.
func (s *Service) invalidateCache(ctx context.Context, key string) {
	if err := s.cacheDel(ctx, key); err != nil {
		logCacheFailure("cache invalidate", key, err)
	}
}

// loadSetting reads one SystemSetting row through the settings port.
func (s *Service) loadSetting(ctx context.Context, key string) (json.RawMessage, bool, error) {
	if s.nilSettings() {
		return nil, false, errNoDatabase
	}
	return s.settings.Load(ctx, key)
}

// cacheGet reads one cache entry through the cache port.
func (s *Service) cacheGet(ctx context.Context, key string) (json.RawMessage, bool, error) {
	if s == nil || s.cache == nil {
		return nil, false, errNoRedis
	}
	return s.cache.Get(ctx, key)
}

// cacheSet writes one cache entry through the cache port.
func (s *Service) cacheSet(ctx context.Context, key string, payload json.RawMessage, ttlSeconds int) error {
	if s == nil || s.cache == nil {
		return errNoRedis
	}
	return s.cache.Set(ctx, key, payload, ttlSeconds)
}

// cacheDel deletes one cache entry through the cache port.
func (s *Service) cacheDel(ctx context.Context, key string) error {
	if s == nil || s.cache == nil {
		return errNoRedis
	}
	return s.cache.Del(ctx, key)
}

// assertPlatformAdmin mirrors PlatformAccessService.assertPlatformAdmin: the model
// service configuration and the OpenAI key pool are global singletons, so only a
// platform admin may write them (MA1).
//
// A machine token can never satisfy the check: GlobalRoleAssignment.userId is a
// foreign key into User(id) and "machine:<id>" is not a user row. The machine case
// is rejected explicitly so the check does not even query MySQL for it.
func (s *Service) assertPlatformAdmin(ctx context.Context, actorID string) error {
	if actorIsMachine(actorID) {
		return &httpError{status: 403, message: "Platform admin access required"}
	}
	if s == nil || s.identity == nil {
		return errNoDatabase
	}
	allowed, err := s.identity.IsPlatformAdmin(ctx, actorID)
	if err != nil {
		return err
	}
	if !allowed {
		return &httpError{status: 403, message: "Platform admin access required"}
	}
	return nil
}

// trimJSON trims ASCII whitespace from a raw JSON value.
func trimJSON(raw json.RawMessage) json.RawMessage {
	start := 0
	end := len(raw)
	for start < end && isJSONSpace(raw[start]) {
		start++
	}
	for end > start && isJSONSpace(raw[end-1]) {
		end--
	}
	return raw[start:end]
}

// isJSONSpace reports whether b is JSON whitespace.
func isJSONSpace(b byte) bool {
	switch b {
	case ' ', '\t', '\n', '\r':
		return true
	default:
		return false
	}
}

// decodeCachedModelServiceEnvelope decodes one model_service cache envelope.
// A malformed envelope behaves like a cache miss.
func decodeCachedModelServiceEnvelope(cached json.RawMessage) (modelServiceRecord, error) {
	var envelope cacheEnvelope
	if err := json.Unmarshal(cached, &envelope); err != nil {
		return modelServiceRecord{}, nil
	}
	if !envelope.Exists {
		return modelServiceRecord{}, nil
	}
	return decodeModelServiceRecord(envelope.Value)
}

// decodeCachedOpenAiKeysEnvelope decodes one openai_keys cache envelope.
func decodeCachedOpenAiKeysEnvelope(cached json.RawMessage) (openAiKeysRecord, error) {
	var envelope cacheEnvelope
	if err := json.Unmarshal(cached, &envelope); err != nil {
		return openAiKeysRecord{}, nil
	}
	if !envelope.Exists {
		return openAiKeysRecord{}, nil
	}
	return decodeOpenAiKeysRecord(envelope.Value)
}

// decodeCachedAppliedStatusEnvelope decodes one applied-status cache envelope.
func decodeCachedAppliedStatusEnvelope(cached json.RawMessage) (appliedStatusRecord, error) {
	var envelope cacheEnvelope
	if err := json.Unmarshal(cached, &envelope); err != nil {
		return appliedStatusRecord{}, nil
	}
	if !envelope.Exists {
		return appliedStatusRecord{}, nil
	}
	return decodeAppliedStatusRecord(envelope.Value)
}

// decodeCachedProxyLoadBalancingEnvelope decodes one load balancing cache
// envelope.
func decodeCachedProxyLoadBalancingEnvelope(cached json.RawMessage) (proxyLoadBalancingRecord, error) {
	var envelope cacheEnvelope
	if err := json.Unmarshal(cached, &envelope); err != nil {
		return proxyLoadBalancingRecord{}, nil
	}
	if !envelope.Exists {
		return proxyLoadBalancingRecord{}, nil
	}
	return decodeProxyLoadBalancingRecord(envelope.Value)
}
