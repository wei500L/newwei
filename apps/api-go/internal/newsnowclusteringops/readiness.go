package newsnowclusteringops

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
)

const (
	// settingKeyModelService is the global SystemSetting row of the model
	// service. NestJS names it "model_service", not "model_service_settings".
	settingKeyModelService = "model_service"
	// settingKeyLLMGatewayProfiles is the global SystemSetting row of the LLM
	// gateway profiles.
	settingKeyLLMGatewayProfiles = "llm_gateway_profiles"
)

const (
	// llmAPISurfaceChatCompletions is the default api surface of a profile.
	llmAPISurfaceChatCompletions = "chat_completions"
	// llmAPISurfaceResponses is the alternative api surface.
	llmAPISurfaceResponses = "responses"
)

// ServiceConfig carries the environment fallbacks the readiness endpoint needs.
// The Go takeover reads MySQL directly instead of the NestJS Redis caches
// (model_service:settings, llm_gateway:profiles); the normalized result is the
// same because both caches are populated from these same rows.
type ServiceConfig struct {
	// ModelServiceEnabled is MODEL_SERVICE_ENABLED.
	ModelServiceEnabled bool
	// ModelServiceBaseURL is MODEL_SERVICE_BASE_URL.
	ModelServiceBaseURL string
	// ModelServiceToken is MODEL_SERVICE_INTERNAL_TOKEN.
	ModelServiceToken string
	// EncryptionKey is SYSTEM_SETTINGS_ENCRYPTION_KEY used to decrypt stored
	// secrets of the system-settings:v1 envelope.
	EncryptionKey string
}

// storedModelServiceSettings is the persisted model_service document.
type storedModelServiceSettings struct {
	Enabled       json.RawMessage `json:"enabled"`
	BaseURL       json.RawMessage `json:"baseUrl"`
	InternalToken json.RawMessage `json:"internalToken"`
}

// storedLLMGatewayProfile is one persisted profile of llm_gateway_profiles.
type storedLLMGatewayProfile struct {
	ID             string          `json:"id"`
	Name           json.RawMessage `json:"name"`
	Model          json.RawMessage `json:"model"`
	AssistantModel json.RawMessage `json:"assistantModel"`
	APISurface     json.RawMessage `json:"apiSurface"`
	Enabled        json.RawMessage `json:"enabled"`
}

// storedLLMGatewaySettings is the persisted llm_gateway_profiles document.
type storedLLMGatewaySettings struct {
	ActiveID json.RawMessage           `json:"activeId"`
	Profiles []storedLLMGatewayProfile `json:"profiles"`
}

// resolvedLLMProfile is one normalized gateway profile.
type resolvedLLMProfile struct {
	ID             string
	Name           string
	Model          string
	AssistantModel string
	APISurface     string
	Enabled        bool
}

// settingValue reads one global SystemSetting row. The second result is false
// when the row does not exist.
func (s *Service) settingValue(ctx context.Context, key string) ([]byte, bool, error) {
	if s == nil || s.db == nil {
		return nil, false, errors.New("newsnowclusteringops: database is not configured")
	}
	var raw []byte
	err := s.db.QueryRowContext(ctx,
		"SELECT value FROM SystemSetting WHERE `key` = ? LIMIT 1", key).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return raw, true, nil
}

// modelServiceReadiness mirrors
// ModelServiceSettingsService.getPublicSettings plus the readiness projection in
// NewsEventClusteringRecoveryService.getReadiness.
func (s *Service) modelServiceReadiness(ctx context.Context) (ModelServiceReadiness, error) {
	enabled := s.cfg.ModelServiceEnabled
	baseURL := strings.TrimSpace(s.cfg.ModelServiceBaseURL)
	token := strings.TrimSpace(s.cfg.ModelServiceToken)

	raw, found, err := s.settingValue(ctx, settingKeyModelService)
	if err != nil {
		return ModelServiceReadiness{}, err
	}
	if found && len(raw) > 0 {
		var stored storedModelServiceSettings
		if err := json.Unmarshal(raw, &stored); err == nil {
			if parsed, ok := boolRaw(stored.Enabled, enabled); ok {
				enabled = parsed
			}
			if parsed := rawString(stored.BaseURL); parsed != "" {
				baseURL = parsed
			}
			if resolved := s.resolveModelServiceToken(stored.InternalToken); resolved != "" {
				token = resolved
			}
		}
	}

	readiness := ModelServiceReadiness{
		Enabled:  enabled,
		HasToken: token != "",
	}
	if baseURL != "" {
		readiness.BaseURL = &baseURL
	}
	readiness.Ready = enabled && baseURL != "" && readiness.HasToken
	return readiness, nil
}

// resolveModelServiceToken resolves a stored token, which may be a plain string
// or a system-settings:v1 encrypted envelope. An undecryptable value resolves to
// the empty string so the caller falls back to the environment token, exactly
// like ModelServiceSettingsService.resolveToken.
func (s *Service) resolveModelServiceToken(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	if plain := rawString(raw); plain != "" {
		return plain
	}
	envelope, ok := decodeEncryptedEnvelope(raw)
	if !ok {
		return ""
	}
	decrypted, err := decryptSystemSettingSecret(envelope, s.cfg.EncryptionKey)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(decrypted)
}

// encryptedEnvelope is the system-settings:v1 encrypted string envelope.
type encryptedEnvelope struct {
	Tag  string `json:"__enc"`
	Alg  string `json:"alg"`
	IV   string `json:"iv"`
	TagV string `json:"tag"`
	Data string `json:"data"`
}

// decodeEncryptedEnvelope parses an encrypted envelope when the raw value has
// the expected tag and algorithm.
func decodeEncryptedEnvelope(raw json.RawMessage) (encryptedEnvelope, bool) {
	var envelope encryptedEnvelope
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return encryptedEnvelope{}, false
	}
	if envelope.Tag != "system-settings:v1" || envelope.Alg != "aes-256-gcm" {
		return encryptedEnvelope{}, false
	}
	return envelope, true
}

// decryptSystemSettingSecret decrypts an AES-256-GCM system-settings secret.
func decryptSystemSettingSecret(envelope encryptedEnvelope, encryptionKey string) (string, error) {
	key, err := decodeSettingsKey(encryptionKey)
	if err != nil {
		return "", err
	}
	iv, err := base64.StdEncoding.DecodeString(envelope.IV)
	if err != nil {
		return "", err
	}
	tag, err := base64.StdEncoding.DecodeString(envelope.TagV)
	if err != nil {
		return "", err
	}
	data, err := base64.StdEncoding.DecodeString(envelope.Data)
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

// decodeSettingsKey accepts a 32-byte base64 key or a 64-character hex key.
func decodeSettingsKey(raw string) ([]byte, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil, errors.New("newsnowclusteringops: missing settings encryption key")
	}
	candidate := strings.TrimPrefix(strings.TrimPrefix(trimmed, "0x"), "0X")
	if len(candidate) == 64 && isHexString(candidate) {
		return hex.DecodeString(candidate)
	}
	decoded, err := base64.StdEncoding.DecodeString(trimmed)
	if err != nil || len(decoded) != 32 {
		return nil, errors.New("newsnowclusteringops: invalid settings encryption key")
	}
	return decoded, nil
}

// isHexString reports whether every rune is a hexadecimal digit.
func isHexString(value string) bool {
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

// llmBackfillReadiness mirrors LlmGatewaySettingsService.getActiveConfig plus
// the readiness projection. The Go takeover never enqueues the LLM backfill, so
// this is reported for operator visibility only.
func (s *Service) llmBackfillReadiness(ctx context.Context) (LLMBackfillReadiness, error) {
	raw, found, err := s.settingValue(ctx, settingKeyLLMGatewayProfiles)
	if err != nil {
		return LLMBackfillReadiness{}, err
	}
	if !found || len(raw) == 0 {
		return LLMBackfillReadiness{}, nil
	}
	var stored storedLLMGatewaySettings
	if err := json.Unmarshal(raw, &stored); err != nil {
		return LLMBackfillReadiness{}, nil
	}
	profiles := normalizeLLMProfiles(stored.Profiles)
	if len(profiles) == 0 {
		return LLMBackfillReadiness{}, nil
	}

	activeID := rawString(stored.ActiveID)
	selected := -1
	for i := range profiles {
		if activeID != "" && profiles[i].ID == activeID && profiles[i].Enabled {
			selected = i
			break
		}
	}
	if selected < 0 {
		for i := range profiles {
			if profiles[i].Enabled {
				selected = i
				break
			}
		}
	}
	if selected < 0 {
		return LLMBackfillReadiness{}, nil
	}

	profile := profiles[selected]
	model := profile.AssistantModel
	if model == "" {
		model = profile.Model
	}
	readiness := LLMBackfillReadiness{Ready: model != ""}
	if profile.ID != "" {
		id := profile.ID
		readiness.ProfileID = &id
	}
	if profile.Name != "" {
		name := profile.Name
		readiness.ProfileName = &name
	}
	if model != "" {
		value := model
		readiness.Model = &value
	}
	if profile.APISurface != "" {
		surface := profile.APISurface
		readiness.APISurface = &surface
	}
	return readiness, nil
}

// normalizeLLMProfiles drops profiles without an id or a model and applies the
// NestJS defaults for the remaining fields.
func normalizeLLMProfiles(raw []storedLLMGatewayProfile) []resolvedLLMProfile {
	out := make([]resolvedLLMProfile, 0, len(raw))
	for _, profile := range raw {
		id := strings.TrimSpace(profile.ID)
		if id == "" {
			continue
		}
		model := rawString(profile.Model)
		if model == "" {
			continue
		}
		name := rawString(profile.Name)
		if name == "" {
			name = id
		}
		enabled := true
		if parsed, ok := boolRaw(profile.Enabled, true); ok {
			enabled = parsed
		}
		surface := rawString(profile.APISurface)
		surface = normalizeLLMAPISurface(surface)
		out = append(out, resolvedLLMProfile{
			ID:             id,
			Name:           name,
			Model:          model,
			AssistantModel: rawString(profile.AssistantModel),
			APISurface:     surface,
			Enabled:        enabled,
		})
	}
	return out
}

// normalizeLLMAPISurface restricts the api surface to the known values and
// falls back to chat_completions.
func normalizeLLMAPISurface(value string) string {
	switch strings.TrimSpace(value) {
	case llmAPISurfaceResponses:
		return llmAPISurfaceResponses
	case llmAPISurfaceChatCompletions:
		return llmAPISurfaceChatCompletions
	default:
		return llmAPISurfaceChatCompletions
	}
}

// rawString trims a JSON string value, returning the empty string when the
// value is absent or not a string.
func rawString(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return ""
	}
	return strings.TrimSpace(value)
}

// readiness assembles the clustering readiness payload.
func (s *Service) readiness(ctx context.Context) (ReadinessResponse, error) {
	modelService, err := s.modelServiceReadiness(ctx)
	if err != nil {
		return ReadinessResponse{}, err
	}
	llmBackfill, err := s.llmBackfillReadiness(ctx)
	if err != nil {
		return ReadinessResponse{}, err
	}
	return ReadinessResponse{
		ModelService: modelService,
		LLMBackfill:  llmBackfill,
		RecoveryAutomation: RecoveryAutomationReadiness{
			Enabled:           true,
			IntervalSeconds:   5 * 60,
			RetryAfterSeconds: 15 * 60,
			BatchSize:         25,
			ActorID:           "system:news-event-clustering-recovery",
		},
	}, nil
}
