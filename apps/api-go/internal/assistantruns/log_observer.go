package assistantruns

import (
	"context"
	"log"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/llmlogs"
	"github.com/wei500L/newwei/apps/api-go/internal/publicportal"
)

// LLMLogObserver persists one llmrequestlogs row per model attempt. The monthly
// assistant token budget aggregates this collection by the feature prefix, so
// every attempt (including failed fallbacks) must be written with feature
// "assistant".
type LLMLogObserver struct {
	writer *llmlogs.CompletionWriter
}

// NewLLMLogObserver builds the observer. A nil writer yields a no-op observer.
func NewLLMLogObserver(writer *llmlogs.CompletionWriter) RequestLogger {
	if writer == nil {
		return nil
	}
	return &LLMLogObserver{writer: writer}
}

// ObserveAssistantAttempt writes one row. Logging is best effort: a write
// failure is a warning and never fails the assistant run.
func (o *LLMLogObserver) ObserveAssistantAttempt(ctx context.Context, attempt publicportal.AssistantAttempt, source string) {
	if o == nil || o.writer == nil {
		return
	}
	if attempt.ModelIndex > 1 && source != "" {
		log.Printf("api-go: assistant %s falling back to model %q (index %d)", source, attempt.Model, attempt.ModelIndex)
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
		Feature:                   "assistant",
		GatewayProfileID:          attempt.GatewayProfileID,
		GovernanceApplied:         &applied,
		AuthMode:                  attempt.AuthMode,
		GovernanceTargetProfileID: attempt.GovernanceTargetProfileID,
		APISurface:                attempt.APISurface,
		Metadata:                  &llmlogs.CompletionMetadata{Feature: "assistant"},
		OccurredAt:                time.Now().UTC(),
	}
	if err := o.writer.WriteAttempt(ctx, entry); err != nil {
		log.Printf("api-go: assistant LLM request log write failed: %v", err)
	}
}
