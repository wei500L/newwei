package llmgatewayops

import (
	"bytes"
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

// Storage keys and lifetimes shared with the NestJS service.
const (
	// governanceSettingsKey is the global SystemSetting row of proxy
	// governance.
	governanceSettingsKey = "litellm_proxy_governance"
	// governanceSettingsDescription is the row description written on every
	// save.
	governanceSettingsDescription = "LiteLLM proxy governance configuration (managed runtime key + team budgets)."
	// governanceCacheKey is the Redis key of the governance envelope.
	governanceCacheKey = "litellm_proxy_governance:settings"
	// governanceCacheTTLSeconds is the governance cache lifetime.
	governanceCacheTTLSeconds = 30
	// modelInfoCachePrefix is the proxy model info cache prefix; the profile id
	// and the first 16 hex characters of the normalized apiBase digest follow.
	modelInfoCachePrefix = "llm_gateway:proxy_model_info:v1:"
	// modelInfoCacheTTLSeconds is the proxy model info cache lifetime.
	modelInfoCacheTTLSeconds = 60
	// auditResource is the audit resource every governance action records.
	auditResource = "system_settings"
	// machineActorPrefix is the user-id prefix produced by the machine token
	// path.
	machineActorPrefix = "machine:"
)

// nowMillis returns the current UTC time truncated to milliseconds, matching
// the DATETIME(3) columns Prisma writes.
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

// governanceCacheEnvelope is the {exists,value} envelope NestJS stores.
type governanceCacheEnvelope struct {
	Exists bool            `json:"exists"`
	Value  json.RawMessage `json:"value,omitempty"`
}

// loadGovernanceRaw reads the governance document: Redis first, then MySQL, and
// a MySQL hit warms the shared envelope. A cache failure only logs: the
// authoritative row is still read, so a Redis outage never hides governance.
//
// found reports whether a document exists at all. A row whose value is not a
// JSON object/array is reported as found with an empty value, matching the
// NestJS `raw && typeof raw === "object"` guard that keeps source="db".
func (s *Service) loadGovernanceRaw(ctx context.Context) (json.RawMessage, bool, error) {
	if cached, ok, err := s.cacheGetJSON(ctx, governanceCacheKey); err != nil {
		logCacheFailure("read", governanceCacheKey, err)
	} else if ok {
		var envelope governanceCacheEnvelope
		if decodeErr := json.Unmarshal(cached, &envelope); decodeErr != nil {
			logCacheFailure("decode", governanceCacheKey, decodeErr)
		} else if !envelope.Exists {
			return nil, false, nil
		} else if len(envelope.Value) == 0 {
			return nil, false, nil
		} else {
			return envelope.Value, true, nil
		}
	}

	raw, found, err := s.loadSettingRaw(ctx, governanceSettingsKey)
	if err != nil {
		return nil, false, err
	}
	stored := found && isJSONObjectOrArray(raw)
	envelope := governanceCacheEnvelope{Exists: stored}
	if stored {
		envelope.Value = raw
	}
	payload, marshalErr := json.Marshal(envelope)
	if marshalErr == nil {
		if cacheErr := s.cacheSetJSON(ctx, governanceCacheKey, payload, governanceCacheTTLSeconds); cacheErr != nil {
			logCacheFailure("write", governanceCacheKey, cacheErr)
		}
	}
	if !stored {
		return nil, false, nil
	}
	return raw, true, nil
}

// isJSONObjectOrArray reports whether raw is a JavaScript "object" in the sense
// of the NestJS guard: an object or an array, but not a scalar.
func isJSONObjectOrArray(raw []byte) bool {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return false
	}
	return trimmed[0] == '{' || trimmed[0] == '['
}

// loadSettingRaw reads one SystemSetting.value document. found is false when the
// row does not exist.
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

// upsertSettingsSQL inserts or updates the global settings row. Both branches
// refresh value, description, isPublic and updatedById, exactly like the Prisma
// upsert the NestJS service performs. `key` is a reserved word and is always
// backquoted.
const upsertSettingsSQL = "INSERT INTO SystemSetting " +
	"(`key`, value, isPublic, description, createdAt, updatedAt, updatedById) " +
	"VALUES (?, ?, 0, ?, ?, ?, ?) AS new_row " +
	"ON DUPLICATE KEY UPDATE value = new_row.value, isPublic = new_row.isPublic, " +
	"description = new_row.description, updatedAt = new_row.updatedAt, updatedById = new_row.updatedById"

// saveGovernance writes the governance row and then invalidates the shared
// cache. The write is durable before the cache is dropped, so a failed
// invalidation leaves a stale-but-consistent envelope that expires in 30
// seconds instead of a lost update.
func (s *Service) saveGovernance(ctx context.Context, payload json.RawMessage, actorID string) error {
	if s == nil || s.db == nil {
		return errNoDatabase
	}
	now := nowMillis()
	if _, err := s.db.ExecContext(ctx, upsertSettingsSQL,
		governanceSettingsKey, []byte(payload), governanceSettingsDescription,
		now, now, nullableActorID(actorID)); err != nil {
		return err
	}
	s.invalidateGovernanceCache(ctx)
	return nil
}

// deleteGovernance removes the governance row and then invalidates the cache.
func (s *Service) deleteGovernance(ctx context.Context) error {
	if s == nil || s.db == nil {
		return errNoDatabase
	}
	if _, err := s.db.ExecContext(ctx,
		"DELETE FROM SystemSetting WHERE `key` = ?", governanceSettingsKey); err != nil {
		return err
	}
	s.invalidateGovernanceCache(ctx)
	return nil
}

// invalidateGovernanceCache drops the shared envelope. Failure is logged only:
// the row is already durable and the envelope expires on its own.
func (s *Service) invalidateGovernanceCache(ctx context.Context) {
	if err := s.cacheDel(ctx, governanceCacheKey); err != nil {
		logCacheFailure("delete", governanceCacheKey, err)
	}
}

// ---- Redis ----

// cacheGetJSON reads one JSON cache entry. A missing key is reported as
// found=false; malformed JSON is an error so the caller falls back to MySQL.
func (s *Service) cacheGetJSON(ctx context.Context, key string) (json.RawMessage, bool, error) {
	if s == nil || s.redis == nil {
		return nil, false, errors.New("llmgatewayops: redis is not configured")
	}
	raw, err := s.redis.Get(ctx, key).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	if len(raw) == 0 || !json.Valid(raw) {
		return nil, false, fmt.Errorf("llmgatewayops: cache entry %q is not valid json", key)
	}
	return json.RawMessage(raw), true, nil
}

// cacheSetJSON writes one JSON cache entry with a TTL.
func (s *Service) cacheSetJSON(ctx context.Context, key string, payload json.RawMessage, ttlSeconds int) error {
	if s == nil || s.redis == nil {
		return errors.New("llmgatewayops: redis is not configured")
	}
	return s.redis.Set(ctx, key, []byte(payload), time.Duration(ttlSeconds)*time.Second).Err()
}

// cacheDel removes one cache entry.
func (s *Service) cacheDel(ctx context.Context, key string) error {
	if s == nil || s.redis == nil {
		return errors.New("llmgatewayops: redis is not configured")
	}
	return s.redis.Del(ctx, key).Err()
}

// logCacheFailure records a Redis failure on a path where NestJS only logs a
// warning and continues.
func logCacheFailure(kind, key string, err error) {
	log.Printf("llmgatewayops: %s cache operation failed for %q: %v", kind, key, err)
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
// insert the AuditLog row first, fall back to an AuditLogOutbox entry on
// failure, and return the original audit error when the outbox insert fails as
// well. A governance change that was already persisted therefore only fails
// when neither the audit log nor its outbox could be written.
func (s *Service) writeAuditLogBestEffort(ctx context.Context, orgID, actorID, action string, metadata json.RawMessage) error {
	if s == nil || s.db == nil {
		return errNoDatabase
	}
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
			id, orgID, actor, auditResource, action, []byte(metadata), now)
		return err
	}()
	if insertErr == nil {
		return nil
	}

	if strings.TrimSpace(orgID) == "" || strings.TrimSpace(action) == "" {
		log.Printf("llmgatewayops: cannot build audit outbox payload for %s", action)
		return insertErr
	}

	payload, payloadErr := json.Marshal(auditOutboxPayload{
		OrgID:     orgID,
		ActorID:   actor,
		Resource:  auditResource,
		Action:    action,
		Metadata:  metadata,
		IPAddress: nil,
		CreatedAt: now.Format("2006-01-02T15:04:05.000Z"),
	})
	outboxID, outboxIDErr := newRowID()
	if payloadErr != nil || outboxIDErr != nil {
		log.Printf("llmgatewayops: failed to build audit outbox payload for %s", action)
		return insertErr
	}
	if _, err := s.db.ExecContext(ctx,
		"INSERT INTO AuditLogOutbox (id, orgId, payload, status, attempts, availableAt, createdAt, updatedAt) "+
			"VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)",
		outboxID, orgID, payload, now, now, now); err != nil {
		log.Printf("llmgatewayops: failed to write audit log and enqueue outbox for %s", action)
		return insertErr
	}
	log.Printf("llmgatewayops: audit log write failed for %s; enqueued outbox entry", action)
	return nil
}
