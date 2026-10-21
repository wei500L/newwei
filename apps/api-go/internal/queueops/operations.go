package queueops

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/bullmqwire"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlqueue"
)

// BullMQ error codes this console maps onto HTTP statuses
// (dist/cjs/enums/error-code.js).
const (
	// codeErrorJobNotExist is ErrorCode.JobNotExist, returned as -1.
	codeErrorJobNotExist = -1
	// codeErrorJobNotInState is ErrorCode.JobNotInState, returned as -3.
	codeErrorJobNotInState = -3
	// codeErrorJobBelongsToScheduler is ErrorCode.JobBelongsToJobScheduler,
	// returned as -8.
	codeErrorJobBelongsToScheduler = -8
)

// safe conflict codes. They match ^[A-Z0-9_]+$ so the shared error filter keeps
// them.
const (
	// codeJobActiveOrLocked is a removal refused because the job is running.
	codeJobActiveOrLocked = "JOB_ACTIVE_OR_LOCKED"
	// codeJobNotDelayed is a promotion of a job that is not delayed.
	codeJobNotDelayed = "JOB_NOT_DELAYED"
	// codeJobNotFailed is a retry of a job that is not in the failed set.
	codeJobNotFailed = "JOB_NOT_FAILED"
	// codeJobSchedulerManaged is a removal of a job-scheduler iteration.
	codeJobSchedulerManaged = "JOB_SCHEDULER_MANAGED"
	// codeCrawlQueuePauseUnsupported is the crawl4ai pause/resume refusal.
	codeCrawlQueuePauseUnsupported = "CRAWL_QUEUE_PAUSE_UNSUPPORTED"
)

// retryBatchSize is how many reprocessJob scripts one pipeline carries. The
// batch routes never push a thousand scripts through a single command.
const retryBatchSize = 100

// crawlQueueNames are the three crawl4ai queues whose pause/resume this console
// refuses. See the package documentation for why.
var crawlQueueNames = map[string]bool{
	crawlqueue.QueueLegacy: true,
	crawlqueue.QueueHot:    true,
	crawlqueue.QueueNormal: true,
}

// Retry moves one failed job back to the wait (or paused) list. It is
// Job.retry(), which BullMQ implements with the reprocessJob script; the worker
// retry path (retryJob) is deliberately not used.
func (s *Service) Retry(ctx context.Context, actor Actor, queue, jobID string) (RetryResult, error) {
	name, err := s.validateQueue(queue)
	if err != nil {
		return RetryResult{}, err
	}
	if s.redis == nil {
		return RetryResult{}, errRedisUnavailable
	}
	keys := s.queueKeys(name)
	job, err := bullmqwire.ReadJob(ctx, s.redis, keys, jobID)
	if err != nil {
		return RetryResult{}, err
	}
	if job == nil {
		return RetryResult{}, newStatus(http.StatusNotFound, "job not found")
	}
	code, err := scriptReprocessJob.Run(ctx, s.redis, retryKeys(keys, jobID),
		jobID, pushCommand(job.Options().Lifo), "failedReason", string(StateFailed)).Int64()
	if err != nil {
		return RetryResult{}, err
	}
	switch code {
	case 1:
	case codeErrorJobNotExist:
		return RetryResult{}, newStatus(http.StatusNotFound, "job not found")
	case codeErrorJobNotInState:
		return RetryResult{}, newConflict(codeJobNotFailed,
			"job is not in the failed state",
			"Job.retry only moves a job out of the failed set; a waiting, active, delayed or completed job cannot be retried.")
	default:
		return RetryResult{}, newStatus(http.StatusConflict, fmt.Sprintf("job retry rejected with BullMQ code %d", code))
	}
	s.auditJob(ctx, actor, actionJobRetry, name, jobID)
	return RetryResult{Queue: name, JobID: jobID, State: string(StateWaiting)}, nil
}

// Delete removes one job from any state. It is Job.remove().
//
// Deleting an itemPipeline job is also how the organization counters are
// decremented: the Go queue-event tracker consumes the "removed" event the
// removeJob script publishes, so this console never adjusts a counter itself.
func (s *Service) Delete(ctx context.Context, actor Actor, queue, jobID string) (DeleteResult, error) {
	name, err := s.validateQueue(queue)
	if err != nil {
		return DeleteResult{}, err
	}
	if s.redis == nil {
		return DeleteResult{}, errRedisUnavailable
	}
	job, err := bullmqwire.ReadJob(ctx, s.redis, s.queueKeys(name), jobID)
	if err != nil {
		return DeleteResult{}, err
	}
	if job == nil {
		return DeleteResult{}, newStatus(http.StatusNotFound, "job not found")
	}
	if _, err := s.removeJob(ctx, name, jobID); err != nil {
		return DeleteResult{}, err
	}
	s.auditJob(ctx, actor, actionJobDelete, name, jobID)
	return DeleteResult{Queue: name, JobID: jobID, Deleted: true}, nil
}

// Promote moves one delayed job to the wait list (or the prioritized set). It is
// Job.promote().
func (s *Service) Promote(ctx context.Context, actor Actor, queue, jobID string) (PromoteResult, error) {
	name, err := s.validateQueue(queue)
	if err != nil {
		return PromoteResult{}, err
	}
	if s.redis == nil {
		return PromoteResult{}, errRedisUnavailable
	}
	keys := s.queueKeys(name)
	job, err := bullmqwire.ReadJob(ctx, s.redis, keys, jobID)
	if err != nil {
		return PromoteResult{}, err
	}
	if job == nil {
		return PromoteResult{}, newStatus(http.StatusNotFound, "job not found")
	}
	code, err := scriptPromote.Run(ctx, s.redis, []string{
		keys.Delayed, keys.Wait, keys.Paused, keys.Meta, keys.Prioritized,
		keys.Active, keys.PC, keys.Events, keys.Marker,
	}, keys.Base, jobID).Int64()
	if err != nil {
		return PromoteResult{}, err
	}
	switch code {
	case 0:
	case codeErrorJobNotExist, codeErrorJobNotInState:
		return PromoteResult{}, newConflict(codeJobNotDelayed,
			"job is not delayed",
			"Job.promote only moves a job out of the delayed sorted set.")
	default:
		return PromoteResult{}, newStatus(http.StatusConflict, fmt.Sprintf("job promote rejected with BullMQ code %d", code))
	}
	s.auditJob(ctx, actor, actionJobPromote, name, jobID)
	return PromoteResult{Queue: name, JobID: jobID}, nil
}

// RetryFailed retries up to limit failed jobs of one queue, newest first.
//
// Matched counts the failed jobs the page returned; Retried counts the ones the
// reprocessJob script actually moved (a job that stopped being failed between
// the page read and the script, or that another worker holds, is skipped).
func (s *Service) RetryFailed(ctx context.Context, actor Actor, queue string, limit int) (RetryFailedResult, error) {
	name, err := s.validateQueue(queue)
	if err != nil {
		return RetryFailedResult{}, err
	}
	if s.redis == nil {
		return RetryFailedResult{}, errRedisUnavailable
	}
	keys := s.queueKeys(name)
	raw, err := scriptGetRanges.Run(ctx, s.redis, []string{keys.Base},
		0, int64(limit-1), "0", string(StateFailed)).Result()
	if err != nil {
		return RetryFailedResult{}, err
	}
	ids := firstRangeIDs(raw)
	retried, runErr := s.reprocessMany(ctx, keys, ids)
	s.auditRetryFailed(ctx, actor, name, limit, len(ids), retried)
	if runErr != nil {
		return RetryFailedResult{}, runErr
	}
	return RetryFailedResult{Queue: name, Matched: len(ids), Retried: retried}, nil
}

// reprocessMany runs Job.retry for a page of ids in bounded pipelines.
func (s *Service) reprocessMany(ctx context.Context, keys bullmqwire.Keys, ids []string) (int, error) {
	if len(ids) == 0 {
		return 0, nil
	}
	// The scripts are pipelined, so NOSCRIPT would not fall back.
	if err := s.loadScripts(ctx, scriptReprocessJob); err != nil {
		return 0, err
	}
	retried := 0
	for start := 0; start < len(ids); start += retryBatchSize {
		end := start + retryBatchSize
		if end > len(ids) {
			end = len(ids)
		}
		batch := ids[start:end]
		pushes, err := s.pushCommands(ctx, keys, batch)
		if err != nil {
			return retried, err
		}
		pipe := s.redis.Pipeline()
		commands := make([]*redis.Cmd, len(batch))
		for index, jobID := range batch {
			commands[index] = scriptReprocessJob.Run(ctx, pipe, retryKeys(keys, jobID),
				jobID, pushes[index], "failedReason", string(StateFailed))
		}
		_, execErr := pipe.Exec(ctx)
		succeeded := 0
		var firstCommandErr error
		for _, command := range commands {
			code, err := command.Int64()
			if err != nil {
				if firstCommandErr == nil {
					firstCommandErr = err
				}
				continue
			}
			if code == 1 {
				succeeded++
			}
		}
		retried += succeeded
		if execErr != nil && succeeded == 0 {
			if firstCommandErr != nil {
				return retried, firstCommandErr
			}
			return retried, execErr
		}
	}
	return retried, nil
}

// pushCommands reads the lifo option of each job, exactly like Job.retry which
// pushes to the tail (RPUSH) for a lifo job and to the head (LPUSH) otherwise.
func (s *Service) pushCommands(ctx context.Context, keys bullmqwire.Keys, ids []string) ([]string, error) {
	pipe := s.redis.Pipeline()
	commands := make([]*redis.StringCmd, len(ids))
	for index, jobID := range ids {
		commands[index] = pipe.HGet(ctx, keys.Job(jobID), "opts")
	}
	if _, err := pipe.Exec(ctx); err != nil && !errors.Is(err, redis.Nil) {
		return nil, err
	}
	out := make([]string, len(ids))
	for index, command := range commands {
		options, err := command.Result()
		if err != nil && !errors.Is(err, redis.Nil) {
			return nil, err
		}
		out[index] = pushCommand(optionsLifo(options))
	}
	return out, nil
}

// pushCommand is the LPUSH/RPUSH selector of Job.retry.
func pushCommand(lifo bool) string {
	if lifo {
		return "RPUSH"
	}
	return "LPUSH"
}

// optionsLifo decodes the lifo flag of a stored JobsOptions document. A malformed
// or absent document is not lifo, which is BullMQ's default.
func optionsLifo(options string) bool {
	if options == "" {
		return false
	}
	var decoded struct {
		Lifo bool `json:"lifo"`
	}
	if err := json.Unmarshal([]byte(options), &decoded); err != nil {
		return false
	}
	return decoded.Lifo
}

// retryKeys is the reprocessJob KEYS tuple of Job.retry(state="failed").
func retryKeys(keys bullmqwire.Keys, jobID string) []string {
	return []string{
		keys.Job(jobID),
		keys.Events,
		keys.Failed,
		keys.Wait,
		keys.Meta,
		keys.Paused,
		keys.Active,
		keys.Marker,
	}
}

// Clean deletes finished jobs of one state older than grace milliseconds. It is
// Queue.clean(grace, limit, state): one cleanJobsInSet call per batch, and the
// returned count is the number of ids the script removed.
func (s *Service) Clean(ctx context.Context, actor Actor, queue string, state CleanState, graceMillis int64, limit int) (CleanResult, error) {
	name, err := s.validateQueue(queue)
	if err != nil {
		return CleanResult{}, err
	}
	if s.redis == nil {
		return CleanResult{}, errRedisUnavailable
	}
	keys := s.queueKeys(name)
	timestamp := s.now().UnixMilli() - graceMillis
	raw, err := scriptCleanJobsInSet.Run(ctx, s.redis, []string{
		keys.Base + string(state), keys.Events, keys.Repeat,
	}, keys.Base, timestamp, limit, string(state)).Result()
	if err != nil {
		return CleanResult{}, err
	}
	removed := len(stringList(raw))
	s.auditClean(ctx, actor, name, state, graceMillis, limit, removed)
	return CleanResult{Queue: name, State: string(state), Removed: removed}, nil
}

// Pause pauses one queue. It is Queue.pause().
func (s *Service) Pause(ctx context.Context, actor Actor, queue string) (PauseResult, error) {
	return s.setPaused(ctx, actor, queue, true)
}

// Resume resumes one queue. It is Queue.resume().
func (s *Service) Resume(ctx context.Context, actor Actor, queue string) (PauseResult, error) {
	return s.setPaused(ctx, actor, queue, false)
}

// setPaused runs the shared pause script. Pause and resume pass the same KEYS in
// the opposite order and a different ARGV[1], exactly like Scripts.pauseArgs.
func (s *Service) setPaused(ctx context.Context, actor Actor, queue string, paused bool) (PauseResult, error) {
	name, err := s.validateQueue(queue)
	if err != nil {
		return PauseResult{}, err
	}
	if crawlQueueNames[name] {
		action := "pause"
		if !paused {
			action = "resume"
		}
		return PauseResult{}, newConflict(codeCrawlQueuePauseUnsupported,
			fmt.Sprintf("crawl4ai queues must be %sd through POST /api/admin/crawl4ai/queue/%s", action, action),
			fmt.Sprintf("Use /api/admin/crawl4ai/queue/%s for %s: that route also updates the adaptive-concurrency state and broadcasts the C2 worker concurrency, which this console does not port.", action, name))
	}
	if s.redis == nil {
		return PauseResult{}, errRedisUnavailable
	}
	keys := s.queueKeys(name)
	source, target, argument := keys.Wait, keys.Paused, "paused"
	if !paused {
		source, target, argument = keys.Paused, keys.Wait, "resumed"
	}
	if _, err := scriptPause.Run(ctx, s.redis, []string{
		source, target, keys.Meta, keys.Prioritized, keys.Events, keys.Delayed, keys.Marker,
	}, argument).Result(); err != nil {
		return PauseResult{}, err
	}
	action := actionQueuePause
	if !paused {
		action = actionQueueResume
	}
	s.auditPause(ctx, actor, action, name, paused)
	return PauseResult{Queue: name, Paused: paused}, nil
}

// removeJob runs Job.remove() for one queue.
//
// A locked (most likely active) job is a 409: BullMQ refuses to remove it because
// the worker still owns it. A job-scheduler iteration is also a 409, because
// removing it would desynchronise the schedule.
func (s *Service) removeJob(ctx context.Context, queue, jobID string) (bool, error) {
	keys := s.queueKeys(queue)
	code, err := scriptRemoveJob.Run(ctx, s.redis, []string{keys.Job(jobID), keys.Repeat},
		jobID, "1", keys.Base).Int64()
	if err != nil {
		return false, err
	}
	switch code {
	case 1:
		return true, nil
	case 0:
		return false, newConflict(codeJobActiveOrLocked,
			"job is active or locked",
			"BullMQ refuses to remove a job that a worker is processing or that still holds a lock; retry once the worker releases it.")
	case codeErrorJobBelongsToScheduler:
		return false, newConflict(codeJobSchedulerManaged,
			"job belongs to a job scheduler and cannot be removed directly",
			"Remove or change the job scheduler instead; its iteration jobs are recreated on the next run.")
	default:
		return false, newStatus(http.StatusConflict, fmt.Sprintf("job could not be removed (BullMQ code %d)", code))
	}
}

// stringList normalizes a Lua array result into a string slice.
//
// The argument is go-redis's generic Lua reply, not business data.
func stringList(raw any) []string {
	switch typed := raw.(type) {
	case []any:
		out := make([]string, 0, len(typed))
		for _, entry := range typed {
			if text, ok := entry.(string); ok {
				out = append(out, text)
			}
		}
		return out
	case []string:
		return typed
	default:
		return nil
	}
}
