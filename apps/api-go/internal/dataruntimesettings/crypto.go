package dataruntimesettings

import (
	"context"
	"encoding/json"

	"github.com/wei500L/newwei/apps/api-go/internal/settingscrypto"
)

// This file is the data-runtime side of the system-settings v1 secret envelope.
// The wire format, the cipher and the key parsing live in settingscrypto:
//
//	{"__enc":"system-settings:v1","alg":"aes-256-gcm",
//	 "iv":"<base64>","tag":"<base64>","data":"<base64>"}
//
// NestJS-written ciphertext decrypts here and vice versa.

// keyStatus mirrors SystemSecuritySettingsService.resolveEnvKeyStatus.
type keyStatus struct {
	present bool
	valid   bool
	key     []byte
	err     string
}

// resolveKeyStatus mirrors resolveEnvKeyStatus: the raw (untrimmed) environment
// value decides presence, and decoding decides validity.
func (s *Service) resolveKeyStatus() keyStatus {
	if !s.cfg.EncryptionKeyPresent {
		return keyStatus{present: false, valid: false}
	}
	key, err := settingscrypto.ParseKey(s.cfg.EncryptionKeyRaw)
	if err != nil {
		return keyStatus{present: true, valid: false, err: err.Error()}
	}
	return keyStatus{present: true, valid: true, key: key}
}

// settingsKey mirrors resolveSettingsKey(env): the decoded key, or nil when the
// variable is absent or invalid. A stored envelope that cannot be decrypted is
// treated as "no stored secret", never as an error, so a rotated key cannot make
// the settings unreadable.
func (s *Service) settingsKey() []byte {
	status := s.resolveKeyStatus()
	if !status.valid {
		return nil
	}
	return status.key
}

// resolvedSecret is the outcome of the shared secret-encoding policy.
type resolvedSecret struct {
	// plaintext is set when the value is written as a plain string.
	plaintext string
	// encrypted is set when the value is written as a v1 envelope.
	encrypted *settingscrypto.Envelope
}

// secretError is the 400 the encoding policy raises. NestJS throws
// BadRequestException with these exact messages.
type secretError struct {
	message string
}

// Error implements the error interface.
func (e *secretError) Error() string { return e.message }

// asHTTPError converts the policy failure into the handler's error type.
func (e *secretError) asHTTPError() *httpError {
	return &httpError{status: 400, message: e.message}
}

// encodeSecretForStorage mirrors SystemSecuritySettingsService.encodeSecretForStorage,
// including the pre-check that distinguishes "enabled with a present but invalid
// key" from "enabled with no key at all".
//
// The policy is deliberately fail-closed: an enabled encryption policy with a
// missing or invalid key is a 400, and production without a key is a 400 rather
// than a silent plaintext downgrade. Only an explicit
// `secretEncryptionEnabled === false` (or a non-production environment with no
// policy at all) stores plaintext.
func (s *Service) encodeSecretForStorage(ctx context.Context, plain string) (resolvedSecret, error) {
	configured, configuredOK := s.systemSecurityConfigured(ctx)
	status := s.resolveKeyStatus()

	if configuredOK && configured && status.present && !status.valid {
		details := ""
		if status.err != "" {
			details = " (" + status.err + ")"
		}
		return resolvedSecret{}, &secretError{
			message: "Secret encryption is enabled but SYSTEM_SETTINGS_ENCRYPTION_KEY is missing or invalid" + details,
		}
	}

	if status.valid {
		if configuredOK && !configured {
			return resolvedSecret{plaintext: plain}, nil
		}
		envelope, err := settingscrypto.Encrypt(plain, status.key)
		if err != nil {
			return resolvedSecret{}, err
		}
		return resolvedSecret{encrypted: &envelope}, nil
	}

	if configuredOK && configured {
		return resolvedSecret{}, &secretError{
			message: "Secret encryption is enabled but SYSTEM_SETTINGS_ENCRYPTION_KEY is not configured",
		}
	}
	if s.cfg.NodeEnv == "production" {
		return resolvedSecret{}, &secretError{
			message: "SYSTEM_SETTINGS_ENCRYPTION_KEY is required to store secrets in production",
		}
	}
	logBackground("SYSTEM_SETTINGS_ENCRYPTION_KEY is missing; storing secret in plaintext (non-production only)", nil)
	return resolvedSecret{plaintext: plain}, nil
}

// toRawValue renders the resolved secret as the JSON value written to the
// SystemSetting column.
func (r resolvedSecret) toRawValue() (json.RawMessage, error) {
	if r.encrypted != nil {
		return json.Marshal(r.encrypted)
	}
	return json.Marshal(r.plaintext)
}
