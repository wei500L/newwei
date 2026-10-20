package crawlfrontierllm

import (
	"context"
	"embed"
	"errors"
	"fmt"
	"log"
	"sync"
	"sync/atomic"
	"time"

	"github.com/redis/go-redis/v9"
)

// worker.go is the BullMQ consumer for one LLM queue. Concurrency is 1 and the
// queue-level limiter is max 1 per 1000ms, exactly like createLlmWorker. The
// limiter key (bull:<queue>:limiter) is shared with any NestJS worker still
// consuming during a switchover, so both sides observe the same rate.

//go:embed scripts/*.lua
var workerScripts embed.FS

type queueScripts struct {
	moveToActive          *redis.Script
	extendLock            *redis.Script
	moveToFinished        *redis.Script
	retryJob              *redis.Script
	moveStalledJobsToWait *redis.Script
}

func loadWorkerScripts() (queueScripts, error) {
	load := func(name string) (*redis.Script, error) {
		content, err := workerScripts.ReadFile("scripts/" + name)
		if err != nil {
			return nil, fmt.Errorf("crawlfrontierllm: read embedded script %s: %w", name, err)
		}
		return redis.NewScript(string(content)), nil
	}
	var scripts queueScripts
	var err error
	if scripts.moveToActive, err = load("moveToActive-11.lua"); err != nil {
		return queueScripts{}, err
	}
	if scripts.extendLock, err = load("extendLock-2.lua"); err != nil {
		return queueScripts{}, err
	}
	if scripts.moveToFinished, err = load("moveToFinished-14.lua"); err != nil {
		return queueScripts{}, err
	}
	if scripts.retryJob, err = load("retryJob-11.lua"); err != nil {
		return queueScripts{}, err
	}
	if scripts.moveStalledJobsToWait, err = load("moveStalledJobsToWait-8.lua"); err != nil {
		return queueScripts{}, err
	}
	return scripts, nil
}

// Processor runs one job. The returned value is stored as the BullMQ
// returnvalue; an error fails the attempt.
type Processor func(ctx context.Context, data JobData) (any, error)

// Worker owns one queue.
type Worker struct {
	queue     string
	keys      queueKeys
	scripts   queueScripts
	client    *redis.Client
	blocking  *redis.Client
	opts      workerOptions
	processor Processor
	tokens    *tokenSource
	slot      chan struct{}

	wg          sync.WaitGroup
	mu          sync.Mutex
	closing     bool
	fetchCtx    context.Context
	cancelFetch context.CancelFunc
	jobCtx      context.Context
	cancelJobs  context.CancelFunc
	fetchDone   chan struct{}
	stalledDone chan struct{}
	closeOnce   sync.Once
	started     atomic.Bool
}

type workerOptions struct {
	LockDuration    time.Duration
	LockRenewTime   time.Duration
	StalledInterval time.Duration
	MaxStalledCount int
	DrainDelay      time.Duration
	Logger          func(format string, args ...any)
}

func normalizedWorkerOptions() workerOptions {
	return workerOptions{
		LockDuration: LockDuration, LockRenewTime: LockRenewTime,
		StalledInterval: StalledInterval, MaxStalledCount: MaxStalledCount,
		DrainDelay: DrainDelay, Logger: log.Printf,
	}
}

// newWorker builds one queue consumer over the shared command client and a
// dedicated blocking client.
func newWorker(queue string, client, blocking *redis.Client, processor Processor) (*Worker, error) {
	if client == nil || blocking == nil {
		return nil, fmt.Errorf("crawlfrontierllm: worker requires command and blocking redis clients")
	}
	if processor == nil {
		return nil, fmt.Errorf("crawlfrontierllm: worker requires a processor")
	}
	scripts, err := loadWorkerScripts()
	if err != nil {
		return nil, err
	}
	return &Worker{
		queue: queue, keys: newQueueKeys(queue), scripts: scripts,
		client: client, blocking: blocking, opts: normalizedWorkerOptions(),
		processor: processor, tokens: newTokenSource("crawl-frontier-llm"), slot: make(chan struct{}, 1),
	}, nil
}

// Start pings Redis and starts the fetch and stalled loops.
func (w *Worker) Start(ctx context.Context) error {
	if w == nil {
		return fmt.Errorf("crawlfrontierllm: worker is nil")
	}
	if !w.started.CompareAndSwap(false, true) {
		return fmt.Errorf("crawlfrontierllm: worker already started")
	}
	pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := w.client.Ping(pingCtx).Err(); err != nil {
		return fmt.Errorf("crawlfrontierllm: redis ping failed: %w", err)
	}
	if err := w.blocking.Ping(pingCtx).Err(); err != nil {
		return fmt.Errorf("crawlfrontierllm: blocking redis ping failed: %w", err)
	}
	w.fetchCtx, w.cancelFetch = context.WithCancel(context.Background())
	w.jobCtx, w.cancelJobs = context.WithCancel(context.Background())
	w.fetchDone = make(chan struct{})
	w.stalledDone = make(chan struct{})
	go func() {
		defer close(w.stalledDone)
		w.stalledLoop(w.fetchCtx)
	}()
	go func() {
		defer close(w.fetchDone)
		w.fetchLoop(w.fetchCtx)
	}()
	return nil
}

// Close drains in-flight work and closes the blocking client.
func (w *Worker) Close(ctx context.Context) error {
	if w == nil {
		return nil
	}
	if ctx == nil {
		ctx = context.Background()
	}
	var closeErr error
	w.closeOnce.Do(func() {
		w.mu.Lock()
		w.closing = true
		w.mu.Unlock()
		if w.cancelFetch != nil {
			w.cancelFetch()
		}
		if w.fetchDone != nil {
			select {
			case <-w.fetchDone:
			case <-ctx.Done():
			}
		}
		if w.stalledDone != nil {
			select {
			case <-w.stalledDone:
			case <-ctx.Done():
			}
		}
		drained := make(chan struct{})
		go func() {
			w.wg.Wait()
			close(drained)
		}()
		select {
		case <-drained:
		case <-ctx.Done():
			if w.cancelJobs != nil {
				w.cancelJobs()
			}
			graceCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			select {
			case <-drained:
			case <-graceCtx.Done():
				closeErr = fmt.Errorf("crawlfrontierllm: in-flight jobs did not stop before the shutdown deadline")
			}
		}
		if w.cancelJobs != nil {
			w.cancelJobs()
		}
		if w.blocking != nil {
			if err := w.blocking.Close(); err != nil {
				w.opts.Logger("crawlfrontierllm: close blocking redis: %v", err)
			}
		}
	})
	return closeErr
}

func (w *Worker) fetchLoop(ctx context.Context) {
	for {
		if ctx.Err() != nil {
			return
		}
		if w.isPaused(ctx) {
			if !sleepWorkerContext(ctx, 250*time.Millisecond) {
				return
			}
			continue
		}
		select {
		case w.slot <- struct{}{}:
		case <-ctx.Done():
			return
		}
		job, limitUntil, nextDelayed, err := w.moveToActive(ctx)
		if err != nil {
			<-w.slot
			if ctx.Err() != nil {
				return
			}
			w.opts.Logger("crawlfrontierllm: fetch job from %s: %v", w.queue, err)
			if !sleepWorkerContext(ctx, time.Second) {
				return
			}
			continue
		}
		if job == nil {
			<-w.slot
			now := time.Now().UnixMilli()
			if limitUntil > now {
				// Queue-level limiter: BullMQ waits exactly until the limiter
				// TTL expires before asking for another job.
				if !sleepWorkerContext(ctx, time.Duration(limitUntil-now)*time.Millisecond) {
					return
				}
				continue
			}
			if nextDelayed > now {
				wait := time.Until(time.UnixMilli(nextDelayed))
				if wait > w.opts.DrainDelay {
					wait = w.opts.DrainDelay
				}
				if !sleepWorkerContext(ctx, wait) {
					return
				}
				continue
			}
			w.waitForMarker(ctx)
			continue
		}
		w.mu.Lock()
		if w.closing {
			w.mu.Unlock()
			<-w.slot
			return
		}
		w.wg.Add(1)
		w.mu.Unlock()
		go func(job Job) {
			defer w.wg.Done()
			defer func() { <-w.slot }()
			w.process(ctx, job)
		}(*job)
	}
}

func (w *Worker) isPaused(ctx context.Context) bool {
	paused, err := w.client.HExists(ctx, w.keys.Meta, "paused").Result()
	return err == nil && paused
}

func (w *Worker) waitForMarker(ctx context.Context) {
	timeout := w.opts.DrainDelay
	if timeout <= 0 {
		timeout = DrainDelay
	}
	_, err := w.blocking.BZPopMin(ctx, timeout, w.keys.Marker).Result()
	if err != nil && !errors.Is(err, redis.Nil) && ctx.Err() == nil {
		w.opts.Logger("crawlfrontierllm: wait for marker on %s: %v", w.queue, err)
		if !sleepWorkerContext(ctx, time.Second) {
			return
		}
	}
}

// moveToActive returns (job, limitUntil, nextDelayed). The two delay values are
// the BullMQ rate-limit TTL (reply[2]) and the next delayed job timestamp
// (reply[3]).
func (w *Worker) moveToActive(ctx context.Context) (*Job, int64, int64, error) {
	token := w.tokens.Next()
	options, err := pack(moveToActiveOptions{
		Token: token, LockDuration: int64(w.opts.LockDuration / time.Millisecond),
		Limiter: &limiterOptions{Max: LimiterMax, Duration: int64(LimiterDuration / time.Millisecond)},
	})
	if err != nil {
		return nil, 0, 0, err
	}
	result, err := w.scripts.moveToActive.Run(ctx, w.client, []string{
		w.keys.Wait, w.keys.Active, w.keys.Prioritized, w.keys.Events, w.keys.Stalled,
		w.keys.Limiter, w.keys.Delayed, w.keys.Paused, w.keys.Meta, w.keys.PC, w.keys.Marker,
	}, w.keys.Base, time.Now().UnixMilli(), options).Result()
	if err != nil {
		return nil, 0, 0, err
	}
	values, ok := result.([]any)
	if !ok || len(values) < 4 {
		return nil, 0, 0, fmt.Errorf("crawlfrontierllm: unexpected moveToActive result %T", result)
	}
	limitUntil := toInt64(values[2])
	nextDelayed := toInt64(values[3])
	flat, ok := values[0].([]any)
	if !ok || len(flat) == 0 {
		return nil, limitUntil, nextDelayed, nil
	}
	job, err := jobFromFlat(flat, token, toText(values[1]))
	if err != nil {
		return nil, limitUntil, nextDelayed, err
	}
	return &job, limitUntil, nextDelayed, nil
}

func (w *Worker) process(parent context.Context, job Job) {
	_ = parent
	jobCtx, cancelJob := context.WithCancelCause(w.jobCtx)
	var leaseLost atomic.Bool
	renewDone := make(chan struct{})
	go w.renewLock(jobCtx, job, cancelJob, &leaseLost, renewDone)

	value, err := w.processor(jobCtx, job.Data)
	close(renewDone)
	cancelJob(nil)

	if w.jobCtx.Err() != nil {
		return
	}
	if leaseLost.Load() {
		w.opts.Logger("crawlfrontierllm: lease lost for job %s on %s; leaving it to stalled recovery", job.ID, w.queue)
		return
	}
	finishCtx, cancelFinish := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancelFinish()
	if err == nil {
		w.finishCompleted(finishCtx, job, value)
		return
	}
	w.opts.Logger("crawlfrontierllm: job %s on %s failed: %v", job.ID, w.queue, err)
	if !job.FinalFailure() {
		w.retryJob(finishCtx, job, err)
		return
	}
	w.finishFailed(finishCtx, job, err)
}

func (w *Worker) renewLock(ctx context.Context, job Job, cancel context.CancelCauseFunc, lost *atomic.Bool, done <-chan struct{}) {
	ticker := time.NewTicker(w.opts.LockRenewTime)
	defer ticker.Stop()
	for {
		select {
		case <-done:
			return
		case <-ctx.Done():
			return
		case <-ticker.C:
			extended, err := w.scripts.extendLock.Run(ctx, w.client, []string{
				w.keys.job(job.ID) + ":lock", w.keys.Stalled,
			}, job.Token, int64(w.opts.LockDuration/time.Millisecond), job.ID).Int64()
			if err != nil {
				if ctx.Err() == nil {
					w.opts.Logger("crawlfrontierllm: renew lock %s: %v", job.ID, err)
				}
				lost.Store(true)
				cancel(ErrLeaseLost)
				return
			}
			if extended == 0 {
				lost.Store(true)
				cancel(ErrLeaseLost)
				return
			}
		}
	}
}

func (w *Worker) finishCompleted(ctx context.Context, job Job, value any) {
	options, err := pack(newFinishOptions(job, keepOnComplete(job.Opts)))
	if err != nil {
		w.opts.Logger("crawlfrontierllm: pack completion options for %s: %v", job.ID, err)
		return
	}
	result, err := w.scripts.moveToFinished.Run(ctx, w.client,
		w.finishKeys(job.ID, w.keys.Completed, "metrics:completed"),
		job.ID, time.Now().UnixMilli(), "returnvalue", marshalReturnValue(value), "completed",
		0, w.keys.Base, options).Result()
	if err != nil {
		w.opts.Logger("crawlfrontierllm: finish completed %s: %v", job.ID, err)
		return
	}
	if code := toInt64(result); code < 0 {
		w.opts.Logger("crawlfrontierllm: finish completed %s rejected with BullMQ code %d", job.ID, code)
	}
}

func (w *Worker) finishFailed(ctx context.Context, job Job, cause error) {
	reason := cause.Error()
	fields, err := pack([]string{"failedReason", reason, "stacktrace", stacktraceJSON(reason)})
	if err != nil {
		w.opts.Logger("crawlfrontierllm: pack failure fields for %s: %v", job.ID, err)
		return
	}
	options, err := pack(newFinishOptions(job, keepOnFail(job.Opts)))
	if err != nil {
		w.opts.Logger("crawlfrontierllm: pack failure options for %s: %v", job.ID, err)
		return
	}
	result, err := w.scripts.moveToFinished.Run(ctx, w.client,
		w.finishKeys(job.ID, w.keys.Failed, "metrics:failed"),
		job.ID, time.Now().UnixMilli(), "failedReason", reason, "failed", 0,
		w.keys.Base, options, fields).Result()
	if err != nil {
		w.opts.Logger("crawlfrontierllm: finish failed %s: %v", job.ID, err)
		return
	}
	if code := toInt64(result); code < 0 {
		w.opts.Logger("crawlfrontierllm: finish failed %s rejected with BullMQ code %d", job.ID, code)
	}
}

func (w *Worker) retryJob(ctx context.Context, job Job, cause error) {
	reason := cause.Error()
	fields, err := pack([]string{"failedReason", reason, "stacktrace", stacktraceJSON(reason)})
	if err != nil {
		w.opts.Logger("crawlfrontierllm: pack retry fields for %s: %v", job.ID, err)
		return
	}
	pushCommand := "LPUSH"
	if job.Opts.LIFO {
		pushCommand = "RPUSH"
	}
	result, err := w.scripts.retryJob.Run(ctx, w.client, []string{
		w.keys.Active, w.keys.Wait, w.keys.Paused, w.keys.job(job.ID), w.keys.Meta,
		w.keys.Events, w.keys.Delayed, w.keys.Prioritized, w.keys.PC, w.keys.Marker, w.keys.Stalled,
	}, w.keys.Base, time.Now().UnixMilli(), pushCommand, job.ID, job.Token, fields).Result()
	if err != nil {
		w.opts.Logger("crawlfrontierllm: retry %s: %v", job.ID, err)
		return
	}
	if code := toInt64(result); code < 0 {
		w.opts.Logger("crawlfrontierllm: retry %s rejected with BullMQ code %d", job.ID, code)
	}
}

func (w *Worker) finishKeys(jobID, target, metricsSuffix string) []string {
	return []string{
		w.keys.Wait, w.keys.Active, w.keys.Prioritized, w.keys.Events, w.keys.Stalled,
		w.keys.Limiter, w.keys.Delayed, w.keys.Paused, w.keys.Meta, w.keys.PC, target,
		w.keys.job(jobID), w.keys.Base + metricsSuffix, w.keys.Marker,
	}
}

func (w *Worker) stalledLoop(ctx context.Context) {
	timer := time.NewTimer(0)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			w.checkStalled(ctx)
			timer.Reset(w.opts.StalledInterval)
		}
	}
}

func (w *Worker) checkStalled(ctx context.Context) {
	_, err := w.scripts.moveStalledJobsToWait.Run(ctx, w.client, []string{
		w.keys.Stalled, w.keys.Wait, w.keys.Active, w.keys.Base + "stalled-check",
		w.keys.Meta, w.keys.Paused, w.keys.Marker, w.keys.Events,
	}, w.opts.MaxStalledCount, w.keys.Base, time.Now().UnixMilli(),
		int64(w.opts.StalledInterval/time.Millisecond)).Result()
	if err != nil && ctx.Err() == nil {
		w.opts.Logger("crawlfrontierllm: stalled recovery on %s: %v", w.queue, err)
	}
}

// newBlockingClient opens the dedicated BZPOPMIN connection for a worker.
func newBlockingClient(options *redis.Options, database int) *redis.Client {
	opts := *options
	opts.DB = database
	opts.Protocol = 2
	return redis.NewClient(&opts)
}

// sleepWorkerContext is the worker loop's cancellable sleep. It returns false
// when the context ended, matching the clustering runner's helper; the LLM
// retry loop uses the error-returning sleepContext in llm.go.
func sleepWorkerContext(ctx context.Context, duration time.Duration) bool {
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
