package llmgatewayprofiles

import (
	"context"
	"encoding/json"
)

// This file holds the read-only projections of the two shared settings
// documents this batch must consult (proxy governance and system security) plus
// the profile document cache.
//
// The governance and security caches belong to their own services and store a
// complete document inside an exists/value envelope. This package therefore only
// READS them: a cache miss falls back to MySQL and deliberately does not write
// the cache back, because writing a two-field projection there would destroy the
// full configuration for every other reader.

// securitySettingsProjection is the strong-typed projection of the
// system_security document needed by the secret encryption policy.
type securitySettingsProjection struct {
	SecretEncryptionEnabled json.RawMessage `json:"secretEncryptionEnabled"`
	MFAPolicy               json.RawMessage `json:"mfaPolicy"`
}

// cachedSecurityEnvelope is the exists/value envelope of the security cache.
type cachedSecurityEnvelope struct {
	Exists bool                        `json:"exists"`
	Value  *securitySettingsProjection `json:"value,omitempty"`
}

// loadSecuritySettings reads system_security with the shared cache envelope,
// falling back to MySQL on a miss or a decode failure.
func (s *Service) loadSecuritySettings(ctx context.Context) (securitySettingsProjection, error) {
	if s != nil && s.securityFn != nil {
		return s.securityFn(ctx)
	}
	if cached, found, err := s.cacheGetJSON(ctx, SecurityCacheKey); err != nil {
		logCacheFailure("read", SecurityCacheKey, err)
	} else if found {
		var envelope cachedSecurityEnvelope
		if decodeErr := json.Unmarshal(cached, &envelope); decodeErr != nil {
			logCacheFailure("decode", SecurityCacheKey, decodeErr)
		} else if !envelope.Exists || envelope.Value == nil {
			return securitySettingsProjection{}, nil
		} else {
			return *envelope.Value, nil
		}
	}

	raw, found, err := s.loadSettingRaw(ctx, SecuritySettingsKey)
	if err != nil {
		return securitySettingsProjection{}, err
	}
	if !found {
		return securitySettingsProjection{}, nil
	}
	var projection securitySettingsProjection
	if err := json.Unmarshal(raw, &projection); err != nil {
		// A non-object document is read as "not configured", exactly like the
		// NestJS `raw && typeof raw === "object" ? raw : null` guard.
		return securitySettingsProjection{}, nil
	}
	return projection, nil
}

// governanceProjection is the strong-typed projection of the
// litellm_proxy_governance document needed by the two protection assertions.
// Only enabled and targetProfileId are decoded: the managed runtime key is never
// needed because this batch performs no governance operation.
type governanceProjection struct {
	Enabled         json.RawMessage `json:"enabled"`
	TargetProfileID json.RawMessage `json:"targetProfileId"`
}

// cachedGovernanceEnvelope is the exists/value envelope of the governance cache.
type cachedGovernanceEnvelope struct {
	Exists bool                  `json:"exists"`
	Value  *governanceProjection `json:"value,omitempty"`
}

// loadGovernanceSettings reads litellm_proxy_governance with the shared cache
// envelope, falling back to MySQL on a miss or a decode failure. It never writes
// the cache.
func (s *Service) loadGovernanceSettings(ctx context.Context) (governanceProjection, error) {
	if s != nil && s.governanceFn != nil {
		return s.governanceFn(ctx)
	}
	if cached, found, err := s.cacheGetJSON(ctx, GovernanceCacheKey); err != nil {
		logCacheFailure("read", GovernanceCacheKey, err)
	} else if found {
		var envelope cachedGovernanceEnvelope
		if decodeErr := json.Unmarshal(cached, &envelope); decodeErr != nil {
			logCacheFailure("decode", GovernanceCacheKey, decodeErr)
		} else if !envelope.Exists || envelope.Value == nil {
			return governanceProjection{}, nil
		} else {
			return *envelope.Value, nil
		}
	}

	raw, found, err := s.loadSettingRaw(ctx, GovernanceSettingsKey)
	if err != nil {
		return governanceProjection{}, err
	}
	if !found {
		return governanceProjection{}, nil
	}
	var projection governanceProjection
	if err := json.Unmarshal(raw, &projection); err != nil {
		return governanceProjection{}, nil
	}
	return projection, nil
}

// loadSettingsCached is the best-effort GET path: the 60 second Redis entry is
// consulted first, then MySQL, and the normalized document warms the cache.
func (s *Service) loadSettingsCached(ctx context.Context) (StoredSettings, error) {
	if cached, found, err := s.cacheGetJSON(ctx, CacheKey); err != nil {
		logCacheFailure("read", CacheKey, err)
	} else if found {
		return NormalizeSettings(cached, s.cfg.Env), nil
	}

	raw, _, err := s.loadSettingRaw(ctx, SettingsKey)
	if err != nil {
		return StoredSettings{}, err
	}
	settings := NormalizeSettings(raw, s.cfg.Env)
	payload, marshalErr := json.Marshal(settings)
	if marshalErr != nil {
		return settings, nil
	}
	if err := s.cacheSetJSON(ctx, CacheKey, payload, CacheTTLSeconds); err != nil {
		logCacheFailure("write", CacheKey, err)
	}
	return settings, nil
}

// loadSettingsAuthoritative is the write-path merge base: always the MySQL row,
// never the cache, and it does not warm the cache with a document that is about
// to be replaced.
func (s *Service) loadSettingsAuthoritative(ctx context.Context) (StoredSettings, error) {
	raw, _, err := s.loadSettingRaw(ctx, SettingsKey)
	if err != nil {
		return StoredSettings{}, err
	}
	return NormalizeSettings(raw, s.cfg.Env), nil
}

// persistedView rebuilds the read projection of the document that was just
// written: the JSON round trip mirrors what the column holds and
// NormalizeSettings mirrors the read path, so a write response is identical to
// the following GET.
func (s *Service) persistedView(settings StoredSettings) StoredSettings {
	payload, err := json.Marshal(settings)
	if err != nil {
		return settings
	}
	return NormalizeSettings(payload, s.cfg.Env)
}

// saveSettings persists the document, then writes the audit trail, then evicts
// the read cache — the same order as the NestJS helper, so the configuration is
// durable before the audit entry is attempted and a doubly-failed audit still
// surfaces as an error.
func (s *Service) saveSettings(ctx context.Context, orgID, actorID string, settings StoredSettings, action AuditAction, metadata json.RawMessage) error {
	payload, err := json.Marshal(settings)
	if err != nil {
		return err
	}
	if err := s.upsertSettingForceDescription(ctx, SettingsKey, payload, SettingsDescription, nullableActorID(actorID)); err != nil {
		return err
	}
	if err := s.writeAuditLogBestEffort(ctx, orgID, actorID, action, metadata); err != nil {
		return err
	}
	if err := s.cacheDel(ctx, CacheKey); err != nil {
		logCacheFailure("delete", CacheKey, err)
	}
	return nil
}
