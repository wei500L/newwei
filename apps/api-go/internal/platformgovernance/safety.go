package platformgovernance

import (
	"context"
	"encoding/json"
	"strings"
)

// AssistantSafetySettingsResponse is the GET /api/system-settings/assistant-safety
// body.
type AssistantSafetySettingsResponse struct {
	Source                  SettingsSource `json:"source"`
	Enabled                 bool           `json:"enabled"`
	OutputModerationEnabled bool           `json:"outputModerationEnabled"`
	Guardrails              []string       `json:"guardrails"`
}

// safetyStoredSettings is the SystemSetting.value shape for key
// "assistant_safety".
type safetyStoredSettings struct {
	Enabled                 optionalBool `json:"enabled"`
	OutputModerationEnabled optionalBool `json:"outputModerationEnabled"`
}

// safetyStoredValue is the value written to SystemSetting.value.
type safetyStoredValue struct {
	Enabled                 bool `json:"enabled"`
	OutputModerationEnabled bool `json:"outputModerationEnabled"`
}

// safetyUpdateMetadata is the AuditLog metadata document for
// "assistant_safety_update".
type safetyUpdateMetadata struct {
	Enabled                 bool     `json:"enabled"`
	OutputModerationEnabled bool     `json:"outputModerationEnabled"`
	Guardrails              []string `json:"guardrails"`
}

// safetyResetMetadata is the AuditLog metadata document for
// "assistant_safety_reset".
type safetyResetMetadata struct {
	OK bool `json:"ok"`
}

// safetyEffectiveValues are the resolved guardrail settings.
type safetyEffectiveValues struct {
	Enabled                 bool
	OutputModerationEnabled bool
	Guardrails              []string
}

// assistantSafetySettings computes the GET /assistant-safety response.
func (s *Service) assistantSafetySettings(ctx context.Context) (AssistantSafetySettingsResponse, error) {
	stored, present, err := s.loadStoredSafety(ctx)
	if err != nil {
		return AssistantSafetySettingsResponse{}, err
	}
	effective := s.resolveSafetyEffective(stored, present)
	guardrails := effective.Guardrails
	if guardrails == nil {
		guardrails = []string{}
	}
	source := SettingsSourceEnv
	if present {
		source = SettingsSourceDB
	}
	return AssistantSafetySettingsResponse{
		Source:                  source,
		Enabled:                 effective.Enabled,
		OutputModerationEnabled: effective.OutputModerationEnabled,
		Guardrails:              guardrails,
	}, nil
}

// updateAssistantSafetySettings performs the PUT flow.
func (s *Service) updateAssistantSafetySettings(ctx context.Context, orgID, actorID string, input safetyUpdateInput) (AssistantSafetySettingsResponse, error) {
	nextStored := safetyStoredValue{
		Enabled:                 input.Enabled,
		OutputModerationEnabled: input.OutputModerationEnabled,
	}
	effective := s.resolveSafetyEffectiveFromValues(nextStored)

	value, err := json.Marshal(nextStored)
	if err != nil {
		return AssistantSafetySettingsResponse{}, err
	}
	if err := s.upsertSetting(ctx, settingKeyAssistantSafety, value, 0, descriptionAssistantSafety, nullableActorID(actorID)); err != nil {
		return AssistantSafetySettingsResponse{}, err
	}

	guardrails := effective.Guardrails
	if guardrails == nil {
		guardrails = []string{}
	}
	metadata, err := json.Marshal(safetyUpdateMetadata{
		Enabled:                 effective.Enabled,
		OutputModerationEnabled: effective.OutputModerationEnabled,
		Guardrails:              guardrails,
	})
	if err != nil {
		return AssistantSafetySettingsResponse{}, err
	}
	s.writeAuditLogBestEffort(ctx, orgID, actorID, "assistant_safety_update", metadata)

	s.invalidateStoredCache(ctx, cacheKeyAssistantSafety)
	return s.assistantSafetySettings(ctx)
}

// resetAssistantSafetySettings performs the DELETE flow.
func (s *Service) resetAssistantSafetySettings(ctx context.Context, orgID, actorID string) (AssistantSafetySettingsResponse, error) {
	if err := s.deleteSetting(ctx, settingKeyAssistantSafety); err != nil {
		return AssistantSafetySettingsResponse{}, err
	}
	metadata, err := json.Marshal(safetyResetMetadata{OK: true})
	if err != nil {
		return AssistantSafetySettingsResponse{}, err
	}
	s.writeAuditLogBestEffort(ctx, orgID, actorID, "assistant_safety_reset", metadata)
	s.invalidateStoredCache(ctx, cacheKeyAssistantSafety)
	return s.assistantSafetySettings(ctx)
}

// loadStoredSafety reads the assistant_safety row through the Redis cache.
func (s *Service) loadStoredSafety(ctx context.Context) (safetyStoredSettings, bool, error) {
	raw, present, err := s.loadStoredWithCache(ctx, settingKeyAssistantSafety, cacheKeyAssistantSafety, cacheTTLSecondsAssistant)
	if err != nil || !present {
		return safetyStoredSettings{}, present, err
	}
	var stored safetyStoredSettings
	// A stored array is object-like to NestJS but has no named fields.
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &stored); err != nil {
			return safetyStoredSettings{}, false, err
		}
	}
	return stored, true, nil
}

// resolveSafetyEffective applies the stored row (when present) over the
// environment guardrail defaults.
func (s *Service) resolveSafetyEffective(stored safetyStoredSettings, present bool) safetyEffectiveValues {
	enabled := s.env.AssistantGuardrailsEnabled
	outputModerationEnabled := s.safetyEnvironmentOutputModeration()
	if present {
		if stored.Enabled.present {
			enabled = stored.Enabled.value
		}
		if stored.OutputModerationEnabled.present {
			outputModerationEnabled = stored.OutputModerationEnabled.value
		}
	}
	return buildSafetyEffective(enabled, outputModerationEnabled)
}

// resolveSafetyEffectiveFromValues resolves the effective guardrails from a
// freshly written value.
func (s *Service) resolveSafetyEffectiveFromValues(value safetyStoredValue) safetyEffectiveValues {
	return buildSafetyEffective(value.Enabled, value.OutputModerationEnabled)
}

// buildSafetyEffective derives the guardrail list: disabled means no guardrails
// at all, otherwise the pre-moderation guardrail always applies and the
// post-moderation one is appended when output moderation is enabled.
func buildSafetyEffective(enabled, outputModerationEnabled bool) safetyEffectiveValues {
	if !enabled {
		return safetyEffectiveValues{Enabled: false, OutputModerationEnabled: outputModerationEnabled}
	}
	guardrails := []string{assistantSafetyGuardrailPre}
	if outputModerationEnabled {
		guardrails = append(guardrails, assistantSafetyGuardrailPost)
	}
	return safetyEffectiveValues{
		Enabled:                 true,
		OutputModerationEnabled: outputModerationEnabled,
		Guardrails:              guardrails,
	}
}

// safetyEnvironmentOutputModeration mirrors
// AssistantSafetySettingsService.normalizeEnvDefaults: ASSISTANT_GUARDRAILS is
// split on commas, every entry is trimmed and emptied out, and the result
// contains "openai-moderation-post".
func (s *Service) safetyEnvironmentOutputModeration() bool {
	for _, entry := range strings.Split(s.env.AssistantGuardrails, ",") {
		if strings.TrimSpace(entry) == assistantSafetyGuardrailPost {
			return true
		}
	}
	return false
}

// AssistantSafetyPublicSettings exposes the GET /assistant-safety projection to
// the diagnostics unit. It is the same computation, including the Redis-backed
// row cache, so the diagnostics panel and the settings panel cannot disagree.
func (s *Service) AssistantSafetyPublicSettings(ctx context.Context) (AssistantSafetySettingsResponse, error) {
	return s.assistantSafetySettings(ctx)
}
