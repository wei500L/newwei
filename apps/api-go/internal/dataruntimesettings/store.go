package dataruntimesettings

import (
	"bytes"
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
)

// ---- SystemSetting reads ----

// loadSettingRaw reads SystemSetting.value as raw JSON bytes. found is false
// when the row does not exist. The bytes are decoded into a named struct by the
// caller; they are never interpreted as a loose map.
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

// ---- SystemSetting upserts ----

// Every upsert keeps the exact per-domain Prisma semantics of the NestJS
// service it replaces. `key` is a reserved word and is always backquoted. The
// alias form (VALUES ... AS new_row) requires MySQL 8.0.19+, which the project's
// CI and production images satisfy.

// upsertRealtimeSQL mirrors the NestJS upsert for realtime_signals_settings:
// both branches write description and value only. isPublic therefore takes its
// Prisma default (false) on insert and keeps its value on update, and
// updatedById is never written (it stays NULL for a new row, unchanged
// otherwise).
const upsertRealtimeSQL = "INSERT INTO SystemSetting " +
	"(`key`, value, isPublic, description, createdAt, updatedAt, updatedById) " +
	"VALUES (?, ?, 0, ?, ?, ?, NULL) AS new_row " +
	"ON DUPLICATE KEY UPDATE value = new_row.value, description = new_row.description, " +
	"updatedAt = new_row.updatedAt"

// upsertArchivePreparationSQL mirrors the NestJS upsert for
// archive_preparation_settings: both branches set value, updatedById,
// description and isPublic=false.
const upsertArchivePreparationSQL = "INSERT INTO SystemSetting " +
	"(`key`, value, isPublic, description, createdAt, updatedAt, updatedById) " +
	"VALUES (?, ?, 0, ?, ?, ?, ?) AS new_row " +
	"ON DUPLICATE KEY UPDATE value = new_row.value, isPublic = new_row.isPublic, " +
	"description = new_row.description, updatedAt = new_row.updatedAt, " +
	"updatedById = new_row.updatedById"

// upsertNominatimSQL mirrors the NestJS upsert for geo_nominatim_identity: the
// update branch writes value and updatedById only, so an existing row keeps its
// description and isPublic; the insert branch also writes the description.
const upsertNominatimSQL = "INSERT INTO SystemSetting " +
	"(`key`, value, isPublic, description, createdAt, updatedAt, updatedById) " +
	"VALUES (?, ?, 0, ?, ?, ?, ?) AS new_row " +
	"ON DUPLICATE KEY UPDATE value = new_row.value, updatedAt = new_row.updatedAt, " +
	"updatedById = new_row.updatedById"

// upsertRealtime writes the realtime-signals settings row.
func (s *Service) upsertRealtime(ctx context.Context, value json.RawMessage) error {
	if s == nil || s.db == nil {
		return errNoDatabase
	}
	now := nowMillis()
	_, err := s.db.ExecContext(ctx, upsertRealtimeSQL,
		settingKeyRealtime, []byte(value), descriptionRealtime, now, now)
	return err
}

// upsertArchivePreparation writes the archive-preparation settings row.
func (s *Service) upsertArchivePreparation(ctx context.Context, value json.RawMessage, updatedByID *string) error {
	if s == nil || s.db == nil {
		return errNoDatabase
	}
	now := nowMillis()
	_, err := s.db.ExecContext(ctx, upsertArchivePreparationSQL,
		settingKeyArchivePreparation, []byte(value), descriptionArchivePreparation, now, now, updatedByID)
	return err
}

// upsertNominatim writes the Nominatim identity row.
func (s *Service) upsertNominatim(ctx context.Context, value json.RawMessage, updatedByID *string) error {
	if s == nil || s.db == nil {
		return errNoDatabase
	}
	now := nowMillis()
	_, err := s.db.ExecContext(ctx, upsertNominatimSQL,
		settingKeyNominatim, []byte(value), descriptionNominatim, now, now, updatedByID)
	return err
}

// deleteSetting removes one global SystemSetting row.
func (s *Service) deleteSetting(ctx context.Context, key string) error {
	if s == nil || s.db == nil {
		return errNoDatabase
	}
	_, err := s.db.ExecContext(ctx, "DELETE FROM SystemSetting WHERE `key` = ?", key)
	return err
}

// deleteRealtimeSettings removes the settings row and the derived ACLED OAuth
// state row in one statement. The worker keeps running with environment
// defaults: no scheduler hot-sync and no worker restart is performed.
func (s *Service) deleteRealtimeSettings(ctx context.Context) error {
	if s == nil || s.db == nil {
		return errNoDatabase
	}
	_, err := s.db.ExecContext(ctx,
		"DELETE FROM SystemSetting WHERE `key` IN (?, ?)",
		settingKeyRealtime, settingKeyAcledAuthState)
	return err
}

// ---- system_security policy (read-only) ----

// systemSecurityConfigured reads the global `system_security` row and returns
// the secretEncryptionEnabled flag when it is a boolean. The Redis envelope is
// consulted first (read-only): this unit never writes system_security.
//
// The second return value is false whenever the stored value is not an object or
// the member is not a boolean, which is exactly the NestJS
// `typeof value === "boolean" ? value : null` rule: a non-boolean member means
// "not configured", never an explicit false. Treating it as false would silently
// downgrade an enabled encryption policy to plaintext storage.
func (s *Service) systemSecurityConfigured(ctx context.Context) (bool, bool) {
	if raw, found, err := s.cacheGet(ctx, cacheKeySystemSecurity); err != nil {
		logBackground("system security settings cache read failed", err)
	} else if found {
		var cached cachedSystemSecuritySettings
		if err := json.Unmarshal(raw, &cached); err == nil {
			if !cached.Exists {
				return false, false
			}
			return configuredFromRaw(cached.Value)
		}
		logBackground("system security settings cache entry is not a settings document", nil)
	}

	raw, found, err := s.loadSettingRaw(ctx, settingKeySystemSecurity)
	if err != nil {
		logBackground("system security settings database read failed", err)
		return false, false
	}
	if !found {
		return false, false
	}
	return configuredFromRaw(raw)
}

// configuredFromRaw extracts the secretEncryptionEnabled tri-state.
func configuredFromRaw(raw json.RawMessage) (bool, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return false, false
	}
	var settings systemSecuritySettings
	if err := json.Unmarshal(trimmed, &settings); err != nil {
		return false, false
	}
	if settings.SecretEncryptionEnabled == nil {
		return false, false
	}
	return *settings.SecretEncryptionEnabled, true
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
