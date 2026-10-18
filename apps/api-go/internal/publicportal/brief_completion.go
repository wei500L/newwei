package publicportal

import (
	"context"
	"time"
)

// BriefCompletionMetadata is the model request metadata for the news-event
// brief. It is serialized verbatim into the upstream request body when the
// active profile has sendMetadata enabled, and it is the untyped-free input
// the request log policy later filters.
type BriefCompletionMetadata struct {
	Feature    string `json:"feature"`
	EventTitle string `json:"eventTitle"`
	Sources    int    `json:"sources"`
}

// BriefCompletionUsage is the token and cost accounting of one model call.
// A value the gateway did not report stays nil; it is never coerced to zero.
type BriefCompletionUsage struct {
	PromptTokens     *float64
	CompletionTokens *float64
	TotalTokens      *float64
	CostUSD          *float64
}

// BriefCompletionAttempt describes one real HTTP attempt: one model, one try.
// Nest writes exactly one LLM request log row per such attempt, including the
// failed ones.
type BriefCompletionAttempt struct {
	OrgID                     string
	Model                     string
	APISurface                string
	GatewayProfileID          string
	GovernanceApplied         bool
	AuthMode                  string
	GovernanceTargetProfileID string
	// Attempt is the 1-based try within one model; ModelIndex is the 1-based
	// position of the model in the primary-plus-fallback order.
	Attempt    int
	ModelIndex int
	Success    bool
	// Err is the attempt failure. It is nil on success.
	Err     error
	Latency time.Duration
	Usage   BriefCompletionUsage
	// Metadata is the unfiltered request metadata, exactly as sent upstream.
	Metadata BriefCompletionMetadata
}

// BriefCompletionObserver receives every real model attempt. Implementations
// must be safe to call synchronously from the completion loop and must not
// block the brief result on their own failures.
type BriefCompletionObserver interface {
	ObserveBriefCompletionAttempt(ctx context.Context, attempt BriefCompletionAttempt)
}

// BriefCompletionRequest is the strongly typed completion input. The caller
// owns prompt construction, JSON validation, sanitizing and cache write-back;
// this surface only performs the model call.
type BriefCompletionRequest struct {
	OrgID    string
	System   string
	User     string
	Metadata BriefCompletionMetadata
	Observer BriefCompletionObserver
}

// BriefCompletionResult is one successful completion.
type BriefCompletionResult struct {
	Content string
	Model   string
	Usage   BriefCompletionUsage
}

// BriefCompleter is the exported completion surface reused by the GraphQL
// news-event brief root. It never writes the brief cache.
type BriefCompleter interface {
	CompleteBrief(ctx context.Context, req BriefCompletionRequest) (BriefCompletionResult, error)
}

// NewBriefCompleter builds the production completer over the gateway settings
// reader. Configuration is resolved lazily on the first call: no model is
// probed at startup.
func NewBriefCompleter(settings BriefSettingsReader, env GatewayEnv) BriefCompleter {
	if settings == nil {
		return unavailableBriefCompleter{}
	}
	return newGateway(settings, env)
}

// CompleteBrief implements BriefCompleter.
func (g *gatewayClient) CompleteBrief(ctx context.Context, req BriefCompletionRequest) (BriefCompletionResult, error) {
	outcome, model, err := g.completeDetailed(ctx, completionRequest{
		OrgID:    req.OrgID,
		System:   req.System,
		User:     req.User,
		Metadata: req.Metadata,
	}, req.Observer)
	if err != nil {
		return BriefCompletionResult{}, err
	}
	return BriefCompletionResult{Content: outcome.Content, Model: model, Usage: outcome.Usage}, nil
}

// completeDetailed wraps complete and additionally reports which model
// produced the content. The model is captured through a one-shot observer so
// the attempt loop keeps a single code path.
func (g *gatewayClient) completeDetailed(ctx context.Context, req completionRequest, observer BriefCompletionObserver) (completionOutcome, string, error) {
	recorder := &completedModelRecorder{next: observer}
	outcome, err := g.complete(ctx, req, recorder)
	if err != nil {
		return completionOutcome{}, "", err
	}
	return outcome, recorder.model, nil
}

type completedModelRecorder struct {
	next  BriefCompletionObserver
	model string
}

func (r *completedModelRecorder) ObserveBriefCompletionAttempt(ctx context.Context, attempt BriefCompletionAttempt) {
	if attempt.Success && r.model == "" {
		r.model = attempt.Model
	}
	if r.next != nil {
		r.next.ObserveBriefCompletionAttempt(ctx, attempt)
	}
}

// unavailableBriefCompleter fails every call when the settings reader is
// missing. Registering the root in that state would otherwise panic later at
// the first request.
type unavailableBriefCompleter struct{}

func (unavailableBriefCompleter) CompleteBrief(context.Context, BriefCompletionRequest) (BriefCompletionResult, error) {
	return BriefCompletionResult{}, errCompletionUnavailable
}

var errCompletionUnavailable = errString("model gateway is not configured")
