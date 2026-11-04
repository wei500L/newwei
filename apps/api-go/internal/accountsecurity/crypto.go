package accountsecurity

import (
	"bytes"
	"encoding/json"
	"errors"

	"github.com/wei500L/newwei/apps/api-go/internal/settingscrypto"
)

// This file is the read side of the system-settings v1 secret envelope. The wire
// format and key parsing live in settingscrypto so every domain shares one
// implementation:
//
//	{"__enc":"system-settings:v1","alg":"aes-256-gcm",
//	 "iv":"<base64>","tag":"<base64>","data":"<base64>"}
//
// The avatar read path only ever decrypts; it never writes a secret. A missing
// or invalid key, or a failed decryption, falls back to the environment value
// exactly like StorageSettingsService.resolveSecret.

// settingsKey mirrors resolveSettingsKey(env): the decoded key, or nil when the
// variable is absent, blank or invalid.
func (s *Service) settingsKey() []byte {
	if s == nil || !s.cfg.EncryptionKeyPresent {
		return nil
	}
	key, err := settingscrypto.ParseKey(s.cfg.EncryptionKeyRaw)
	if err != nil {
		return nil
	}
	return key
}

// resolveStorageSecret mirrors StorageSettingsService.resolveSecret for the read
// path: a missing/empty/invalid value falls back to S3_SECRET_ACCESS_KEY, a
// stored plaintext string is returned as-is, and a stored envelope is decrypted
// (falling back on a missing key or a decryption failure). The secret never
// reaches the logs.
func (s *Service) resolveStorageSecret(raw json.RawMessage) string {
	fallback := s.cfg.S3SecretAccessKey
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return fallback
	}
	switch trimmed[0] {
	case '"':
		text, ok := jsonString(trimmed)
		if !ok || text == "" {
			return fallback
		}
		return text
	case '{':
		if !settingscrypto.IsEnvelope(trimmed) {
			return fallback
		}
		var envelope settingscrypto.Envelope
		if err := json.Unmarshal(trimmed, &envelope); err != nil {
			return fallback
		}
		key := s.settingsKey()
		if key == nil {
			logRedisFailure("storage secret decryption", "settings-key", errors.New("missing encryption key"))
			return fallback
		}
		plain, err := settingscrypto.Decrypt(envelope, key)
		if err != nil {
			logRedisFailure("storage secret decryption", "settings-key", err)
			return fallback
		}
		return plain
	default:
		return fallback
	}
}
