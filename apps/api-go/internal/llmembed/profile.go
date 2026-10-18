package llmembed

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"math"
	"strings"
	"time"
)

const (
	gatewaySettingsKey    = "llm_gateway_profiles"
	governanceSettingsKey = "litellm_proxy_governance"
)

type storedProfile struct {
	ID              string
	Name            string
	APIBase         string
	APIKey          string
	Model           string
	EmbeddingModel  string
	RerankModel     string
	RerankFallbacks []string
	Timeout         time.Duration
	MaxRetries      int
	SendMetadata    bool
	Enabled         bool
}

type gatewaySettings struct {
	ActiveID          string
	EmbeddingActiveID string
	EmbeddingMode     string
	RerankActiveID    string
	RerankMode        string
	Profiles          []storedProfile
}

type runtimeProfile struct {
	storedProfile
	// GovernanceApplied reports whether applyGovernance replaced the profile
	// key with the managed runtime key for this call. It is observation-only:
	// no request behavior depends on it.
	GovernanceApplied bool
	// GovernanceTargetProfileID is the governance target profile id when the
	// key was swapped.
	GovernanceTargetProfileID string
	// AuthMode is the effective credential mode, "profile_key" or
	// "managed_runtime_key".
	AuthMode string
}

func (c *Client) resolveEmbedding(ctx context.Context) (runtimeProfile, error) {
	settings, err := c.loadGatewaySettings(ctx)
	if err != nil {
		return runtimeProfile{}, errEmbeddingUnavailable
	}
	selected := selectKind(settings, "embedding")
	if selected == nil || strings.TrimSpace(selected.EmbeddingModel) == "" {
		return runtimeProfile{}, errEmbeddingUnavailable
	}
	return c.applyGovernance(ctx, settings.Profiles, *selected)
}

func (c *Client) resolveRerank(ctx context.Context) (runtimeProfile, error) {
	settings, err := c.loadGatewaySettings(ctx)
	if err != nil {
		return runtimeProfile{}, errRerankUnavailable
	}
	selected := selectKind(settings, "rerank")
	if selected == nil || strings.TrimSpace(selected.RerankModel) == "" {
		return runtimeProfile{}, errRerankUnavailable
	}
	return c.applyGovernance(ctx, settings.Profiles, *selected)
}

func selectKind(settings gatewaySettings, kind string) *storedProfile {
	var resolvedID, mode string
	var modelOf func(storedProfile) string
	switch kind {
	case "embedding":
		resolvedID = settings.EmbeddingActiveID
		mode = settings.EmbeddingMode
		modelOf = func(profile storedProfile) string { return profile.EmbeddingModel }
	default:
		resolvedID = settings.RerankActiveID
		mode = settings.RerankMode
		modelOf = func(profile storedProfile) string { return profile.RerankModel }
	}
	if resolvedID == "" && mode != "use_default" {
		resolvedID = settings.ActiveID
	}
	if explicit := findProfile(settings.Profiles, resolvedID); explicit != nil && explicit.Enabled && strings.TrimSpace(modelOf(*explicit)) != "" {
		return explicit
	}
	if mode == "use_default" || resolvedID == "" {
		for i := range settings.Profiles {
			profile := &settings.Profiles[i]
			if profile.Enabled && strings.TrimSpace(modelOf(*profile)) != "" {
				return profile
			}
		}
	}
	return nil
}

func findProfile(profiles []storedProfile, id string) *storedProfile {
	if id == "" {
		return nil
	}
	for i := range profiles {
		if profiles[i].ID == id {
			return &profiles[i]
		}
	}
	return nil
}

func (c *Client) applyGovernance(ctx context.Context, profiles []storedProfile, profile storedProfile) (runtimeProfile, error) {
	runtime := runtimeProfile{storedProfile: profile, AuthMode: "profile_key"}
	runtime.APIBase = normalizeAPIBase(profile.APIBase)
	gov, err := c.loadGovernance(ctx)
	if err != nil {
		return runtimeProfile{}, errUpstream
	}
	if !gov.Enabled || gov.TargetID == "" {
		return runtime, nil
	}
	target := findProfile(profiles, gov.TargetID)
	if target == nil || !target.Enabled {
		return runtime, nil
	}
	candidateBase := normalizeAPIBase(profile.APIBase)
	targetBase := normalizeAPIBase(target.APIBase)
	if profile.ID != target.ID || candidateBase == "" || targetBase == "" || candidateBase != targetBase {
		return runtime, nil
	}
	if gov.KeyState == "unreadable" || strings.TrimSpace(gov.Key) == "" {
		return runtimeProfile{}, errUpstream
	}
	runtime.APIBase = targetBase
	runtime.APIKey = stripBearer(gov.Key)
	runtime.GovernanceApplied = true
	runtime.GovernanceTargetProfileID = gov.TargetID
	runtime.AuthMode = "managed_runtime_key"
	return runtime, nil
}

type governanceState struct {
	Enabled  bool
	TargetID string
	Key      string
	KeyState string
}

func (c *Client) loadGovernance(ctx context.Context) (governanceState, error) {
	raw, ok, err := c.loadSetting(ctx, governanceSettingsKey)
	if err != nil || !ok || len(raw) == 0 {
		return governanceState{KeyState: "missing"}, err
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return governanceState{KeyState: "missing"}, nil
	}
	state := governanceState{
		Enabled:  jsonBool(doc["enabled"], false),
		TargetID: jsonString(doc["targetProfileId"]),
	}
	state.Key, state.KeyState = resolveGovernanceSecret(doc["managedRuntimeKey"], gatewayEnv().EncryptionKey)
	return state, nil
}

func resolveGovernanceSecret(raw any, encryptionKey string) (string, string) {
	if raw == nil {
		return "", "missing"
	}
	switch value := raw.(type) {
	case string:
		trimmed := strings.TrimSpace(value)
		if trimmed == "" {
			return "", "missing"
		}
		return trimmed, "available"
	case map[string]any:
		if !isEncryptedSecret(value) {
			return "", "missing"
		}
		if strings.TrimSpace(encryptionKey) == "" {
			return "", "unreadable"
		}
		plain, err := decryptSecret(value, encryptionKey)
		if err != nil {
			return "", "unreadable"
		}
		plain = strings.TrimSpace(plain)
		if plain == "" {
			return "", "missing"
		}
		return plain, "available"
	default:
		return "", "missing"
	}
}

func (c *Client) loadGatewaySettings(ctx context.Context) (gatewaySettings, error) {
	raw, ok, err := c.loadSetting(ctx, gatewaySettingsKey)
	if err != nil {
		return gatewaySettings{}, err
	}
	if !ok || len(raw) == 0 {
		return gatewaySettings{EmbeddingMode: "follow_completion", RerankMode: "follow_completion"}, nil
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return gatewaySettings{EmbeddingMode: "follow_completion", RerankMode: "follow_completion"}, nil
	}
	return normalizeGatewaySettings(doc, gatewayEnv()), nil
}

func (c *Client) loadSetting(ctx context.Context, key string) ([]byte, bool, error) {
	if c == nil || c.db == nil {
		return nil, false, errUpstream
	}
	var raw []byte
	err := c.db.QueryRowContext(ctx, "SELECT value FROM SystemSetting WHERE `key` = ? LIMIT 1", key).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return raw, true, nil
}

func normalizeGatewaySettings(doc map[string]any, env gatewayDefaults) gatewaySettings {
	mode := "follow_completion"
	if jsonString(doc["embeddingMode"]) == "use_default" {
		mode = "use_default"
	}
	rerankMode := "follow_completion"
	if jsonString(doc["rerankMode"]) == "use_default" {
		rerankMode = "use_default"
	}
	rawProfiles, _ := doc["profiles"].([]any)
	profiles := make([]storedProfile, 0, len(rawProfiles))
	for _, entry := range rawProfiles {
		record, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		profile, ok := normalizeProfile(record, env)
		if ok {
			profiles = append(profiles, profile)
		}
	}
	settings := gatewaySettings{
		EmbeddingMode: mode,
		RerankMode:    rerankMode,
		Profiles:      profiles,
	}
	if active := findProfile(profiles, jsonString(doc["activeId"])); active != nil && active.Enabled {
		settings.ActiveID = active.ID
	}
	if embedding := findProfile(profiles, jsonString(doc["embeddingActiveId"])); embedding != nil && embedding.Enabled && embedding.EmbeddingModel != "" {
		settings.EmbeddingActiveID = embedding.ID
	}
	if rerank := findProfile(profiles, jsonString(doc["rerankActiveId"])); rerank != nil && rerank.Enabled && rerank.RerankModel != "" {
		settings.RerankActiveID = rerank.ID
	}
	return settings
}

func normalizeProfile(record map[string]any, env gatewayDefaults) (storedProfile, bool) {
	id := jsonString(record["id"])
	model := jsonString(record["model"])
	if id == "" || model == "" {
		return storedProfile{}, false
	}
	name := jsonString(record["name"])
	if name == "" {
		name = id
	}
	apiBase := jsonString(record["apiBase"])
	if apiBase == "" {
		apiBase = env.APIBase
	}
	return storedProfile{
		ID:              id,
		Name:            name,
		APIBase:         apiBase,
		APIKey:          resolveProfileKey(record["apiKey"], env.EncryptionKey),
		Model:           model,
		EmbeddingModel:  optionalString(record["embeddingModel"]),
		RerankModel:     optionalString(record["rerankModel"]),
		RerankFallbacks: stringList(record["rerankFallbackModels"]),
		Timeout:         time.Duration(positiveInt(record["timeoutMs"], env.TimeoutMs)) * time.Millisecond,
		MaxRetries:      positiveInt(record["maxRetries"], env.MaxRetries),
		SendMetadata:    jsonBool(record["sendMetadata"], true),
		Enabled:         jsonBool(record["enabled"], true),
	}, true
}

func resolveProfileKey(raw any, encryptionKey string) string {
	switch value := raw.(type) {
	case string:
		return stripBearer(value)
	case map[string]any:
		if !isEncryptedSecret(value) {
			return ""
		}
		if strings.TrimSpace(encryptionKey) == "" {
			return ""
		}
		plain, err := decryptSecret(value, encryptionKey)
		if err != nil {
			return ""
		}
		return stripBearer(plain)
	default:
		return ""
	}
}

func optionalString(value any) string {
	if value == nil {
		return ""
	}
	return jsonString(value)
}

func stringList(value any) []string {
	items, ok := value.([]any)
	if !ok {
		return nil
	}
	seen := map[string]struct{}{}
	out := make([]string, 0, len(items))
	for _, item := range items {
		text, ok := item.(string)
		if !ok {
			continue
		}
		text = strings.TrimSpace(text)
		if text == "" {
			continue
		}
		if _, exists := seen[text]; exists {
			continue
		}
		seen[text] = struct{}{}
		out = append(out, text)
	}
	return out
}

func positiveInt(value any, fallback int) int {
	number, ok := asFloat(value)
	if !ok || number <= 0 || math.IsNaN(number) || math.IsInf(number, 0) {
		return fallback
	}
	return int(math.Floor(number))
}

func asFloat(value any) (float64, bool) {
	switch typed := value.(type) {
	case float64:
		return typed, true
	case json.Number:
		parsed, err := typed.Float64()
		return parsed, err == nil
	case string:
		parsed, err := json.Number(strings.TrimSpace(typed)).Float64()
		return parsed, err == nil
	default:
		return 0, false
	}
}

func jsonString(value any) string {
	text, _ := value.(string)
	return strings.TrimSpace(text)
}

func jsonBool(value any, fallback bool) bool {
	typed, ok := value.(bool)
	if !ok {
		return fallback
	}
	return typed
}
