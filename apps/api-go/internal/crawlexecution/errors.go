package crawlexecution

// Error classification and the catch-block side effects of runTask:
// CrawlTask status/lastError, the error TaskLog, the PipelineJob failure update
// and the news source failure state.

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/crawl4ai"
)

// maxErrorMessageLength is the runTask normalizedMessage ceiling.
const maxErrorMessageLength = 4000

// handleRunError is the catch block of runTask.
func (s *Service) handleRunError(ctx context.Context, task *taskRow, orgID string, sourceID, pipelineJobID *string, runErr error) {
	message := strings.TrimSpace(runErr.Error())
	if message == "" {
		message = "crawl job failed"
	}
	normalizedMessage := truncateMessage(message, maxErrorMessageLength)
	retryable := isRetryableCrawlError(runErr, message)
	// The pipeline call path passes no retry context, so a retryable error still
	// terminates the task as failed (the pipeline schedules its own retry).
	shouldRetry := false
	crawlTaskStatus := "failed"

	s.markTaskFailed(ctx, task, crawlTaskStatus, normalizedMessage)
	s.syncSourceQueueCounts(ctx, orgID, sourceID)

	s.writeTaskLog(ctx, taskLogEntry{
		Queue:  crawlQueueName,
		JobID:  task.ID,
		OrgID:  orgID,
		Stage:  "error",
		Status: "failed",
		Error:  sanitizeError(runErr),
		Data: map[string]any{
			"attempt":        nil,
			"maxAttempts":    nil,
			"backoffDelayMs": nil,
			"retryable":      retryable,
			"willRetry":      shouldRetry,
			"nextRetryAt":    nil,
		},
	})

	if pipelineJobID != nil && *pipelineJobID != "" {
		if err := s.updatePipelineJobFailure(ctx, *pipelineJobID, normalizedMessage, shouldRetry); err != nil {
			log.Printf("crawlexecution: failed to update pipeline job status for crawl failure pipelineJobId=%s taskId=%s: %v",
				*pipelineJobID, task.ID, err)
		}
	}
	if sourceID != nil && *sourceID != "" && pipelineJobID != nil && *pipelineJobID != "" && !shouldRetry {
		s.markSourceFailureState(ctx, *sourceID, s.now().UTC())
	}
}

// updatePipelineJobFailure is pipelineJob.updateMany for the failure status.
func (s *Service) updatePipelineJobFailure(ctx context.Context, pipelineJobID, message string, shouldRetry bool) error {
	if s.db == nil {
		return errNotConfigured("crawlexecution: mysql is not configured")
	}
	now := s.now().UTC().Truncate(time.Millisecond)
	status := "failed"
	var completedAt any = now
	attempts := 0
	if shouldRetry {
		status = "delayed"
		completedAt = nil
	}
	_, err := s.db.ExecContext(ctx,
		"UPDATE `PipelineJob` SET `status` = ?, `completedAt` = ?, `error` = ?, `attempts` = ?, `updatedAt` = ? WHERE `id` = ?",
		status, completedAt, message, attempts, now, pipelineJobID)
	if err != nil {
		return fmt.Errorf("crawlexecution: update pipeline job: %w", err)
	}
	return nil
}

// retryableCrawlStatusCodes is CrawlExecutionResultsService's set.
var retryableCrawlStatusCodes = map[int]struct{}{
	408: {}, 423: {}, 425: {}, 429: {}, 500: {}, 502: {}, 503: {}, 504: {},
}

// isRetryableCrawlError is the catch-block retryable decision: the crawl4ai
// exception status first, then the message needle list.
func isRetryableCrawlError(err error, message string) bool {
	status := crawl4ai.StatusOf(err)
	if _, ok := retryableCrawlStatusCodes[status]; ok {
		return true
	}
	return isRetryableStatus(nil, message)
}

// truncateMessage is the normalizedMessage construction: trim, fall back to the
// generic message when blank and cut to the limit with an ellipsis.
func truncateMessage(message string, maxLength int) string {
	trimmed := strings.TrimSpace(message)
	if trimmed == "" {
		trimmed = "crawl job failed"
	}
	runes := []rune(trimmed)
	if len(runes) <= maxLength {
		return trimmed
	}
	head := strings.TrimRight(string(runes[:maxLength-1]), " ")
	return head + "…"
}

// sanitizeError is sanitizeError({redactSensitive:true}) for the task-log error
// leaf. The crawl errors never carry the api key or the proxy credentials, so
// only the message projection is kept here.
func sanitizeError(err error) map[string]any {
	if err == nil {
		return nil
	}
	return map[string]any{
		"message": strings.TrimSpace(err.Error()),
	}
}

// taskLogErrorMessage is the TaskLog error leaf for a plain string message.
func taskLogErrorMessage(message string) map[string]any {
	if strings.TrimSpace(message) == "" {
		return nil
	}
	return map[string]any{"message": strings.TrimSpace(message)}
}

// jsonRawOrNull returns the raw JSON value or nil.
func jsonRawOrNull(raw json.RawMessage) any {
	if len(raw) == 0 {
		return nil
	}
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil
	}
	return value
}

// durationMillis is a helper for task-log duration fields.
func durationMillis(start time.Time, end time.Time) int64 {
	return end.Sub(start).Milliseconds()
}
