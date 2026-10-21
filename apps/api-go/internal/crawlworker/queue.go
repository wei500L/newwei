package crawlworker

// One crawl queue worker: the fetch loop, the dedicated blocking connection, the
// lock renewal, the stalled checker and the BullMQ transitions of a claimed job.
//
// The queue runtime is the Go equivalent of `new Worker(queueName, handler,
// {connection, concurrency, limiter})` in CrawlQueueProcessor: BullMQ builds one
// worker per queue, and each worker owns a blocking connection because BZPOPMIN
// occupies it. The shared command client stays owned by main and is never
// closed here.

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"github.com/redis/go-redis/v9"
)

// queueRuntime is one running queue worker.
type queueRuntime struct {
	worker   *Worker
	spec     queueSpec
	keys     keys
	scripts  queueScripts
	client   *redis.Client
	blocking *redis.Client

	mu          sync.Mutex
	concurrency int
	inFlight    int
	wake        chan struct{}

	closeOnce sync.Once
}

// start launches the fetch loop and the stalled checker of this queue.
func (q *queueRuntime) start(fetchCtx, stalledCtx context.Context) {
	q.mu.Lock()
	if q.concurrency < 1 {
		q.concurrency = 1
	}
	q.mu.Unlock()
	q.worker.fetchWG.Add(1)
	go func() {
		defer q.worker.fetchWG.Done()
		q.fetchLoop(fetchCtx)
	}()
	q.worker.stalledWG.Add(1)
	go func() {
		defer q.worker.stalledWG.Done()
		q.stalledLoop(stalledCtx)
	}()
}

// close releases the dedicated blocking connection. The shared command client is
// not touched.
func (q *queueRuntime) close() {
	q.closeOnce.Do(func() {
		if q.blocking == nil {
			return
		}
		if err := q.blocking.Close(); err != nil {
			q.worker.logf("crawlworker: failed to close the blocking redis connection of queue=%s: %v", q.spec.Name, err)
		}
	})
}

// setConcurrency is worker.concurrency = n: the pull concurrency of this queue
// worker. It never changes the in-flight attempts, only how many jobs the fetch
// loop may claim at once.
func (q *queueRuntime) setConcurrency(concurrency int) {
	q.mu.Lock()
	q.concurrency = maxInt(1, jsRound(float64(concurrency)))
	q.mu.Unlock()
	q.wakeUp()
}

// currentConcurrency reads the pull concurrency.
func (q *queueRuntime) currentConcurrency() int {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.concurrency
}

// target builds the attempt target of this queue.
func (q *queueRuntime) target() queueTarget {
	return queueTarget{Name: q.spec.Name, Class: q.spec.Class, Transitions: q}
}

// ---------------------------------------------------------------------------
// fetch loop
// ---------------------------------------------------------------------------

// fetchLoop claims jobs while the worker is running. It holds at most
// `concurrency` slots (moveToActive calls plus running attempts), blocks on the
// marker when the queue is drained, and paces itself on the BullMQ rate limiter
// and delayed timestamps the script reports.
func (q *queueRuntime) fetchLoop(ctx context.Context) {
	for ctx.Err() == nil {
		if q.worker.closingState() {
			return
		}
		if !q.acquireSlot(ctx) {
			return
		}
		job, rateLimitTTL, delayUntil, err := q.moveToActive(ctx)
		if err != nil {
			q.releaseSlot()
			if ctx.Err() != nil {
				return
			}
			q.worker.logf("crawlworker: moveToActive failed queue=%s: %v", q.spec.Name, err)
			if !sleepContext(ctx, time.Second) {
				return
			}
			continue
		}
		if job == nil {
			q.releaseSlot()
			if !q.pace(ctx, rateLimitTTL, delayUntil) {
				return
			}
			continue
		}
		q.worker.jobWG.Add(1)
		go func(job claimedJob) {
			defer q.worker.jobWG.Done()
			defer q.releaseSlot()
			q.process(job)
		}(*job)
	}
}

// acquireSlot waits until fewer than `concurrency` slots of this queue are in
// use. The wake channel is only a hint: the state is re-read under the mutex
// after every wake-up, so a coalesced signal cannot strand the loop.
func (q *queueRuntime) acquireSlot(ctx context.Context) bool {
	for {
		q.mu.Lock()
		available := q.inFlight < q.concurrency
		if available {
			q.inFlight++
		}
		q.mu.Unlock()
		if available {
			return true
		}
		select {
		case <-ctx.Done():
			return false
		case <-q.wake:
		}
	}
}

// releaseSlot frees one slot and wakes the waiting fetch loop.
func (q *queueRuntime) releaseSlot() {
	q.mu.Lock()
	if q.inFlight > 0 {
		q.inFlight--
	}
	q.mu.Unlock()
	q.wakeUp()
}

// wakeUp signals the fetch loop without blocking.
func (q *queueRuntime) wakeUp() {
	select {
	case q.wake <- struct{}{}:
	default:
	}
}

// pace decides what to do after moveToActive returned no job: wait out the rate
// limiter TTL, wait for the next delayed job, or block on the queue marker. The
// wait is capped by the BullMQ drain delay so a paused or maxed queue keeps
// polling at the same cadence BullMQ uses.
func (q *queueRuntime) pace(ctx context.Context, rateLimitTTL, delayUntil int64) bool {
	now := q.worker.opts.now().UnixMilli()
	switch {
	case rateLimitTTL > 0:
		wait := time.Duration(rateLimitTTL) * time.Millisecond
		if wait > drainDelay {
			wait = drainDelay
		}
		return sleepContext(ctx, wait)
	case delayUntil > now:
		wait := time.Duration(delayUntil-now) * time.Millisecond
		if wait > drainDelay {
			wait = drainDelay
		}
		return sleepContext(ctx, wait)
	default:
		return q.waitForMarker(ctx)
	}
}

// waitForMarker blocks on the queue marker (BZPOPMIN) for the drain delay, which
// is how the BullMQ event loop sleeps on an empty queue.
func (q *queueRuntime) waitForMarker(ctx context.Context) bool {
	err := q.blocking.BZPopMin(ctx, drainDelay, q.keys.Marker).Err()
	if err == nil || err == redis.Nil {
		return ctx.Err() == nil
	}
	if ctx.Err() != nil {
		return false
	}
	q.worker.logf("crawlworker: wait for the queue marker failed queue=%s: %v", q.spec.Name, err)
	return sleepContext(ctx, time.Second)
}

// moveToActive runs moveToActive-11 and decodes the {jobData, jobId,
// rateLimitTtl, delayUntil} reply. A nil job means no claimable job (drained,
// paused or maxed); rateLimitTTL/delayUntil carry the pacing hint.
func (q *queueRuntime) moveToActive(ctx context.Context) (*claimedJob, int64, int64, error) {
	token := q.worker.tokens.Next()
	options, err := pack(moveToActiveOptions{
		Token:        token,
		LockDuration: int64(lockDuration / time.Millisecond),
		Limiter: limiterOptions{
			Max:      resolveManualLimiterMax(q.currentConcurrency()),
			Duration: 1_000,
		},
	})
	if err != nil {
		return nil, 0, 0, err
	}
	result, err := q.scripts.moveToActive.Run(ctx, q.client,
		[]string{
			q.keys.Wait,
			q.keys.Active,
			q.keys.Prioritized,
			q.keys.Events,
			q.keys.Stalled,
			q.keys.Limiter,
			q.keys.Delayed,
			q.keys.Paused,
			q.keys.Meta,
			q.keys.PC,
			q.keys.Marker,
		},
		q.keys.Base,
		q.worker.opts.now().UnixMilli(),
		options,
	).Result()
	if err != nil {
		return nil, 0, 0, err
	}
	values, ok := result.([]any)
	if !ok || len(values) < 4 {
		return nil, 0, 0, fmt.Errorf("crawlworker: unexpected moveToActive reply %T", result)
	}
	rateLimitTTL := toInt64(values[2])
	delayUntil := toInt64(values[3])
	flat, ok := values[0].([]any)
	if !ok || len(flat) == 0 {
		return nil, rateLimitTTL, delayUntil, nil
	}
	job, err := jobFromFlat(flat, token, toText(values[1]))
	if err != nil {
		return nil, rateLimitTTL, delayUntil, err
	}
	return &job, rateLimitTTL, delayUntil, nil
}

// process runs one claimed job with its lock renewal. A lost lease or a shutdown
// deadline leaves the job active: its lock expires and BullMQ stalled recovery
// hands it to the next attempt.
func (q *queueRuntime) process(job claimedJob) {
	jobCtx, cancelJob := context.WithCancelCause(q.worker.jobCtx)
	var leaseLost atomic.Bool
	renewDone := make(chan struct{})
	go q.renewLock(jobCtx, job, cancelJob, &leaseLost, renewDone)
	outcome := q.worker.attempt.run(jobCtx, q.target(), job)
	close(renewDone)
	cancelJob(nil)
	q.worker.logf("crawlworker: crawl attempt finished queue=%s jobId=%s taskId=%s outcome=%s leaseLost=%t",
		q.spec.Name, job.ID, job.Data.TaskID, outcome.String(), leaseLost.Load())
}

// renewLock extends the job lock every lockDuration/2. A failed renewal or a lock
// owned by another token cancels the handler context, so the attempt cannot write
// a terminal state it no longer owns.
func (q *queueRuntime) renewLock(ctx context.Context, job claimedJob, cancel context.CancelCauseFunc, lost *atomic.Bool, done <-chan struct{}) {
	ticker := time.NewTicker(lockRenewTime)
	defer ticker.Stop()
	for {
		select {
		case <-done:
			return
		case <-ctx.Done():
			return
		case <-ticker.C:
			extended, err := q.scripts.extendLock.Run(ctx, q.client,
				[]string{q.keys.Job(job.ID) + ":lock", q.keys.Stalled},
				job.Token,
				int64(lockDuration/time.Millisecond),
				job.ID,
			).Int64()
			if err != nil {
				if ctx.Err() == nil {
					q.worker.logf("crawlworker: failed to renew the lock queue=%s jobId=%s: %v", q.spec.Name, job.ID, err)
				}
				lost.Store(true)
				cancel(errLockLost)
				return
			}
			if extended == 0 {
				lost.Store(true)
				cancel(errLockLost)
				return
			}
		}
	}
}

// ---------------------------------------------------------------------------
// BullMQ transitions (jobTransitions)
// ---------------------------------------------------------------------------

// UpdateData implements jobTransitions through the updateData script.
func (q *queueRuntime) UpdateData(ctx context.Context, job claimedJob, data []byte) error {
	result, err := q.scripts.updateData.Run(ctx, q.client, []string{q.keys.Job(job.ID)}, data).Result()
	if err != nil {
		return fmt.Errorf("crawlworker: update job data of queue=%s jobId=%s: %w", q.spec.Name, job.ID, err)
	}
	if code := toInt64(result); code < 0 {
		return fmt.Errorf("crawlworker: update job data of queue=%s jobId=%s rejected with BullMQ code %d", q.spec.Name, job.ID, code)
	}
	return nil
}

// MoveToCompleted implements jobTransitions: moveToFinished target "completed"
// with the marshalled summary as the stored returnvalue.
func (q *queueRuntime) MoveToCompleted(ctx context.Context, job claimedJob, returnValue json.RawMessage, maxAttempts int) error {
	options, err := q.finishOptions(job, KeepOnComplete(job.Opts), maxAttempts)
	if err != nil {
		return err
	}
	value := "null"
	if len(returnValue) > 0 {
		value = string(returnValue)
	}
	return q.moveToFinished(ctx, job, q.keys.Completed, "metrics:completed", "returnvalue", value, "completed", options, nil)
}

// MoveToFailed implements jobTransitions: moveToFinished target "failed", which
// emits 'failed' and 'retries-exhausted'. It is only used for a terminal failure.
func (q *queueRuntime) MoveToFailed(ctx context.Context, job claimedJob, reason string, maxAttempts int) error {
	options, err := q.finishOptions(job, KeepOnFail(job.Opts), maxAttempts)
	if err != nil {
		return err
	}
	fields, err := newFailureFields(reason).pack()
	if err != nil {
		return err
	}
	return q.moveToFinished(ctx, job, q.keys.Failed, "metrics:failed", "failedReason", reason, "failed", options, fields)
}

// moveToFinished runs the vendored script with fetch-next disabled: the Go fetch
// loop claims the next job itself, so the transition only needs to finish this
// one.
func (q *queueRuntime) moveToFinished(ctx context.Context, job claimedJob, target, metricsKey, property, value, state string, options finishOptions, fields []byte) error {
	packedOptions, err := pack(options)
	if err != nil {
		return err
	}
	args := []any{
		job.ID,
		q.worker.opts.now().UnixMilli(),
		property,
		value,
		state,
		0,
		q.keys.Base,
		packedOptions,
	}
	if fields != nil {
		args = append(args, fields)
	}
	result, err := q.scripts.moveToFinished.Run(ctx, q.client, q.finishKeys(job.ID, target, metricsKey), args...).Result()
	if err != nil {
		return fmt.Errorf("crawlworker: moveToFinished %s queue=%s jobId=%s: %w", state, q.spec.Name, job.ID, err)
	}
	if code := toInt64(result); code < 0 {
		return fmt.Errorf("crawlworker: moveToFinished %s queue=%s jobId=%s rejected with BullMQ code %d", state, q.spec.Name, job.ID, code)
	}
	return nil
}

// Retry implements jobTransitions through retryJob-11: the job returns to the
// wait/prioritized list and the job hash attemptsMade counter is incremented.
func (q *queueRuntime) Retry(ctx context.Context, job claimedJob, reason string) error {
	fields, err := newFailureFields(reason).pack()
	if err != nil {
		return err
	}
	pushCommand := "LPUSH"
	if job.Opts.LIFO {
		pushCommand = "RPUSH"
	}
	result, err := q.scripts.retryJob.Run(ctx, q.client,
		[]string{
			q.keys.Active,
			q.keys.Wait,
			q.keys.Paused,
			q.keys.Job(job.ID),
			q.keys.Meta,
			q.keys.Events,
			q.keys.Delayed,
			q.keys.Prioritized,
			q.keys.PC,
			q.keys.Marker,
			q.keys.Stalled,
		},
		q.keys.Base,
		q.worker.opts.now().UnixMilli(),
		pushCommand,
		job.ID,
		job.Token,
		fields,
	).Result()
	if err != nil {
		return fmt.Errorf("crawlworker: retryJob queue=%s jobId=%s: %w", q.spec.Name, job.ID, err)
	}
	if code := toInt64(result); code < 0 {
		return fmt.Errorf("crawlworker: retryJob queue=%s jobId=%s rejected with BullMQ code %d", q.spec.Name, job.ID, code)
	}
	return nil
}

// RetryLater implements jobTransitions through moveToDelayed-8: the attempt is
// delayed by the job backoff and the job hash attemptsMade counter is incremented
// (skipAttempt "0").
func (q *queueRuntime) RetryLater(ctx context.Context, job claimedJob, reason string, delayMs int64) error {
	fields, err := newFailureFields(reason).pack()
	if err != nil {
		return err
	}
	result, err := q.scripts.moveToDelayed.Run(ctx, q.client,
		[]string{
			q.keys.Marker,
			q.keys.Active,
			q.keys.Prioritized,
			q.keys.Delayed,
			q.keys.Job(job.ID),
			q.keys.Events,
			q.keys.Meta,
			q.keys.Stalled,
		},
		q.keys.Base,
		q.worker.opts.now().UnixMilli(),
		job.ID,
		job.Token,
		delayMs,
		"0",
		fields,
	).Result()
	if err != nil {
		return fmt.Errorf("crawlworker: moveToDelayed queue=%s jobId=%s: %w", q.spec.Name, job.ID, err)
	}
	if code := toInt64(result); code < 0 {
		return fmt.Errorf("crawlworker: moveToDelayed queue=%s jobId=%s rejected with BullMQ code %d", q.spec.Name, job.ID, code)
	}
	return nil
}

// MoveToWait implements jobTransitions through moveJobFromActiveToWait-9, the
// RateLimitError path. The script moves the job back to wait/prioritized without
// touching attemptsMade or attemptsStarted, emits the 'waiting' event with
// prev=active and returns the limiter PTTL (or 0).
func (q *queueRuntime) MoveToWait(ctx context.Context, job claimedJob) (int64, error) {
	result, err := q.scripts.moveJobFromActiveToWait.Run(ctx, q.client,
		[]string{
			q.keys.Active,
			q.keys.Wait,
			q.keys.Stalled,
			q.keys.Paused,
			q.keys.Meta,
			q.keys.Limiter,
			q.keys.Prioritized,
			q.keys.Marker,
			q.keys.Events,
		},
		job.ID,
		job.Token,
		q.keys.Job(job.ID),
	).Result()
	if err != nil {
		return 0, fmt.Errorf("crawlworker: moveJobFromActiveToWait queue=%s jobId=%s: %w", q.spec.Name, job.ID, err)
	}
	pttl := toInt64(result)
	if pttl < 0 {
		return 0, fmt.Errorf("crawlworker: moveJobFromActiveToWait queue=%s jobId=%s rejected with BullMQ code %d", q.spec.Name, job.ID, pttl)
	}
	return pttl, nil
}

// finishOptions builds the moveToFinished MessagePack options of one job.
func (q *queueRuntime) finishOptions(job claimedJob, keep keepJobs, maxAttempts int) (finishOptions, error) {
	return finishOptions{
		Token:          job.Token,
		KeepJobs:       keep,
		Limiter:        limiterOptions{Max: resolveManualLimiterMax(q.currentConcurrency()), Duration: 1_000},
		LockDuration:   int64(lockDuration / time.Millisecond),
		Attempts:       maxAttempts,
		MaxMetricsSize: "",
	}, nil
}

// finishKeys is moveToFinishedKeys with the target set, metrics key, job key and
// marker filled in.
func (q *queueRuntime) finishKeys(jobID, target, metricsKey string) []string {
	return []string{
		q.keys.Wait,
		q.keys.Active,
		q.keys.Prioritized,
		q.keys.Events,
		q.keys.Stalled,
		q.keys.Limiter,
		q.keys.Delayed,
		q.keys.Paused,
		q.keys.Meta,
		q.keys.PC,
		target,
		q.keys.Job(jobID),
		q.keys.Base + metricsKey,
		q.keys.Marker,
	}
}

// ---------------------------------------------------------------------------
// stalled recovery
// ---------------------------------------------------------------------------

// stalledLoop runs the stalled checker every StalledInterval, like the BullMQ
// Worker timer. One loop per queue, as in NestJS (each Worker owns its own).
func (q *queueRuntime) stalledLoop(ctx context.Context) {
	timer := time.NewTimer(0)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			q.checkStalled(ctx)
			timer.Reset(stalledInterval)
		}
	}
}

// checkStalled runs moveStalledJobsToWait-8 and applies the 'stalled' side effect
// for every recovered job id. The script returns a flat array of job ids,
// including the jobs that exceeded maxStalledCount (the Lua stamps their `defa`
// deferred failure and re-queues them in the same pass).
func (q *queueRuntime) checkStalled(ctx context.Context) {
	result, err := q.scripts.moveStalledJobsToWait.Run(ctx, q.client,
		[]string{
			q.keys.Stalled,
			q.keys.Wait,
			q.keys.Active,
			q.keys.Base + "stalled-check",
			q.keys.Meta,
			q.keys.Paused,
			q.keys.Marker,
			q.keys.Events,
		},
		maxStalledCount,
		q.keys.Base,
		q.worker.opts.now().UnixMilli(),
		int64(stalledInterval/time.Millisecond),
	).Result()
	if err != nil {
		if ctx.Err() == nil {
			q.worker.logf("crawlworker: stalled recovery failed queue=%s: %v", q.spec.Name, err)
		}
		return
	}
	jobIDs := toTextSlice(result)
	if len(jobIDs) == 0 {
		return
	}
	q.worker.logf("crawlworker: recovered %d stalled job(s) queue=%s", len(jobIDs), q.spec.Name)
	for _, jobID := range jobIDs {
		data, err := q.loadJobData(ctx, jobID)
		if err != nil {
			q.worker.logf("crawlworker: failed to read the data of stalled job queue=%s jobId=%s: %v", q.spec.Name, jobID, err)
			continue
		}
		q.worker.attempt.stalledSideEffects(ctx, q.spec.Name, jobID, data)
	}
}

// loadJobData reads CrawlJobData from the job hash for the stalled side effect.
func (q *queueRuntime) loadJobData(ctx context.Context, jobID string) (JobData, error) {
	raw, err := q.client.HGet(ctx, q.keys.Job(jobID), "data").Result()
	if err != nil {
		return JobData{}, err
	}
	if raw == "" {
		return JobData{}, fmt.Errorf("crawlworker: job queue=%s jobId=%s has no data field", q.spec.Name, jobID)
	}
	var data JobData
	if err := json.Unmarshal([]byte(raw), &data); err != nil {
		return JobData{}, err
	}
	return data, nil
}

// sleepContext waits for the duration unless the context is canceled first.
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
