package llmgatewayprofiles

import (
	"bytes"
	"encoding/json"
	"time"
)

// Default compatibility values, mirroring the NestJS service constants.
const (
	defaultSendMetadata              = true
	defaultAssistantWebSearchEnabled = false
)

// DefaultProfileResponseFormatMode is the fallback response format mode.
const DefaultProfileResponseFormatMode = ResponseFormatJSONSchema

// DefaultProfileAPISurface is the fallback completion API surface.
const DefaultProfileAPISurface = APISurfaceChatCompletions

// EnvDefaults is the effective LITELLM_* configuration the NestJS
// EnvService.liteLlmConfig getter exposes. The Go wiring builds it from the same
// environment variables with the same precedence (including the zod schema
// defaults that make LITELLM_MAX_TOKENS and LITELLM_RETRY_ATTEMPTS win over
// their legacy aliases even when only the alias is set).
type EnvDefaults struct {
	// Model is LITELLM_MODEL (schema default openai/gpt-4o-mini). It is
	// recorded for parity but never backfills a profile: neither normalizeProfile
	// nor the create path takes a missing model from the environment.
	Model string
	// APIBase is LITELLM_API_URL, else LITELLM_API_BASE, else the default.
	APIBase string
	// TimeoutMs is LITELLM_TIMEOUT_MS (default 60000).
	TimeoutMs float64
	// Temperature is LITELLM_TEMPERATURE (default 0.2).
	Temperature float64
	// TopP is LITELLM_TOP_P (default 0.9).
	TopP float64
	// MaxOutputTokens is the effective LITELLM_MAX_TOKENS value (schema default
	// 2048; LITELLM_MAX_OUTPUT_TOKENS cannot win because MAX_TOKENS always has
	// a schema default).
	MaxOutputTokens float64
	// MaxRetries is the effective LITELLM_RETRY_ATTEMPTS value (schema default
	// 3; LITELLM_MAX_RETRIES cannot win for the same reason).
	MaxRetries float64
	// FallbackModels is LITELLM_FALLBACK_MODELS split on commas with empty
	// entries dropped.
	FallbackModels []string
}

// nowISO returns the current UTC time in the JavaScript Date.toISOString()
// shape (millisecond precision).
func nowISO() string {
	return time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
}

// NormalizeSettings mirrors the NestJS normalizeSettings: it resolves the three
// active selections against the normalized profiles and never synthesises an
// environment profile out of thin air.
func NormalizeSettings(raw json.RawMessage, env EnvDefaults) StoredSettings {
	var decoded rawStoredSettings
	if present(raw) {
		// A non-object document (or invalid JSON) behaves like an empty object:
		// every lookup below then falls back to its default.
		_ = json.Unmarshal(raw, &decoded)
	}

	profiles := normalizeProfiles(decoded.Profiles, env)

	activeIDRaw := normalizeString(decoded.ActiveID)
	embeddingActiveIDRaw := normalizeString(decoded.EmbeddingActiveID)
	rerankActiveIDRaw := normalizeString(decoded.RerankActiveID)

	embeddingMode := EmbeddingModeFollowCompletion
	if mode := normalizeString(decoded.EmbeddingMode); mode != nil && *mode == string(EmbeddingModeUseDefault) {
		embeddingMode = EmbeddingModeUseDefault
	}
	rerankMode := RerankModeFollowCompletion
	if mode := normalizeString(decoded.RerankMode); mode != nil && *mode == string(RerankModeUseDefault) {
		rerankMode = RerankModeUseDefault
	}

	return StoredSettings{
		ActiveID:          resolveActiveID(profiles, activeIDRaw, activeKindCompletion),
		EmbeddingActiveID: resolveActiveID(profiles, embeddingActiveIDRaw, activeKindEmbedding),
		EmbeddingMode:     embeddingMode,
		RerankActiveID:    resolveActiveID(profiles, rerankActiveIDRaw, activeKindRerank),
		RerankMode:        rerankMode,
		Profiles:          profiles,
	}
}

// activeKind selects the availability rule of one active selection.
type activeKind int

const (
	activeKindCompletion activeKind = iota
	activeKindEmbedding
	activeKindRerank
)

// resolveActiveID keeps the stored id only when the referenced profile exists
// and satisfies that channel's requirements.
func resolveActiveID(profiles []StoredProfile, candidate *string, kind activeKind) *string {
	if candidate == nil {
		return nil
	}
	for index := range profiles {
		profile := profiles[index]
		if profile.ID != *candidate {
			continue
		}
		if !profile.Enabled {
			return nil
		}
		switch kind {
		case activeKindEmbedding:
			if profile.EmbeddingModel == nil {
				return nil
			}
		case activeKindRerank:
			if profile.RerankModel == nil {
				return nil
			}
		}
		id := profile.ID
		return &id
	}
	return nil
}

// normalizeProfiles decodes the profiles array tolerantly, then normalizes and
// filters it. Duplicate ids are preserved: the original update replaces the
// first match and delete removes every match.
func normalizeProfiles(raw json.RawMessage, env EnvDefaults) []StoredProfile {
	trimmed := bytes.TrimSpace(raw)
	out := make([]StoredProfile, 0)
	if len(trimmed) == 0 || trimmed[0] != '[' {
		return out
	}
	var entries []json.RawMessage
	if err := json.Unmarshal(trimmed, &entries); err != nil {
		return out
	}
	for _, entry := range entries {
		if profile, ok := NormalizeProfile(entry, env); ok {
			out = append(out, profile)
		}
	}
	return out
}

// NormalizeProfile mirrors the NestJS normalizeProfile. A profile without a
// non-empty id or model is dropped; a missing model is never backfilled from the
// environment.
func NormalizeProfile(raw json.RawMessage, env EnvDefaults) (StoredProfile, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return StoredProfile{}, false
	}
	var decoded rawStoredProfile
	if err := json.Unmarshal(trimmed, &decoded); err != nil {
		return StoredProfile{}, false
	}

	id := normalizeString(decoded.ID)
	if id == nil {
		return StoredProfile{}, false
	}
	model := normalizeString(decoded.Model)
	if model == nil {
		return StoredProfile{}, false
	}
	name := normalizeString(decoded.Name)
	if name == nil {
		name = id
	}
	apiBase := normalizeString(decoded.APIBase)
	if apiBase == nil {
		apiBase = &env.APIBase
	}
	createdAt := normalizeString(decoded.CreatedAt)
	if createdAt == nil {
		value := nowISO()
		createdAt = &value
	}
	updatedAt := normalizeString(decoded.UpdatedAt)
	if updatedAt == nil {
		value := nowISO()
		updatedAt = &value
	}

	return StoredProfile{
		ID:                        *id,
		Name:                      *name,
		APIBase:                   *apiBase,
		APIKey:                    decodeSecretValue(decoded.APIKey),
		Model:                     *model,
		EmbeddingModel:            normalizeString(decoded.EmbeddingModel),
		RerankModel:               normalizeString(decoded.RerankModel),
		RerankFallbackModels:      normalizeStringList(decoded.RerankFallbackModels, []string{}),
		AssistantModel:            normalizeString(decoded.AssistantModel),
		AssistantWebSearchEnabled: boolNullable(normalizeBool(decoded.AssistantWebSearchEnabled, defaultAssistantWebSearchEnabled)),
		TimeoutMs:                 asPositiveInt(parseJSNumber(decoded.TimeoutMs), env.TimeoutMs),
		Temperature:               clampNumber(parseJSNumber(decoded.Temperature), env.Temperature, 0, 2),
		TopP:                      clampNumber(parseJSNumber(decoded.TopP), env.TopP, 0, 1),
		MaxOutputTokens:           asPositiveInt(parseJSNumber(decoded.MaxOutputTokens), env.MaxOutputTokens),
		MaxRetries:                asPositiveInt(parseJSNumber(decoded.MaxRetries), env.MaxRetries),
		FallbackModels:            normalizeStringList(decoded.FallbackModels, []string{}),
		SendMetadata:              boolNullable(normalizeBool(decoded.SendMetadata, defaultSendMetadata)),
		ResponseFormatMode:        normalizeResponseFormatMode(decoded.ResponseFormatMode, DefaultProfileResponseFormatMode),
		APISurface:                normalizeAPISurface(decoded.APISurface, DefaultProfileAPISurface),
		Enabled:                   normalizeEnabled(decoded.Enabled),
		CreatedAt:                 *createdAt,
		UpdatedAt:                 *updatedAt,
	}, true
}

// normalizeResponseFormatMode mirrors the service helper: only the three known
// literals survive, otherwise the fallback is used.
func normalizeResponseFormatMode(raw json.RawMessage, fallback ResponseFormatMode) ResponseFormatMode {
	if value, ok := jsString(raw); ok {
		switch ResponseFormatMode(value) {
		case ResponseFormatJSONSchema, ResponseFormatJSONObject, ResponseFormatNone:
			return ResponseFormatMode(value)
		}
	}
	return fallback
}

// normalizeAPISurface mirrors the service helper.
func normalizeAPISurface(raw json.RawMessage, fallback APISurface) APISurface {
	if value, ok := jsString(raw); ok {
		switch APISurface(value) {
		case APISurfaceChatCompletions, APISurfaceResponses:
			return APISurface(value)
		}
	}
	return fallback
}

// PublicProfileOf renders one stored profile. The apiKey is never part of the
// projection; hasAPIKey is computed by the caller because it needs the
// encryption key.
func PublicProfileOf(profile StoredProfile, hasAPIKey bool) PublicProfile {
	return PublicProfile{
		ID:                        profile.ID,
		Name:                      profile.Name,
		Model:                     profile.Model,
		EmbeddingModel:            profile.EmbeddingModel,
		RerankModel:               profile.RerankModel,
		AssistantModel:            profile.AssistantModel,
		AssistantWebSearchEnabled: profile.AssistantWebSearchEnabled,
		APIBase:                   profile.APIBase,
		TimeoutMs:                 profile.TimeoutMs,
		Temperature:               profile.Temperature,
		TopP:                      profile.TopP,
		MaxOutputTokens:           profile.MaxOutputTokens,
		MaxRetries:                profile.MaxRetries,
		FallbackModels:            nonNilStrings(profile.FallbackModels),
		RerankFallbackModels:      nonNilStrings(profile.RerankFallbackModels),
		SendMetadata:              profile.SendMetadata,
		ResponseFormatMode:        profile.ResponseFormatMode,
		APISurface:                profile.APISurface,
		Enabled:                   profile.Enabled,
		CreatedAt:                 profile.CreatedAt,
		UpdatedAt:                 profile.UpdatedAt,
		HasAPIKey:                 hasAPIKey,
	}
}

// PublicSettingsOf renders the full document with the same key order and
// defaults as the NestJS list().
func PublicSettingsOf(settings StoredSettings, hasAPIKey func(StoredProfile) bool) SettingsPublic {
	profiles := make([]PublicProfile, 0, len(settings.Profiles))
	for _, profile := range settings.Profiles {
		profiles = append(profiles, PublicProfileOf(profile, hasAPIKey(profile)))
	}
	return SettingsPublic{
		ActiveID:          settings.ActiveID,
		EmbeddingActiveID: settings.EmbeddingActiveID,
		EmbeddingMode:     settings.EmbeddingMode,
		RerankActiveID:    settings.RerankActiveID,
		RerankMode:        settings.RerankMode,
		Profiles:          profiles,
	}
}
