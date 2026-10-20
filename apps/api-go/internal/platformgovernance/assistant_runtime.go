package platformgovernance

import (
	"context"
	"time"
)

// AssistantQuotaSnapshot is the effective assistant quota of one organization
// plus the usage the submit gate needs. It is the read-only projection reused
// by the assistant worker/submit path; the settings service keeps its own
// public GET response unchanged.
type AssistantQuotaSnapshot struct {
	Enabled            bool
	SubmitLimitPerHour int64
	MaxInFlightPerOrg  int64
	MonthlyTokenBudget int64
	MonthStart         time.Time
	TotalTokens        int64
	InFlight           int64
}

// AssistantQuotaSnapshot resolves assistant_quota exactly like the settings
// endpoint: the stored row over the environment defaults, with the same
// coercion and clamping. The token total uses the same feature-prefix
// aggregation over llmrequestlogs and is always org-scoped.
func (s *Service) AssistantQuotaSnapshot(ctx context.Context, orgID string) (AssistantQuotaSnapshot, error) {
	stored, present, err := s.loadStoredQuota(ctx)
	if err != nil {
		return AssistantQuotaSnapshot{}, err
	}
	effective := s.resolveQuotaEffective(stored, present)
	monthStart := startOfUTCMonth(time.Now())
	totalTokens, err := s.assistantTokenUsage(ctx, orgID, monthStart)
	if err != nil {
		return AssistantQuotaSnapshot{}, err
	}
	inFlight, err := s.assistantInFlight(ctx, orgID)
	if err != nil {
		return AssistantQuotaSnapshot{}, err
	}
	return AssistantQuotaSnapshot{
		Enabled:            effective.Enabled,
		SubmitLimitPerHour: effective.SubmitLimitPerHour,
		MaxInFlightPerOrg:  effective.MaxInFlightPerOrg,
		MonthlyTokenBudget: effective.MonthlyTokenBudget,
		MonthStart:         monthStart,
		TotalTokens:        totalTokens,
		InFlight:           inFlight,
	}, nil
}

// AssistantGuardrailConfig is the effective assistant safety configuration the
// worker passes to the gateway.
type AssistantGuardrailConfig struct {
	Enabled                 bool
	OutputModerationEnabled bool
	Guardrails              []string
}

// AssistantGuardrails resolves assistant_safety exactly like
// getEffectiveConfig: the stored row over the environment defaults, with the
// pre-moderation guardrail always present when enabled and the post-moderation
// one appended when output moderation is on.
func (s *Service) AssistantGuardrails(ctx context.Context) (AssistantGuardrailConfig, error) {
	stored, present, err := s.loadStoredSafety(ctx)
	if err != nil {
		return AssistantGuardrailConfig{}, err
	}
	effective := s.resolveSafetyEffective(stored, present)
	return AssistantGuardrailConfig{
		Enabled:                 effective.Enabled,
		OutputModerationEnabled: effective.OutputModerationEnabled,
		Guardrails:              effective.Guardrails,
	}, nil
}
