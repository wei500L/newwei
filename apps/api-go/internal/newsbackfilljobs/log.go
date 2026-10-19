package newsbackfilljobs

import (
	"context"
	"log"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/llmlogs"
	"github.com/wei500L/newwei/apps/api-go/internal/publicportal"
)

// decisionObserver writes one llmrequestlogs row per real model attempt of the
// clustering LLM backfill. Logging is best effort: a failed write is a warning
// and never changes the group status or the worker result.
type decisionObserver struct {
	writer *llmlogs.CompletionWriter
}

// newDecisionObserver returns nil when no writer is configured, so the
// completion surface skips the observer entirely.
func newDecisionObserver(writer *llmlogs.CompletionWriter) publicportal.ClusteringDecisionObserver {
	if writer == nil {
		return nil
	}
	return decisionObserver{writer: writer}
}

func (o decisionObserver) ObserveClusteringDecisionAttempt(ctx context.Context, attempt publicportal.ClusteringDecisionAttempt) {
	if o.writer == nil {
		return
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
	entry := llmlogs.ClusteringDecisionLogEntry{
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
		Metadata: &llmlogs.ClusteringDecisionMetadata{
			Feature:            attempt.Metadata.Feature,
			CandidateCount:     attempt.Metadata.CandidateCount,
			ArticleFingerprint: attempt.Metadata.ArticleFingerprint,
		},
		OccurredAt: time.Now().UTC().Truncate(time.Millisecond),
	}
	if err := o.writer.WriteClusteringDecision(ctx, entry); err != nil {
		log.Printf("newsbackfilljobs: clustering LLM request log write failed: %v", err)
	}
}
