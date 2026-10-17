package runtimesettings

import (
	"bytes"
	"context"
	"encoding/json"
	"math"
	"strconv"
	"sync"
	"time"
)

// Audit log retention bounds, copied from audit-log-settings.service.ts.
const (
	auditLogMinRetentionDays = 1
	auditLogMaxRetentionDays = 3650
)

// auditLogRetentionTTLMs is the per-process cache TTL the NestJS service keeps
// in memory (30 seconds). It is not shared across replicas there either.
const auditLogRetentionTTLMs = 30000

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

// retentionCache mirrors the service's process-local 30 second cache.
type retentionCache struct {
	mutex     sync.Mutex
	days      int
	expiresAt time.Time
	valid     bool
}

// load returns the cached value when it has not expired.
func (c *retentionCache) load(now time.Time) (int, bool) {
	c.mutex.Lock()
	defer c.mutex.Unlock()
	if c.valid && now.Before(c.expiresAt) {
		return c.days, true
	}
	return 0, false
}

// store refreshes the cache.
func (c *retentionCache) store(days int, now time.Time) {
	c.mutex.Lock()
	defer c.mutex.Unlock()
	c.days = days
	c.valid = true
	c.expiresAt = now.Add(auditLogRetentionTTLMs * time.Millisecond)
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

// getAuditLogRetention mirrors getRetentionDays: a 30 second process-local cache
// in front of the database read.
func (s *Service) getAuditLogRetention(ctx context.Context) (int, error) {
	now := time.Now()
	if days, ok := s.retention.load(now); ok {
		return days, nil
	}
	days, err := s.loadRetentionDays(ctx)
	if err != nil {
		return 0, err
	}
	s.retention.store(days, now)
	return days, nil
}

// updateAuditLogRetention mirrors updateRetentionDays: upsert the raw number,
// write the audit row best-effort and refresh the process-local cache. The
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
	s.retention.store(normalized, time.Now())
	return normalized, nil
}
