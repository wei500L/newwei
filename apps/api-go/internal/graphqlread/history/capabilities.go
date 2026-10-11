package history

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
)

const (
	profilesCacheKey     = "llm_gateway:profiles"
	profilesSettingKey   = "llm_gateway_profiles"
	governanceCacheKey   = "litellm_proxy_governance:settings"
	governanceSettingKey = "litellm_proxy_governance"
	defaultLiteLLMBase   = "http://localhost:4001"

	settingSQL = "SELECT value FROM SystemSetting WHERE `key` = ? LIMIT 1"
)

type gatewayProfile struct {
	id             string
	model          string
	assistantModel string
	webSearch      bool
	apiSurface     string
	apiBase        string
	enabled        bool
}

type gatewaySettings struct {
	activeID string
	profiles []gatewayProfile
}

func (s *service) runtimeCapabilities(ctx context.Context) (AssistantRuntimeCapabilitiesModel, error) {
	settings, err := s.loadProfiles(ctx)
	if err != nil {
		return AssistantRuntimeCapabilitiesModel{}, err
	}
	selected := selectCompletion(settings)
	if selected == nil {
		return AssistantRuntimeCapabilitiesModel{}, nil
	}
	profile := *selected
	if err := s.ensureGovernance(ctx, profile, settings.profiles); err != nil {
		return AssistantRuntimeCapabilitiesModel{}, err
	}
	return capabilitiesOf(profile), nil
}

func (s *service) loadProfiles(ctx context.Context) (gatewaySettings, error) {
	// Nest writes llm_gateway:profiles on a miss (EX 60) as the fully normalized
	// profile document, including apiKey. This path only reads that key. A
	// reduced document would replace the shared cache.
	if parsed, ok := s.readCache(ctx, profilesCacheKey); ok {
		return normalizeSettings(parsed), nil
	}
	value, found, err := s.settingValue(ctx, profilesSettingKey)
	if err != nil {
		return gatewaySettings{}, err
	}
	if !found || value == nil {
		return gatewaySettings{}, nil
	}
	return normalizeSettings(value), nil
}

func (s *service) ensureGovernance(ctx context.Context, selected gatewayProfile, profiles []gatewayProfile) error {
	stored, err := s.loadGovernance(ctx)
	if err != nil {
		return err
	}
	enabled, ok := stored["enabled"].(bool)
	if !ok || !enabled {
		return nil
	}
	target := findProfile(profiles, normalizeString(stored["targetProfileId"]))
	if target == nil || !target.enabled {
		return nil
	}
	if selected.id != target.id {
		return nil
	}
	candidate := normalizeOpenAIBase(selected.resolvedAPIBase())
	governed := normalizeOpenAIBase(target.resolvedAPIBase())
	if candidate == "" || governed == "" || candidate != governed {
		return nil
	}
	switch managedKeyState(stored["managedRuntimeKey"]) {
	case "unreadable":
		return &contract.Failure{
			Message: "LiteLLM governance is enabled but the managed runtime key is unreadable",
			Status:  503,
		}
	case "missing":
		return &contract.Failure{
			Message: "LiteLLM governance is enabled but the managed runtime key is missing",
			Status:  503,
		}
	default:
		return nil
	}
}

func (s *service) loadGovernance(ctx context.Context) (map[string]any, error) {
	if parsed, ok := s.readCache(ctx, governanceCacheKey); ok {
		return governanceValue(parsed), nil
	}
	value, found, err := s.settingValue(ctx, governanceSettingKey)
	if err != nil || !found || value == nil {
		return nil, err
	}
	record, _ := value.(map[string]any)
	return record, nil
}

func (s *service) readCache(ctx context.Context, key string) (any, bool) {
	if s == nil || s.redis == nil {
		return nil, false
	}
	raw, err := s.redis.Get(ctx, key).Result()
	if err != nil || raw == "" {
		return nil, false
	}
	parsed, ok := parseJSONValue([]byte(raw))
	if !ok || !jsTruthy(parsed) {
		return nil, false
	}
	return parsed, true
}

func (s *service) settingValue(ctx context.Context, key string) (any, bool, error) {
	if s == nil || s.db == nil {
		return nil, false, errDatabaseUnavailable
	}
	var raw []byte
	err := s.db.QueryRowContext(ctx, settingSQL, key).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	if len(raw) == 0 {
		return nil, true, nil
	}
	value, ok := parseJSONValue(raw)
	if !ok {
		return nil, false, errors.New("system setting " + key + " is not valid JSON")
	}
	return value, true, nil
}

func governanceValue(parsed any) map[string]any {
	record, ok := parsed.(map[string]any)
	if !ok {
		return nil
	}
	exists, _ := record["exists"].(bool)
	if !exists {
		return nil
	}
	value, _ := record["value"].(map[string]any)
	return value
}

func normalizeSettings(raw any) gatewaySettings {
	record, ok := raw.(map[string]any)
	if !ok || record == nil {
		return gatewaySettings{}
	}
	entries, _ := record["profiles"].([]any)
	profiles := make([]gatewayProfile, 0, len(entries))
	for _, entry := range entries {
		item, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		profile, ok := normalizeProfile(item)
		if !ok {
			continue
		}
		profiles = append(profiles, profile)
	}
	activeID := normalizeString(record["activeId"])
	if profile := findProfile(profiles, activeID); profile == nil || !profile.enabled {
		activeID = ""
	}
	return gatewaySettings{activeID: activeID, profiles: profiles}
}

func normalizeProfile(record map[string]any) (gatewayProfile, bool) {
	id := normalizeString(record["id"])
	model := normalizeString(record["model"])
	if id == "" || model == "" {
		return gatewayProfile{}, false
	}
	surface := "chat_completions"
	if record["apiSurface"] == "responses" || record["apiSurface"] == "chat_completions" {
		surface, _ = record["apiSurface"].(string)
	}
	web, _ := record["assistantWebSearchEnabled"].(bool)
	return gatewayProfile{
		id:             id,
		model:          model,
		assistantModel: normalizeString(record["assistantModel"]),
		webSearch:      web,
		apiSurface:     surface,
		apiBase:        normalizeString(record["apiBase"]),
		enabled:        flagEnabled(record),
	}, true
}

func flagEnabled(record map[string]any) bool {
	value, present := record["enabled"]
	if !present || value == nil {
		return true
	}
	return jsTruthy(value)
}

func normalizeString(value any) string {
	text, ok := value.(string)
	if !ok {
		return ""
	}
	return strings.TrimSpace(text)
}

func selectCompletion(settings gatewaySettings) *gatewayProfile {
	if active := findProfile(settings.profiles, settings.activeID); active != nil && active.enabled {
		return active
	}
	for i := range settings.profiles {
		if settings.profiles[i].enabled {
			return &settings.profiles[i]
		}
	}
	return nil
}

func findProfile(profiles []gatewayProfile, id string) *gatewayProfile {
	if id == "" {
		return nil
	}
	for i := range profiles {
		if profiles[i].id == id {
			return &profiles[i]
		}
	}
	return nil
}

func (p gatewayProfile) resolvedAPIBase() string {
	if base := strings.TrimSpace(p.apiBase); base != "" {
		return base
	}
	if base := strings.TrimSpace(os.Getenv("LITELLM_API_BASE")); base != "" {
		return base
	}
	return defaultLiteLLMBase
}

func capabilitiesOf(profile gatewayProfile) AssistantRuntimeCapabilitiesModel {
	model := strings.TrimSpace(profile.assistantModel)
	if model == "" {
		model = strings.TrimSpace(profile.model)
	}
	var surface *string
	if profile.apiSurface == "responses" || profile.apiSurface == "chat_completions" {
		surface = stringPtr(profile.apiSurface)
	}
	web := surface != nil && *surface == "responses" && profile.webSearch
	return AssistantRuntimeCapabilitiesModel{
		APISurface:         surface,
		AssistantModel:     nonemptyPtr(model),
		WebSearchSupported: web,
	}
}

var openAIPathSuffixes = []string{
	"/v1/chat/completions",
	"/chat/completions",
	"/v1/embeddings",
	"/embeddings",
	"/v1/models",
	"/models",
	"/v1/responses",
	"/responses",
}

func normalizeOpenAIBase(raw string) string {
	base := strings.TrimSpace(raw)
	if base == "" {
		return ""
	}
	base = strings.TrimRight(base, "/")
	lower := strings.ToLower(base)
	for _, suffix := range openAIPathSuffixes {
		if strings.HasSuffix(lower, suffix) {
			base = strings.TrimRight(base[:len(base)-len(suffix)], "/")
			break
		}
	}
	if strings.HasSuffix(strings.ToLower(base), "/v1") {
		base = strings.TrimRight(base[:len(base)-len("/v1")], "/")
	}
	return strings.TrimRight(base, "/")
}

func parseJSONValue(raw []byte) (any, bool) {
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, false
	}
	return value, true
}
