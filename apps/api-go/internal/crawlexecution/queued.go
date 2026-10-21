package crawlexecution

// The runTask entry points. The pipeline bridge calls RunTask synchronously
// after creating or reusing the task; the BullMQ crawl worker calls
// RunQueuedTask with the job's retry context and triggeredById. Both share one
// implementation so the pipeline path keeps exactly its previous behaviour: it
// passes no retry context and no triggeredById, which disables the retry
// decision and the completion/failure notifications.

import (
	"context"
	"log"
	"math"
	"time"
)

// runRetryContext is CrawlExecutionRetryContext for the worker path.
type runRetryContext struct {
	// Attempt is the 1-based attempt number BullMQ reports for the job.
	Attempt int
	// MaxAttempts is the job's attempts ceiling (>= 1).
	MaxAttempts int
	// BackoffDelayMs is the configured backoff interval, nil without a backoff
	// strategy.
	BackoffDelayMs *int
	// RequestTimeoutMs is the per-queue request timeout, 0 when unresolved.
	RequestTimeoutMs int
}

// runTaskRequest is one runTask invocation.
type runTaskRequest struct {
	OrgID         string
	TaskID        string
	TriggeredByID string
	// Retry is nil on the pipeline path, which is what makes a retryable error
	// terminate the task and skip the failure notification.
	Retry *runRetryContext
}

// runTaskContext is the resolved runTask scope handed to the try-block body.
type runTaskContext struct {
	Task          *taskRow
	OrgID         string
	SourceID      *string
	PipelineJobID *string
	TriggeredByID string
	Retry         *runRetryContext
	// RequestTimeoutMs is the value crawl4ai and the preflight use
	// (normalizeRequestTimeoutMs of the retry context).
	RequestTimeoutMs int
}

// RunTask is CrawlExecutionService.runTask for the pipeline call path. The
// pipeline bridge calls it synchronously with the task it just created or
// reused, so there is no triggeredById and no queue retry context (the NestJS
// signature accepts both; neither is present on this path).
func (s *Service) RunTask(ctx context.Context, orgID, taskID string) (Summary, error) {
	full, err := s.runTask(ctx, runTaskRequest{OrgID: orgID, TaskID: taskID})
	if err != nil {
		return Summary{}, err
	}
	return pipelineSummaryFrom(full), nil
}

// RunQueuedTask is CrawlExecutionService.runTask for the BullMQ worker path: the
// job carries triggeredById (the notification audience) and the retry context
// that decides whether a retryable failure re-queues the task.
func (s *Service) RunQueuedTask(
	ctx context.Context,
	orgID, taskID, triggeredByID string,
	options RunOptions,
) (FullSummary, error) {
	return s.runTask(ctx, runTaskRequest{
		OrgID:         orgID,
		TaskID:        taskID,
		TriggeredByID: triggeredByID,
		Retry: &runRetryContext{
			Attempt:          options.Attempt,
			MaxAttempts:      options.MaxAttempts,
			BackoffDelayMs:   options.BackoffDelayMs,
			RequestTimeoutMs: options.RequestTimeoutMs,
		},
	})
}

// runTask is runTask: load -> mark running -> sync queue counts -> try body,
// with the catch block as the error branch.
func (s *Service) runTask(ctx context.Context, request runTaskRequest) (FullSummary, error) {
	task, err := s.loadTask(ctx, request.OrgID, request.TaskID)
	if err != nil {
		return FullSummary{}, err
	}
	if task == nil {
		log.Printf("crawlexecution: attempted to run missing crawl task taskId=%s orgId=%s", request.TaskID, request.OrgID)
		return FullSummary{Inserted: 0, Skipped: 0}, nil
	}

	pipelineJobID := extractPipelineJobID(task.Config)
	sourceID := task.NewsSourceID
	if sourceID == nil {
		sourceID = extractPipelineSourceID(task.Config)
	}

	if err := s.markTaskRunning(ctx, task.ID); err != nil {
		return FullSummary{}, err
	}
	s.syncSourceQueueCounts(ctx, request.OrgID, sourceID)

	body := runTaskContext{
		Task:             task,
		OrgID:            request.OrgID,
		SourceID:         sourceID,
		PipelineJobID:    pipelineJobID,
		TriggeredByID:    request.TriggeredByID,
		Retry:            request.Retry,
		RequestTimeoutMs: request.Retry.normalizedRequestTimeoutMs(),
	}
	summary, runErr := s.runTaskBody(ctx, &body)
	if runErr != nil {
		s.handleRunError(ctx, body, runErr)
		return FullSummary{}, runErr
	}
	return summary, nil
}

// normalizedRequestTimeoutMs is
// CrawlConditionalPreflightService.normalizeRequestTimeoutMs(retryContext?.requestTimeoutMs).
// A nil retry context has no requestTimeoutMs member, so the pipeline path keeps
// normalizing zero.
func (c *runRetryContext) normalizedRequestTimeoutMs() int {
	if c == nil {
		return normalizeRequestTimeoutMs(0)
	}
	return normalizeRequestTimeoutMs(c.RequestTimeoutMs)
}

// shouldRetry is the catch-block decision:
//
//	retryable && typeof attempt === "number" && typeof maxAttempts === "number"
//	          && attempt < maxAttempts
//
// A nil context (pipeline path) never retries, which keeps the previous
// behaviour where a retryable error still terminates the task.
func (c *runRetryContext) shouldRetry(retryable bool) bool {
	if c == nil || !retryable {
		return false
	}
	return c.Attempt < c.MaxAttempts
}

// nextRetryAt is the catch-block nextRetryAt: Date.now() plus the backoff delay,
// floored at zero, or nil when the task will not be retried or the job carries
// no backoff interval.
func (c *runRetryContext) nextRetryAt(now time.Time, shouldRetry bool) *time.Time {
	if c == nil || !shouldRetry || c.BackoffDelayMs == nil {
		return nil
	}
	delay := *c.BackoffDelayMs
	if delay < 0 {
		delay = 0
	}
	value := now.Add(time.Duration(delay) * time.Millisecond)
	return &value
}

// attemptLogValue is the PipelineJob attempts value:
// `typeof attempt === "number" ? Math.max(0, attempt) : 0`.
func (c *runRetryContext) attemptLogValue() int {
	if c == nil {
		return 0
	}
	return maxInt(c.Attempt, 0)
}

// jsRound is Math.round: half rounds toward positive infinity.
func jsRound(value float64) float64 {
	return math.Floor(value + 0.5)
}
