package infrastructuresettings

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
)

// This file implements the system-settings v1 secret envelope. The wire format
// is fixed and independent of the Go implementation:
//
//	{"__enc":"system-settings:v1","alg":"aes-256-gcm",
//	 "iv":"<base64>","tag":"<base64>","data":"<base64>"}
//
// 32-byte key, a fresh random 12-byte IV per encryption, a 16-byte
// authentication tag stored separately, and no additional authenticated data.

const (
	settingsEncTag         = "system-settings:v1"
	encryptionAlgorithm    = "aes-256-gcm"
	systemSettingsKeyBytes = 32
	gcmTagBytes            = 16
	gcmIVBytes             = 12
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

// encodeJSON renders the envelope with the canonical member order.
func (e encryptedStringValueV1) encodeJSON() (json.RawMessage, error) {
	return json.Marshal(e)
}

// errKeyEmpty and errKeyLength mirror the two decode failure messages the
// NestJS helper produces. They are surfaced verbatim inside the
// "missing or invalid (<error>)" 400 detail.
var (
	errKeyEmpty  = errors.New("SYSTEM_SETTINGS_ENCRYPTION_KEY is empty")
	errKeyLength = errors.New("SYSTEM_SETTINGS_ENCRYPTION_KEY must be 32 bytes (base64) or 64 hex chars")
)

var hexKeyRe = regexp.MustCompile(`^[0-9a-fA-F]+$`)

// decodeSystemSettingsKey mirrors decodeSystemSettingsKey: an optional 0x/0X
// prefix followed by exactly 64 hex characters, or a Node-compatible base64
// decoding that yields exactly 32 bytes.
func decodeSystemSettingsKey(raw string) ([]byte, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil, errKeyEmpty
	}
	hexCandidate := trimmed
	if len(hexCandidate) >= 2 && (hexCandidate[0] == '0') && (hexCandidate[1] == 'x' || hexCandidate[1] == 'X') {
		hexCandidate = hexCandidate[2:]
	}
	if len(hexCandidate) == systemSettingsKeyBytes*2 && hexKeyRe.MatchString(hexCandidate) {
		decoded, err := hex.DecodeString(hexCandidate)
		if err == nil {
			return decoded, nil
		}
	}
	decoded := decodeNodeBase64(trimmed)
	if len(decoded) == systemSettingsKeyBytes {
		return decoded, nil
	}
	return nil, errKeyLength
}

// decodeNodeBase64 mirrors Buffer.from(value, "base64"), which skips every
// character outside the (URL-safe) base64 alphabet and stops at the first
// padding character.
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
			// Padding terminates the payload.
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

// encryptStringValueV1 encrypts one plaintext with a fresh random IV.
func encryptStringValueV1(plain string, key []byte) (encryptedStringValueV1, error) {
	if len(key) != systemSettingsKeyBytes {
		return encryptedStringValueV1{}, errors.New("invalid SYSTEM_SETTINGS_ENCRYPTION_KEY length")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return encryptedStringValueV1{}, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return encryptedStringValueV1{}, err
	}
	iv := make([]byte, gcmIVBytes)
	if _, err := rand.Read(iv); err != nil {
		return encryptedStringValueV1{}, err
	}
	sealed := aead.Seal(nil, iv, []byte(plain), nil)
	if len(sealed) < gcmTagBytes {
		return encryptedStringValueV1{}, errors.New("invalid sealed payload")
	}
	data := sealed[:len(sealed)-gcmTagBytes]
	tag := sealed[len(sealed)-gcmTagBytes:]
	ivText := base64.StdEncoding.EncodeToString(iv)
	tagText := base64.StdEncoding.EncodeToString(tag)
	dataText := base64.StdEncoding.EncodeToString(data)
	return encryptedStringValueV1{
		Enc:  settingsEncTag,
		Alg:  encryptionAlgorithm,
		IV:   &ivText,
		Tag:  &tagText,
		Data: &dataText,
	}, nil
}

// decryptStringValueV1 decrypts one envelope. Any failure (bad base64, wrong
// key, tampered tag) is reported as a single opaque error.
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
	raw := s.cfg.EncryptionKeyRaw
	if !s.cfg.EncryptionKeyPresent {
		return keyStatus{present: false, valid: false}
	}
	key, err := decodeSystemSettingsKey(raw)
	if err != nil {
		return keyStatus{present: true, valid: false, err: err.Error()}
	}
	return keyStatus{present: true, valid: true, key: key}
}

// settingsKey mirrors resolveSettingsKey(env): the decoded key, or nil when the
// variable is absent or invalid.
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
	encrypted *encryptedStringValueV1
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
// including the pre-check that distinguishes "enabled with a present but
// invalid key" from "enabled with no key at all".
func (s *Service) encodeSecretForStorage(ctx context.Context, plain string) (resolvedSecret, error) {
	configured, configuredOK := s.systemSecurityConfigured(ctx)
	status := s.resolveKeyStatus()

	if configuredOK && configured == true && status.present && !status.valid {
		details := ""
		if status.err != "" {
			details = " (" + status.err + ")"
		}
		return resolvedSecret{}, &secretError{
			message: "Secret encryption is enabled but SYSTEM_SETTINGS_ENCRYPTION_KEY is missing or invalid" + details,
		}
	}

	if status.valid {
		if configuredOK && configured == false {
			return resolvedSecret{plaintext: plain}, nil
		}
		envelope, err := encryptStringValueV1(plain, status.key)
		if err != nil {
			return resolvedSecret{}, err
		}
		return resolvedSecret{encrypted: &envelope}, nil
	}

	if configuredOK && configured == true {
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
		return r.encrypted.encodeJSON()
	}
	return json.Marshal(r.plaintext)
}
