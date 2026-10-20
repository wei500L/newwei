package economicdata

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"

	"github.com/redis/go-redis/v9"
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

type encryptedSecret struct {
	Enc  string `json:"__enc"`
	Alg  string `json:"alg"`
	IV   string `json:"iv"`
	Tag  string `json:"tag"`
	Data string `json:"data"`
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
	if strings.HasPrefix(trimmed, "{") {
		var secret encryptedSecret
		if json.Unmarshal(raw, &secret) != nil || secret.Enc != "system-settings:v1" || secret.Alg != "aes-256-gcm" {
			return ""
		}
		plain, err := decryptSettingSecret(secret, encryptionKey)
		if err != nil {
			return ""
		}
		return strings.TrimSpace(plain)
	}
	return ""
}

func decryptSettingSecret(secret encryptedSecret, encryptionKey string) (string, error) {
	key, err := decodeSettingsKey(encryptionKey)
	if err != nil {
		return "", err
	}
	iv, err := base64.StdEncoding.DecodeString(secret.IV)
	if err != nil {
		return "", err
	}
	tag, err := base64.StdEncoding.DecodeString(secret.Tag)
	if err != nil {
		return "", err
	}
	data, err := base64.StdEncoding.DecodeString(secret.Data)
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	plain, err := gcm.Open(nil, iv, append(data, tag...), nil)
	if err != nil {
		return "", err
	}
	return string(plain), nil
}

func decodeSettingsKey(raw string) ([]byte, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil, errors.New("missing encryption key")
	}
	hexCandidate := strings.TrimPrefix(strings.TrimPrefix(trimmed, "0x"), "0X")
	if len(hexCandidate) == 64 {
		if decoded, err := hex.DecodeString(hexCandidate); err == nil {
			return decoded, nil
		}
	}
	decoded, err := base64.StdEncoding.DecodeString(trimmed)
	if err != nil || len(decoded) != 32 {
		return nil, errors.New("invalid encryption key")
	}
	return decoded, nil
}
