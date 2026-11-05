package queue

// The alerts consumer now runs on the shared bullmq.Worker state machine. This
// file keeps only the queue name, the business processor signature, the delayed
// deferral helper, the repeat scheduling hook and the custom backoff table; the
// loop, lock renewal, finish, retry and stalled recovery live in internal/bullmq.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/bullmq"
)

// Processor runs one claimed job. Returning a *DelayedError asks the worker to
// move the job to the delayed set without consuming an attempt (the NestJS
// `job.moveToDelayed(ts, token)` + `throw new DelayedError()` pattern);
// returning any other error goes through BullMQ's retry/backoff decision.
type Processor func(ctx context.Context, job Job, handle JobHandle) error

// JobHandle exposes the one BullMQ job operation the delivery handler needs.
// It is valid only while the attempt runs.
type JobHandle struct {
	client *redis.Client
	keys   Keys
	job    Job
}

// UpdateData replaces the job hash `data` field, equivalent to
// `job.updateData(data)`: BullMQ writes the JSON through the updateData
// script.
func (h JobHandle) UpdateData(ctx context.Context, data []byte) error {
	if h.client == nil {
		return errors.New("alertworker/queue: job handle without a worker")
	}
	result, err := bullmq.ScriptUpdateData.Run(ctx, h.client,
		[]string{h.keys.Job(h.job.ID)}, data,
	).Result()
	if err != nil {
		return fmt.Errorf("alertworker/queue: update job data %s: %w", h.job.ID, err)
	}
	if code := toInt64(result); code < 0 {
		return fmt.Errorf("alertworker/queue: update job data %s rejected with BullMQ code %d", h.job.ID, code)
	}
	return nil
}

// WorkerOptions are the BullMQ 5.63.2 worker defaults plus the two settings the
// alerts processor overrides: concurrency and the custom backoff strategy.
type WorkerOptions struct {
	Concurrency     int
	Prefix          string
	LockDuration    time.Duration
	LockRenewTime   time.Duration
	StalledInterval time.Duration
	MaxStalledCount int
	DrainDelay      time.Duration
	Processor       Processor
	// BackoffDelay mirrors settings.backoffStrategy(attemptsMade+1, type). It is
	// only consulted for backoff types that are not BullMQ's built-ins.
	BackoffDelay func(attemptsMade int, backoffType string) (int64, bool)
	Logger       func(format string, args ...any)
}

func (o WorkerOptions) normalized() WorkerOptions {
	if o.Concurrency < 1 {
		o.Concurrency = 1
	}
	if o.Prefix == "" {
		o.Prefix = Prefix
	}
	if o.LockDuration <= 0 {
		o.LockDuration = LockDuration
	}
	if o.LockRenewTime <= 0 {
		o.LockRenewTime = o.LockDuration / 2
	}
	if o.StalledInterval <= 0 {
		o.StalledInterval = StalledInterval
	}
	if o.MaxStalledCount < 0 {
		o.MaxStalledCount = MaxStalledCount
	}
	if o.DrainDelay <= 0 {
		o.DrainDelay = DrainDelay
	}
	if o.Logger == nil {
		o.Logger = log.Printf
	}
	return o
}

// Worker consumes the `alerts` BullMQ queue.
type Worker struct {
	client  *redis.Client
	keys    Keys
	scripts queueScripts
	opts    WorkerOptions
	inner   *bullmq.Worker
}

// NewWorker builds a worker over the shared command client and a dedicated
// blocking client.
func NewWorker(client, blocking *redis.Client, opts WorkerOptions) (*Worker, error) {
	if client == nil || blocking == nil {
		return nil, errors.New("alertworker/queue: worker requires command and blocking redis clients")
	}
	if opts.Processor == nil {
		return nil, errors.New("alertworker/queue: worker requires a processor")
	}
	scripts, err := loadQueueScripts()
	if err != nil {
		return nil, err
	}
	normalized := opts.normalized()
	worker := &Worker{client: client, keys: NewKeys(normalized.Prefix, QueueName), scripts: scripts, opts: normalized}
	inner, err := bullmq.NewWorker(client, blocking, QueueName, worker.processor(), bullmq.WorkerOptions{
		Prefix:          normalized.Prefix,
		Concurrency:     normalized.Concurrency,
		LockDuration:    normalized.LockDuration,
		LockRenewTime:   normalized.LockRenewTime,
		StalledInterval: normalized.StalledInterval,
		MaxStalledCount: normalized.MaxStalledCount,
		DrainDelay:      normalized.DrainDelay,
		Logger:          normalized.Logger,
		Stacktrace:      stacktraceJSON,
		FailurePolicy:   worker.failurePolicy(),
	})
	if err != nil {
		return nil, err
	}
	worker.inner = inner
	return worker, nil
}

// Start verifies both Redis connections and starts the loops.
func (w *Worker) Start(ctx context.Context) error {
	if w == nil || w.inner == nil {
		return errors.New("alertworker/queue: worker is not configured")
	}
	return w.inner.Start(ctx)
}

// Close stops claiming new jobs and drains the in-flight ones.
func (w *Worker) Close(ctx context.Context) error {
	if w == nil || w.inner == nil {
		return nil
	}
	return w.inner.Close(ctx)
}

// processor adapts the business handler into a bullmq.Processor. It reschedules
// the next repeat iteration first (Worker.nextJobFromJobData), then runs the
// handler; a DelayedError moves the job to the delayed set without consuming an
// attempt.
func (w *Worker) processor() bullmq.Processor {
	return func(ctx context.Context, job *bullmq.Job) (json.RawMessage, error) {
		claimed := jobFromBullmq(job)
		if err := w.rescheduleRepeat(ctx, claimed); err != nil {
			w.opts.Logger("alertworker/queue: reschedule repeat for job %s: %v", job.ID, err)
			return nil, bullmq.Handled(nil)
		}
		err := w.opts.Processor(ctx, claimed, JobHandle{client: w.client, keys: w.keys, job: claimed})
		if err == nil {
			return nil, nil
		}
		var delayed *DelayedError
		if errors.As(err, &delayed) {
			w.moveToDelayedUntil(ctx, claimed, delayed.UntilMs, true, nil)
			return nil, bullmq.Handled(nil)
		}
		return nil, err
	}
}

// failurePolicy reproduces backoffDelay for the shared worker's retry decision.
func (w *Worker) failurePolicy() bullmq.FailurePolicy {
	return func(job *bullmq.Job, err error) bullmq.FailureDecision {
		var unrecoverable *bullmq.UnrecoverableError
		if errors.As(err, &unrecoverable) {
			return bullmq.FailureDecision{Final: true, Permanent: true}
		}
		if job.DeferredFailure != "" {
			return bullmq.FailureDecision{Final: true, Permanent: true}
		}
		if job.FinalFailure() {
			return bullmq.FailureDecision{Final: true}
		}
		delay, ok := w.backoffDelay(jobFromBullmq(job), err)
		if !ok {
			return bullmq.FailureDecision{Final: true}
		}
		return bullmq.FailureDecision{Final: false, DelayMillis: delay}
	}
}

// backoffDelay mirrors Backoffs.calculate + lookupStrategy: built-ins first,
// then the worker's custom strategy.
func (w *Worker) backoffDelay(job Job, cause error) (int64, bool) {
	backoff := job.Opts.Backoff
	if backoff == nil {
		return 0, true
	}
	attempt := job.AttemptsMade + 1
	switch backoff.Type {
	case "fixed":
		if backoff.Delay == nil {
			return 0, true
		}
		return int64(*backoff.Delay), true
	case "exponential":
		delay := 0.0
		if backoff.Delay != nil {
			delay = *backoff.Delay
		}
		return int64(math.Round(math.Pow(2, float64(attempt-1)) * delay)), true
	default:
		if w.opts.BackoffDelay == nil {
			return 0, false
		}
		return w.opts.BackoffDelay(attempt, backoff.Type)
	}
}

// moveToDelayedUntil moves the job to the delayed set. skipAttempt is true for
// the DelayedError path (atm untouched) and false for the retry path (atm
// incremented once).
func (w *Worker) moveToDelayedUntil(ctx context.Context, job Job, untilMs int64, skipAttempt bool, fields []any) {
	nowMs := time.Now().UnixMilli()
	delay := untilMs - nowMs
	if delay < 0 {
		delay = 0
	}
	skipAttemptArg := "0"
	if skipAttempt {
		skipAttemptArg = "1"
	}
	var encodedFields any
	if fields != nil {
		packed, err := MarshalMsgpack(fields)
		if err != nil {
			w.opts.Logger("alertworker/queue: pack delayed fields for %s: %v", job.ID, err)
			return
		}
		encodedFields = packed
	}
	result, err := w.scripts.moveToDelayed.Run(ctx, w.client,
		[]string{
			w.keys.Marker,
			w.keys.Active,
			w.keys.Prioritized,
			w.keys.Delayed,
			w.keys.Job(job.ID),
			w.keys.Events,
			w.keys.Meta,
			w.keys.Stalled,
		},
		w.keys.Base,
		nowMs,
		job.ID,
		job.Token,
		delay,
		skipAttemptArg,
		encodedFields,
	).Result()
	if err != nil {
		w.opts.Logger("alertworker/queue: move to delayed %s: %v", job.ID, err)
		return
	}
	if code := toInt64(result); code < 0 {
		w.opts.Logger("alertworker/queue: move to delayed %s rejected with BullMQ code %d", job.ID, code)
	}
}

// rescheduleRepeat mirrors Worker.nextJobFromJobData: a fetched job that belongs
// to a repeat schedule schedules the next iteration before it is processed.
func (w *Worker) rescheduleRepeat(ctx context.Context, job Job) error {
	if job.RepeatJobKey == "" || job.Opts.Repeat == nil {
		return nil
	}
	if strings.Count(job.RepeatJobKey, ":")+1 >= 5 {
		w.opts.Logger("alertworker/queue: legacy repeat key %s for job %s is not rescheduled", job.RepeatJobKey, job.ID)
		return nil
	}
	every := job.Opts.Repeat.Every
	if every == nil || *every <= 0 {
		w.opts.Logger("alertworker/queue: repeat job %s has no every interval; not rescheduled", job.ID)
		return nil
	}
	merged, err := mergeRepeatOptions(job)
	if err != nil {
		return err
	}
	encodedOpts, err := MarshalMsgpack(merged)
	if err != nil {
		return err
	}
	templateData := job.Data
	if len(templateData) == 0 || !json.Valid(templateData) {
		templateData = []byte("{}")
	}
	if _, err := w.scripts.updateJobScheduler.Run(ctx, w.client,
		[]string{
			w.keys.Repeat,
			w.keys.Delayed,
			w.keys.Wait,
			w.keys.Paused,
			w.keys.Meta,
			w.keys.Prioritized,
			w.keys.Marker,
			w.keys.ID,
			w.keys.Events,
			w.keys.PC,
			w.keys.Job(job.ID),
			w.keys.Active,
		},
		"",
		job.RepeatJobKey,
		string(templateData),
		encodedOpts,
		time.Now().UnixMilli(),
		w.keys.Base,
		job.ID,
	).Result(); err != nil {
		return fmt.Errorf("alertworker/queue: update job scheduler %s: %w", job.RepeatJobKey, err)
	}
	return nil
}

// mergeRepeatOptions rebuilds the next iteration's options the way
// JobScheduler.upsertJobScheduler does for the {override: false} branch.
func mergeRepeatOptions(job Job) (map[string]any, error) {
	repeat := job.Opts.Repeat
	count := int64(1)
	if repeat.Count != nil {
		count = *repeat.Count + 1
	}
	iteration := map[string]any{
		"every":     *repeat.Every,
		"offset":    nil,
		"count":     count,
		"startDate": nil,
		"endDate":   nil,
	}
	if repeat.JobID != "" {
		iteration["jobId"] = repeat.JobID
	}
	if repeat.Pattern != "" {
		iteration["pattern"] = repeat.Pattern
	}
	if repeat.TZ != "" {
		iteration["tz"] = repeat.TZ
	}
	if repeat.Limit != nil {
		iteration["limit"] = *repeat.Limit
	}
	merged := map[string]any{
		"jobId":     "repeat:" + job.RepeatJobKey + ":undefined",
		"delay":     math.NaN(),
		"timestamp": time.Now().UnixMilli(),
		"repeat":    iteration,
	}
	if job.Opts.Attempts != nil {
		merged["attempts"] = int64(*job.Opts.Attempts)
	}
	if keep, ok := decodeKeepJobs(job.Opts.RemoveOnComplete); ok {
		merged["removeOnComplete"] = keepJobsWire(keep)
	}
	if keep, ok := decodeKeepJobs(job.Opts.RemoveOnFail); ok {
		merged["removeOnFail"] = keepJobsWire(keep)
	}
	if job.Opts.LIFO {
		merged["lifo"] = true
	}
	if job.Opts.Priority != nil {
		merged["priority"] = int64(*job.Opts.Priority)
	}
	return merged, nil
}

// keepJobsWire rebuilds the JSON shape of a keepJobs option (boolean, number or
// {age, count}) for the MessagePack payload.
func keepJobsWire(keep KeepJobs) any {
	if keep.Age == nil && keep.Count != nil {
		switch *keep.Count {
		case -1:
			return false
		case 0:
			return true
		}
	}
	value := map[string]any{}
	if keep.Age != nil {
		value["age"] = *keep.Age
	}
	if keep.Count != nil {
		value["count"] = *keep.Count
	}
	return value
}

// jobFromBullmq adapts the shared job into the business job view.
func jobFromBullmq(job *bullmq.Job) Job {
	if job == nil {
		return Job{}
	}
	adapted := Job{
		ID:              job.ID,
		Name:            job.Name,
		Token:           job.Token,
		Data:            job.Data,
		RepeatJobKey:    job.RepeatJobKey,
		AttemptsMade:    int(job.AttemptsMade),
		AttemptsStarted: int(job.AttemptsStarted),
		StalledCounter:  int(job.StalledCount),
		DeferredFailure: job.DeferredFailure,
		Timestamp:       job.Timestamp,
	}
	if job.ProcessedOn != nil {
		adapted.ProcessedOn = *job.ProcessedOn
	}
	if len(job.Opts) > 0 {
		_ = json.Unmarshal(job.Opts, &adapted.Opts)
	}
	return adapted
}

func sleepContext(ctx context.Context, duration time.Duration) bool {
	if duration <= 0 {
		return ctx.Err() == nil
	}
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}
