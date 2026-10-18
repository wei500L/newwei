package accountsecurity

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
)

// This file implements the read side of the system-settings v1 secret envelope.
// The wire format is fixed and independent of the Go implementation:
//
//	{"__enc":"system-settings:v1","alg":"aes-256-gcm",
//	 "iv":"<base64>","tag":"<base64>","data":"<base64>"}
//
// The avatar read path only ever decrypts; it never writes a secret. A missing
// or invalid key, or a failed decryption, falls back to the environment value
// exactly like StorageSettingsService.resolveSecret.

const (
	settingsEncTag         = "system-settings:v1"
	encryptionAlgorithm    = "aes-256-gcm"
	systemSettingsKeyBytes = 32
	gcmTagBytes            = 16
)

// encryptedStringValueV1 is the stored envelope. IV/Tag/Data are pointers so a
// missing member is distinguishable from an empty string: NestJS requires all
// three to be strings before treating a value as an envelope.
type encryptedStringValueV1 struct {
	Enc  string  `json:"__enc"`
	Alg  string  `json:"alg"`
	IV   *string `json:"iv"`
	Tag  *string `json:"tag"`
	Data *string `json:"data"`
}

// valid reports whether the value has the exact v1 shape NestJS recognises.
func (e encryptedStringValueV1) valid() bool {
	return e.Enc == settingsEncTag &&
		e.Alg == encryptionAlgorithm &&
		e.IV != nil && e.Tag != nil && e.Data != nil
}

var hexKeyRe = regexp.MustCompile(`^[0-9a-fA-F]+$`)

// decodeSystemSettingsKey mirrors decodeSystemSettingsKey: an optional 0x/0X
// prefix followed by exactly 64 hex characters, or a Node-compatible base64
// decoding that yields exactly 32 bytes.
func decodeSystemSettingsKey(raw string) ([]byte, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil, errors.New("SYSTEM_SETTINGS_ENCRYPTION_KEY is empty")
	}
	hexCandidate := trimmed
	if len(hexCandidate) >= 2 && hexCandidate[0] == '0' && (hexCandidate[1] == 'x' || hexCandidate[1] == 'X') {
		hexCandidate = hexCandidate[2:]
	}
	if len(hexCandidate) == systemSettingsKeyBytes*2 && hexKeyRe.MatchString(hexCandidate) {
		if decoded, err := hex.DecodeString(hexCandidate); err == nil {
			return decoded, nil
		}
	}
	if decoded := decodeNodeBase64(trimmed); len(decoded) == systemSettingsKeyBytes {
		return decoded, nil
	}
	return nil, errors.New("SYSTEM_SETTINGS_ENCRYPTION_KEY must be 32 bytes (base64) or 64 hex chars")
}

// decodeNodeBase64 mirrors Buffer.from(value, "base64").
func decodeNodeBase64(value string) []byte {
	filtered := make([]byte, 0, len(value))
	for index := 0; index < len(value); index++ {
		ch := value[index]
		switch {
		case ch >= 'A' && ch <= 'Z', ch >= 'a' && ch <= 'z', ch >= '0' && ch <= '9':
			filtered = append(filtered, ch)
		case ch == '+', ch == '-':
			filtered = append(filtered, '+')
		case ch == '/', ch == '_':
			filtered = append(filtered, '/')
		case ch == '=':
			index = len(value)
		}
	}
	remainder := len(filtered) % 4
	if remainder == 1 {
		filtered = filtered[:len(filtered)-1]
		remainder = 0
	}
	for remainder != 0 && remainder != 4 {
		filtered = append(filtered, '=')
		remainder++
	}
	decoded, err := base64.StdEncoding.DecodeString(string(filtered))
	if err != nil {
		return nil
	}
	return decoded
}

// decryptStringValueV1 decrypts one envelope. Any failure is reported as a
// single opaque error; the caller falls back to the environment value.
func decryptStringValueV1(payload encryptedStringValueV1, key []byte) (string, error) {
	if len(key) != systemSettingsKeyBytes {
		return "", errors.New("invalid SYSTEM_SETTINGS_ENCRYPTION_KEY length")
	}
	if !payload.valid() {
		return "", errors.New("invalid system settings envelope")
	}
	iv, err := base64.StdEncoding.DecodeString(*payload.IV)
	if err != nil {
		return "", errors.New("failed to decrypt system setting secret")
	}
	tag, err := base64.StdEncoding.DecodeString(*payload.Tag)
	if err != nil || len(tag) != gcmTagBytes {
		return "", errors.New("failed to decrypt system setting secret")
	}
	data, err := base64.StdEncoding.DecodeString(*payload.Data)
	if err != nil {
		return "", errors.New("failed to decrypt system setting secret")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", errors.New("failed to decrypt system setting secret")
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return "", errors.New("failed to decrypt system setting secret")
	}
	opened, err := aead.Open(nil, iv, append(append([]byte{}, data...), tag...), nil)
	if err != nil {
		return "", errors.New("failed to decrypt system setting secret")
	}
	return string(opened), nil
}

// settingsKey mirrors resolveSettingsKey(env): the decoded key, or nil when the
// variable is absent, blank or invalid.
func (s *Service) settingsKey() []byte {
	if s == nil || !s.cfg.EncryptionKeyPresent {
		return nil
	}
	key, err := decodeSystemSettingsKey(s.cfg.EncryptionKeyRaw)
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
		var envelope encryptedStringValueV1
		if err := json.Unmarshal(trimmed, &envelope); err != nil || !envelope.valid() {
			return fallback
		}
		key := s.settingsKey()
		if key == nil {
			logRedisFailure("storage secret decryption", "settings-key", errors.New("missing encryption key"))
			return fallback
		}
		plain, err := decryptStringValueV1(envelope, key)
		if err != nil {
			logRedisFailure("storage secret decryption", "settings-key", err)
			return fallback
		}
		return plain
	default:
		return fallback
	}
}
