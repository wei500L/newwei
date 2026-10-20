package situationsettings

import (
	"bytes"
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

// errNoDatabase reports a missing MySQL pool. The handler maps it to the
// fail-closed 503 Prisma connection failure shape.
var errNoDatabase = errors.New("situationsettings: mysql is not configured")

// Options wire the service. DB and Redis are required whenever the switch is
// go; config validation enforces that at startup.
type Options struct {
	DB    *sql.DB
	Redis *redis.Client
	Env   Env
}

// Service owns the settings row, its cache envelope and the audit writes. It
// holds no request state and is safe for concurrent use.
type Service struct {
	db    *sql.DB
	redis *redis.Client
	env   Env
}

// NewService wires the shared MySQL and Redis clients.
func NewService(options Options) *Service {
	return &Service{db: options.DB, redis: options.Redis, env: options.Env}
}

// ---- SystemSetting storage ----

// settingsCacheEnvelope is the Redis envelope NestJS writes:
//
//	{"exists":true,"value":<stored object>}
//	{"exists":false}
//
// `value` is omitted when the row exists but its JSON is not object-like,
// because NestJS writes `value: settings ?? undefined`.
type settingsCacheEnvelope struct {
	Exists bool            `json:"exists"`
	Value  json.RawMessage `json:"value,omitempty"`
}

// loadSettings mirrors loadStoredSettings: the Redis envelope wins whenever it
// decodes to a truthy value, MySQL is consulted only on a miss, and the MySQL
// result repopulates the same envelope with the same 30 second TTL.
func (s *Service) loadSettings(ctx context.Context) (loadedSettings, error) {
	if s == nil || s.db == nil {
		return loadedSettings{}, errNoDatabase
	}
	if s.redis != nil {
		if cached, err := s.redis.Get(ctx, settingsCacheKey).Bytes(); err == nil {
			if loaded, ok := decodeSettingsEnvelope(cached); ok {
				return loaded, nil
			}
		} else if !errors.Is(err, redis.Nil) {
			log.Printf("situationsettings: settings cache read failed: %v", err)
		}
	}

	var raw []byte
	err := s.db.QueryRowContext(ctx,
		"SELECT value FROM SystemSetting WHERE `key` = ? LIMIT 1", settingsKey).Scan(&raw)
	exists := true
	if errors.Is(err, sql.ErrNoRows) {
		exists = false
	} else if err != nil {
		return loadedSettings{}, err
	}

	loaded := loadedSettings{exists: exists}
	if exists && len(raw) > 0 {
		trimmed := bytes.TrimSpace(raw)
		if isJSONObjectOrArray(trimmed) {
			loaded.stored = true
			loaded.raw = append(json.RawMessage(nil), raw...)
			loaded.fields = decodeStoredFields(raw)
		}
	}
	s.writeSettingsCache(ctx, loaded)
	return loaded, nil
}

func decodeSettingsEnvelope(raw []byte) (loadedSettings, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return loadedSettings{}, false
	}
	if trimmed[0] != '{' {
		// Any other truthy JSON value would have `exists: undefined`, which is
		// falsy, so NestJS resolves it to "no stored settings" without a DB
		// read. Only an object envelope is meaningful here.
		return loadedSettings{}, false
	}
	var envelope settingsCacheEnvelope
	if err := json.Unmarshal(trimmed, &envelope); err != nil {
		log.Printf("situationsettings: settings cache decode failed: %v", err)
		return loadedSettings{}, false
	}
	if !envelope.Exists {
		return loadedSettings{exists: false}, true
	}
	loaded := loadedSettings{exists: true}
	value := bytes.TrimSpace(envelope.Value)
	if isJSONObjectOrArray(value) {
		loaded.stored = true
		loaded.raw = append(json.RawMessage(nil), value...)
		loaded.fields = decodeStoredFields(value)
	}
	return loaded, true
}

// writeSettingsCache writes the envelope NestJS would have written. A Redis
// failure is logged and ignored.
func (s *Service) writeSettingsCache(ctx context.Context, loaded loadedSettings) {
	if s.redis == nil {
		return
	}
	envelope := settingsCacheEnvelope{Exists: loaded.exists}
	if loaded.exists && len(bytes.TrimSpace(loaded.raw)) > 0 {
		envelope.Value = loaded.raw
	}
	payload, err := json.Marshal(envelope)
	if err != nil {
		log.Printf("situationsettings: settings cache encode failed: %v", err)
		return
	}
	if err := s.redis.Set(ctx, settingsCacheKey, payload, settingsCacheTTL).Err(); err != nil {
		log.Printf("situationsettings: settings cache write failed: %v", err)
	}
}

// invalidateSettingsCache mirrors invalidateCache: delete the shared key and
// ignore Redis failures.
func (s *Service) invalidateSettingsCache(ctx context.Context) {
	if s == nil || s.redis == nil {
		return
	}
	if err := s.redis.Del(ctx, settingsCacheKey).Err(); err != nil {
		log.Printf("situationsettings: settings cache invalidation failed: %v", err)
	}
}

func decodeStoredFields(raw []byte) storedFields {
	var fields storedFields
	if len(raw) == 0 {
		return fields
	}
	if err := json.Unmarshal(raw, &fields); err != nil {
		// A non-object document reads as "every property undefined" in
		// JavaScript; the zero projection reproduces that.
		return storedFields{}
	}
	return fields
}

func isJSONObjectOrArray(raw []byte) bool {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return false
	}
	return trimmed[0] == '{' || trimmed[0] == '['
}

// upsertSettingsSQL mirrors the Prisma upsert used by updateSettings and
// clearTelegramConfiguration: the INSERT branch writes isPublic=false and a
// NULL updatedById, while the UPDATE branch only refreshes value, description
// and updatedAt.
//
// The alias form (VALUES ... AS new_row) requires MySQL 8.0.19+, the project's
// CI and production image.
const upsertSettingsSQL = "INSERT INTO SystemSetting " +
	"(`key`, value, isPublic, description, createdAt, updatedAt, updatedById) " +
	"VALUES (?, ?, 0, ?, ?, ?, NULL) AS new_row " +
	"ON DUPLICATE KEY UPDATE value = new_row.value, description = new_row.description, " +
	"updatedAt = new_row.updatedAt"

func (s *Service) upsertSettings(ctx context.Context, value []byte) error {
	if s == nil || s.db == nil {
		return errNoDatabase
	}
	now := nowMillis()
	_, err := s.db.ExecContext(ctx, upsertSettingsSQL,
		settingsKey, value, settingsDescription, now, now)
	return err
}

// deleteSettings mirrors systemSetting.deleteMany({where:{key}}).
func (s *Service) deleteSettings(ctx context.Context) error {
	if s == nil || s.db == nil {
		return errNoDatabase
	}
	_, err := s.db.ExecContext(ctx, "DELETE FROM SystemSetting WHERE `key` = ?", settingsKey)
	return err
}

// ---- system_security secret-encoding policy ----

// securityStoredFields is the SystemSetting.value shape for key
// "system_security". Only the encryption toggle matters here.
type securityStoredFields struct {
	SecretEncryptionEnabled json.RawMessage `json:"secretEncryptionEnabled"`
}

// loadSecurityConfigured mirrors SystemSecuritySettingsService.loadStoredSettings
// + resolveConfigured: nil means the toggle is absent or not a real boolean.
func (s *Service) loadSecurityConfigured(ctx context.Context) (*bool, error) {
	if s == nil || s.db == nil {
		return nil, errNoDatabase
	}
	if s.redis != nil {
		if cached, err := s.redis.Get(ctx, securityCacheKey).Bytes(); err == nil {
			if configured, ok := decodeSecurityEnvelope(cached); ok {
				return configured, nil
			}
		} else if !errors.Is(err, redis.Nil) {
			log.Printf("situationsettings: system security cache read failed: %v", err)
		}
	}

	var raw []byte
	err := s.db.QueryRowContext(ctx,
		"SELECT value FROM SystemSetting WHERE `key` = ? LIMIT 1", securitySettingsKey).Scan(&raw)
	exists := true
	if errors.Is(err, sql.ErrNoRows) {
		exists = false
	} else if err != nil {
		return nil, err
	}

	var configured *bool
	var cacheValue json.RawMessage
	if exists && len(raw) > 0 {
		trimmed := bytes.TrimSpace(raw)
		if isJSONObjectOrArray(trimmed) {
			if trimmed[0] == '{' {
				cacheValue = append(json.RawMessage(nil), raw...)
			}
			var fields securityStoredFields
			if json.Unmarshal(raw, &fields) == nil {
				switch string(bytes.TrimSpace(fields.SecretEncryptionEnabled)) {
				case "true":
					value := true
					configured = &value
				case "false":
					value := false
					configured = &value
				}
			}
		}
	}
	if s.redis != nil {
		envelope := settingsCacheEnvelope{Exists: exists}
		if exists && len(bytes.TrimSpace(cacheValue)) > 0 {
			envelope.Value = cacheValue
		}
		if payload, err := json.Marshal(envelope); err == nil {
			if err := s.redis.Set(ctx, securityCacheKey, payload, securityCacheTTL).Err(); err != nil {
				log.Printf("situationsettings: system security cache write failed: %v", err)
			}
		}
	}
	return configured, nil
}

func decodeSecurityEnvelope(raw []byte) (*bool, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) || trimmed[0] != '{' {
		return nil, false
	}
	var envelope settingsCacheEnvelope
	if err := json.Unmarshal(trimmed, &envelope); err != nil {
		log.Printf("situationsettings: system security cache decode failed: %v", err)
		return nil, false
	}
	if !envelope.Exists {
		return nil, true
	}
	value := bytes.TrimSpace(envelope.Value)
	if len(value) == 0 || value[0] != '{' {
		return nil, true
	}
	var fields securityStoredFields
	if json.Unmarshal(value, &fields) != nil {
		return nil, true
	}
	switch string(bytes.TrimSpace(fields.SecretEncryptionEnabled)) {
	case "true":
		result := true
		return &result, true
	case "false":
		result := false
		return &result, true
	}
	return nil, true
}

// ---- AuditLog ----

// auditOutboxPayload is the JSON document enqueued when the direct AuditLog
// insert fails. Its field set matches the NestJS createOutboxPayload.
type auditOutboxPayload struct {
	OrgID     string          `json:"orgId"`
	ActorID   *string         `json:"actorId"`
	Resource  string          `json:"resource"`
	Action    string          `json:"action"`
	Metadata  json.RawMessage `json:"metadata"`
	IPAddress *string         `json:"ipAddress"`
	CreatedAt string          `json:"createdAt"`
}

// writeAuditLogBestEffort mirrors writeAuditLogBestEffort: insert the AuditLog
// row first, fall back to an AuditLogOutbox entry on failure, and never turn a
// successful settings change into an HTTP error.
func (s *Service) writeAuditLogBestEffort(ctx context.Context, orgID, actorID, action string, metadata json.RawMessage) {
	if s == nil || s.db == nil {
		return
	}
	const resource = "system_settings"
	actor := nullableActorID(actorID)
	now := nowMillis()

	if id, err := newRowID(); err == nil {
		if _, err := s.db.ExecContext(ctx,
			"INSERT INTO AuditLog (id, orgId, actorId, resource, action, metadata, ipAddress, createdAt) "+
				"VALUES (?, ?, ?, ?, ?, ?, NULL, ?)",
			id, orgID, actor, resource, action, []byte(metadata), now); err == nil {
			return
		}
	}

	payload, payloadErr := json.Marshal(auditOutboxPayload{
		OrgID:     orgID,
		ActorID:   actor,
		Resource:  resource,
		Action:    action,
		Metadata:  metadata,
		IPAddress: nil,
		CreatedAt: now.Format("2006-01-02T15:04:05.000Z"),
	})
	outboxID, idErr := newRowID()
	if payloadErr != nil || idErr != nil {
		log.Printf("situationsettings: failed to build audit outbox payload for %s: %v", action, payloadErr)
		return
	}
	if _, err := s.db.ExecContext(ctx,
		"INSERT INTO AuditLogOutbox (id, orgId, payload, status, attempts, availableAt, createdAt, updatedAt) "+
			"VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)",
		outboxID, orgID, payload, now, now, now); err != nil {
		log.Printf("situationsettings: failed to write audit log and enqueue outbox for %s: %v", action, err)
	}
}

// nullableActorID converts a machine token id into SQL NULL so the AuditLog
// foreign key into User(id) stays valid, matching normalizeAuditActorId.
func nullableActorID(actorID string) *string {
	if actorID == "" || strings.HasPrefix(actorID, "machine:") {
		return nil
	}
	return &actorID
}

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

// ---- Telegram cross-instance clear (T1) ----

// clearTelegramStateEverywhere publishes the cross-instance clear and deletes
// the shared Telegram state cache. Every NestJS instance subscribed to the
// channel clears its own in-process client and state. Both effects are
// best-effort: a Redis failure is logged and does not fail the HTTP response,
// matching the controller's clearTelegramStateBestEffort posture.
func (s *Service) clearTelegramStateEverywhere(ctx context.Context) {
	if s == nil || s.redis == nil {
		return
	}
	if err := s.redis.Publish(ctx, telegramClearChannel, telegramClearMessage).Err(); err != nil {
		log.Printf("situationsettings: publish telegram clear broadcast failed: %v", err)
	}
	if err := s.redis.Del(ctx, telegramStateCacheKey).Err(); err != nil {
		log.Printf("situationsettings: delete telegram state cache failed: %v", err)
	}
}
