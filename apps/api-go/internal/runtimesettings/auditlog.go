package runtimesettings

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"math"
	"strconv"
)

// Audit log retention bounds, copied from audit-log-settings.service.ts.
const (
	auditLogMinRetentionDays = 1
	auditLogMaxRetentionDays = 3650
)

// auditLogRetentionCacheKey and auditLogRetentionCacheTTLSeconds are the shared
// Redis cache the NestJS AuditLogSettingsService and this package both read and
// write. It replaces the former process-local 30 second cache, which could not
// see a write performed by the other runtime.
const (
	auditLogRetentionCacheKey        = "audit_log:retention_days"
	auditLogRetentionCacheTTLSeconds = 30
)

// auditLogRetentionResponse is the GET/PUT response body: a bare object with one
// integer key.
type auditLogRetentionResponse struct {
	RetentionDays int `json:"retentionDays"`
}

// auditLogRetentionRequest mirrors UpdateAuditLogRetentionDto.
type auditLogRetentionRequest struct {
	RetentionDays json.RawMessage `json:"retentionDays"`
}

// auditLogRetentionMetadata is the AuditLog.metadata document for the update.
type auditLogRetentionMetadata struct {
	RetentionDays int `json:"retentionDays"`
}

// auditLogStoredValue is the object form a stored SystemSetting.value may use
// (`{"retentionDays": 90}`); a bare JSON number is also accepted.
type auditLogStoredValue struct {
	RetentionDays json.RawMessage `json:"retentionDays"`
}

// parseUpdateAuditLogRetention validates the PUT body.
func parseUpdateAuditLogRetention(body []byte) (auditLogRetentionRequest, error) {
	var dto auditLogRetentionRequest
	if err := decodeBodyError(newStrictDecoder(body).Decode(&dto)); err != nil {
		return auditLogRetentionRequest{}, err
	}
	problems := validationErrors{}
	numberField(&problems, dto.RetentionDays, "retentionDays", true, auditLogMinRetentionDays, auditLogMaxRetentionDays)
	if err := problems.err(); err != nil {
		return auditLogRetentionRequest{}, err
	}
	return dto, nil
}

// normalizeRetentionDays mirrors the service normalize: Math.floor first, then
// NaN/below-minimum becomes the minimum and above-maximum becomes the maximum.
func normalizeRetentionDays(value float64) int {
	floored := math.Floor(value)
	if math.IsNaN(floored) || floored < auditLogMinRetentionDays {
		return auditLogMinRetentionDays
	}
	if floored > auditLogMaxRetentionDays {
		return auditLogMaxRetentionDays
	}
	return int(floored)
}

// loadRetentionDays mirrors loadRetentionDays: accept a raw JSON number or an
// object with a numeric retentionDays property, otherwise fall back to the
// environment default (itself normalized).
func (s *Service) loadRetentionDays(ctx context.Context) (int, error) {
	fallback := normalizeRetentionDays(float64(s.cfg.AuditLogRetentionDays))
	raw, found, err := s.loadSetting(ctx, settingKeyAuditLogRetention)
	if err != nil {
		return 0, err
	}
	if !found {
		return fallback, nil
	}
	trimmed := bytes.TrimSpace(raw)
	switch {
	case len(trimmed) > 0 && (trimmed[0] == '-' || (trimmed[0] >= '0' && trimmed[0] <= '9')):
		value, parseErr := parseJSONFloat(trimmed)
		if parseErr != nil {
			return fallback, nil
		}
		return normalizeRetentionDays(value), nil
	case objectLikeJSON(trimmed):
		var stored auditLogStoredValue
		if err := json.Unmarshal(trimmed, &stored); err != nil {
			return fallback, nil
		}
		if !isJSONNumber(stored.RetentionDays) {
			return fallback, nil
		}
		value, parseErr := parseJSONFloat(stored.RetentionDays)
		if parseErr != nil {
			return fallback, nil
		}
		return normalizeRetentionDays(value), nil
	default:
		return fallback, nil
	}
}

// getAuditLogRetention mirrors getRetentionDays: the shared Redis document is
// read first, then MySQL, and a cache miss refreshes the shared entry. A Redis
// failure is logged and never fails the request, which is the same tolerance the
// NestJS service applies around CacheService.
func (s *Service) getAuditLogRetention(ctx context.Context) (int, error) {
	if raw, found, cacheErr := s.cacheGet(ctx, auditLogRetentionCacheKey); cacheErr != nil {
		logCacheFailure("audit log retention", auditLogRetentionCacheKey, cacheErr)
	} else if found {
		var cached int
		if err := json.Unmarshal(raw, &cached); err == nil {
			return normalizeRetentionDays(float64(cached)), nil
		}
		logCacheFailure("audit log retention", auditLogRetentionCacheKey, errors.New("cache entry is not a retention number"))
	}

	days, err := s.loadRetentionDays(ctx)
	if err != nil {
		return 0, err
	}
	if encoded, encodeErr := json.Marshal(days); encodeErr == nil {
		if cacheErr := s.cacheSet(ctx, auditLogRetentionCacheKey, encoded, auditLogRetentionCacheTTLSeconds); cacheErr != nil {
			logCacheFailure("audit log retention", auditLogRetentionCacheKey, cacheErr)
		}
	}
	return days, nil
}

// updateAuditLogRetention mirrors updateRetentionDays: upsert the raw number,
// write the audit row best-effort and refresh the shared Redis document. The
// caller must have already enforced the platform-admin gate.
func (s *Service) updateAuditLogRetention(ctx context.Context, orgID, actorID string, days int) (int, error) {
	if s == nil || s.db == nil {
		return 0, errNoDatabase
	}
	normalized := normalizeRetentionDays(float64(days))
	encoded := json.RawMessage(strconv.Itoa(normalized))
	if err := s.upsertSetting(ctx, settingKeyAuditLogRetention, encoded, descriptionAuditLogRetention, nullableActorID(actorID)); err != nil {
		return 0, err
	}
	if metadata, marshalErr := json.Marshal(auditLogRetentionMetadata{RetentionDays: normalized}); marshalErr == nil {
		s.writeAuditLogBestEffort(ctx, orgID, actorID, "audit_log_retention_update", metadata)
	}
	if cachePayload, encodeErr := json.Marshal(normalized); encodeErr == nil {
		if cacheErr := s.cacheSet(ctx, auditLogRetentionCacheKey, cachePayload, auditLogRetentionCacheTTLSeconds); cacheErr != nil {
			logCacheFailure("audit log retention", auditLogRetentionCacheKey, cacheErr)
		}
	}
	return normalized, nil
}
