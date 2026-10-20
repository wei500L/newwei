package crawlfrontierllm

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"strings"
	"time"
)

// llm_profile.go resolves the active LiteLLM gateway profile the same way
// LiteLlmService.prepareRequest does: the llm_gateway_profiles SystemSetting
// row, the completion/rerank selection rules and the managed proxy governance
// key swap. The derivation is copied from the existing publicportal/gateway.go
// helpers (they are package-private), so both Go paths resolve identical
// profiles.

// LLMGatewayEnv is the LITELLM_* environment Nest merges under a stored
// profile.
type LLMGatewayEnv struct {
	APIBase       string
	APIKey        string
	EncryptionKey string
	TimeoutMs     int
	MaxRetries    int
}

// gatewayProfile is the effective completion/rerank profile.
type gatewayProfile struct {
	ID                        string
	APIBase                   string
	APIKey                    string
	Model                     string
	FallbackModels            []string
	RerankModel               string
	RerankFallbacks           []string
	Timeout                   time.Duration
	MaxRetries                int
	SendMetadata              bool
	ResponseFormatMode        string
	APISurface                string
	TopP                      float64
	GovernanceApplied         bool
	GovernanceAuthMode        string
	GovernanceTargetProfileID string
}

func (p gatewayProfile) authMode() string {
	if p.GovernanceApplied {
		return "managed_runtime_key"
	}
	if p.GovernanceAuthMode != "" {
		return p.GovernanceAuthMode
	}
	return "profile_key"
}

// gatewaySettingsReader reads the two SystemSetting rows the gateway uses.
type gatewaySettingsReader struct {
	db *sql.DB
}

func (r gatewaySettingsReader) settings(ctx context.Context) (profiles, governance []byte, err error) {
	read := func(key string) ([]byte, error) {
		var raw []byte
		err := r.db.QueryRowContext(ctx, "SELECT value FROM SystemSetting WHERE `key` = ? LIMIT 1", key).Scan(&raw)
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return raw, err
	}
	profiles, err = read("llm_gateway_profiles")
	if err != nil {
		return nil, nil, err
	}
	governance, err = read("litellm_proxy_governance")
	if err != nil {
		return nil, nil, err
	}
	return profiles, governance, nil
}

// resolveGatewayProfile selects the completion or rerank profile.
func resolveGatewayProfile(ctx context.Context, db *sql.DB, env LLMGatewayEnv, kind string) (gatewayProfile, error) {
	profilesJSON, governanceJSON, err := gatewaySettingsReader{db: db}.settings(ctx)
	if err != nil {
		return gatewayProfile{}, err
	}
	if env.APIBase == "" {
		env.APIBase = "http://localhost:4001"
	}
	if env.TimeoutMs <= 0 {
		env.TimeoutMs = 60_000
	}
	if env.MaxRetries <= 0 {
		env.MaxRetries = 3
	}
	var settings struct {
		ActiveID       string            `json:"activeId"`
		RerankActiveID string            `json:"rerankActiveId"`
		RerankMode     string            `json:"rerankMode"`
		Profiles       []json.RawMessage `json:"profiles"`
	}
	if len(profilesJSON) > 0 {
		if err := json.Unmarshal(profilesJSON, &settings); err != nil {
			return gatewayProfile{}, errors.New("model gateway settings are invalid")
		}
	}
	profiles := make([]gatewayProfile, 0, len(settings.Profiles))
	for _, raw := range settings.Profiles {
		profile, ok := normalizeGatewayProfile(raw, env)
		if ok {
			profiles = append(profiles, profile)
		}
	}
	var selected *gatewayProfile
	if kind == "rerank" {
		resolvedID := strings.TrimSpace(settings.RerankActiveID)
		if resolvedID == "" && settings.RerankMode != "use_default" {
			resolvedID = strings.TrimSpace(settings.ActiveID)
		}
		if resolvedID != "" {
			for index := range profiles {
				if profiles[index].ID == resolvedID && profiles[index].RerankModel != "" {
					selected = &profiles[index]
					break
				}
			}
		}
		if selected == nil && (settings.RerankMode == "use_default" || resolvedID == "") {
			for index := range profiles {
				if profiles[index].RerankModel != "" {
					selected = &profiles[index]
					break
				}
			}
		}
		if selected == nil {
			return gatewayProfile{}, errors.New("rerank model is not configured")
		}
	} else {
		activeID := strings.TrimSpace(settings.ActiveID)
		if activeID != "" {
			for index := range profiles {
				if profiles[index].ID == activeID && profiles[index].Model != "" {
					selected = &profiles[index]
					break
				}
			}
		}
		if selected == nil {
			for index := range profiles {
				if profiles[index].Model != "" {
					selected = &profiles[index]
					break
				}
			}
		}
		if selected == nil {
			return gatewayProfile{}, errors.New("completion model is not configured")
		}
	}
	if err := applyGatewayGovernance(selected, profiles, governanceJSON, env.EncryptionKey); err != nil {
		return gatewayProfile{}, err
	}
	selected.APIBase = normalizeAPIBase(selected.APIBase)
	selected.APIKey = stripBearer(selected.APIKey)
	return *selected, nil
}

func normalizeGatewayProfile(raw []byte, env LLMGatewayEnv) (gatewayProfile, bool) {
	var record map[string]any
	if err := json.Unmarshal(raw, &record); err != nil {
		return gatewayProfile{}, false
	}
	id := jsonString(record["id"])
	model := jsonString(record["model"])
	if id == "" {
		return gatewayProfile{}, false
	}
	switch value := record["enabled"].(type) {
	case nil:
	case bool:
		if !value {
			return gatewayProfile{}, false
		}
	default:
		return gatewayProfile{}, false
	}
	apiBase := jsonString(record["apiBase"])
	if apiBase == "" {
		apiBase = env.APIBase
	}
	profile := gatewayProfile{
		ID:                 id,
		APIBase:            apiBase,
		APIKey:             profileAPIKey(record["apiKey"], env.EncryptionKey),
		Model:              model,
		FallbackModels:     jsonStringList(mustJSONBytes(record["fallbackModels"])),
		RerankModel:        jsonString(record["rerankModel"]),
		RerankFallbacks:    jsonStringList(mustJSONBytes(record["rerankFallbackModels"])),
		Timeout:            time.Duration(positiveIntValue(record["timeoutMs"], env.TimeoutMs)) * time.Millisecond,
		MaxRetries:         positiveIntValue(record["maxRetries"], env.MaxRetries),
		SendMetadata:       jsonBool(record["sendMetadata"], true),
		ResponseFormatMode: jsonString(record["responseFormatMode"]),
		APISurface:         jsonString(record["apiSurface"]),
		TopP:               0.9,
	}
	if stored, ok := record["topP"]; ok {
		if number, ok := finiteNumber(stored); ok {
			profile.TopP = math.Max(0, math.Min(1, number))
		}
	}
	if profile.ResponseFormatMode == "" {
		profile.ResponseFormatMode = "json_schema"
	}
	if profile.APISurface == "" {
		profile.APISurface = "chat_completions"
	}
	return profile, true
}

func applyGatewayGovernance(selected *gatewayProfile, profiles []gatewayProfile, raw []byte, encryptionKey string) error {
	if len(raw) == 0 || selected == nil {
		return nil
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil
	}
	if !jsonBool(doc["enabled"], false) {
		return nil
	}
	targetID := jsonString(doc["targetProfileId"])
	if targetID == "" {
		return nil
	}
	var target *gatewayProfile
	for index := range profiles {
		if profiles[index].ID == targetID {
			target = &profiles[index]
			break
		}
	}
	if target == nil {
		return nil
	}
	if selected.ID != target.ID || normalizeAPIBase(selected.APIBase) != normalizeAPIBase(target.APIBase) {
		return nil
	}
	state, key := governanceSecret(doc["managedRuntimeKey"], encryptionKey)
	if state == "unreadable" {
		return &NestError{Status: http.StatusServiceUnavailable, Message: "LiteLLM governance is enabled but the managed runtime key is unreadable"}
	}
	if key == "" {
		return &NestError{Status: http.StatusServiceUnavailable, Message: "LiteLLM governance is enabled but the managed runtime key is missing"}
	}
	selected.APIBase = target.APIBase
	selected.APIKey = strings.TrimSpace(key)
	selected.GovernanceApplied = true
	selected.GovernanceAuthMode = "managed_runtime_key"
	selected.GovernanceTargetProfileID = target.ID
	return nil
}

func governanceSecret(raw any, encryptionKey string) (string, string) {
	if raw == nil {
		return "missing", ""
	}
	switch value := raw.(type) {
	case string:
		trimmed := strings.TrimSpace(value)
		if trimmed == "" {
			return "missing", ""
		}
		return "available", trimmed
	case map[string]any:
		if value["__enc"] != "system-settings:v1" {
			return "missing", ""
		}
		plain, err := decryptSecret(value, encryptionKey)
		if err != nil {
			return "unreadable", ""
		}
		plain = strings.TrimSpace(plain)
		if plain == "" {
			return "missing", ""
		}
		return "available", plain
	default:
		return "missing", ""
	}
}

func profileAPIKey(raw any, encryptionKey string) string {
	switch value := raw.(type) {
	case string:
		return stripBearer(value)
	case map[string]any:
		plain, err := decryptSecret(value, encryptionKey)
		if err != nil {
			return ""
		}
		return stripBearer(plain)
	default:
		return ""
	}
}

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
	if len(hexCandidate) == 64 && isHexString(hexCandidate) {
		return hex.DecodeString(hexCandidate)
	}
	decoded, err := base64.StdEncoding.DecodeString(trimmed)
	if err != nil || len(decoded) != 32 {
		return nil, errors.New("invalid encryption key")
	}
	return decoded, nil
}

func isHexString(value string) bool {
	for _, char := range value {
		switch {
		case char >= '0' && char <= '9':
		case char >= 'a' && char <= 'f':
		case char >= 'A' && char <= 'F':
		default:
			return false
		}
	}
	return true
}

func stripBearer(value string) string {
	trimmed := strings.TrimSpace(value)
	if len(trimmed) >= 7 && strings.EqualFold(trimmed[:7], "bearer ") {
		trimmed = strings.TrimSpace(trimmed[7:])
	}
	return trimmed
}

func normalizeAPIBase(raw string) string {
	base := strings.TrimRight(strings.TrimSpace(raw), "/")
	lower := strings.ToLower(base)
	for _, suffix := range []string{
		"/v1/chat/completions", "/chat/completions", "/v1/embeddings", "/embeddings",
		"/v1/models", "/models", "/v1/responses", "/responses",
	} {
		if strings.HasSuffix(lower, suffix) {
			base = strings.TrimRight(base[:len(base)-len(suffix)], "/")
			lower = strings.ToLower(base)
			break
		}
	}
	if strings.HasSuffix(strings.ToLower(base), "/v1") {
		base = strings.TrimRight(base[:len(base)-len("/v1")], "/")
	}
	return base
}

func uniqueModels(models []string) []string {
	seen := map[string]struct{}{}
	out := make([]string, 0, len(models))
	for _, model := range models {
		model = strings.TrimSpace(model)
		if model == "" {
			continue
		}
		if _, ok := seen[model]; ok {
			continue
		}
		seen[model] = struct{}{}
		out = append(out, model)
	}
	return out
}

func jsonString(value any) string {
	text, _ := value.(string)
	return strings.TrimSpace(text)
}

func jsonBool(value any, fallback bool) bool {
	flag, ok := value.(bool)
	if !ok {
		return fallback
	}
	return flag
}

func finiteNumber(value any) (float64, bool) {
	number, ok := value.(float64)
	if !ok || math.IsNaN(number) || math.IsInf(number, 0) {
		return 0, false
	}
	return number, true
}

func positiveIntValue(value any, fallback int) int {
	number, ok := finiteNumber(value)
	if !ok || number != math.Trunc(number) || number <= 0 {
		return fallback
	}
	return int(number)
}

func mustJSONBytes(value any) []byte {
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil
	}
	return encoded
}

func jsonStringList(raw []byte) []string {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	var values []string
	if err := json.Unmarshal(raw, &values); err != nil {
		return nil
	}
	return values
}
