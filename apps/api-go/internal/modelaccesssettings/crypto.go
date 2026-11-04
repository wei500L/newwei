package modelaccesssettings

import (
	"encoding/json"
	"errors"

	"github.com/wei500L/newwei/apps/api-go/internal/settingscrypto"
)

// Encryption protocol constants. These name the shared system-settings:v1
// envelope; the cipher, the key parsing and the envelope struct live in
// settingscrypto so every domain shares one implementation.
const (
	encryptionAlgorithm   = settingscrypto.Algorithm
	settingsEncryptionTag = settingscrypto.EnvelopeTag
)

// errDecryptSecret is the generic decrypt failure this package has always
// surfaced (capitalized). The shared package returns its own opaque sentinel;
// this package maps it to keep the historical message.
var errDecryptSecret = errors.New("Failed to decrypt system setting secret")

// isEncryptedSecretShape reports whether raw is a v1 envelope and returns its
// parsed form. Extra keys are tolerated (the stored bytes are preserved for
// re-serialization); the tag and algorithm must match and iv/tag/data must all
// be strings.
func isEncryptedSecretShape(raw []byte) (settingscrypto.Envelope, bool) {
	if !settingscrypto.IsEnvelope(raw) {
		return settingscrypto.Envelope{}, false
	}
	var envelope settingscrypto.Envelope
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return settingscrypto.Envelope{}, false
	}
	return envelope, true
}

// encryptStringValueV1 produces the system-settings:v1 envelope with a fresh
// random IV through the shared implementation.
func encryptStringValueV1(plain string, key []byte) (settingscrypto.Envelope, error) {
	return settingscrypto.Encrypt(plain, key)
}

// decryptStringValueV1 decrypts one envelope. Every failure path returns the
// single generic error this package has always raised; the cause (wrong key,
// corrupted row, short IV/tag) is never surfaced.
func decryptStringValueV1(payload settingscrypto.Envelope, key []byte) (string, error) {
	plain, err := settingscrypto.Decrypt(payload, key)
	if err != nil {
		return "", errDecryptSecret
	}
	return plain, nil
}
