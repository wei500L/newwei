package itemsreading

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"strings"
)

// System setting keys and cache keys shared with NestJS.
const (
	situationMonitorSettingsKey      = "situation_monitor_settings"
	situationMonitorSettingsCacheKey = "situation_monitor:settings"
	situationMonitorSettingsTTL      = 30

	llmGatewayProfilesKey      = "llm_gateway_profiles"
	llmGatewayProfilesCacheKey = "llm_gateway:profiles"
	llmGatewayProfilesTTL      = 60

	defaultDeepLxBaseURL = "https://api.deeplx.org"
)

// Exact provider status messages, copied verbatim from
// apps/api/src/modules/items/items-rss-translation.service.ts.
const (
	messageDeepLxLanguageUnsupported = "DeepLX API translation currently supports Chinese (zh-CN) target language only."
	messageDeepLxFallbackInUse       = "DeepLX primary endpoint is unavailable; fallback translation API is configured and will be used."
	messageDeepLxDisabled            = "DeepLX translation API is disabled in Situation Monitor settings."
	messageDeepLxBaseURLMissing      = "DeepLX translation API base URL is not configured."
	messageDeepLxKeyMissing          = "DeepLX translation API key is not configured."
	messageFallbackDisabled          = "Fallback translation API is disabled in Situation Monitor settings."
	messageFallbackBaseURLMissing    = "Fallback translation API base URL is not configured."
	messageNoTranslationProvider     = "DeepLX or fallback translation API is not available in Situation Monitor settings."
	messageNoActiveLlmProfile        = "No enabled LLM gateway profile is active."
)

// situationMonitorSettingsCache is the cached `{exists,value}` wrapper.
type situationMonitorSettingsCache struct {
	Exists bool      `json:"exists"`
	Value  *OpenJSON `json:"value,omitempty"`
}

// situationMonitorStored is the typed view of the situation_monitor_settings
// SystemSetting value. Only the translation fields the status query reads are
// modelled.
type situationMonitorStored struct {
	TranslationAPIEnabled      *bool     `json:"translationApiEnabled"`
	TranslationAPIBaseURL      *string   `json:"translationApiBaseUrl"`
	TranslationAPIKey          *OpenJSON `json:"translationApiKey"`
	TranslationFallbackEnabled *bool     `json:"translationFallbackApiEnabled"`
	TranslationFallbackBaseURL *string   `json:"translationFallbackApiBaseUrl"`
}

// llmGatewayProfile is the typed view of one stored LLM gateway profile.
type llmGatewayProfile struct {
	ID      *string `json:"id"`
	Model   *string `json:"model"`
	Enabled *bool   `json:"enabled"`
}

// llmGatewaySettings is the typed view of the llm_gateway_profiles value.
type llmGatewaySettings struct {
	ActiveID *string             `json:"activeId"`
	Profiles []llmGatewayProfile `json:"profiles"`
}

// translationRuntimeConfig is the resolved DeepLX runtime configuration.
type translationRuntimeConfig struct {
	Enabled         bool
	BaseURL         string
	APIKey          string
	FallbackEnabled bool
	FallbackBaseURL string
}

// ReadJSONSystemSetting reads one SystemSetting JSON value. The second result
// reports whether the row exists; a database failure is returned as an error so
// the GraphQL field fails exactly like NestJS.
func (s *mySQLStore) ReadJSONSystemSetting(ctx context.Context, key string) (OpenJSON, bool, error) {
	if s == nil || s.db == nil {
		return OpenJSON{}, false, errors.New("mysql is not configured")
	}
	var raw []byte
	err := s.db.QueryRowContext(ctx, "SELECT `value` FROM `SystemSetting` WHERE `key` = ? LIMIT 1", key).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return OpenJSON{}, false, nil
	}
	if err != nil {
		return OpenJSON{}, false, err
	}
	return NewOpenJSON(raw), true, nil
}

// RssTranslationStatus ports ItemsRssTranslationService.getProviderStatuses.
// The element order is always deeplx then llm. The computation only reports
// configuration availability: it never translates and never probes connectivity.
func (s *Service) RssTranslationStatus(
	ctx context.Context,
	targetLanguage *string,
) ([]RssTranslationProviderStatus, error) {
	normalizedTarget := DefaultTargetLanguage
	if targetLanguage != nil {
		if trimmed := strings.TrimSpace(*targetLanguage); trimmed != "" {
			normalizedTarget = trimmed
		}
	}
	deeplx, err := s.deepLxStatus(ctx, normalizedTarget)
	if err != nil {
		return nil, err
	}
	llm, err := s.llmStatus(ctx)
	if err != nil {
		return nil, err
	}
	return []RssTranslationProviderStatus{deeplx, llm}, nil
}

// deepLxStatus ports getDeepLxStatus.
func (s *Service) deepLxStatus(ctx context.Context, targetLanguage string) (RssTranslationProviderStatus, error) {
	if !isChineseTargetLanguage(targetLanguage) {
		message := messageDeepLxLanguageUnsupported
		return RssTranslationProviderStatus{
			Provider:                RssTranslationProviderDeepLx,
			Available:               false,
			Message:                 &message,
			TargetLanguageSupported: false,
		}, nil
	}
	runtime, err := s.translationRuntimeConfig(ctx)
	if err != nil {
		return RssTranslationProviderStatus{}, err
	}
	deepLxReady := runtime.Enabled && strings.TrimSpace(runtime.BaseURL) != "" && strings.TrimSpace(runtime.APIKey) != ""
	fallbackReady := runtime.FallbackEnabled && strings.TrimSpace(runtime.FallbackBaseURL) != ""
	switch {
	case deepLxReady:
		return RssTranslationProviderStatus{
			Provider:                RssTranslationProviderDeepLx,
			Available:               true,
			TargetLanguageSupported: true,
		}, nil
	case fallbackReady:
		message := messageDeepLxFallbackInUse
		return RssTranslationProviderStatus{
			Provider:                RssTranslationProviderDeepLx,
			Available:               true,
			Message:                 &message,
			TargetLanguageSupported: true,
		}, nil
	default:
		reasons := make([]string, 0, 2)
		if reason := deepLxConfigError(runtime); reason != "" {
			reasons = append(reasons, reason)
		}
		if reason := fallbackConfigError(runtime); reason != "" {
			reasons = append(reasons, reason)
		}
		message := strings.Join(reasons, " ")
		if message == "" {
			message = messageNoTranslationProvider
		}
		return RssTranslationProviderStatus{
			Provider:                RssTranslationProviderDeepLx,
			Available:               false,
			Message:                 &message,
			TargetLanguageSupported: true,
		}, nil
	}
}

// isChineseTargetLanguage ports isChineseTargetLanguage.
func isChineseTargetLanguage(value string) bool {
	normalized := strings.ToLower(strings.TrimSpace(value))
	return normalized == "zh" || normalized == "zh-cn" || strings.HasPrefix(normalized, "zh-")
}

// deepLxConfigError ports buildDeepLxConfigError.
func deepLxConfigError(runtime translationRuntimeConfig) string {
	if !runtime.Enabled {
		return messageDeepLxDisabled
	}
	if strings.TrimSpace(runtime.BaseURL) == "" {
		return messageDeepLxBaseURLMissing
	}
	if strings.TrimSpace(runtime.APIKey) == "" {
		return messageDeepLxKeyMissing
	}
	return ""
}

// fallbackConfigError ports buildFallbackConfigError.
func fallbackConfigError(runtime translationRuntimeConfig) string {
	if !runtime.FallbackEnabled {
		return messageFallbackDisabled
	}
	if strings.TrimSpace(runtime.FallbackBaseURL) == "" {
		return messageFallbackBaseURLMissing
	}
	return ""
}

// llmStatus ports getLlmStatus. Availability means "an enabled completion
// profile exists"; embedding/rerank profiles are deliberately ignored and no
// connectivity is probed.
func (s *Service) llmStatus(ctx context.Context) (RssTranslationProviderStatus, error) {
	settings, err := s.loadLLMGatewaySettings(ctx)
	if err != nil {
		return RssTranslationProviderStatus{}, err
	}
	activeID := ""
	if settings.ActiveID != nil {
		activeID = strings.TrimSpace(*settings.ActiveID)
	}
	var selected *llmGatewayProfile
	if activeID != "" {
		for index := range settings.Profiles {
			profile := settings.Profiles[index]
			if profile.ID != nil && strings.TrimSpace(*profile.ID) == activeID && profileEnabled(profile) {
				selected = &settings.Profiles[index]
				break
			}
		}
	} else {
		for index := range settings.Profiles {
			if profileEnabled(settings.Profiles[index]) {
				selected = &settings.Profiles[index]
				break
			}
		}
	}
	if selected == nil {
		message := messageNoActiveLlmProfile
		return RssTranslationProviderStatus{
			Provider:                RssTranslationProviderLlm,
			Available:               false,
			Message:                 &message,
			TargetLanguageSupported: true,
		}, nil
	}
	return RssTranslationProviderStatus{
		Provider:                RssTranslationProviderLlm,
		Available:               true,
		TargetLanguageSupported: true,
	}, nil
}

// profileEnabled implements the JavaScript `enabled ?? true` truthiness rule.
func profileEnabled(profile llmGatewayProfile) bool {
	if profile.Enabled == nil {
		return true
	}
	return *profile.Enabled
}

// translationRuntimeConfig loads the stored settings and applies the
// stored -> env -> default precedence exactly like resolveEffectiveConfig.
func (s *Service) translationRuntimeConfig(ctx context.Context) (translationRuntimeConfig, error) {
	stored, err := s.loadSituationMonitorSettings(ctx)
	if err != nil {
		return translationRuntimeConfig{}, err
	}
	config := translationRuntimeConfig{}
	config.Enabled = boolWithFallback(storedBool(stored, func(value situationMonitorStored) *bool {
		return value.TranslationAPIEnabled
	}), envBoolDefault("SITUATION_MONITOR_TRANSLATION_API_ENABLED", true))
	config.BaseURL = firstNonEmpty(
		normalizeURLString(storedString(stored, func(value situationMonitorStored) *string {
			return value.TranslationAPIBaseURL
		})),
		normalizeURLString(os.Getenv("SITUATION_MONITOR_TRANSLATION_API_BASE_URL")),
		defaultDeepLxBaseURL,
	)
	config.APIKey = resolveStoredAPIKey(storedRawJSON(stored, func(value situationMonitorStored) *OpenJSON {
		return value.TranslationAPIKey
	}))
	config.FallbackEnabled = boolWithFallback(storedBool(stored, func(value situationMonitorStored) *bool {
		return value.TranslationFallbackEnabled
	}), envBoolDefault("SITUATION_MONITOR_TRANSLATION_FALLBACK_API_ENABLED", false))
	config.FallbackBaseURL = firstNonEmpty(
		normalizeURLString(storedString(stored, func(value situationMonitorStored) *string {
			return value.TranslationFallbackBaseURL
		})),
		normalizeURLString(os.Getenv("SITUATION_MONITOR_TRANSLATION_FALLBACK_API_BASE_URL")),
	)
	return config, nil
}

// storedValue decodes the situation monitor settings into the typed struct.
func decodeSituationMonitorStored(value OpenJSON) *situationMonitorStored {
	if !value.Valid() {
		return nil
	}
	var stored situationMonitorStored
	if err := json.Unmarshal(value.Bytes(), &stored); err != nil {
		return nil
	}
	return &stored
}

func storedBool(stored *situationMonitorStored, pick func(situationMonitorStored) *bool) *bool {
	if stored == nil {
		return nil
	}
	return pick(*stored)
}

func storedString(stored *situationMonitorStored, pick func(situationMonitorStored) *string) string {
	if stored == nil {
		return ""
	}
	value := pick(*stored)
	if value == nil {
		return ""
	}
	return *value
}

func storedRawJSON(stored *situationMonitorStored, pick func(situationMonitorStored) *OpenJSON) OpenJSON {
	if stored == nil {
		return OpenJSON{}
	}
	value := pick(*stored)
	if value == nil {
		return OpenJSON{}
	}
	return *value
}

func boolWithFallback(value *bool, fallback bool) bool {
	if value == nil {
		return fallback
	}
	return *value
}

// envBoolDefault reads a boolean environment variable with a fallback.
func envBoolDefault(name string, fallback bool) bool {
	raw := strings.ToLower(strings.TrimSpace(os.Getenv(name)))
	switch raw {
	case "true", "1", "yes", "y", "on":
		return true
	case "false", "0", "no", "n", "off":
		return false
	default:
		return fallback
	}
}

// normalizeURLString trims and strips trailing slashes, mirroring normalizeUrl.
func normalizeURLString(value string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return ""
	}
	return strings.TrimRight(trimmed, "/")
}

// loadSituationMonitorSettings reads the {exists,value} cached wrapper, falls
// back to MySQL, and refills the cache best-effort.
func (s *Service) loadSituationMonitorSettings(ctx context.Context) (*situationMonitorStored, error) {
	if payload, ok := s.cache.Get(ctx, situationMonitorSettingsCacheKey); ok {
		var cached situationMonitorSettingsCache
		if err := json.Unmarshal(payload, &cached); err == nil {
			if !cached.Exists {
				return nil, nil
			}
			return decodeSituationMonitorStored(derefOpenJSON(cached.Value)), nil
		}
	}
	value, exists, err := s.mysql.ReadJSONSystemSetting(ctx, situationMonitorSettingsKey)
	if err != nil {
		return nil, err
	}
	var stored *situationMonitorStored
	if exists {
		stored = decodeSituationMonitorStored(value)
	}
	wrapper := situationMonitorSettingsCache{Exists: exists}
	if exists && value.Valid() {
		copy := value
		wrapper.Value = &copy
	}
	if encoded, err := json.Marshal(wrapper); err == nil {
		_ = s.cache.Set(ctx, situationMonitorSettingsCacheKey, encoded, situationMonitorSettingsTTL)
	}
	return stored, nil
}

// derefOpenJSON resolves the optional cached value.
func derefOpenJSON(value *OpenJSON) OpenJSON {
	if value == nil {
		return OpenJSON{}
	}
	return *value
}

// loadLLMGatewaySettings reads the llm_gateway_profiles cache (stored directly,
// without an exists wrapper), falls back to MySQL, and normalizes the profiles
// the same way normalizeSettings does.
func (s *Service) loadLLMGatewaySettings(ctx context.Context) (llmGatewaySettings, error) {
	if payload, ok := s.cache.Get(ctx, llmGatewayProfilesCacheKey); ok {
		var cached llmGatewaySettings
		if err := json.Unmarshal(payload, &cached); err == nil {
			return normalizeLLMGatewaySettings(cached), nil
		}
	}
	value, exists, err := s.mysql.ReadJSONSystemSetting(ctx, llmGatewayProfilesKey)
	if err != nil {
		return llmGatewaySettings{}, err
	}
	settings := llmGatewaySettings{}
	if exists && value.Valid() {
		_ = json.Unmarshal(value.Bytes(), &settings)
	}
	normalized := normalizeLLMGatewaySettings(settings)
	if encoded, err := json.Marshal(normalized); err == nil {
		_ = s.cache.Set(ctx, llmGatewayProfilesCacheKey, encoded, llmGatewayProfilesTTL)
	}
	return normalized, nil
}

// normalizeLLMGatewaySettings drops profiles without an id or model (matching
// the NestJS normalizeProfile) and resolves activeId to an enabled profile.
func normalizeLLMGatewaySettings(settings llmGatewaySettings) llmGatewaySettings {
	normalized := llmGatewaySettings{Profiles: make([]llmGatewayProfile, 0, len(settings.Profiles))}
	for _, profile := range settings.Profiles {
		id := ""
		if profile.ID != nil {
			id = strings.TrimSpace(*profile.ID)
		}
		model := ""
		if profile.Model != nil {
			model = strings.TrimSpace(*profile.Model)
		}
		if id == "" || model == "" {
			continue
		}
		trimmedID := id
		trimmedModel := model
		candidate := llmGatewayProfile{ID: &trimmedID, Model: &trimmedModel, Enabled: profile.Enabled}
		normalized.Profiles = append(normalized.Profiles, candidate)
	}
	activeID := ""
	if settings.ActiveID != nil {
		activeID = strings.TrimSpace(*settings.ActiveID)
	}
	if activeID != "" {
		found := false
		for _, profile := range normalized.Profiles {
			if profile.ID != nil && strings.TrimSpace(*profile.ID) == activeID && profileEnabled(profile) {
				found = true
				break
			}
		}
		if !found {
			activeID = ""
		}
	}
	if activeID != "" {
		value := activeID
		normalized.ActiveID = &value
	}
	return normalized
}

// encryptedStringValueV1 is the system-settings AES-256-GCM envelope.
type encryptedStringValueV1 struct {
	Enc  string `json:"__enc"`
	Alg  string `json:"alg"`
	IV   string `json:"iv"`
	Tag  string `json:"tag"`
	Data string `json:"data"`
}

// resolveStoredAPIKey ports resolveStoredApiKey: a legacy plain string is used
// verbatim, a v1 envelope is decrypted, and anything else (or a decryption
// failure) counts as "not configured".
func resolveStoredAPIKey(raw OpenJSON) string {
	if !raw.Valid() {
		return ""
	}
	trimmed := strings.TrimSpace(string(raw.Bytes()))
	if strings.HasPrefix(trimmed, "\"") {
		var text string
		if err := json.Unmarshal(raw.Bytes(), &text); err != nil {
			return ""
		}
		return strings.TrimSpace(text)
	}
	var envelope encryptedStringValueV1
	if err := json.Unmarshal(raw.Bytes(), &envelope); err != nil {
		return ""
	}
	plaintext, ok := decryptStringValueV1(envelope)
	if !ok {
		return ""
	}
	return strings.TrimSpace(plaintext)
}

// decryptStringValueV1 decrypts one AES-256-GCM envelope.
func decryptStringValueV1(envelope encryptedStringValueV1) (string, bool) {
	if envelope.Enc != "system-settings:v1" || envelope.Alg != "aes-256-gcm" {
		return "", false
	}
	key, ok := systemSettingsKey()
	if !ok {
		return "", false
	}
	iv, err := base64.StdEncoding.DecodeString(envelope.IV)
	if err != nil {
		return "", false
	}
	tag, err := base64.StdEncoding.DecodeString(envelope.Tag)
	if err != nil {
		return "", false
	}
	data, err := base64.StdEncoding.DecodeString(envelope.Data)
	if err != nil {
		return "", false
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", false
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return "", false
	}
	sealed := append(append([]byte{}, data...), tag...)
	plaintext, err := aead.Open(nil, iv, sealed, nil)
	if err != nil {
		return "", false
	}
	return string(plaintext), true
}

// systemSettingsKey decodes SYSTEM_SETTINGS_ENCRYPTION_KEY (64 hex chars or 32
// base64 bytes).
func systemSettingsKey() ([]byte, bool) {
	raw := strings.TrimSpace(os.Getenv("SYSTEM_SETTINGS_ENCRYPTION_KEY"))
	if raw == "" {
		return nil, false
	}
	candidate := strings.TrimPrefix(raw, "0x")
	if len(candidate) == 64 {
		if decoded, err := hex.DecodeString(candidate); err == nil && len(decoded) == 32 {
			return decoded, true
		}
	}
	if decoded, err := base64.StdEncoding.DecodeString(raw); err == nil && len(decoded) == 32 {
		return decoded, true
	}
	return nil, false
}
