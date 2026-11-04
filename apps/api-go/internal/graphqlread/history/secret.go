package history

import (
	"os"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/settingscrypto"
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
	if raw["__enc"] != settingscrypto.EnvelopeTag || raw["alg"] != settingscrypto.Algorithm {
		return false
	}
	_, ivOK := raw["iv"].(string)
	_, tagOK := raw["tag"].(string)
	_, dataOK := raw["data"].(string)
	return ivOK && tagOK && dataOK
}

func decryptSecret(payload map[string]any, encryptionKey string) (string, error) {
	iv := payload["iv"].(string)
	tag := payload["tag"].(string)
	data := payload["data"].(string)
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
