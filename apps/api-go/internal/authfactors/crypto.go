package authfactors

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/settingscrypto"
)

// This file is the auth-factor read/write side of the system-settings v1 secret
// envelope shared with the former NestJS service. The wire format and the
// cipher/key handling live in settingscrypto:
//
//	{"__enc":"system-settings:v1","alg":"aes-256-gcm",
//	 "iv":"<base64>","tag":"<base64>","data":"<base64>"}
//
// The policy around it mirrors AuthSecurityService.encodeSecret exactly, which
// (unlike the system-security settings service) does not wrap failures in a
// BadRequestException: a missing key that the stored policy requires surfaces as
// the production 500, not as a 400.

// errEncryptionRequired mirrors SystemSettingsEncryptionRequiredError: the
// stored policy or the production environment demands encryption but no usable
// key exists. It is not an HttpException in NestJS, so it renders as a 500.
var errEncryptionRequired = errors.New("secret encryption is enabled but SYSTEM_SETTINGS_ENCRYPTION_KEY is not configured")

// settingsKey mirrors AuthSecurityService.resolveSettingsKey: the decoded key,
// or nil when the variable is absent, blank or undecodable.
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

// ---- named secret models ----

// secretKind discriminates the three shapes a JSON secret column can hold.
type secretKind int

const (
	// secretAbsent is SQL NULL or a JSON value that is neither a string nor a
	// v1 envelope.
	secretAbsent secretKind = iota
	// secretPlaintext is a bare JSON string (the documented plaintext escape
	// hatch and the pre-encryption legacy format).
	secretPlaintext
	// secretEnvelope is a valid system-settings v1 envelope.
	secretEnvelope
)

// storedSecret is the named model for one JSON secret column value. The raw
// bytes are decoded once at the boundary; business code never sees a loose
// map.
type storedSecret struct {
	kind      secretKind
	plaintext string
	envelope  settingscrypto.Envelope
}

// parseStoredSecret decodes raw JSON into the named model. A JSON null, an
// array, a number or an object that is not a v1 envelope is secretAbsent, which
// is exactly the NestJS `typeof value === "string"` /
// `isEncryptedStringValueV1(value)` pair of guards.
func parseStoredSecret(raw []byte) storedSecret {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return storedSecret{kind: secretAbsent}
	}
	if strings.HasPrefix(trimmed, `"`) {
		var text string
		if err := json.Unmarshal([]byte(trimmed), &text); err == nil {
			return storedSecret{kind: secretPlaintext, plaintext: text}
		}
		return storedSecret{kind: secretAbsent}
	}
	if !strings.HasPrefix(trimmed, "{") {
		return storedSecret{kind: secretAbsent}
	}
	if !settingscrypto.IsEnvelope([]byte(trimmed)) {
		return storedSecret{kind: secretAbsent}
	}
	var envelope settingscrypto.Envelope
	if err := json.Unmarshal([]byte(trimmed), &envelope); err != nil {
		return storedSecret{kind: secretAbsent}
	}
	return storedSecret{kind: secretEnvelope, envelope: envelope}
}

// encodeSecret applies the shared fail-closed encoding policy and returns the
// JSON value to store in the column.
//
//   - a valid key is present and the stored policy is not explicitly disabled
//     -> AES-256-GCM envelope;
//   - a valid key is present and `secretEncryptionEnabled` is exactly false
//     -> plaintext escape hatch;
//   - `secretEncryptionEnabled` is exactly true and no usable key exists
//     -> error (the NestJS production 500);
//   - NODE_ENV is exactly "production" and no usable key exists -> error;
//   - otherwise -> plaintext with a warning.
func (s *Service) encodeSecret(ctx context.Context, plain string) (json.RawMessage, error) {
	if s == nil {
		return nil, errNoDatabase
	}
	configured, configuredOK := s.systemSecurityConfigured(ctx)
	key := s.settingsKey()

	if key != nil {
		if configuredOK && configured == false {
			return json.Marshal(plain)
		}
		envelope, err := settingscrypto.Encrypt(plain, key)
		if err != nil {
			return nil, err
		}
		return json.Marshal(envelope)
	}

	if configuredOK && configured == true {
		return nil, errEncryptionRequired
	}
	if s.cfg.NodeEnv == "production" {
		return nil, errEncryptionRequired
	}
	logBackground("SYSTEM_SETTINGS_ENCRYPTION_KEY is missing; storing secret in plaintext (non-production only)", nil)
	return json.Marshal(plain)
}

// decodeSecret mirrors AuthSecurityService.decodeSecret: a plain string is
// returned as-is, anything that is not a valid envelope or cannot be decoded
// because no key is configured returns found=false, and a decryption failure
// with a present key propagates as an error (never as "no secret").
func (s *Service) decodeSecret(raw []byte) (string, bool, error) {
	stored := parseStoredSecret(raw)
	switch stored.kind {
	case secretPlaintext:
		return stored.plaintext, true, nil
	case secretEnvelope:
		key := s.settingsKey()
		if key == nil {
			return "", false, nil
		}
		plaintext, err := settingscrypto.Decrypt(stored.envelope, key)
		if err != nil {
			return "", false, err
		}
		return plaintext, true, nil
	default:
		return "", false, nil
	}
}
