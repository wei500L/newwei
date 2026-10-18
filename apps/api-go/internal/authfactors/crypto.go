package authfactors

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

// This file implements the system-settings v1 secret envelope shared with
// NestJS. The wire format is fixed and independent of the implementation:
//
//	{"__enc":"system-settings:v1","alg":"aes-256-gcm",
//	 "iv":"<base64>","tag":"<base64>","data":"<base64>"}
//
// A 32-byte key, a fresh random 12-byte IV per encryption, a 16-byte
// authentication tag stored separately, and no additional authenticated data.
// The policy around it mirrors AuthSecurityService.encodeSecret exactly, which
// (unlike the system-security settings service) does not wrap failures in a
// BadRequestException: a missing key that the stored policy requires surfaces
// as the production 500, not as a 400.

const (
	settingsEncTag         = "system-settings:v1"
	encryptionAlgorithm    = "aes-256-gcm"
	systemSettingsKeyBytes = 32
	gcmTagBytes            = 16
	gcmIVBytes             = 12
)

// encryptedStringValueV1 is the stored envelope. IV/Tag/Data are pointers so a
// missing member stays distinguishable from an empty string: NestJS requires
// all three to be strings before treating a value as an envelope.
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
// NestJS helper produces.
var (
	errKeyEmpty  = errors.New("SYSTEM_SETTINGS_ENCRYPTION_KEY is empty")
	errKeyLength = errors.New("SYSTEM_SETTINGS_ENCRYPTION_KEY must be 32 bytes (base64) or 64 hex chars")
)

// errEncryptionRequired mirrors SystemSettingsEncryptionRequiredError: the
// stored policy or the production environment demands encryption but no usable
// key exists. It is not an HttpException in NestJS, so it renders as a 500.
var errEncryptionRequired = errors.New("secret encryption is enabled but SYSTEM_SETTINGS_ENCRYPTION_KEY is not configured")

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
	if len(hexCandidate) >= 2 && hexCandidate[0] == '0' && (hexCandidate[1] == 'x' || hexCandidate[1] == 'X') {
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

// decryptStringValueV1 decrypts one envelope. A tampered tag or a wrong key
// produces an error that propagates exactly like the NestJS
// SystemSettingsDecryptionError.
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

// settingsKey mirrors AuthSecurityService.resolveSettingsKey: the decoded key,
// or nil when the variable is absent, blank or undecodable.
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
	envelope  encryptedStringValueV1
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
	var envelope encryptedStringValueV1
	if err := json.Unmarshal([]byte(trimmed), &envelope); err != nil {
		return storedSecret{kind: secretAbsent}
	}
	if !envelope.valid() {
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
		envelope, err := encryptStringValueV1(plain, key)
		if err != nil {
			return nil, err
		}
		return envelope.encodeJSON()
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
		plaintext, err := decryptStringValueV1(stored.envelope, key)
		if err != nil {
			return "", false, err
		}
		return plaintext, true, nil
	default:
		return "", false, nil
	}
}
