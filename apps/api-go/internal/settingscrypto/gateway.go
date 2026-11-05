package settingscrypto

import (
	"encoding/json"
	"strings"
)

// This file holds the gateway-secret normalisation helpers that every LiteLLM
// profile reader needs. They previously lived in llmembed/export.go as a public
// surface only litellmcompat consumed; keeping them here lets every gateway
// client share one implementation without importing the embedding package.
//
// The semantics are fixed by the NestJS LiteLlmService helpers they port:
// IsEncryptedSettingsSecret only inspects the __enc/alg markers (a malformed
// envelope is reported as encrypted and then fails DecryptSettingsSecret),
// NormalizeGatewaySecret trims and drops one bearer prefix, and
// NormalizeGatewayAPIBase strips the known endpoint suffix and a trailing /v1.

// IsEncryptedSettingsSecret reports whether raw carries the system-settings:v1
// __enc marker and the aes-256-gcm alg. It deliberately does not require the
// iv/tag/data members: a value with the markers but missing payload is still
// treated as an encrypted secret and fails closed in DecryptSettingsSecret.
func IsEncryptedSettingsSecret(raw json.RawMessage) bool {
	var payload map[string]any
	if len(raw) == 0 || json.Unmarshal(raw, &payload) != nil {
		return false
	}
	return payload["__enc"] == EnvelopeTag && payload["alg"] == Algorithm
}

// DecryptSettingsSecret decrypts one system-settings:v1 envelope. ok is false
// when the value is not an envelope, the key is missing/invalid or the
// ciphertext does not authenticate.
func DecryptSettingsSecret(raw json.RawMessage, encryptionKey string) (string, bool) {
	var payload map[string]any
	if len(raw) == 0 || json.Unmarshal(raw, &payload) != nil {
		return "", false
	}
	if payload["__enc"] != EnvelopeTag || payload["alg"] != Algorithm {
		return "", false
	}
	plain, err := decryptSecretMap(payload, encryptionKey)
	if err != nil {
		return "", false
	}
	return plain, true
}

// decryptSecretMap decrypts one already-decoded envelope map. Missing iv/tag/data
// members decode to empty strings and are rejected by the length check in
// Decrypt, preserving the previous fail-closed behaviour.
func decryptSecretMap(payload map[string]any, encryptionKey string) (string, error) {
	iv, _ := payload["iv"].(string)
	tag, _ := payload["tag"].(string)
	data, _ := payload["data"].(string)
	key, err := ParseKey(encryptionKey)
	if err != nil {
		return "", err
	}
	return Decrypt(Envelope{
		Enc:  EnvelopeTag,
		Alg:  Algorithm,
		IV:   &iv,
		Tag:  &tag,
		Data: &data,
	}, key)
}

// NormalizeGatewaySecret reproduces LiteLlmService's normalizeSecret: trim, drop
// an optional bearer prefix, and treat a bare "bearer" as empty.
func NormalizeGatewaySecret(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" || strings.EqualFold(trimmed, "bearer") {
		return ""
	}
	if len(trimmed) >= 7 && strings.EqualFold(trimmed[:7], "bearer ") {
		trimmed = strings.TrimSpace(trimmed[7:])
	}
	return trimmed
}

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
