package newsevents

import (
	"context"
	"log"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/llmlogs"
	"github.com/wei500L/newwei/apps/api-go/internal/publicportal"
)

// briefAttemptObserver persists one llmrequestlogs row per real model attempt.
// Nest writes exactly one row per attempt, including the failed ones, so a
// forceRefresh or a cold generation leaves an audit trail. Logging is best
// effort: a write failure is a warning and never fails the generated brief.
type briefAttemptObserver struct {
	writer *llmlogs.CompletionWriter
}

func newBriefAttemptObserver(writer *llmlogs.CompletionWriter) publicportal.BriefCompletionObserver {
	if writer == nil {
		return nil
	}
	return briefAttemptObserver{writer: writer}
}

func (o briefAttemptObserver) ObserveBriefCompletionAttempt(ctx context.Context, attempt publicportal.BriefCompletionAttempt) {
	// The primary model is index 1; anything above it is a fallback switch.
	// Nest records the switch through recordModelFallbackOrWarn; here the log
	// row already carries the model, and this warning keeps the transition
	// visible without introducing a metrics surface.
	if attempt.ModelIndex > 1 && attempt.Attempt == 1 {
		log.Printf("api-go: news event brief falling back to model %q (index %d)", attempt.Model, attempt.ModelIndex)
	}
	status := "success"
	message := ""
	if !attempt.Success {
		status = "error"
		if attempt.Err != nil {
			message = attempt.Err.Error()
		}
	}
	applied := attempt.GovernanceApplied
	entry := llmlogs.CompletionLogEntry{
		OrgID:   attempt.OrgID,
		Model:   attempt.Model,
		Status:  status,
		Error:   message,
		Latency: attempt.Latency,
		Usage: llmlogs.CompletionUsage{
			PromptTokens:     attempt.Usage.PromptTokens,
			CompletionTokens: attempt.Usage.CompletionTokens,
			TotalTokens:      attempt.Usage.TotalTokens,
			CostUSD:          attempt.Usage.CostUSD,
		},
		Feature:                   attempt.Metadata.Feature,
		GatewayProfileID:          attempt.GatewayProfileID,
		GovernanceApplied:         &applied,
		AuthMode:                  attempt.AuthMode,
		GovernanceTargetProfileID: attempt.GovernanceTargetProfileID,
		APISurface:                attempt.APISurface,
		Metadata: &llmlogs.CompletionMetadata{
			Feature:    attempt.Metadata.Feature,
			EventTitle: attempt.Metadata.EventTitle,
			Sources:    attempt.Metadata.Sources,
		},
		OccurredAt: time.Now().UTC(),
	}
	if err := o.writer.WriteAttempt(ctx, entry); err != nil {
		log.Printf("api-go: news event brief LLM request log write failed: %v", err)
	}
}
