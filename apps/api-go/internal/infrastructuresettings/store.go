package infrastructuresettings

import (
	"bytes"
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

// ---- SystemSetting storage ----

// loadSetting reads SystemSetting.value as raw JSON bytes. found is false when
// the row does not exist. The bytes are decoded into a named struct by the
// caller; they are never interpreted as a loose map.
func (s *Service) loadSetting(ctx context.Context, key string) (json.RawMessage, bool, error) {
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

// upsertSettingSQL inserts or updates one global SystemSetting row while
// keeping the existing description, which is what a Prisma upsert whose
// `update` block omits `description` does.
//
// isPublic is refreshed on both branches (the NestJS update blocks set it), and
// updatedById is written on both branches with SQL NULL for machine tokens: the
// column is a nullable foreign key into User(id).
//
// The alias form (VALUES ... AS new_row) requires MySQL 8.0.19+, which the
// project's CI and production images satisfy. `key` is a reserved word and is
// always backquoted.
const upsertSettingSQL = "INSERT INTO SystemSetting " +
	"(`key`, value, isPublic, description, createdAt, updatedAt, updatedById) " +
	"VALUES (?, ?, ?, ?, ?, ?, ?) AS new_row " +
	"ON DUPLICATE KEY UPDATE value = new_row.value, isPublic = new_row.isPublic, " +
	"updatedAt = new_row.updatedAt, updatedById = new_row.updatedById"

// upsertSettingForceDescriptionSQL is the description-overwriting variant used
// by the domains whose NestJS upsert sets description in both branches
// (vector service and news-source runtime secrets).
const upsertSettingForceDescriptionSQL = "INSERT INTO SystemSetting " +
	"(`key`, value, isPublic, description, createdAt, updatedAt, updatedById) " +
	"VALUES (?, ?, ?, ?, ?, ?, ?) AS new_row " +
	"ON DUPLICATE KEY UPDATE value = new_row.value, isPublic = new_row.isPublic, " +
	"updatedAt = new_row.updatedAt, updatedById = new_row.updatedById, description = new_row.description"

// upsertSetting keeps the existing description of the row.
func (s *Service) upsertSetting(ctx context.Context, key string, value json.RawMessage, description string, isPublic bool, updatedByID *string) error {
	if s == nil || s.db == nil {
		return errNoDatabase
	}
	now := nowMillis()
	_, err := s.db.ExecContext(ctx, upsertSettingSQL, key, []byte(value), isPublic, description, now, now, updatedByID)
	return err
}

// upsertSettingForceDescription overwrites the description as well.
func (s *Service) upsertSettingForceDescription(ctx context.Context, key string, value json.RawMessage, description string, isPublic bool, updatedByID *string) error {
	if s == nil || s.db == nil {
		return errNoDatabase
	}
	now := nowMillis()
	_, err := s.db.ExecContext(ctx, upsertSettingForceDescriptionSQL, key, []byte(value), isPublic, description, now, now, updatedByID)
	return err
}

// storageWriteOp is one SystemSetting upsert inside the storage transaction.
// The typed struct replaces the previous Object.entries iteration.
type storageWriteOp struct {
	Key         string
	Value       json.RawMessage
	IsPublic    bool
	Description string
}

// applyStorageOps runs every upsert in one transaction so a mixed PATCH either
// commits completely or not at all.
func (s *Service) applyStorageOps(ctx context.Context, ops []storageWriteOp, updatedByID *string) error {
	if s == nil || s.db == nil {
		return errNoDatabase
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	now := nowMillis()
	for _, op := range ops {
		if _, err := tx.ExecContext(ctx, upsertSettingSQL,
			op.Key, []byte(op.Value), op.IsPublic, op.Description, now, now, updatedByID); err != nil {
			_ = tx.Rollback()
			return err
		}
	}
	return tx.Commit()
}

// deleteSetting removes one global SystemSetting row.
func (s *Service) deleteSetting(ctx context.Context, key string) error {
	if s == nil || s.db == nil {
		return errNoDatabase
	}
	_, err := s.db.ExecContext(ctx, "DELETE FROM SystemSetting WHERE `key` = ?", key)
	return err
}

// loadSettings reads the storage domain's nine rows in one query.
func (s *Service) loadStorageRecordsFromDB(ctx context.Context) (storageRecordMap, error) {
	records := storageRecordMap{}
	if s == nil || s.db == nil {
		return records, errNoDatabase
	}
	rows, err := s.db.QueryContext(ctx,
		"SELECT `key`, value FROM SystemSetting WHERE `key` IN (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		settingKeyCrawlImageStorage, settingKeyS3AccessKeyID, settingKeyS3SecretAccessKey,
		settingKeyS3Region, settingKeyS3Bucket, settingKeyS3Endpoint, settingKeyS3PublicBaseURL,
		settingKeyS3ForcePathStyle, settingKeyS3PresignedURLTTLSecond)
	if err != nil {
		return records, err
	}
	defer rows.Close()
	for rows.Next() {
		var key string
		var value []byte
		if err := rows.Scan(&key, &value); err != nil {
			return records, err
		}
		records.set(key, json.RawMessage(value))
	}
	return records, rows.Err()
}

// systemSecurityConfigured reads the global `system_security` row and returns
// the secretEncryptionEnabled flag when it is a boolean. The Redis envelope is
// consulted first (read-only): this unit never writes system_security.
func (s *Service) systemSecurityConfigured(ctx context.Context) (bool, bool) {
	if raw, found, err := s.cacheGet(ctx, cacheKeySystemSecurity); err != nil {
		logBackground("system security settings cache read failed", err)
	} else if found {
		var cached cachedSystemSecuritySettings
		if err := json.Unmarshal(raw, &cached); err == nil {
			if !cached.Exists {
				return false, false
			}
			return configuredFromRaw(cached.Value), true
		}
		logBackground("system security settings cache entry is not a settings document", nil)
	}

	raw, found, err := s.loadSetting(ctx, settingKeySystemSecurity)
	if err != nil {
		logBackground("system security settings database read failed", err)
		return false, false
	}
	if !found {
		return false, false
	}
	return configuredFromRaw(raw), true
}

// configuredFromRaw extracts secretEncryptionEnabled when the stored value is
// an object carrying a boolean. Arrays and primitives count as "not an object"
// exactly like the NestJS typeof check.
func configuredFromRaw(raw json.RawMessage) bool {
	settings := parseSystemSecuritySettings(raw)
	if settings == nil {
		return false
	}
	if settings.SecretEncryptionEnabled == nil {
		return false
	}
	return *settings.SecretEncryptionEnabled
}

// cachedSystemSecuritySettings is the `system_security:settings` envelope.
type cachedSystemSecuritySettings struct {
	Exists bool            `json:"exists"`
	Value  json.RawMessage `json:"value,omitempty"`
}

// systemSecuritySettings is the stored value shape.
type systemSecuritySettings struct {
	SecretEncryptionEnabled *bool `json:"secretEncryptionEnabled"`
}

// parseSystemSecuritySettings returns nil when the raw value is not an object.
func parseSystemSecuritySettings(raw json.RawMessage) *systemSecuritySettings {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return nil
	}
	var settings systemSecuritySettings
	if err := json.Unmarshal(trimmed, &settings); err != nil {
		return nil
	}
	return &settings
}

// ---- Redis cache ----

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
		return nil, false, fmt.Errorf("infrastructuresettings: cache entry %q is not valid json", key)
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
// tolerated by the callers (NestJS logs and continues).
func (s *Service) cacheDel(ctx context.Context, key string) error {
	if s == nil || s.redis == nil {
		return errNoRedis
	}
	return s.redis.Del(ctx, key).Err()
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
