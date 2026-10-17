package llmgatewayprofiles

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

// Storage keys shared with the NestJS service.
const (
	// SettingsKey is the global SystemSetting row holding every profile.
	SettingsKey = "llm_gateway_profiles"
	// SettingsDescription is the row description written on create and update.
	SettingsDescription = "OpenAI-compatible LLM gateway profiles (apiBase/apiKey/model overrides)."
	// CacheKey is the Redis key of the normalized settings document.
	CacheKey = "llm_gateway:profiles"
	// CacheTTLSeconds is the best-effort read cache lifetime.
	CacheTTLSeconds = 60
	// GovernanceSettingsKey is the SystemSetting row of proxy governance.
	GovernanceSettingsKey = "litellm_proxy_governance"
	// GovernanceCacheKey is the Redis key of the governance envelope.
	GovernanceCacheKey = "litellm_proxy_governance:settings"
	// GovernanceCacheTTLSeconds is the governance cache lifetime.
	GovernanceCacheTTLSeconds = 30
	// SecuritySettingsKey is the SystemSetting row of system security.
	SecuritySettingsKey = "system_security"
	// SecurityCacheKey is the Redis key of the security envelope.
	SecurityCacheKey = "system_security:settings"
	// SecurityCacheTTLSeconds is the security cache lifetime.
	SecurityCacheTTLSeconds = 30
	// machineActorPrefix is the user-id prefix produced by the machine token path.
	machineActorPrefix = "machine:"
)

// nowMillis returns the current UTC time truncated to milliseconds, matching the
// DATETIME(3) columns Prisma writes.
func nowMillis() time.Time {
	return time.Now().UTC().Truncate(time.Millisecond)
}

// newRowID generates a client-side identifier in the same shape Prisma's cuid()
// produces ('c' plus 24 hex characters).
func newRowID() (string, error) {
	var buf [12]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return "c" + hex.EncodeToString(buf[:]), nil
}

// actorIsMachine reports whether the actor id came from a machine access token.
func actorIsMachine(actorID string) bool {
	return actorID == "" || strings.HasPrefix(actorID, machineActorPrefix)
}

// nullableActorID converts an actor id into the value written to a nullable
// foreign key column. Machine ids are not User rows, so they must be written as
// NULL instead of producing a foreign key violation.
func nullableActorID(actorID string) *string {
	if actorIsMachine(actorID) {
		return nil
	}
	return &actorID
}

// loadSettingRaw reads one SystemSetting.value document. found is false when the
// row does not exist; the bytes are decoded by the caller into a named type and
// never widened into a loose container.
func (s *Service) loadSettingRaw(ctx context.Context, key string) (json.RawMessage, bool, error) {
	if s == nil || s.db == nil {
		return nil, false, errNoDatabase
	}
	var raw []byte
	err := s.db.QueryRowContext(ctx,
		"SELECT value FROM SystemSetting WHERE `key` = ? LIMIT 1", key).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return json.RawMessage(raw), true, nil
}

// upsertSettingsSQL inserts or updates the global settings row. Both the update
// and the insert branch refresh value, description, isPublic and updatedById,
// exactly like the Prisma upsert in saveSettings which sets all four in both
// branches. `key` is a reserved word and is always backquoted.
const upsertSettingsSQL = "INSERT INTO SystemSetting " +
	"(`key`, value, isPublic, description, createdAt, updatedAt, updatedById) " +
	"VALUES (?, ?, 0, ?, ?, ?, ?) AS new_row " +
	"ON DUPLICATE KEY UPDATE value = new_row.value, isPublic = new_row.isPublic, " +
	"description = new_row.description, updatedAt = new_row.updatedAt, updatedById = new_row.updatedById"

// upsertSettingForceDescription writes one global SystemSetting row.
func (s *Service) upsertSettingForceDescription(ctx context.Context, key string, value json.RawMessage, description string, updatedByID *string) error {
	if s == nil || s.db == nil {
		return errNoDatabase
	}
	now := nowMillis()
	_, err := s.db.ExecContext(ctx, upsertSettingsSQL,
		key, []byte(value), description, now, now, updatedByID)
	return err
}

// ---- Redis cache ----

// cacheGetJSON reads one JSON cache entry. A missing key is reported as
// found=false; malformed JSON is an error so the caller falls back to MySQL the
// way NestJS does when JSON.parse throws.
func (s *Service) cacheGetJSON(ctx context.Context, key string) (json.RawMessage, bool, error) {
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
		return nil, false, fmt.Errorf("llmgatewayprofiles: cache entry %q is not valid json", key)
	}
	return json.RawMessage(raw), true, nil
}

// cacheSetJSON writes one JSON cache entry with a TTL.
func (s *Service) cacheSetJSON(ctx context.Context, key string, payload json.RawMessage, ttlSeconds int) error {
	if s == nil || s.redis == nil {
		return errNoRedis
	}
	return s.redis.Set(ctx, key, []byte(payload), time.Duration(ttlSeconds)*time.Second).Err()
}

// cacheDel removes one cache entry.
func (s *Service) cacheDel(ctx context.Context, key string) error {
	if s == nil || s.redis == nil {
		return errNoRedis
	}
	return s.redis.Del(ctx, key).Err()
}

// logCacheFailure records a Redis failure on a path where NestJS only logs a
// warning and continues.
func logCacheFailure(kind, key string, err error) {
	log.Printf("llmgatewayprofiles: %s cache operation failed for %q: %v", kind, key, err)
}

// ---- AuditLog / AuditLogOutbox ----

// auditOutboxPayload is the JSON document enqueued when the direct AuditLog
// insert fails. Its field set matches the NestJS createOutboxPayload so the
// existing retry worker can replay it.
type auditOutboxPayload struct {
	OrgID     string          `json:"orgId"`
	ActorID   *string         `json:"actorId"`
	Resource  string          `json:"resource"`
	Action    string          `json:"action"`
	Metadata  json.RawMessage `json:"metadata"`
	IPAddress *string         `json:"ipAddress"`
	CreatedAt string          `json:"createdAt"`
}

// writeAuditLogBestEffort mirrors apps/api/src/modules/audit/audit-log.writer.ts:
// insert the AuditLog row first, fall back to an AuditLogOutbox entry on failure,
// and return the original audit error when the outbox insert fails as well. A
// successfully persisted settings change therefore only fails when neither the
// audit log nor its outbox could be written.
func (s *Service) writeAuditLogBestEffort(ctx context.Context, orgID, actorID string, action AuditAction, metadata json.RawMessage) error {
	if s == nil || s.db == nil {
		return errNoDatabase
	}
	const resource = "system_settings"
	actor := nullableActorID(actorID)
	now := nowMillis()

	insertErr := func() error {
		id, idErr := newRowID()
		if idErr != nil {
			return idErr
		}
		_, err := s.db.ExecContext(ctx,
			"INSERT INTO AuditLog (id, orgId, actorId, resource, action, metadata, ipAddress, createdAt) "+
				"VALUES (?, ?, ?, ?, ?, ?, NULL, ?)",
			id, orgID, actor, resource, string(action), []byte(metadata), now)
		return err
	}()
	if insertErr == nil {
		return nil
	}

	// createOutboxPayload refuses to build a payload when orgId, resource or
	// action is blank; those are all non-blank here, so the payload is always
	// buildable, but the check is kept for parity.
	if strings.TrimSpace(orgID) == "" || strings.TrimSpace(resource) == "" || strings.TrimSpace(string(action)) == "" {
		log.Printf("llmgatewayprofiles: cannot build audit outbox payload for %s", action)
		return insertErr
	}

	payload, payloadErr := json.Marshal(auditOutboxPayload{
		OrgID:     orgID,
		ActorID:   actor,
		Resource:  resource,
		Action:    string(action),
		Metadata:  metadata,
		IPAddress: nil,
		CreatedAt: now.Format("2006-01-02T15:04:05.000Z"),
	})
	outboxID, outboxIDErr := newRowID()
	if payloadErr != nil || outboxIDErr != nil {
		log.Printf("llmgatewayprofiles: failed to build audit outbox payload for %s", action)
		return insertErr
	}
	if _, err := s.db.ExecContext(ctx,
		"INSERT INTO AuditLogOutbox (id, orgId, payload, status, attempts, availableAt, createdAt, updatedAt) "+
			"VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)",
		outboxID, orgID, payload, now, now, now); err != nil {
		log.Printf("llmgatewayprofiles: failed to write audit log and enqueue outbox for %s", action)
		return insertErr
	}
	log.Printf("llmgatewayprofiles: audit log write failed for %s; enqueued outbox entry", action)
	return nil
}
