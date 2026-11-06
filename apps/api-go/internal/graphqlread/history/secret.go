package history

import (
	"encoding/json"
	"os"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/settingscrypto"
)

// managedKeyState reports the availability of the managed runtime key of the
// litellm_proxy_governance document. It delegates envelope detection and
// decryption to settingscrypto so this read-only capability view shares the one
// settings-secret implementation.
func managedKeyState(raw any) string {
	switch typed := raw.(type) {
	case string:
		if strings.TrimSpace(typed) == "" {
			return "missing"
		}
		return "available"
	case map[string]any:
		encoded, err := json.Marshal(typed)
		if err != nil || !settingscrypto.IsEnvelope(encoded) {
			return "missing"
		}
		plain, ok := settingscrypto.DecryptSettingsSecret(encoded, os.Getenv("SYSTEM_SETTINGS_ENCRYPTION_KEY"))
		if !ok {
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
