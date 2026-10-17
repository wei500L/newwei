package modelaccesssettings

import (
	"context"
	"log"
)

// encodeSecretForStorage mirrors
// SystemSecuritySettingsService.encodeSecretForStorage, including the extra
// pre-check the shared helper does not have. The decision table is:
//
//	configured=true,  key present but undecodable -> 400 "... missing or invalid (<decode error>)"
//	configured=true,  key absent                  -> 400 "... is not configured"
//	configured=true,  key valid                   -> encrypt
//	configured=false, key valid                   -> plaintext escape hatch
//	configured=null,  key valid                   -> encrypt
//	configured!=true, key absent, production      -> 400 "... required to store secrets in production"
//	configured!=true, key absent, non-production  -> plaintext + security warning
//
// `configured` is only ever a stored JSON boolean; any other type counts as unset,
// so a malformed system_security row cannot silently disable encryption. The
// production branch is reached even when the toggle is explicitly false, because
// encodeSecretValue checks `key` before it checks `configured` — the overview
// comment in the crypto module does not describe that ordering.
func (s *Service) encodeSecretForStorage(ctx context.Context, plain string) (secretValue, error) {
	security, err := s.readSystemSecurityRecordCached(ctx)
	if err != nil {
		return secretValue{}, err
	}
	configured, configuredSet := security.resolveConfigured()

	raw := s.cfg.SettingsEncryptionKeyRaw
	keyPresent := raw != ""
	var key []byte
	var keyErr error
	if keyPresent {
		key, keyErr = decodeSettingsKey(raw)
	}
	keyValid := keyPresent && keyErr == nil

	if configuredSet && configured && keyPresent && !keyValid {
		detail := ""
		if keyErr != nil {
			detail = " (" + keyErr.Error() + ")"
		}
		return secretValue{}, &httpError{
			status:  400,
			message: "Secret encryption is enabled but SYSTEM_SETTINGS_ENCRYPTION_KEY is missing or invalid" + detail,
		}
	}

	if keyValid {
		if configuredSet && !configured {
			return secretValuePlain(plain), nil
		}
		encrypted, err := encryptStringValueV1(plain, key)
		if err != nil {
			return secretValue{}, err
		}
		return secretValueEncrypted(encrypted), nil
	}

	if configuredSet && configured {
		return secretValue{}, &httpError{
			status:  400,
			message: "Secret encryption is enabled but SYSTEM_SETTINGS_ENCRYPTION_KEY is not configured",
		}
	}

	if s.cfg.IsProduction {
		return secretValue{}, &httpError{
			status:  400,
			message: "SYSTEM_SETTINGS_ENCRYPTION_KEY is required to store secrets in production",
		}
	}

	// Non-production without a key and without an explicit encryption request: the
	// existing plaintext escape hatch, with the same security warning.
	log.Printf("modelaccesssettings: SYSTEM_SETTINGS_ENCRYPTION_KEY is missing; storing secret in plaintext (non-production only)")
	return secretValuePlain(plain), nil
}
