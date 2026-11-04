package llmgatewayprofiles

import (
	"github.com/wei500L/newwei/apps/api-go/internal/settingscrypto"
)

// Encryption key policy errors, copied verbatim from
// apps/api/src/modules/storage/storage-settings.crypto.ts.
const (
	errKeyEmptyMessage  = "SYSTEM_SETTINGS_ENCRYPTION_KEY is empty"
	errKeyLengthMessage = "SYSTEM_SETTINGS_ENCRYPTION_KEY must be 32 bytes (base64) or 64 hex chars"
	// keyByteLength is the AES-256 key length.
	keyByteLength = settingscrypto.KeyBytes
	// gcmIVByteLength is the GCM nonce length.
	gcmIVByteLength = settingscrypto.IVBytes
	// gcmTagByteLength is the detached authentication tag length.
	gcmTagByteLength = settingscrypto.TagBytes
)

// encryptStringValueV1 produces the domain's v1 envelope projection with a fresh
// random IV. The cipher itself lives in settingscrypto.
func encryptStringValueV1(plain string, key []byte) (EncryptedStringValueV1, error) {
	envelope, err := settingscrypto.Encrypt(plain, key)
	if err != nil {
		return EncryptedStringValueV1{}, err
	}
	return EncryptedStringValueV1{
		Enc:  envelope.Enc,
		Alg:  envelope.Alg,
		IV:   *envelope.IV,
		Tag:  *envelope.Tag,
		Data: *envelope.Data,
	}, nil
}

// decryptStringValueV1 decrypts one envelope. A wrong key, a truncated envelope
// or a corrupted tag surfaces as an error; the caller degrades to
// hasApiKey=false instead of failing the request.
func decryptStringValueV1(payload EncryptedStringValueV1, key []byte) (string, error) {
	iv := payload.IV
	tag := payload.Tag
	data := payload.Data
	return settingscrypto.Decrypt(settingscrypto.Envelope{
		Enc:  settingscrypto.EnvelopeTag,
		Alg:  settingscrypto.Algorithm,
		IV:   &iv,
		Tag:  &tag,
		Data: &data,
	}, key)
}

// keyStatus is the resolved SYSTEM_SETTINGS_ENCRYPTION_KEY state. present
// mirrors the JavaScript truthiness check on the raw value, so a whitespace-only
// key counts as present but invalid, exactly like NestJS.
type keyStatus struct {
	present    bool
	valid      bool
	key        []byte
	errMessage string
}

// resolveKeyStatus mirrors SystemSecuritySettingsService.resolveEnvKeyStatus.
func (s *Service) resolveKeyStatus() keyStatus {
	if s == nil {
		return keyStatus{}
	}
	raw := s.cfg.SettingsEncryptionKey
	if raw == "" {
		return keyStatus{}
	}
	key, err := settingscrypto.ParseKey(raw)
	if err != nil {
		return keyStatus{present: true, errMessage: err.Error()}
	}
	return keyStatus{present: true, valid: true, key: key}
}
