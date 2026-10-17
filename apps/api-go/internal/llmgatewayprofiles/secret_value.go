package llmgatewayprofiles

import (
	"context"
	"log"
	"regexp"
	"strings"
)

// bearerOnlyPattern and bearerPrefixPattern reproduce the two regular
// expressions of the NestJS stripBearerPrefix helper. This service trims first,
// then drops a standalone "Bearer", then removes a leading "Bearer " prefix; the
// OpenAI keys service uses a different order and must not be reused here.
var (
	bearerOnlyPattern   = regexp.MustCompile(`(?i)^bearer$`)
	bearerPrefixPattern = regexp.MustCompile(`(?i)^bearer[[:space:]\x{00a0}]+`)
)

// stripBearerPrefix mirrors the service helper.
func stripBearerPrefix(value string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return ""
	}
	if bearerOnlyPattern.MatchString(trimmed) {
		return ""
	}
	return strings.TrimSpace(bearerPrefixPattern.ReplaceAllString(trimmed, ""))
}

// strictBoolPointer mirrors resolveConfigured: only a real boolean counts, so a
// legacy string "true" is treated as "not configured".
func strictBoolPointer(raw []byte) *bool {
	value, ok := jsBool(raw)
	if !ok {
		return nil
	}
	return &value
}

// encodeSecretForStorage mirrors
// SystemSecuritySettingsService.encodeSecretForStorage plus the shared
// encodeSecretValue policy it delegates to:
//
//   - a valid key encrypts by default unless secret encryption is explicitly
//     disabled;
//   - encryption enabled with a present but invalid key -> 400 with the decode
//     error appended;
//   - encryption enabled without a key -> 400;
//   - production without any usable key -> 400 instead of silently storing
//     plaintext;
//   - non-production without a key -> plaintext with a warning, the historical
//     fallback.
func (s *Service) encodeSecretForStorage(ctx context.Context, plain string) (*SecretValue, error) {
	stored, err := s.loadSecuritySettings(ctx)
	if err != nil {
		return nil, err
	}
	status := s.resolveKeyStatus()
	configured := strictBoolPointer(stored.secretEncryptionEnabled)

	if configured != nil && *configured && status.present && !status.valid {
		details := ""
		if status.errMessage != "" {
			details = " (" + status.errMessage + ")"
		}
		return nil, badRequest("Secret encryption is enabled but SYSTEM_SETTINGS_ENCRYPTION_KEY is missing or invalid" + details)
	}

	if status.valid {
		if configured != nil && !*configured {
			return newPlaintextSecret(plain), nil
		}
		envelope, err := encryptStringValueV1(plain, status.key)
		if err != nil {
			return nil, err
		}
		return newEncryptedSecret(envelope), nil
	}

	if configured != nil && *configured {
		return nil, badRequest("Secret encryption is enabled but SYSTEM_SETTINGS_ENCRYPTION_KEY is not configured")
	}
	if s.cfg.Production {
		return nil, badRequest("SYSTEM_SETTINGS_ENCRYPTION_KEY is required to store secrets in production")
	}
	log.Printf("llmgatewayprofiles: SYSTEM_SETTINGS_ENCRYPTION_KEY is missing; storing LLM gateway secret in plaintext (non-production only)")
	return newPlaintextSecret(plain), nil
}

// resolveSecret mirrors the service resolveApiKey: a stored plaintext or a
// decryptable v1 envelope yields the trimmed key, everything else (no key,
// invalid key, corrupted ciphertext, unknown legacy value) reports absent. The
// LITELLM_API_KEY environment variable is never used as a fallback.
func (s *Service) resolveSecret(secret *SecretValue) (string, bool) {
	if secret == nil {
		return "", false
	}
	switch secret.kind {
	case SecretPlaintext:
		return nonEmptySecret(stripBearerPrefix(secret.plaintext))
	case SecretEncrypted:
		status := s.resolveKeyStatus()
		if !status.valid {
			log.Printf("llmgatewayprofiles: missing SYSTEM_SETTINGS_ENCRYPTION_KEY for LLM gateway key")
			return "", false
		}
		decrypted, err := decryptStringValueV1(secret.encrypted, status.key)
		if err != nil {
			log.Printf("llmgatewayprofiles: failed to decrypt LLM gateway key")
			return "", false
		}
		return nonEmptySecret(stripBearerPrefix(decrypted))
	default:
		return "", false
	}
}

// nonEmptySecret collapses an empty key to "absent".
func nonEmptySecret(value string) (string, bool) {
	if value == "" {
		return "", false
	}
	return value, true
}

// hasAPIKey mirrors the service hasApiKey.
func (s *Service) hasAPIKey(profile StoredProfile) bool {
	_, ok := s.resolveSecret(profile.APIKey)
	return ok
}

// normalizeAPIKeyInput mirrors the service normalizeApiKeyInput:
//
//   - an absent key keeps the previously stored value byte-for-byte;
//   - an explicit null, a blank string or a standalone "Bearer" clears it;
//   - any other string is trimmed, stripped of a leading "Bearer " and encoded
//     through the encryption policy.
func (s *Service) normalizeAPIKeyInput(ctx context.Context, input profileInput, base *StoredProfile) (*SecretValue, error) {
	if !input.APIKeySet {
		if base != nil {
			return base.APIKey, nil
		}
		return nil, nil
	}
	normalized := ""
	if input.APIKey != nil {
		normalized = stripBearerPrefix(*input.APIKey)
	}
	if normalized == "" {
		return newNullSecret(), nil
	}
	return s.encodeSecretForStorage(ctx, normalized)
}
