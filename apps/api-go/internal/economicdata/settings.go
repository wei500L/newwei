package economicdata

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/settingscrypto"
)

const situationMonitorSettingsKey = "situation_monitor_settings"

const situationMonitorSettingsCacheKey = "situation_monitor:settings"

type keyResolver struct {
	redis         *redis.Client
	db            *sql.DB
	encryptionKey string
	// overrides keeps provider tests offline without decrypting a real
	// SystemSetting document. Production never sets it.
	overrides map[string]string
}

// newKeyResolver builds the read-only SystemSetting accessor. It never writes
// the situation_monitor:settings cache and never falls back to environment
// variables for the two provider keys.
func newKeyResolver(redisClient *redis.Client, db *sql.DB, encryptionKey string) *keyResolver {
	return &keyResolver{redis: redisClient, db: db, encryptionKey: encryptionKey}
}

// resolve returns a provider key from the shared cache envelope or the MySQL
// document. Missing, undecryptable and non-string values are empty.
func (r *keyResolver) resolve(ctx context.Context, field string) (string, error) {
	if r == nil {
		return "", nil
	}
	if value, ok := r.overrides[field]; ok {
		return value, nil
	}
	raw, found, err := r.load(ctx)
	if err != nil || !found {
		return "", err
	}
	value, exists := raw[field]
	if !exists {
		return "", nil
	}
	return resolveStoredAPIKey(value, r.encryptionKey), nil
}

// load returns the situation monitor settings object. The cached envelope is
// `{exists:boolean,value?:object}`; MySQL stores the object directly under the
// situation_monitor_settings key.
func (r *keyResolver) load(ctx context.Context) (map[string]json.RawMessage, bool, error) {
	if r.redis != nil {
		payload, err := r.redis.Get(ctx, situationMonitorSettingsCacheKey).Bytes()
		if err == nil {
			return decodeCachedSettings(payload)
		}
		if err != redis.Nil {
			return nil, false, err
		}
	}
	if r.db == nil {
		return nil, false, nil
	}
	var raw []byte
	if err := r.db.QueryRowContext(ctx, "SELECT `value` FROM `SystemSetting` WHERE `key` = ? LIMIT 1", situationMonitorSettingsKey).Scan(&raw); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, false, nil
		}
		return nil, false, err
	}
	var value map[string]json.RawMessage
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, false, nil
	}
	return value, true, nil
}

func decodeCachedSettings(payload []byte) (map[string]json.RawMessage, bool, error) {
	var envelope struct {
		Exists bool                       `json:"exists"`
		Value  map[string]json.RawMessage `json:"value"`
	}
	if err := json.Unmarshal(payload, &envelope); err != nil {
		return nil, false, nil
	}
	if !envelope.Exists {
		return nil, false, nil
	}
	if envelope.Value == nil {
		return map[string]json.RawMessage{}, true, nil
	}
	return envelope.Value, true, nil
}

func resolveStoredAPIKey(raw json.RawMessage, encryptionKey string) string {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return ""
	}
	if strings.HasPrefix(trimmed, `"`) {
		var text string
		if json.Unmarshal(raw, &text) == nil {
			return strings.TrimSpace(text)
		}
		return ""
	}
	if !settingscrypto.IsEnvelope(raw) {
		return ""
	}
	var secret settingscrypto.Envelope
	if json.Unmarshal(raw, &secret) != nil {
		return ""
	}
	key, err := settingscrypto.ParseKey(encryptionKey)
	if err != nil {
		return ""
	}
	plain, err := settingscrypto.Decrypt(secret, key)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(plain)
}
