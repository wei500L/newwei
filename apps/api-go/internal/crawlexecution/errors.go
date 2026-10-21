package crawlexecution

// Error classification and the catch-block side effects of runTask:
// CrawlTask status/lastError, the error TaskLog, the PipelineJob failure update,
// the news source failure state and the failure notification.

import (
	"context"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/crawl4ai"
)

// maxErrorMessageLength is the runTask normalizedMessage ceiling.
const maxErrorMessageLength = 4000

// handleRunError is the catch block of runTask.
//
// The retry context decides whether the task is re-queued (CrawlTask status
// "queued") or terminated ("failed"). The pipeline path has no retry context, so
// a retryable error still terminates the task as before; the worker path keeps
// the job retry BullMQ itself schedules.
func (s *Service) handleRunError(ctx context.Context, scope runTaskContext, runErr error) {
	task := scope.Task
	orgID := scope.OrgID
	sourceID := scope.SourceID
	pipelineJobID := scope.PipelineJobID

	message := strings.TrimSpace(runErr.Error())
	if message == "" {
		message = "crawl job failed"
	}
	normalizedMessage := truncateMessage(message, maxErrorMessageLength)
	retryable := isRetryableCrawlError(runErr, message)
	shouldRetry := scope.Retry.shouldRetry(retryable)
	crawlTaskStatus := "failed"
	if shouldRetry {
		crawlTaskStatus = "queued"
	}
	nextRetryAt := scope.Retry.nextRetryAt(s.now().UTC(), shouldRetry)

	s.markTaskFailed(ctx, task, crawlTaskStatus, normalizedMessage)
	s.syncSourceQueueCounts(ctx, orgID, sourceID)

	errorLogData := map[string]any{
		"attempt":        nil,
		"maxAttempts":    nil,
		"backoffDelayMs": nil,
		"retryable":      retryable,
		"willRetry":      shouldRetry,
		"nextRetryAt":    nil,
	}
	if scope.Retry != nil {
		errorLogData["attempt"] = scope.Retry.Attempt
		errorLogData["maxAttempts"] = scope.Retry.MaxAttempts
		if scope.Retry.BackoffDelayMs != nil {
			errorLogData["backoffDelayMs"] = *scope.Retry.BackoffDelayMs
		}
	}
	if nextRetryAt != nil {
		errorLogData["nextRetryAt"] = isoMillisJS(*nextRetryAt)
	}
	s.writeTaskLog(ctx, taskLogEntry{
		Queue:  crawlQueueName,
		JobID:  task.ID,
		OrgID:  orgID,
		Stage:  "error",
		Status: "failed",
		Error:  sanitizeError(runErr),
		Data:   errorLogData,
	})

	if pipelineJobID != nil && *pipelineJobID != "" {
		if err := s.updatePipelineJobFailure(ctx, *pipelineJobID, normalizedMessage, shouldRetry, scope.Retry.attemptLogValue()); err != nil {
			log.Printf("crawlexecution: failed to update pipeline job status for crawl failure pipelineJobId=%s taskId=%s: %v",
				*pipelineJobID, task.ID, err)
		}
	}
	// The circuit breaker only counts terminal failures: a task BullMQ will
	// retry has not failed the source yet.
	if sourceID != nil && *sourceID != "" && pipelineJobID != nil && *pipelineJobID != "" && !shouldRetry {
		s.markSourceFailureState(ctx, *sourceID, s.now().UTC())
	}
	// The failure notification is only sent once the task stops retrying, so a
	// retried job never notifies twice.
	if scope.TriggeredByID != "" && !shouldRetry {
		s.safeNotifyCrawl(ctx, task, FullSummary{Inserted: 0, Skipped: 0},
			scope.TriggeredByID, notificationStatusFailed, normalizedMessage)
	}
}

// updatePipelineJobFailure is pipelineJob.updateMany for the failure status. A
// retried job goes back to "delayed" with no completedAt; a terminal one is
// "failed" with the completion timestamp.
func (s *Service) updatePipelineJobFailure(ctx context.Context, pipelineJobID, message string, shouldRetry bool, attempts int) error {
	if s.db == nil {
		return errNotConfigured("crawlexecution: mysql is not configured")
	}
	now := s.now().UTC().Truncate(time.Millisecond)
	status := "failed"
	var completedAt any = now
	if shouldRetry {
		status = "delayed"
		completedAt = nil
	}
	_, err := s.db.ExecContext(ctx,
		"UPDATE `PipelineJob` SET `status` = ?, `completedAt` = ?, `error` = ?, `attempts` = ?, `updatedAt` = ? WHERE `id` = ?",
		status, completedAt, message, maxInt(attempts, 0), now, pipelineJobID)
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
