package llmgatewayprofiles

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"strings"
)

// Encryption key policy errors, copied verbatim from
// apps/api/src/modules/storage/storage-settings.crypto.ts.
const (
	errKeyEmptyMessage  = "SYSTEM_SETTINGS_ENCRYPTION_KEY is empty"
	errKeyLengthMessage = "SYSTEM_SETTINGS_ENCRYPTION_KEY must be 32 bytes (base64) or 64 hex chars"
	// keyByteLength is the AES-256 key length.
	keyByteLength = 32
	// gcmIVByteLength is the GCM nonce length.
	gcmIVByteLength = 12
	// gcmTagByteLength is the detached authentication tag length.
	gcmTagByteLength = 16
)

// decodeSystemSettingsKey mirrors decodeSystemSettingsKey: trim, prefer a
// 0x-prefixed 64 hex character key, otherwise Node-compatible base64 that must
// decode to exactly 32 bytes.
func decodeSystemSettingsKey(raw string) ([]byte, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil, errors.New(errKeyEmptyMessage)
	}
	hexCandidate := trimmed
	if strings.HasPrefix(hexCandidate, "0x") || strings.HasPrefix(hexCandidate, "0X") {
		hexCandidate = hexCandidate[2:]
	}
	if isHexString(hexCandidate) && len(hexCandidate) == keyByteLength*2 {
		if decoded, err := hex.DecodeString(hexCandidate); err == nil {
			return decoded, nil
		}
	}
	if decoded := nodeBase64Decode(trimmed); len(decoded) == keyByteLength {
		return decoded, nil
	}
	return nil, errors.New(errKeyLengthMessage)
}

// isHexString reports whether every rune is a hexadecimal digit.
func isHexString(value string) bool {
	if value == "" {
		return false
	}
	for _, r := range value {
		switch {
		case r >= '0' && r <= '9':
		case r >= 'a' && r <= 'f':
		case r >= 'A' && r <= 'F':
		default:
			return false
		}
	}
	return true
}

// isBase64Char reports membership in Node's base64 alphabet.
func isBase64Char(r rune) bool {
	switch {
	case r >= 'A' && r <= 'Z':
	case r >= 'a' && r <= 'z':
	case r >= '0' && r <= '9':
	case r == '+' || r == '/':
	default:
		return false
	}
	return true
}

// nodeBase64Decode reproduces Buffer.from(value, "base64"): characters outside
// the alphabet are ignored and decoding stops at the first '='.
func nodeBase64Decode(raw string) []byte {
	var builder strings.Builder
	for _, r := range raw {
		if r == '=' {
			break
		}
		if isBase64Char(r) {
			builder.WriteRune(r)
		}
	}
	encoded := builder.String()
	if encoded == "" {
		return nil
	}
	decoded, err := base64.RawStdEncoding.DecodeString(encoded)
	if err != nil {
		return nil
	}
	return decoded
}

// lenientBase64Decode accepts both padded and unpadded standard base64, matching
// the tolerance of Buffer.from(value, "base64") for stored envelope fields.
func lenientBase64Decode(value string) ([]byte, error) {
	if decoded, err := base64.StdEncoding.DecodeString(value); err == nil {
		return decoded, nil
	}
	return base64.RawStdEncoding.DecodeString(value)
}

// encryptStringValueV1 mirrors encryptStringValueV1: AES-256-GCM, a random 12
// byte IV, a detached 16 byte tag and no additional authenticated data.
func encryptStringValueV1(plain string, key []byte) (EncryptedStringValueV1, error) {
	if len(key) != keyByteLength {
		return EncryptedStringValueV1{}, errors.New("Invalid SYSTEM_SETTINGS_ENCRYPTION_KEY length")
	}
	gcm, err := newGCM(key)
	if err != nil {
		return EncryptedStringValueV1{}, err
	}
	iv := make([]byte, gcmIVByteLength)
	if _, err := rand.Read(iv); err != nil {
		return EncryptedStringValueV1{}, err
	}
	sealed := gcm.Seal(nil, iv, []byte(plain), nil)
	if len(sealed) < gcmTagByteLength {
		return EncryptedStringValueV1{}, errors.New("aes-gcm sealing produced a short payload")
	}
	ciphertext := sealed[:len(sealed)-gcmTagByteLength]
	tag := sealed[len(sealed)-gcmTagByteLength:]
	return EncryptedStringValueV1{
		Enc:  EncryptionTag,
		Alg:  EncryptionAlgorithm,
		IV:   base64.StdEncoding.EncodeToString(iv),
		Tag:  base64.StdEncoding.EncodeToString(tag),
		Data: base64.StdEncoding.EncodeToString(ciphertext),
	}, nil
}

// decryptStringValueV1 mirrors decryptStringValueV1 and reports an error for a
// wrong key, a truncated envelope or a corrupted tag. The caller degrades to
// hasApiKey=false instead of failing the request.
func decryptStringValueV1(payload EncryptedStringValueV1, key []byte) (string, error) {
	if len(key) != keyByteLength {
		return "", errors.New("Invalid SYSTEM_SETTINGS_ENCRYPTION_KEY length")
	}
	iv, err := lenientBase64Decode(payload.IV)
	if err != nil {
		return "", err
	}
	tag, err := lenientBase64Decode(payload.Tag)
	if err != nil {
		return "", err
	}
	data, err := lenientBase64Decode(payload.Data)
	if err != nil {
		return "", err
	}
	gcm, err := newGCM(key)
	if err != nil {
		return "", err
	}
	sealed := make([]byte, 0, len(data)+len(tag))
	sealed = append(sealed, data...)
	sealed = append(sealed, tag...)
	plain, err := gcm.Open(nil, iv, sealed, nil)
	if err != nil {
		return "", err
	}
	return string(plain), nil
}

// newGCM builds the AES-256-GCM AEAD for one key.
func newGCM(key []byte) (cipher.AEAD, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
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
	key, err := decodeSystemSettingsKey(raw)
	if err != nil {
		return keyStatus{present: true, errMessage: err.Error()}
	}
	return keyStatus{present: true, valid: true, key: key}
}
