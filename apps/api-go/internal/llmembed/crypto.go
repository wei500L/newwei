package llmembed

import (
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"strings"
)

func decryptSecret(payload map[string]any, encryptionKey string) (string, error) {
	if payload["__enc"] != "system-settings:v1" || payload["alg"] != "aes-256-gcm" {
		return "", errors.New("not an encrypted setting")
	}
	key, err := decodeSettingsKey(encryptionKey)
	if err != nil {
		return "", err
	}
	iv, err := base64.StdEncoding.DecodeString(jsonString(payload["iv"]))
	if err != nil {
		return "", err
	}
	tag, err := base64.StdEncoding.DecodeString(jsonString(payload["tag"]))
	if err != nil {
		return "", err
	}
	data, err := base64.StdEncoding.DecodeString(jsonString(payload["data"]))
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
	plain, err := gcm.Open(nil, iv, append(data, tag...), nil)
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
	hexCandidate := strings.TrimPrefix(strings.TrimPrefix(trimmed, "0x"), "0X")
	if len(hexCandidate) == 64 && isHex(hexCandidate) {
		return hex.DecodeString(hexCandidate)
	}
	decoded, err := base64.StdEncoding.DecodeString(trimmed)
	if err != nil || len(decoded) != 32 {
		return nil, errors.New("invalid encryption key")
	}
	return decoded, nil
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

func isEncryptedSecret(raw any) bool {
	payload, ok := raw.(map[string]any)
	if !ok {
		return false
	}
	return payload["__enc"] == "system-settings:v1" && payload["alg"] == "aes-256-gcm"
}

func stripBearer(value string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" || strings.EqualFold(trimmed, "bearer") {
		return ""
	}
	if len(trimmed) >= 7 && strings.EqualFold(trimmed[:7], "bearer ") {
		trimmed = strings.TrimSpace(trimmed[7:])
	}
	return trimmed
}
