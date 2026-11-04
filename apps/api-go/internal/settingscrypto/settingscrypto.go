// Package settingscrypto is the single implementation of the system-settings v1
// secret envelope shared with the former NestJS service. Every domain that reads
// or writes SYSTEM_SETTINGS_ENCRYPTION_KEY-encrypted values delegates here so the
// wire format and the key-parsing rules live in exactly one place.
//
// The wire format is fixed and independent of the Go implementation:
//
//	{"__enc":"system-settings:v1","alg":"aes-256-gcm",
//	 "iv":"<base64>","tag":"<base64>","data":"<base64>"}
//
// The cipher is AES-256-GCM with a 32-byte key, a fresh random 12-byte IV per
// encryption, a detached 16-byte authentication tag and no additional
// authenticated data. Ciphertext written by NestJS decrypts here and vice versa.
package settingscrypto

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
)

const (
	// EnvelopeTag is the fixed value stored under the "__enc" member.
	EnvelopeTag = "system-settings:v1"
	// Algorithm is the only cipher this envelope supports.
	Algorithm = "aes-256-gcm"
	// KeyBytes is the AES-256 key size.
	KeyBytes = 32
	// IVBytes is the GCM nonce size.
	IVBytes = 12
	// TagBytes is the detached GCM authentication tag size.
	TagBytes = 16
)

// Sentinels returned by ParseKey and Decrypt. Their messages are the exact
// strings the NestJS helper and the HTTP 400 bodies used, so a domain that
// surfaces err.Error() keeps its original wording; a domain that only needs a
// boolean can compare with errors.Is.
var (
	// ErrKeyEmpty reports a blank SYSTEM_SETTINGS_ENCRYPTION_KEY.
	ErrKeyEmpty = errors.New("SYSTEM_SETTINGS_ENCRYPTION_KEY is empty")
	// ErrKeyLength reports a key that does not decode to exactly 32 bytes.
	ErrKeyLength = errors.New("SYSTEM_SETTINGS_ENCRYPTION_KEY must be 32 bytes (base64) or 64 hex chars")
	// ErrDecrypt is the single opaque failure Decrypt returns for a wrong key,
	// a malformed envelope, a bad IV/tag length or a failed GCM check. The
	// underlying cause is never surfaced so key material cannot leak.
	ErrDecrypt = errors.New("failed to decrypt system setting secret")
)

// Envelope is the stored system-settings:v1 secret. IV/Tag/Data are pointers so
// a missing member stays distinguishable from an empty string: NestJS only
// treats a value as an envelope when all three are present strings. The field
// order matches the members NestJS writes, so a freshly produced envelope is
// byte-identical.
type Envelope struct {
	Enc  string  `json:"__enc"`
	Alg  string  `json:"alg"`
	IV   *string `json:"iv"`
	Tag  *string `json:"tag"`
	Data *string `json:"data"`
}

// Valid reports whether the envelope has the exact v1 shape: the tag and
// algorithm match and all three payload members were present in the JSON.
func (e Envelope) Valid() bool {
	return e.Enc == EnvelopeTag &&
		e.Alg == Algorithm &&
		e.IV != nil && e.Tag != nil && e.Data != nil
}

// IsEnvelope reports whether raw is a JSON object with the exact v1 shape. It is
// the shared plaintext-vs-ciphertext discriminator; domains that used a bespoke
// check must keep the same answer, so a missing or non-string iv/tag/data is
// never an envelope.
func IsEnvelope(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return false
	}
	var envelope Envelope
	if err := json.Unmarshal(trimmed, &envelope); err != nil {
		return false
	}
	return envelope.Valid()
}

// ParseKey decodes SYSTEM_SETTINGS_ENCRYPTION_KEY. After trimming, a key with an
// optional 0x/0X prefix followed by exactly 64 hex characters decodes as hex;
// anything else is decoded with Node's Buffer.from(value, "base64") semantics
// (standard and URL-safe alphabets accepted, other characters ignored, '='
// terminates). The result must be exactly 32 bytes.
func ParseKey(raw string) ([]byte, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil, ErrKeyEmpty
	}
	hexCandidate := trimmed
	if len(hexCandidate) >= 2 && hexCandidate[0] == '0' && (hexCandidate[1] == 'x' || hexCandidate[1] == 'X') {
		hexCandidate = hexCandidate[2:]
	}
	if len(hexCandidate) == KeyBytes*2 && isHexString(hexCandidate) {
		if decoded, err := hex.DecodeString(hexCandidate); err == nil {
			return decoded, nil
		}
	}
	if decoded := nodeBase64Decode(trimmed); len(decoded) == KeyBytes {
		return decoded, nil
	}
	return nil, ErrKeyLength
}

// Encrypt produces a v1 envelope for one plaintext with a fresh random IV.
func Encrypt(plain string, key []byte) (Envelope, error) {
	if len(key) != KeyBytes {
		return Envelope{}, ErrKeyLength
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return Envelope{}, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return Envelope{}, err
	}
	iv := make([]byte, IVBytes)
	if _, err := rand.Read(iv); err != nil {
		return Envelope{}, err
	}
	sealed := aead.Seal(nil, iv, []byte(plain), nil)
	if len(sealed) < TagBytes {
		return Envelope{}, ErrDecrypt
	}
	data := sealed[:len(sealed)-TagBytes]
	tag := sealed[len(sealed)-TagBytes:]
	ivText := base64.StdEncoding.EncodeToString(iv)
	tagText := base64.StdEncoding.EncodeToString(tag)
	dataText := base64.StdEncoding.EncodeToString(data)
	return Envelope{
		Enc:  EnvelopeTag,
		Alg:  Algorithm,
		IV:   &ivText,
		Tag:  &tagText,
		Data: &dataText,
	}, nil
}

// Decrypt opens one v1 envelope. Every failure (wrong key, malformed envelope,
// wrong IV/tag length, failed GCM verification) returns ErrDecrypt. The IV and
// tag lengths are checked before crypto/cipher because Go's GCM panics on a
// nonce of the wrong size while Node only throws.
func Decrypt(envelope Envelope, key []byte) (string, error) {
	if len(key) != KeyBytes {
		return "", ErrDecrypt
	}
	if !envelope.Valid() {
		return "", ErrDecrypt
	}
	iv := nodeBase64Decode(*envelope.IV)
	tag := nodeBase64Decode(*envelope.Tag)
	data := nodeBase64Decode(*envelope.Data)
	if len(iv) != IVBytes || len(tag) != TagBytes {
		return "", ErrDecrypt
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", ErrDecrypt
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return "", ErrDecrypt
	}
	sealed := make([]byte, 0, len(data)+len(tag))
	sealed = append(sealed, data...)
	sealed = append(sealed, tag...)
	plain, err := aead.Open(nil, iv, sealed, nil)
	if err != nil {
		return "", ErrDecrypt
	}
	return string(plain), nil
}

// isHexString reports whether every rune is an ASCII hexadecimal digit.
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

// nodeBase64Alphabet maps one ASCII byte to its 6-bit value, or -1 when the byte
// is not part of either the standard or the URL-safe base64 alphabet.
//
// Node's Buffer.from(value, "base64") accepts both `+/` and `-_`, ignores every
// other character, and stops at the first `=`. This matters for
// SYSTEM_SETTINGS_ENCRYPTION_KEY: Node accepts an unpadded 43-character base64
// key while Go's encoding/base64 rejects it, so a strict decoder would misreport
// a valid key as invalid.
var nodeBase64Alphabet = buildNodeBase64Alphabet()

// buildNodeBase64Alphabet assembles the 256-entry lookup table once.
func buildNodeBase64Alphabet() [256]int8 {
	var table [256]int8
	for index := range table {
		table[index] = -1
	}
	const standard = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
	const urlSafe = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
	for index := 0; index < len(standard); index++ {
		table[standard[index]] = int8(index)
	}
	for index := 0; index < len(urlSafe); index++ {
		table[urlSafe[index]] = int8(index)
	}
	return table
}

// nodeBase64Decode reproduces Node's lenient base64 decoding: invalid characters
// are skipped, `=` terminates the input, and a trailing partial group of 2 or 3
// characters yields 1 or 2 bytes (a single leftover character yields nothing).
func nodeBase64Decode(value string) []byte {
	sextets := make([]byte, 0, len(value))
	for index := 0; index < len(value); index++ {
		current := value[index]
		if current == '=' {
			break
		}
		mapped := nodeBase64Alphabet[current]
		if mapped < 0 {
			continue
		}
		sextets = append(sextets, byte(mapped))
	}
	out := make([]byte, 0, len(sextets)/4*3+2)
	for index := 0; index+3 < len(sextets); index += 4 {
		block := uint32(sextets[index])<<18 | uint32(sextets[index+1])<<12 |
			uint32(sextets[index+2])<<6 | uint32(sextets[index+3])
		out = append(out, byte(block>>16), byte(block>>8), byte(block))
	}
	switch len(sextets) % 4 {
	case 2:
		block := uint32(sextets[len(sextets)-2])<<18 | uint32(sextets[len(sextets)-1])<<12
		out = append(out, byte(block>>16))
	case 3:
		block := uint32(sextets[len(sextets)-3])<<18 | uint32(sextets[len(sextets)-2])<<12 |
			uint32(sextets[len(sextets)-1])<<6
		out = append(out, byte(block>>16), byte(block>>8))
	}
	return out
}
