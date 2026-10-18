package llmembed

import (
	"context"
	"strings"
	"time"
)

// RerankMinTimeoutMs is the floor the items-search rerank contract applies to a
// caller supplied timeout (NestJS uses Math.max(100, timeoutMs)).
const RerankMinTimeoutMs = 100

// Rerank status tokens of RerankOutcome, matching the LlmRequestLog status enum.
const (
	// RerankStatusSuccess means a model returned usable scores.
	RerankStatusSuccess = "success"
	// RerankStatusError means every configured model failed.
	RerankStatusError = "error"
)

// RerankOptions is the named per-request rerank contract. It exists alongside
// Rerank so a caller that needs a bounded per-request timeout, a fixed retry
// budget and the reviewable metadata/log surface can ask for them without
// changing the shared profile defaults every other embedding/rerank call uses.
type RerankOptions struct {
	// OrgID is the tenant the request belongs to.
	OrgID string
	// Query is the search term.
	Query string
	// Documents are the candidate documents, indexed by position.
	Documents []string
	// TimeoutMs is the per-request timeout; values below RerankMinTimeoutMs are
	// raised to it.
	TimeoutMs int
	// MaxRetries caps the attempts per model; values below 1 become 1.
	MaxRetries int
	// MetadataSource and MetadataStage are the Nest metadata tokens, sent only
	// when the resolved profile enables sendMetadata.
	MetadataSource string
	MetadataStage  string
}

// RerankOutcome is the named observation surface of one RerankWithOutcome call.
// The fields describe the request that actually ran, so a caller can persist
// the same request log NestJS writes without re-resolving the profile.
type RerankOutcome struct {
	// Hits are the scored documents when Status is success.
	Hits []Hit
	// Model is the model that produced the scores.
	Model string
	// Attempts is the 1-based index of the model that succeeded, or the number
	// of models tried on failure.
	Attempts int
	// Status is RerankStatusSuccess or RerankStatusError.
	Status string
	// LatencyMs is the wall-clock duration of the whole call.
	LatencyMs int64
	// ProfileID is the resolved gateway profile id.
	ProfileID string
	// GovernanceApplied reports whether the managed runtime key replaced the
	// profile key.
	GovernanceApplied bool
	// AuthMode is "profile_key" or "managed_runtime_key".
	AuthMode string
	// GovernanceTargetProfileID is the governance target profile id, when set.
	GovernanceTargetProfileID string
	// Error is a safe, non-secret failure description.
	Error string
}

// RerankWithOutcome ports LiteLlmService.rerank for the items-search relevance
// stage: it tries the configured rerank model then each fallback in order, with
// the caller's timeout and a single attempt per model, and reports the named
// observation result. The legacy Rerank method keeps the profile defaults.
func (c *Client) RerankWithOutcome(ctx context.Context, opts RerankOptions) (outcome RerankOutcome, err error) {
	outcome = RerankOutcome{Status: RerankStatusError, AuthMode: "profile_key"}
	started := time.Now()
	defer func() {
		outcome.LatencyMs = time.Since(started).Milliseconds()
	}()

	if len(opts.Documents) == 0 {
		outcome.Error = "rerank documents are required"
		return outcome, errRerankUnavailable
	}
	query := strings.TrimSpace(opts.Query)
	if query == "" {
		outcome.Error = "rerank query is required"
		return outcome, errRerankUnavailable
	}
	if err := ctx.Err(); err != nil {
		outcome.Error = "request cancelled"
		return outcome, err
	}

	profile, resolveErr := c.resolveRerank(ctx)
	if resolveErr != nil {
		if ctx.Err() != nil {
			outcome.Error = "request cancelled"
			return outcome, ctx.Err()
		}
		outcome.Error = "rerank profile is unavailable"
		return outcome, errRerankUnavailable
	}
	outcome.ProfileID = profile.ID
	outcome.AuthMode = profile.AuthMode
	if outcome.AuthMode == "" {
		outcome.AuthMode = "profile_key"
	}
	outcome.GovernanceApplied = profile.GovernanceApplied
	outcome.GovernanceTargetProfileID = profile.GovernanceTargetProfileID

	models := uniqueModels(append([]string{profile.RerankModel}, profile.RerankFallbacks...))
	if len(models) == 0 {
		outcome.Error = "rerank model is not configured"
		return outcome, errRerankUnavailable
	}

	timeout := time.Duration(opts.TimeoutMs) * time.Millisecond
	if timeout < RerankMinTimeoutMs*time.Millisecond {
		timeout = RerankMinTimeoutMs * time.Millisecond
	}
	maxRetries := opts.MaxRetries
	if maxRetries < 1 {
		maxRetries = 1
	}

	for index, model := range models {
		payload := map[string]any{
			"model":     model,
			"query":     query,
			"documents": opts.Documents,
			"top_n":     len(opts.Documents),
		}
		if profile.SendMetadata && (opts.MetadataSource != "" || opts.MetadataStage != "") {
			payload["metadata"] = requestMeta{Source: opts.MetadataSource, Stage: opts.MetadataStage}
		}
		raw, callErr := c.postWithRetryOptions(ctx, profile, "/v1/rerank", "/rerank", payload, timeout, maxRetries)
		outcome.Attempts = index + 1
		if callErr != nil {
			if ctx.Err() != nil {
				outcome.Error = "request cancelled"
				return outcome, ctx.Err()
			}
			continue
		}
		hits, parseErr := parseRerank(raw, len(opts.Documents))
		if parseErr != nil || len(hits) == 0 {
			continue
		}
		outcome.Hits = hits
		outcome.Model = model
		outcome.Status = RerankStatusSuccess
		outcome.Error = ""
		return outcome, nil
	}
	outcome.Error = "all configured rerank models failed"
	return outcome, errRerankUnavailable
}
