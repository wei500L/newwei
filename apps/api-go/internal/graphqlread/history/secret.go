package history

import (
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"os"
	"strings"
)

func managedKeyState(raw any) string {
	switch typed := raw.(type) {
	case string:
		if strings.TrimSpace(typed) == "" {
			return "missing"
		}
		return "available"
	case map[string]any:
		if !encryptedSecret(typed) {
			return "missing"
		}
		plain, err := decryptSecret(typed, os.Getenv("SYSTEM_SETTINGS_ENCRYPTION_KEY"))
		if err != nil {
			return "unreadable"
		}
		if strings.TrimSpace(plain) == "" {
			return "missing"
		}
		return "available"
	default:
		return "missing"
	}
}

func encryptedSecret(raw map[string]any) bool {
	if raw["__enc"] != "system-settings:v1" || raw["alg"] != "aes-256-gcm" {
		return false
	}
	_, ivOK := raw["iv"].(string)
	_, tagOK := raw["tag"].(string)
	_, dataOK := raw["data"].(string)
	return ivOK && tagOK && dataOK
}

func decryptSecret(payload map[string]any, encryptionKey string) (string, error) {
	key, err := decodeSettingsKey(encryptionKey)
	if err != nil {
		return "", err
	}
	iv, err := decodeBase64(payload["iv"].(string))
	if err != nil {
		return "", err
	}
	tag, err := decodeBase64(payload["tag"].(string))
	if err != nil {
		return "", err
	}
	data, err := decodeBase64(payload["data"].(string))
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
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

func decodeSettingsKey(raw string) ([]byte, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil, errors.New("missing encryption key")
	}
	hexCandidate := trimmed
	if len(trimmed) > 2 && (trimmed[:2] == "0x" || trimmed[:2] == "0X") {
		hexCandidate = trimmed[2:]
	}
	if len(hexCandidate) == 64 && isHex(hexCandidate) {
		return hex.DecodeString(hexCandidate)
	}
	decoded, err := decodeBase64(trimmed)
	if err != nil || len(decoded) != 32 {
		return nil, errors.New("invalid encryption key")
	}
	return decoded, nil
}

func decodeBase64(value string) ([]byte, error) {
	decoded, err := base64.StdEncoding.DecodeString(value)
	if err == nil {
		return decoded, nil
	}
	return base64.RawStdEncoding.DecodeString(value)
}

func isHex(value string) bool {
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
