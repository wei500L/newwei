package modelaccesssettings

import (
	"bytes"
	"encoding/json"
)

// DecodeStoredSettingsSecret resolves one stored system-settings secret the way
// every settings reader does (resolveToken in VectorServiceSettingsService, the
// stored-token branch of ModelServiceSettingsService):
//
//   - a JSON string is returned trimmed and must be non-blank;
//   - a system-settings:v1 envelope is decrypted with SYSTEM_SETTINGS_ENCRYPTION_KEY;
//   - anything else, an unusable key or a failed decryption yields ok=false.
//
// The helper exists so a background unit that reads a stored secret reuses this
// package's encryption protocol instead of re-implementing AES-GCM.
func DecodeStoredSettingsSecret(rawValue []byte, settingsKeyRaw string) (string, bool) {
	trimmed := bytes.TrimSpace(rawValue)
	if len(trimmed) == 0 || string(trimmed) == "null" {
		return "", false
	}
	var text string
	if err := json.Unmarshal(trimmed, &text); err == nil {
		normalized := jsTrimSpace(text)
		if normalized == "" {
			return "", false
		}
		return normalized, true
	}
	payload, ok := isEncryptedSecretShape(trimmed)
	if !ok {
		return "", false
	}
	if settingsKeyRaw == "" {
		return "", false
	}
	key, err := decodeSettingsKey(settingsKeyRaw)
	if err != nil {
		return "", false
	}
	decrypted, err := decryptStringValueV1(payload, key)
	if err != nil {
		return "", false
	}
	normalized := jsTrimSpace(decrypted)
	if normalized == "" {
		return "", false
	}
	return normalized, true
}
