package situationsettings

import (
	"context"
	"encoding/json"
	"log"

	"github.com/wei500L/newwei/apps/api-go/internal/settingscrypto"
)

// This file is the situation-monitor side of the system-settings:v1 secret
// envelope. The wire format, the cipher and the key parsing live in
// settingscrypto:
//
//	{"__enc":"system-settings:v1","alg":"aes-256-gcm",
//	 "iv":"<base64>","tag":"<base64>","data":"<base64>"}
//
// NestJS-written ciphertext decrypts here and vice versa.

// encryptSettingsSecret returns the canonical JSON envelope for one plaintext.
func encryptSettingsSecret(plain string, key []byte) (json.RawMessage, error) {
	envelope, err := settingscrypto.Encrypt(plain, key)
	if err != nil {
		return nil, err
	}
	return json.Marshal(envelope)
}

// decryptSettingsSecret decrypts a stored v1 envelope. Failure is reported as
// ok=false: the caller treats an undecryptable secret as absent.
func decryptSettingsSecret(raw json.RawMessage, keyMaterial string) (string, bool) {
	if !settingscrypto.IsEnvelope(raw) {
		return "", false
	}
	var envelope settingscrypto.Envelope
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return "", false
	}
	key, err := settingscrypto.ParseKey(keyMaterial)
	if err != nil {
		return "", false
	}
	plain, err := settingscrypto.Decrypt(envelope, key)
	if err != nil {
		return "", false
	}
	return plain, true
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
	key, err := settingscrypto.ParseKey(s.env.EncryptionKeyRaw)
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
