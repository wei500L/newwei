package situationsettings

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"regexp"
	"strings"
)

// This file implements the system-settings:v1 secret envelope shared with
// NestJS (apps/api/src/modules/storage/storage-settings.crypto.ts):
//
//	{"__enc":"system-settings:v1","alg":"aes-256-gcm",
//	 "iv":"<base64>","tag":"<base64>","data":"<base64>"}
//
// 32-byte key, a fresh random 12-byte IV per encryption, a 16-byte
// authentication tag stored separately, no additional authenticated data.
// NestJS-written ciphertext decrypts here and vice versa.

const (
	settingsEncryptionTag  = "system-settings:v1"
	settingsEncryptionAlg  = "aes-256-gcm"
	systemSettingsKeyBytes = 32
)

var (
	errEncryptionKeyEmpty  = errors.New("SYSTEM_SETTINGS_ENCRYPTION_KEY is empty")
	errEncryptionKeyLength = errors.New("SYSTEM_SETTINGS_ENCRYPTION_KEY must be 32 bytes (base64) or 64 hex chars")
	hexKeyPattern          = regexp.MustCompile(`^[0-9a-fA-F]+$`)
)

// encryptedStringValueV1 is the stored envelope. IV/Tag/Data are pointers so a
// missing member is distinguishable from an empty string, exactly like
// isEncryptedStringValueV1.
type encryptedStringValueV1 struct {
	Enc  string  `json:"__enc"`
	Alg  string  `json:"alg"`
	IV   *string `json:"iv"`
	Tag  *string `json:"tag"`
	Data *string `json:"data"`
}

// isEncryptedSettingsValue mirrors isEncryptedStringValueV1.
func isEncryptedSettingsValue(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return false
	}
	var envelope encryptedStringValueV1
	if err := json.Unmarshal(trimmed, &envelope); err != nil {
		return false
	}
	return envelope.Enc == settingsEncryptionTag &&
		envelope.Alg == settingsEncryptionAlg &&
		envelope.IV != nil && envelope.Tag != nil && envelope.Data != nil
}

// decodeSettingsKey mirrors decodeSystemSettingsKey: an optional 0x prefix
// followed by exactly 64 hex characters, or a base64 decoding of exactly 32
// bytes.
func decodeSettingsKey(raw string) ([]byte, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil, errEncryptionKeyEmpty
	}
	hexCandidate := trimmed
	if len(hexCandidate) >= 2 && hexCandidate[0] == '0' && (hexCandidate[1] == 'x' || hexCandidate[1] == 'X') {
		hexCandidate = hexCandidate[2:]
	}
	if len(hexCandidate) == systemSettingsKeyBytes*2 && hexKeyPattern.MatchString(hexCandidate) {
		decoded, err := hex.DecodeString(hexCandidate)
		if err == nil {
			return decoded, nil
		}
	}
	if decoded, err := base64.StdEncoding.DecodeString(trimmed); err == nil && len(decoded) == systemSettingsKeyBytes {
		return decoded, nil
	}
	if decoded, err := base64.RawStdEncoding.DecodeString(trimmed); err == nil && len(decoded) == systemSettingsKeyBytes {
		return decoded, nil
	}
	return nil, errEncryptionKeyLength
}

// encryptSettingsSecret mirrors encryptStringValueV1 and returns the canonical
// JSON envelope.
func encryptSettingsSecret(plain string, key []byte) (json.RawMessage, error) {
	if len(key) != systemSettingsKeyBytes {
		return nil, errors.New("Invalid SYSTEM_SETTINGS_ENCRYPTION_KEY length")
	}
	iv := make([]byte, 12)
	if _, err := rand.Read(iv); err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	sealed := gcm.Seal(nil, iv, []byte(plain), nil)
	tagStart := len(sealed) - gcm.Overhead()
	tag := sealed[tagStart:]
	data := sealed[:tagStart]
	ivText := base64.StdEncoding.EncodeToString(iv)
	tagText := base64.StdEncoding.EncodeToString(tag)
	dataText := base64.StdEncoding.EncodeToString(data)
	envelope := encryptedStringValueV1{
		Enc:  settingsEncryptionTag,
		Alg:  settingsEncryptionAlg,
		IV:   &ivText,
		Tag:  &tagText,
		Data: &dataText,
	}
	return json.Marshal(envelope)
}

// decryptSettingsSecret mirrors decryptStringValueV1. Failure is reported as
// ok=false: the caller treats an undecryptable secret as absent.
func decryptSettingsSecret(raw json.RawMessage, keyMaterial string) (string, bool) {
	key, err := decodeSettingsKey(keyMaterial)
	if err != nil {
		return "", false
	}
	var envelope encryptedStringValueV1
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return "", false
	}
	if envelope.IV == nil || envelope.Tag == nil || envelope.Data == nil {
		return "", false
	}
	iv, err := base64.StdEncoding.DecodeString(*envelope.IV)
	if err != nil {
		return "", false
	}
	tag, err := base64.StdEncoding.DecodeString(*envelope.Tag)
	if err != nil {
		return "", false
	}
	data, err := base64.StdEncoding.DecodeString(*envelope.Data)
	if err != nil {
		return "", false
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", false
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", false
	}
	if len(iv) != gcm.NonceSize() {
		return "", false
	}
	sealed := make([]byte, 0, len(data)+len(tag))
	sealed = append(sealed, data...)
	sealed = append(sealed, tag...)
	plain, err := gcm.Open(nil, iv, sealed, nil)
	if err != nil {
		return "", false
	}
	return string(plain), true
}

// encryptionKeyStatus mirrors resolveEnvKeyStatus.
type encryptionKeyStatus struct {
	present bool
	valid   bool
	key     []byte
	errText string
}

func (s *Service) encryptionKeyStatus() encryptionKeyStatus {
	if s == nil || !s.env.EncryptionKeyPresent() {
		return encryptionKeyStatus{}
	}
	key, err := decodeSettingsKey(s.env.EncryptionKeyRaw)
	if err != nil {
		return encryptionKeyStatus{present: true, errText: err.Error()}
	}
	return encryptionKeyStatus{present: true, valid: true, key: key}
}

// secretEncoder is one request-scoped read of the system_security toggle plus
// the encryption-key status, reused for every credential in one update.
type secretEncoder struct {
	configured *bool
	keyStatus  encryptionKeyStatus
}

func (s *Service) loadSecretEncoder(ctx context.Context) (secretEncoder, error) {
	configured, err := s.loadSecurityConfigured(ctx)
	if err != nil {
		return secretEncoder{}, err
	}
	return secretEncoder{configured: configured, keyStatus: s.encryptionKeyStatus()}, nil
}

// encodeSecretForStorage mirrors SystemSecuritySettingsService.encodeSecretForStorage
// and the shared encodeSecretValue policy:
//
//   - valid key, toggle explicitly false -> plaintext escape hatch;
//   - valid key otherwise -> encrypt;
//   - no key, toggle true -> 400 "not configured";
//   - no key, production -> 400 "required to store secrets in production";
//   - no key, non-production -> plaintext with a warning.
func (e secretEncoder) encodeSecretForStorage(plain string, env Env) (json.RawMessage, error) {
	configuredTrue := e.configured != nil && *e.configured
	if configuredTrue && e.keyStatus.present && !e.keyStatus.valid {
		details := ""
		if e.keyStatus.errText != "" {
			details = " (" + e.keyStatus.errText + ")"
		}
		return nil, badRequest("Secret encryption is enabled but SYSTEM_SETTINGS_ENCRYPTION_KEY is missing or invalid" + details)
	}

	if e.keyStatus.valid {
		if e.configured != nil && !*e.configured {
			return json.Marshal(plain)
		}
		encrypted, err := encryptSettingsSecret(plain, e.keyStatus.key)
		if err != nil {
			return nil, err
		}
		return encrypted, nil
	}

	if configuredTrue {
		return nil, badRequest("Secret encryption is enabled but SYSTEM_SETTINGS_ENCRYPTION_KEY is not configured")
	}
	if env.NodeEnv == "production" {
		return nil, badRequest("SYSTEM_SETTINGS_ENCRYPTION_KEY is required to store secrets in production")
	}
	logPlaintextFallback()
	return json.Marshal(plain)
}

func logPlaintextFallback() {
	log.Printf("situationsettings: SYSTEM_SETTINGS_ENCRYPTION_KEY is missing; storing secret in plaintext (non-production only)")
}
