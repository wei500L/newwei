package modelaccesssettings

import (
	"context"
	"time"
)

// AssistantModelServiceConfig is the effective model-service connection the
// assistant forecast path reuses. It mirrors ModelServiceSettingsService
// getEffectiveConfig so the Go client reads the same base URL, token, timeout
// and retry count as NestJS.
type AssistantModelServiceConfig struct {
	Enabled       bool
	BaseURL       string
	InternalToken string
	Timeout       time.Duration
	MaxRetries    int
}

// AssistantModelServiceConfig resolves model_service exactly like the settings
// endpoint: the stored row over the environment defaults, with the stored token
// decrypted only when usable.
func (s *Service) AssistantModelServiceConfig(ctx context.Context) (AssistantModelServiceConfig, error) {
	record, err := s.readModelServiceRecordCached(ctx)
	if err != nil {
		return AssistantModelServiceConfig{}, err
	}
	effective := s.resolveEffectiveConfig(record)
	return AssistantModelServiceConfig{
		Enabled:       effective.enabled,
		BaseURL:       effective.baseURL,
		InternalToken: effective.internalToken,
		Timeout:       time.Duration(effective.timeoutMs) * time.Millisecond,
		MaxRetries:    effective.maxRetries,
	}, nil
}

// AssistantOpenAIKeyCount is the structural key count OpenAiKeysSettingsService
// getKeyCount returns. It never decrypts: a wrapped entry counts when its value
// is truthy, a legacy plaintext or bare encrypted entry counts unconditionally.
// The assistant guardrail bucketing uses it to decide whether to suffix the
// moderation guardrail names.
func (s *Service) AssistantOpenAIKeyCount(ctx context.Context) (int, error) {
	record, err := s.readOpenAiKeysRecordCached(ctx)
	if err != nil {
		return 0, err
	}
	return countStoredKeysParsed(parseOpenAiKeyEntries(record.entries)), nil
}
