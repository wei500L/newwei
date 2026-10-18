package llmgatewayprofiles

import (
	"context"
	"regexp"
	"strings"
)

// openAIPathSuffixes is the ordered endpoint suffix list of the shared
// normalizeOpenAiApiBase helper. Order matters: the longer /v1 form is matched
// first.
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

// trailingSlashesPattern mirrors the JavaScript replace(/\/+$/, "").
var trailingSlashesPattern = regexp.MustCompile(`/+$`)

// normalizeOpenAiApiBase mirrors apps/api/src/common/llm-openai-compat.ts. It is
// used only to compare the current and the next apiBase of a governance target;
// a stored apiBase is never rewritten by it.
func normalizeOpenAiApiBase(raw string) string {
	base := strings.TrimSpace(raw)
	if base == "" {
		return base
	}
	base = trailingSlashesPattern.ReplaceAllString(base, "")

	lower := strings.ToLower(base)
	matched := ""
	for _, suffix := range openAIPathSuffixes {
		if strings.HasSuffix(lower, suffix) {
			matched = suffix
			break
		}
	}
	if matched != "" {
		base = base[:len(base)-len(matched)]
		base = trailingSlashesPattern.ReplaceAllString(base, "")
	}
	if strings.HasSuffix(strings.ToLower(base), "/v1") {
		base = base[:len(base)-len("/v1")]
	}
	return trailingSlashesPattern.ReplaceAllString(base, "")
}

// governanceState is the resolved projection of the governance document.
type governanceState struct {
	enabled         bool
	targetProfileID *string
}

// resolveGovernanceSettings reads and normalizes the governance projection:
// enabled is a strict boolean (anything else is false) and targetProfileId is a
// trimmed non-empty string or null.
func (s *Service) resolveGovernanceSettings(ctx context.Context) (governanceState, error) {
	stored, err := s.loadGovernanceSettings(ctx)
	if err != nil {
		return governanceState{}, err
	}
	return governanceState{
		enabled:         normalizeBool(stored.Enabled, false),
		targetProfileID: normalizeString(stored.TargetProfileID),
	}, nil
}

// guardTarget reports whether the governance protection applies to profileID.
func (state governanceState) guardTarget(profileID string) bool {
	return state.enabled && state.targetProfileID != nil && *state.targetProfileID == profileID
}

// assertProfileUpdateAllowed mirrors
// LiteLlmProxyGovernanceService.assertProfileUpdateAllowed. Only a governance
// target profile is protected, and the apiBase comparison treats a base and its
// endpoint-suffixed form as the same target.
func (s *Service) assertProfileUpdateAllowed(ctx context.Context, profileID, currentAPIBase, nextAPIBase string, nextEnabled bool) error {
	state, err := s.resolveGovernanceSettings(ctx)
	if err != nil {
		return err
	}
	if !state.guardTarget(profileID) {
		return nil
	}
	if !nextEnabled {
		return badRequest("Disable LiteLLM managed governance or choose a different target profile before disabling this gateway profile")
	}
	currentNormalized := normalizeOpenAiApiBase(currentAPIBase)
	nextNormalized := normalizeOpenAiApiBase(nextAPIBase)
	if currentNormalized != "" && nextNormalized != "" && currentNormalized != nextNormalized {
		return badRequest("Disable LiteLLM managed governance or choose a different target profile before changing this gateway profile apiBase")
	}
	return nil
}

// assertProfileDeletionAllowed mirrors
// LiteLlmProxyGovernanceService.assertProfileDeletionAllowed.
func (s *Service) assertProfileDeletionAllowed(ctx context.Context, profileID string) error {
	state, err := s.resolveGovernanceSettings(ctx)
	if err != nil {
		return err
	}
	if !state.guardTarget(profileID) {
		return nil
	}
	return badRequest("Disable LiteLLM managed governance or choose a different target profile before deleting this gateway profile")
}
