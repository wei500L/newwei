package crawlworker

// One claimed BullMQ job, from the concurrency slot to the Redis transition.
//
// The attempt reproduces the CrawlQueueProcessor handler body: resolve the retry
// context, run the task or the Frontier node, then apply the NestJS error
// classification in the same order (memory pressure, retryable, unrecoverable)
// and perform exactly one BullMQ transition. The B1 side effects
// (crawl:activity, CrawlTask status, ops snapshot) run here too, once, after the
// transition succeeded — the QueueEvents readers that performed them in NestJS
// are not migrated.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"

	"github.com/wei500L/newwei/apps/api-go/internal/crawlqueue"
)

// jobTransitions is the BullMQ state-machine subset one attempt drives. The
// production implementation is *queueRuntime (vendored Lua over Redis); unit
// tests substitute a fake so the decision logic runs without Redis.
type jobTransitions interface {
	// UpdateData is Job.updateData (the updateData script).
	UpdateData(ctx context.Context, job claimedJob, data []byte) error
	// MoveToCompleted is Job.moveToCompleted (moveToFinished target completed).
	MoveToCompleted(ctx context.Context, job claimedJob, returnValue json.RawMessage, maxAttempts int) error
	// MoveToFailed is the final failure form of Job.moveToFailed
	// (moveToFinished target failed), used for terminal failures only.
	MoveToFailed(ctx context.Context, job claimedJob, reason string, maxAttempts int) error
	// Retry is Job.moveToFailed with a retry and no backoff delay (retryJob).
	Retry(ctx context.Context, job claimedJob, reason string) error
	// RetryLater is Job.moveToFailed with a backoff delay (moveToDelayed).
	RetryLater(ctx context.Context, job claimedJob, reason string, delayMs int64) error
	// MoveToWait is Job.moveToWait (moveJobFromActiveToWait): the job returns to
	// the wait/prioritized list without consuming an attempt. It returns the
	// limiter PTTL the worker uses to pause its fetch loop.
	MoveToWait(ctx context.Context, job claimedJob) (int64, error)
}

// queueTarget is the queue a job belongs to: the name and priority class the
// NestJS worker context carried, plus its transitions.
type queueTarget struct {
	Name        string
	Class       crawlqueue.PriorityClass
	Transitions jobTransitions
}

// attemptOutcome is what one attempt did with its job. The fetch loop only needs
// it for logging and tests; the Redis transition already happened.
type attemptOutcome int

const (
	// outcomeAbandoned means no terminal transition was written: the job stays in
	// the active list and BullMQ stalled recovery re-delivers it.
	outcomeAbandoned attemptOutcome = iota
	// outcomeCompleted means moveToFinished(completed) succeeded.
	outcomeCompleted
	// outcomeUnrecoverable means the job was moved straight to failed.
	outcomeUnrecoverable
	// outcomeRetried means the job returned to wait or moved to delayed with
	// attempts remaining.
	outcomeRetried
	// outcomeFailed means the last attempt failed and the job entered the failed
	// set.
	outcomeFailed
	// outcomeRateLimited means the memory pressure path requeued the job through
	// moveJobFromActiveToWait without consuming an attempt.
	outcomeRateLimited
)

// String renders the outcome for logs.
func (o attemptOutcome) String() string {
	switch o {
	case outcomeAbandoned:
		return "abandoned"
	case outcomeCompleted:
		return "completed"
	case outcomeUnrecoverable:
		return "unrecoverable"
	case outcomeRetried:
		return "retried"
	case outcomeFailed:
		return "failed"
	case outcomeRateLimited:
		return "rate-limited"
	default:
		return "unknown"
	}
}

// attempt runs one claimed job. It holds the dependencies the handler needs and is
// shared by the queue runtimes.
type attempt struct {
	runner       TaskRunner
	frontier     FrontierNodeProcessor
	limiter      *concurrencyLimiter
	settings     settingsProvider
	activity     ActivityCounter
	tasks        taskStore
	snapshots    Snapshots
	rateLimitAll func(ctx context.Context, cooldownMs int64) error
	config       Config
	log          func(format string, args ...any)
}

// run is the CrawlQueueProcessor handler. The limiter slot is released when the
// attempt returns, exactly like the `finally releaseConcurrency()` block.
func (a *attempt) run(ctx context.Context, target queueTarget, job claimedJob) attemptOutcome {
	a.logf("crawlworker: processing crawl job queue=%s jobId=%s taskId=%s jobKind=%s frontierNodeId=%s",
		target.Name, job.ID, job.Data.TaskID, job.Data.JobKind, job.Data.FrontierNodeID)

	// A deferred failure (`defa`) is stamped by moveStalledJobsToWait when a job
	// exceeded maxStalledCount. BullMQ fails such a job before running the
	// processor, so the crawl handler (and the concurrency slot) is skipped and
	// the message becomes the UnrecoverableError text.
	if job.DeferredFailure != "" {
		a.logf("crawlworker: crawl job carries a deferred failure queue=%s jobId=%s taskId=%s: %s",
			target.Name, job.ID, job.Data.TaskID, job.DeferredFailure)
		deferredCtx, cancelDeferred := context.WithTimeout(context.Background(), transitionTimeout)
		defer cancelDeferred()
		return a.failUnrecoverable(deferredCtx, target, job, errors.New(job.DeferredFailure))
	}

	slot, err := a.limiter.acquire(ctx, target.Class)
	if err != nil {
		a.logf("crawlworker: no crawl concurrency slot for queue=%s jobId=%s taskId=%s: %v; leaving the job to stalled recovery",
			target.Name, job.ID, job.Data.TaskID, err)
		return outcomeAbandoned
	}
	defer slot()

	maxAttempts := job.Attempts()
	attemptsStarted := resolveAttemptsStarted(job.AttemptsStarted, job.AttemptsMade)
	attemptNumber := resolveAttempt(maxAttempts, attemptsStarted)
	backoffDelayMs := resolveBackoffDelayMs(job.Opts.Backoff, attemptNumber)
	requestTimeoutMs := a.resolveRequestTimeout(ctx, target.Class)

	value, runErr := a.execute(ctx, job, RunOptions{
		Attempt:          attemptNumber,
		MaxAttempts:      maxAttempts,
		BackoffDelayMs:   backoffDelayMs,
		PriorityClass:    string(target.Class),
		RequestTimeoutMs: requestTimeoutMs,
	})
	// A canceled context is a lost lock or a shutdown deadline: the attempt must
	// not record a terminal state, the job stays active for stalled recovery.
	if ctx.Err() != nil {
		a.logf("crawlworker: crawl attempt canceled queue=%s jobId=%s taskId=%s: %v; leaving the job to stalled recovery",
			target.Name, job.ID, job.Data.TaskID, context.Cause(ctx))
		return outcomeAbandoned
	}
	// The transition must not inherit the attempt context: the lock renewal may
	// cancel it while the attempt is still acknowledging, and Close cancels the
	// fetch context while jobs drain.
	transitionCtx, cancelTransition := context.WithTimeout(context.Background(), transitionTimeout)
	defer cancelTransition()

	if runErr == nil {
		return a.finishCompleted(transitionCtx, target, job, value, maxAttempts)
	}
	return a.handleFailure(transitionCtx, target, job, runErr, maxAttempts, attemptsStarted)
}

// execute runs the task or the Frontier node and returns the BullMQ returnvalue.
func (a *attempt) execute(ctx context.Context, job claimedJob, options RunOptions) (json.RawMessage, error) {
	if job.Data.IsFrontierNode() {
		return a.frontier.ProcessQueuedNode(ctx, job.Data.FrontierNodeID, job.Data.OrgID, options.RequestTimeoutMs)
	}
	if a.runner == nil {
		return nil, errNoTaskRunner
	}
	triggeredByID := ""
	if job.Data.TriggeredByID != nil {
		triggeredByID = *job.Data.TriggeredByID
	}
	summary, err := a.runner.RunQueuedTask(ctx, job.Data.OrgID, job.Data.TaskID, triggeredByID, options)
	if err != nil {
		return nil, err
	}
	encoded, err := json.Marshal(summary)
	if err != nil {
		return nil, fmt.Errorf("crawlworker: encode crawl summary for task %s: %w", job.Data.TaskID, err)
	}
	return encoded, nil
}

// resolveRequestTimeout is resolveQueueTimeoutMs: the settings value of the
// queue class, then CRAWL4AI_TIMEOUT_MS, then 120s.
func (a *attempt) resolveRequestTimeout(ctx context.Context, class crawlqueue.PriorityClass) int {
	settings, err := a.settings.Read(ctx)
	if err != nil {
		a.logf("crawlworker: failed to resolve the crawl timeout tier for %s: %v; using the env fallback", class, err)
		// The NestJS catch branch discards the settings document entirely, so a
		// partially populated value must not win over CRAWL4AI_TIMEOUT_MS.
		settings = crawlqueue.Settings{}
	}
	return resolveRequestTimeoutMs(class, settings, a.config.DefaultTimeoutMs)
}

// finishCompleted acknowledges the job and applies the completion side effects.
func (a *attempt) finishCompleted(ctx context.Context, target queueTarget, job claimedJob, returnValue json.RawMessage, maxAttempts int) attemptOutcome {
	if err := target.Transitions.MoveToCompleted(ctx, job, returnValue, maxAttempts); err != nil {
		a.logf("crawlworker: failed to finish crawl job queue=%s jobId=%s taskId=%s as completed: %v; leaving it to stalled recovery",
			target.Name, job.ID, job.Data.TaskID, err)
		return outcomeAbandoned
	}
	a.completedSideEffects(ctx, target, job)
	return outcomeCompleted
}

// handleFailure is the NestJS catch block, in the same order: memory pressure
// first (its own requeue budget and cooldown), then the retryable split.
func (a *attempt) handleFailure(ctx context.Context, target queueTarget, job claimedJob, cause error, maxAttempts, attemptsStarted int) attemptOutcome {
	if isMemoryPressureError(cause) {
		return a.handleMemoryPressure(ctx, target, job, cause, maxAttempts, attemptsStarted)
	}
	if !isRetryableError(cause) {
		return a.failUnrecoverable(ctx, target, job, cause)
	}
	return a.failNormally(ctx, target, job, cause)
}

// handleMemoryPressure is the crawl4ai memory pressure fallback: exhaust the
// requeue budget as an unrecoverable failure, otherwise rate limit every crawl
// queue of this process, persist the requeue counter and move the job back to
// wait with a RateLimitError.
func (a *attempt) handleMemoryPressure(ctx context.Context, target queueTarget, job claimedJob, cause error, maxAttempts, attemptsStarted int) attemptOutcome {
	requeues := job.Data.MemoryPressureRequeues
	if attemptsStarted >= maxAttempts || requeues >= maxAttempts-1 {
		a.logf("crawlworker: crawl4ai memory pressure retry budget exhausted queue=%s jobId=%s taskId=%s attemptsStarted=%d maxAttempts=%d memoryPressureRequeues=%d; failing the job as unrecoverable",
			target.Name, job.ID, job.Data.TaskID, attemptsStarted, maxAttempts, requeues)
		return a.failUnrecoverable(ctx, target, job, cause)
	}

	configuredCooldownMs := memoryPressureDefaultCooldownMs
	if settings, err := a.settings.Read(ctx); err != nil {
		a.logf("crawlworker: failed to load crawl settings for the memory pressure cooldown: %v; using the default", err)
	} else {
		configuredCooldownMs = settings.QueueOverloadCooldownMs
	}
	memoryPercent := extractMemoryPressurePercent(cause)
	cooldownMs := resolveQueueOverloadCooldownMs(configuredCooldownMs, memoryPercent)

	if err := a.rateLimitAll(ctx, int64(cooldownMs)); err != nil {
		a.logf("crawlworker: failed to apply the crawl queue rate limit during the memory pressure fallback queue=%s jobId=%s taskId=%s cooldownMs=%d: %v",
			target.Name, job.ID, job.Data.TaskID, cooldownMs, err)
		// The NestJS handler rethrows the original crawl error here, so BullMQ's
		// normal retry/fail decision applies to this attempt.
		return a.failNormally(ctx, target, job, cause)
	}

	nextRequeues := requeues + 1
	if err := persistMemoryPressureRequeues(ctx, target.Transitions, job, nextRequeues); err != nil {
		a.logf("crawlworker: failed to persist the memory pressure retry state queue=%s jobId=%s taskId=%s nextRequeues=%d maxAttempts=%d: %v; failing the job as unrecoverable",
			target.Name, job.ID, job.Data.TaskID, nextRequeues, maxAttempts, err)
		return a.failUnrecoverable(ctx, target, job, cause)
	}

	if _, err := target.Transitions.MoveToWait(ctx, job); err != nil {
		a.logf("crawlworker: failed to move the memory pressure job back to wait queue=%s jobId=%s taskId=%s: %v; leaving it to stalled recovery",
			target.Name, job.ID, job.Data.TaskID, err)
		return outcomeAbandoned
	}
	percentText := "none"
	if memoryPercent != nil {
		percentText = strconv.FormatFloat(*memoryPercent, 'f', -1, 64)
	}
	a.logf("crawlworker: crawl4ai memory pressure detected queue=%s jobId=%s taskId=%s cooldownMs=%d memoryPercent=%s memoryPressureRequeues=%d maxAttempts=%d error=%s; requeued the job with a queue-wide cooldown",
		target.Name, job.ID, job.Data.TaskID, cooldownMs, percentText, nextRequeues, maxAttempts, truncateText(errorMessage(cause), 500))
	return outcomeRateLimited
}

// failUnrecoverable is the UnrecoverableError branch: moveToFinished("failed")
// immediately, even while attempts remain, and then apply the failure side
// effects.
func (a *attempt) failUnrecoverable(ctx context.Context, target queueTarget, job claimedJob, cause error) attemptOutcome {
	failure := newUnrecoverableError(cause)
	if err := target.Transitions.MoveToFailed(ctx, job, failure.Error(), job.Attempts()); err != nil {
		a.logf("crawlworker: failed to move the unrecoverable crawl job queue=%s jobId=%s taskId=%s to failed: %v; leaving it to stalled recovery",
			target.Name, job.ID, job.Data.TaskID, err)
		return outcomeAbandoned
	}
	a.logf("crawlworker: crawl job failed queue=%s jobId=%s taskId=%s unrecoverable=true error=%s",
		target.Name, job.ID, job.Data.TaskID, truncateText(failure.Error(), 500))
	a.failedSideEffects(ctx, target, job, failure.Error())
	return outcomeUnrecoverable
}

// failNormally is the generic failure path: BullMQ decides between a retry
// (retryJob without a backoff delay, moveToDelayed with one) and the final
// failure, exactly like Job.shouldRetryJob.
func (a *attempt) failNormally(ctx context.Context, target queueTarget, job claimedJob, cause error) attemptOutcome {
	reason := errorMessage(cause)
	maxAttempts := job.Attempts()
	if job.AttemptsMade+1 < maxAttempts {
		// Backoffs.calculate receives attemptsMade + 1, the attempt that just
		// failed, not the attempt counter the execution retry context uses.
		delay := resolveBackoffDelayMs(job.Opts.Backoff, job.AttemptsMade+1)
		if delay != nil && *delay > 0 {
			if err := target.Transitions.RetryLater(ctx, job, reason, int64(*delay)); err != nil {
				a.logf("crawlworker: failed to delay the crawl job retry queue=%s jobId=%s taskId=%s delayMs=%d: %v; leaving it to stalled recovery",
					target.Name, job.ID, job.Data.TaskID, *delay, err)
				return outcomeAbandoned
			}
			a.logf("crawlworker: crawl job retry scheduled queue=%s jobId=%s taskId=%s delayMs=%d attemptsMade=%d maxAttempts=%d error=%s",
				target.Name, job.ID, job.Data.TaskID, *delay, job.AttemptsMade, maxAttempts, truncateText(reason, 500))
			return outcomeRetried
		}
		if err := target.Transitions.Retry(ctx, job, reason); err != nil {
			a.logf("crawlworker: failed to retry the crawl job queue=%s jobId=%s taskId=%s: %v; leaving it to stalled recovery",
				target.Name, job.ID, job.Data.TaskID, err)
			return outcomeAbandoned
		}
		a.logf("crawlworker: crawl job retry scheduled queue=%s jobId=%s taskId=%s attemptsMade=%d maxAttempts=%d error=%s",
			target.Name, job.ID, job.Data.TaskID, job.AttemptsMade, maxAttempts, truncateText(reason, 500))
		return outcomeRetried
	}
	if err := target.Transitions.MoveToFailed(ctx, job, reason, maxAttempts); err != nil {
		a.logf("crawlworker: failed to move the crawl job queue=%s jobId=%s taskId=%s to failed: %v; leaving it to stalled recovery",
			target.Name, job.ID, job.Data.TaskID, err)
		return outcomeAbandoned
	}
	a.logf("crawlworker: crawl job failed queue=%s jobId=%s taskId=%s attemptsMade=%d maxAttempts=%d error=%s",
		target.Name, job.ID, job.Data.TaskID, job.AttemptsMade, maxAttempts, truncateText(reason, 500))
	a.failedSideEffects(ctx, target, job, reason)
	return outcomeFailed
}

// persistMemoryPressureRequeues is persistMemoryPressureRequeueCount: rewrite the
// job hash `data` with memoryPressureRequeues incremented by one, preserving the
// original key order (an object spread appends a new key and keeps existing
// positions).
func persistMemoryPressureRequeues(ctx context.Context, transitions jobTransitions, job claimedJob, nextRequeues int) error {
	if len(job.rawData) == 0 {
		return errJobPayloadMissing
	}
	nextData, err := withJSONIntegerField(job.rawData, "memoryPressureRequeues", nextRequeues)
	if err != nil {
		return err
	}
	if err := transitions.UpdateData(ctx, job, nextData); err != nil {
		return fmt.Errorf("crawlworker: update crawl job data: %w", err)
	}
	return nil
}

// completedSideEffects is the B1 'completed' side effect, applied once after the
// completion transition: only plain crawl tasks (no jobKind) were counted by
// markTaskQueued, so only they decrement the counter, and a job carrying a
// sourceId refreshes that source's ops snapshot.
func (a *attempt) completedSideEffects(ctx context.Context, target queueTarget, job claimedJob) {
	if job.Data.TaskID == "" || job.Data.OrgID == "" {
		return
	}
	if job.Data.JobKind == "" {
		a.markTaskTerminal(ctx, target, job)
	}
	a.syncSourceCounts(ctx, target, job)
}

// failedSideEffects is the B1 'failed' side effect, applied once after the final
// failure transition: the activity decrement, the CrawlTask queued|running ->
// failed write with the lastError fallback and the ops snapshot refresh.
func (a *attempt) failedSideEffects(ctx context.Context, target queueTarget, job claimedJob, reason string) {
	if job.Data.TaskID == "" || job.Data.OrgID == "" {
		a.logf("crawlworker: crawl failed side effects skipped queue=%s jobId=%s: the job data carries no taskId/orgId", target.Name, job.ID)
		return
	}
	if job.Data.JobKind == "" {
		a.markTaskTerminal(ctx, target, job)
	}
	normalizedReason := failedLastErrorFallback
	if trimText(reason) != "" {
		normalizedReason = truncateText(reason, maxErrorText)
	}
	if err := a.tasks.MarkFailed(ctx, job.Data.TaskID, job.Data.OrgID, normalizedReason); err != nil {
		fallbackReason := normalizedReason
		if utf16Length(normalizedReason) > mysqlVarchar191 {
			fallbackReason = truncateText(normalizedReason, mysqlVarchar191)
		}
		a.logf("crawlworker: failed to persist the crawl failure reason queue=%s jobId=%s taskId=%s: %v; retrying with a truncated reason",
			target.Name, job.ID, job.Data.TaskID, err)
		if retryErr := a.tasks.MarkFailed(ctx, job.Data.TaskID, job.Data.OrgID, fallbackReason); retryErr != nil {
			a.logf("crawlworker: failed to persist the crawl failure reason after truncation queue=%s jobId=%s taskId=%s: %v",
				target.Name, job.ID, job.Data.TaskID, retryErr)
		}
	}
	a.syncSourceCounts(ctx, target, job)
}

// stalledSideEffects is the B1 'stalled' side effect for one recovered job id:
// CrawlTask running -> queued with the stalled message, then the ops snapshot.
// Jobs that exceeded maxStalledCount are reported by moveStalledJobsToWait in the
// same array (the Lua marks them with the `defa` deferred failure and re-queues
// them); they get the same requeue write, and their eventual final failure runs
// the failed side effects.
func (a *attempt) stalledSideEffects(ctx context.Context, queueName, jobID string, data JobData) {
	if data.TaskID == "" || data.OrgID == "" {
		a.logf("crawlworker: crawl stalled side effects skipped queue=%s jobId=%s: the job data carries no taskId/orgId", queueName, jobID)
		return
	}
	if err := a.tasks.MarkStalled(ctx, data.TaskID, data.OrgID, stalledRequeueMessage); err != nil {
		a.logf("crawlworker: failed to handle the crawl stalled event queue=%s jobId=%s taskId=%s: %v", queueName, jobID, data.TaskID, err)
		return
	}
	if data.SourceID == nil || *data.SourceID == "" || a.snapshots == nil {
		return
	}
	if err := a.snapshots.SyncQueueCounts(ctx, data.OrgID, *data.SourceID); err != nil {
		a.logf("crawlworker: failed to sync the queue counts of source=%s after a stalled job queue=%s jobId=%s: %v",
			*data.SourceID, queueName, jobID, err)
	}
}

// markTaskTerminal decrements the crawl:activity counter atomically. The write is
// best effort: a Redis failure is logged and does not change the job outcome,
// exactly like the QueueEvents handler swallowed it.
func (a *attempt) markTaskTerminal(ctx context.Context, target queueTarget, job claimedJob) {
	if a.activity == nil {
		return
	}
	if err := a.activity.MarkTasksTerminalAtomic(ctx, 1); err != nil {
		a.logf("crawlworker: failed to decrement the crawl activity counter queue=%s jobId=%s taskId=%s: %v",
			target.Name, job.ID, job.Data.TaskID, err)
	}
}

// syncSourceCounts refreshes the news source ops snapshot of a job that carries a
// sourceId. A failure only warns.
func (a *attempt) syncSourceCounts(ctx context.Context, target queueTarget, job claimedJob) {
	if job.Data.SourceID == nil || *job.Data.SourceID == "" || a.snapshots == nil {
		return
	}
	if err := a.snapshots.SyncQueueCounts(ctx, job.Data.OrgID, *job.Data.SourceID); err != nil {
		a.logf("crawlworker: failed to sync the queue counts of source=%s queue=%s jobId=%s: %v",
			*job.Data.SourceID, target.Name, job.ID, err)
	}
}

// logf writes one structured line.
func (a *attempt) logf(format string, args ...any) {
	if a == nil || a.log == nil {
		return
	}
	a.log(format, args...)
}
