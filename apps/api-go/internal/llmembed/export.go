package llmembed

// This file exposes the settings-crypto primitives already used by the
// embedding/rerank profile resolver. The archive preparation worker and the news
// classifier need the same decryption semantics for gateway profile api keys and
// for the LiteLLM proxy managed runtime key; they must not grow a second
// implementation.

import (
	"encoding/json"
	"strings"
)

// encryptedSecretPayload is the stored envelope shape.
type encryptedSecretPayload struct {
	Enc  string `json:"__enc"`
	Alg  string `json:"alg"`
	IV   string `json:"iv"`
	Tag  string `json:"tag"`
	Data string `json:"data"`
}

// IsEncryptedSettingsSecret reports whether raw is a system-settings:v1
// AES-256-GCM envelope.
func IsEncryptedSettingsSecret(raw json.RawMessage) bool {
	var payload map[string]any
	if len(raw) == 0 || json.Unmarshal(raw, &payload) != nil {
		return false
	}
	return isEncryptedSecret(payload)
}

// DecryptSettingsSecret decrypts one system-settings:v1 envelope. ok is false
// when the value is not an envelope, the key is missing/invalid or the ciphertext
// does not authenticate.
func DecryptSettingsSecret(raw json.RawMessage, encryptionKey string) (string, bool) {
	var payload map[string]any
	if len(raw) == 0 || json.Unmarshal(raw, &payload) != nil {
		return "", false
	}
	if !isEncryptedSecret(payload) {
		return "", false
	}
	plain, err := decryptSecret(payload, encryptionKey)
	if err != nil {
		return "", false
	}
	return plain, true
}

// NormalizeGatewaySecret reproduces LiteLlmService's normalizeSecret: trim, drop
// an optional bearer prefix, and treat a bare "bearer" as empty.
func NormalizeGatewaySecret(raw string) string { return stripBearer(raw) }

// NormalizeGatewayAPIBase reproduces normalizeOpenAiApiBase: trim, strip a
// trailing known OpenAI path, then a trailing /v1 and any remaining slashes.
func NormalizeGatewayAPIBase(raw string) string {
	base := strings.TrimSpace(raw)
	if base == "" {
		return ""
	}
	base = strings.TrimRight(base, "/")
	lower := strings.ToLower(base)
	for _, suffix := range []string{
		"/v1/chat/completions", "/chat/completions",
		"/v1/embeddings", "/embeddings",
		"/v1/models", "/models",
		"/v1/responses", "/responses",
	} {
		if strings.HasSuffix(lower, suffix) {
			base = strings.TrimRight(base[:len(base)-len(suffix)], "/")
			break
		}
	}
	if strings.HasSuffix(strings.ToLower(base), "/v1") {
		base = base[:len(base)-3]
	}
	return strings.TrimRight(base, "/")
}
