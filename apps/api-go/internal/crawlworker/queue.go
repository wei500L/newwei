package crawlworker

// One crawl queue consumer and the BullMQ transition helpers its attempts use.
//
// The shared bullmq.Worker owns the fetch loop, the lock renewal, the stalled
// timer, the pull concurrency and the graceful shutdown. queueWorker only pairs
// a queue spec with that worker; queueTransitions keeps the vendored Lua
// transitions (moveToFinished / retryJob / moveToDelayed /
// moveJobFromActiveToWait / updateData) that the CrawlQueueProcessor handler
// body drove directly, so attempt.run can keep performing its own state machine
// and B1 side effects and return the bullmq.Handled sentinel.

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/bullmq"
)

// queueWorker pairs one queue spec with its shared bullmq.Worker.
type queueWorker struct {
	spec  queueSpec
	inner *bullmq.Worker
}

// queueTransitions implements jobTransitions over the vendored Lua commands. It
// carries the queue identity the error text and logging use, plus the shared
// command client and script set.
type queueTransitions struct {
	worker  *Worker
	spec    queueSpec
	keys    keys
	scripts queueScripts
	client  *redis.Client
	now     func() time.Time
}

// UpdateData implements jobTransitions through the updateData script.
func (t *queueTransitions) UpdateData(ctx context.Context, job claimedJob, data []byte) error {
	result, err := t.scripts.updateData.Run(ctx, t.client, []string{t.keys.Job(job.ID)}, data).Result()
	if err != nil {
		return fmt.Errorf("crawlworker: update job data of queue=%s jobId=%s: %w", t.spec.Name, job.ID, err)
	}
	if code := toInt64(result); code < 0 {
		return fmt.Errorf("crawlworker: update job data of queue=%s jobId=%s rejected with BullMQ code %d", t.spec.Name, job.ID, code)
	}
	return nil
}

// MoveToCompleted implements jobTransitions: moveToFinished target "completed"
// with the marshalled summary as the stored returnvalue.
func (t *queueTransitions) MoveToCompleted(ctx context.Context, job claimedJob, returnValue json.RawMessage, maxAttempts int) error {
	options := t.finishOptions(job, KeepOnComplete(job.Opts), maxAttempts)
	value := "null"
	if len(returnValue) > 0 {
		value = string(returnValue)
	}
	return t.moveToFinished(ctx, job, t.keys.Completed, "metrics:completed", "returnvalue", value, "completed", options, nil)
}

// MoveToFailed implements jobTransitions: moveToFinished target "failed", which
// emits 'failed' and 'retries-exhausted'. It is only used for a terminal failure.
func (t *queueTransitions) MoveToFailed(ctx context.Context, job claimedJob, reason string, maxAttempts int) error {
	options := t.finishOptions(job, KeepOnFail(job.Opts), maxAttempts)
	fields, err := newFailureFields(reason).pack()
	if err != nil {
		return err
	}
	return t.moveToFinished(ctx, job, t.keys.Failed, "metrics:failed", "failedReason", reason, "failed", options, fields)
}

// moveToFinished runs the vendored script with fetch-next disabled: the shared
// bullmq.Worker fetch loop claims the next job itself, so the transition only
// needs to finish this one.
func (t *queueTransitions) moveToFinished(ctx context.Context, job claimedJob, target, metricsKey, property, value, state string, options finishOptions, fields []byte) error {
	packedOptions, err := pack(options)
	if err != nil {
		return err
	}
	args := []any{
		job.ID,
		t.now().UnixMilli(),
		property,
		value,
		state,
		0,
		t.keys.Base,
		packedOptions,
	}
	if fields != nil {
		args = append(args, fields)
	}
	result, err := t.scripts.moveToFinished.Run(ctx, t.client, t.finishKeys(job.ID, target, metricsKey), args...).Result()
	if err != nil {
		return fmt.Errorf("crawlworker: moveToFinished %s queue=%s jobId=%s: %w", state, t.spec.Name, job.ID, err)
	}
	if code := toInt64(result); code < 0 {
		return fmt.Errorf("crawlworker: moveToFinished %s queue=%s jobId=%s rejected with BullMQ code %d", state, t.spec.Name, job.ID, code)
	}
	return nil
}

// Retry implements jobTransitions through retryJob-11: the job returns to the
// wait/prioritized list and the job hash attemptsMade counter is incremented.
func (t *queueTransitions) Retry(ctx context.Context, job claimedJob, reason string) error {
	fields, err := newFailureFields(reason).pack()
	if err != nil {
		return err
	}
	pushCommand := "LPUSH"
	if job.Opts.LIFO {
		pushCommand = "RPUSH"
	}
	result, err := t.scripts.retryJob.Run(ctx, t.client,
		[]string{
			t.keys.Active,
			t.keys.Wait,
			t.keys.Paused,
			t.keys.Job(job.ID),
			t.keys.Meta,
			t.keys.Events,
			t.keys.Delayed,
			t.keys.Prioritized,
			t.keys.PC,
			t.keys.Marker,
			t.keys.Stalled,
		},
		t.keys.Base,
		t.now().UnixMilli(),
		pushCommand,
		job.ID,
		job.Token,
		fields,
	).Result()
	if err != nil {
		return fmt.Errorf("crawlworker: retryJob queue=%s jobId=%s: %w", t.spec.Name, job.ID, err)
	}
	if code := toInt64(result); code < 0 {
		return fmt.Errorf("crawlworker: retryJob queue=%s jobId=%s rejected with BullMQ code %d", t.spec.Name, job.ID, code)
	}
	return nil
}

// RetryLater implements jobTransitions through moveToDelayed-8: the attempt is
// delayed by the job backoff and the job hash attemptsMade counter is incremented
// (skipAttempt "0").
func (t *queueTransitions) RetryLater(ctx context.Context, job claimedJob, reason string, delayMs int64) error {
	fields, err := newFailureFields(reason).pack()
	if err != nil {
		return err
	}
	result, err := t.scripts.moveToDelayed.Run(ctx, t.client,
		[]string{
			t.keys.Marker,
			t.keys.Active,
			t.keys.Prioritized,
			t.keys.Delayed,
			t.keys.Job(job.ID),
			t.keys.Events,
			t.keys.Meta,
			t.keys.Stalled,
		},
		t.keys.Base,
		t.now().UnixMilli(),
		job.ID,
		job.Token,
		delayMs,
		"0",
		fields,
	).Result()
	if err != nil {
		return fmt.Errorf("crawlworker: moveToDelayed queue=%s jobId=%s: %w", t.spec.Name, job.ID, err)
	}
	if code := toInt64(result); code < 0 {
		return fmt.Errorf("crawlworker: moveToDelayed queue=%s jobId=%s rejected with BullMQ code %d", t.spec.Name, job.ID, code)
	}
	return nil
}

// MoveToWait implements jobTransitions through moveJobFromActiveToWait-9, the
// RateLimitError path. The script moves the job back to wait/prioritized without
// touching attemptsMade or attemptsStarted, emits the 'waiting' event with
// prev=active and returns the limiter PTTL (or 0).
func (t *queueTransitions) MoveToWait(ctx context.Context, job claimedJob) (int64, error) {
	result, err := t.scripts.moveJobFromActiveToWait.Run(ctx, t.client,
		[]string{
			t.keys.Active,
			t.keys.Wait,
			t.keys.Stalled,
			t.keys.Paused,
			t.keys.Meta,
			t.keys.Limiter,
			t.keys.Prioritized,
			t.keys.Marker,
			t.keys.Events,
		},
		job.ID,
		job.Token,
		t.keys.Job(job.ID),
	).Result()
	if err != nil {
		return 0, fmt.Errorf("crawlworker: moveJobFromActiveToWait queue=%s jobId=%s: %w", t.spec.Name, job.ID, err)
	}
	pttl := toInt64(result)
	if pttl < 0 {
		return 0, fmt.Errorf("crawlworker: moveJobFromActiveToWait queue=%s jobId=%s rejected with BullMQ code %d", t.spec.Name, job.ID, pttl)
	}
	return pttl, nil
}

// finishOptions builds the moveToFinished MessagePack options of one job. The
// manual limiter follows the shared pull concurrency, exactly like the retired
// worker's moveToActive options did.
func (t *queueTransitions) finishOptions(job claimedJob, keep keepJobs, maxAttempts int) finishOptions {
	return finishOptions{
		Token:          job.Token,
		KeepJobs:       keep,
		Limiter:        limiterOptions{Max: resolveManualLimiterMax(t.worker.currentConcurrency()), Duration: 1_000},
		LockDuration:   int64(lockDuration / time.Millisecond),
		Attempts:       maxAttempts,
		MaxMetricsSize: "",
	}
}

// finishKeys is moveToFinishedKeys with the target set, metrics key, job key and
// marker filled in.
func (t *queueTransitions) finishKeys(jobID, target, metricsKey string) []string {
	return []string{
		t.keys.Wait,
		t.keys.Active,
		t.keys.Prioritized,
		t.keys.Events,
		t.keys.Stalled,
		t.keys.Limiter,
		t.keys.Delayed,
		t.keys.Paused,
		t.keys.Meta,
		t.keys.PC,
		target,
		t.keys.Job(jobID),
		t.keys.Base + metricsKey,
		t.keys.Marker,
	}
}

// loadJobData reads CrawlJobData from the job hash for the stalled side effect.
func (t *queueTransitions) loadJobData(ctx context.Context, jobID string) (JobData, error) {
	raw, err := t.client.HGet(ctx, t.keys.Job(jobID), "data").Result()
	if err != nil {
		return JobData{}, err
	}
	if raw == "" {
		return JobData{}, fmt.Errorf("crawlworker: job queue=%s jobId=%s has no data field", t.spec.Name, jobID)
	}
	var data JobData
	if err := json.Unmarshal([]byte(raw), &data); err != nil {
		return JobData{}, err
	}
	return data, nil
}
