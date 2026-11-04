package llmembed

import (
	"errors"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/settingscrypto"
)

func decryptSecret(payload map[string]any, encryptionKey string) (string, error) {
	if payload["__enc"] != settingscrypto.EnvelopeTag || payload["alg"] != settingscrypto.Algorithm {
		return "", errors.New("not an encrypted setting")
	}
	iv := jsonString(payload["iv"])
	tag := jsonString(payload["tag"])
	data := jsonString(payload["data"])
	key, err := settingscrypto.ParseKey(encryptionKey)
	if err != nil {
		return "", err
	}
	plain, err := settingscrypto.Decrypt(settingscrypto.Envelope{
		Enc:  settingscrypto.EnvelopeTag,
		Alg:  settingscrypto.Algorithm,
		IV:   &iv,
		Tag:  &tag,
		Data: &data,
	}, key)
	if err != nil {
		return "", err
	}
	return plain, nil
}

func isEncryptedSecret(raw any) bool {
	payload, ok := raw.(map[string]any)
	if !ok {
		return false
	}
	return payload["__enc"] == settingscrypto.EnvelopeTag && payload["alg"] == settingscrypto.Algorithm
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
