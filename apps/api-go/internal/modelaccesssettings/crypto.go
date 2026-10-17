package modelaccesssettings

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
)

// Encryption protocol constants. These MUST stay byte-compatible with
// apps/api/src/modules/storage/storage-settings.crypto.ts: the same envelope
// tag, the same algorithm name, an independent 16 byte GCM tag, the ciphertext
// without the tag, no additional authenticated data, and a fresh random 12 byte
// IV per write.
const (
	encryptionAlgorithm   = "aes-256-gcm"
	settingsEncryptionTag = "system-settings:v1"
	settingsKeyBytes      = 32
	gcmIVBytes            = 12
	gcmTagBytes           = 16
)

// Decode errors. The first two strings are the exact NestJS messages surfaced
// inside the 400 body of the encryption policy; the third is the generic
// decrypt failure raised by SystemSettingsDecryptionError.
var (
	errEncryptionKeyEmpty   = errors.New("SYSTEM_SETTINGS_ENCRYPTION_KEY is empty")
	errEncryptionKeyInvalid = errors.New("SYSTEM_SETTINGS_ENCRYPTION_KEY must be 32 bytes (base64) or 64 hex chars")
	errEncryptionKeyLength  = errors.New("Invalid SYSTEM_SETTINGS_ENCRYPTION_KEY length")
	errDecryptSecret        = errors.New("Failed to decrypt system setting secret")
)

// encryptedSecret is the on-disk system-settings:v1 envelope. The field order is
// the order NestJS writes, so a freshly produced envelope is byte-identical.
type encryptedSecret struct {
	Enc  string `json:"__enc"`
	Alg  string `json:"alg"`
	IV   string `json:"iv"`
	Tag  string `json:"tag"`
	Data string `json:"data"`
}

// isEncryptedSecretShape mirrors isEncryptedStringValueV1: the tag and algorithm
// must match exactly and iv/tag/data must all be strings. Extra keys are
// tolerated (the stored bytes are preserved for re-serialization).
func isEncryptedSecretShape(raw []byte) (encryptedSecret, bool) {
	var probe struct {
		Enc  string  `json:"__enc"`
		Alg  string  `json:"alg"`
		IV   *string `json:"iv"`
		Tag  *string `json:"tag"`
		Data *string `json:"data"`
	}
	if err := json.Unmarshal(raw, &probe); err != nil {
		return encryptedSecret{}, false
	}
	if probe.Enc != settingsEncryptionTag || probe.Alg != encryptionAlgorithm {
		return encryptedSecret{}, false
	}
	if probe.IV == nil || probe.Tag == nil || probe.Data == nil {
		return encryptedSecret{}, false
	}
	return encryptedSecret{
		Enc:  probe.Enc,
		Alg:  probe.Alg,
		IV:   *probe.IV,
		Tag:  *probe.Tag,
		Data: *probe.Data,
	}, true
}

// decodeSettingsKey mirrors decodeSystemSettingsKey exactly:
//   - the input is trimmed;
//   - a 64 character hex string (with an optional 0x/0X prefix) decodes as hex;
//   - anything else decodes with Node's lenient base64 semantics and must yield
//     exactly 32 bytes.
func decodeSettingsKey(raw string) ([]byte, error) {
	trimmed := jsTrimSpace(raw)
	if trimmed == "" {
		return nil, errEncryptionKeyEmpty
	}
	hexCandidate := trimmed
	if len(trimmed) >= 2 && (trimmed[0] == '0') && (trimmed[1] == 'x' || trimmed[1] == 'X') {
		hexCandidate = trimmed[2:]
	}
	if len(hexCandidate) == settingsKeyBytes*2 && isHexString(hexCandidate) {
		decoded, err := hex.DecodeString(hexCandidate)
		if err != nil {
			return nil, errEncryptionKeyInvalid
		}
		return decoded, nil
	}
	decoded := nodeBase64Decode(trimmed)
	if len(decoded) != settingsKeyBytes {
		return nil, errEncryptionKeyInvalid
	}
	return decoded, nil
}

// isHexString reports whether every byte is an ASCII hex digit.
func isHexString(value string) bool {
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

// encryptStringValueV1 produces the system-settings:v1 envelope with a fresh
// random IV. A wrong key length is a programming error surfaced verbatim, like
// the NestJS helper.
func encryptStringValueV1(plain string, key []byte) (encryptedSecret, error) {
	if len(key) != settingsKeyBytes {
		return encryptedSecret{}, errEncryptionKeyLength
	}
	iv := make([]byte, gcmIVBytes)
	if _, err := rand.Read(iv); err != nil {
		return encryptedSecret{}, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return encryptedSecret{}, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return encryptedSecret{}, err
	}
	sealed := gcm.Seal(nil, iv, []byte(plain), nil)
	tag := sealed[len(sealed)-gcm.Overhead():]
	data := sealed[:len(sealed)-gcm.Overhead()]
	return encryptedSecret{
		Enc:  settingsEncryptionTag,
		Alg:  encryptionAlgorithm,
		IV:   base64.StdEncoding.EncodeToString(iv),
		Tag:  base64.StdEncoding.EncodeToString(tag),
		Data: base64.StdEncoding.EncodeToString(data),
	}, nil
}

// decryptStringValueV1 mirrors decryptStringValueV1. Every failure path returns
// the single generic error NestJS raises (the original cause is deliberately not
// surfaced, so a corrupted row can never leak key material into a response).
//
// The IV length and tag length are checked before handing control to
// crypto/cipher: Go's GCM panics on a nonce of the wrong size, while Node merely
// throws. A wrong-sized tag is also rejected here because crypto/cipher only
// supports the 16 byte GCM tag, which is what every writer in this repository
// produces.
func decryptStringValueV1(payload encryptedSecret, key []byte) (string, error) {
	if len(key) != settingsKeyBytes {
		return "", errEncryptionKeyLength
	}
	iv := nodeBase64Decode(payload.IV)
	tag := nodeBase64Decode(payload.Tag)
	data := nodeBase64Decode(payload.Data)
	if len(iv) != gcmIVBytes || len(tag) != gcmTagBytes {
		return "", errDecryptSecret
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", errDecryptSecret
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", errDecryptSecret
	}
	sealed := make([]byte, 0, len(data)+len(tag))
	sealed = append(sealed, data...)
	sealed = append(sealed, tag...)
	plain, err := gcm.Open(nil, iv, sealed, nil)
	if err != nil {
		return "", errDecryptSecret
	}
	return string(plain), nil
}

// nodeBase64Alphabet maps one ASCII byte to its 6 bit value, or -1 when the byte
// is not part of either the standard or the URL-safe base64 alphabet.
//
// Node's Buffer.from(value, "base64") accepts both `+/` and `-_`, ignores every
// other character, and stops at the first `=`. Custom alphabets outside those
// two are not part of this protocol.
var nodeBase64Alphabet = buildNodeBase64Alphabet()

// buildNodeBase64Alphabet assembles the 256 entry lookup table once.
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

// nodeBase64Decode reproduces Node's lenient base64 decoding for the cases this
// protocol can meet: invalid characters are skipped, `=` terminates the input,
// and a trailing partial group of 2 or 3 characters yields 1 or 2 bytes (a
// single leftover character yields nothing).
//
// This matters for SYSTEM_SETTINGS_ENCRYPTION_KEY: Node accepts an unpadded
// 43 character base64 key while Go's encoding/base64 rejects it, so the strict
// decoder would misreport a valid key as invalid.
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
