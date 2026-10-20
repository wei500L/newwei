package assistantqueue

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/vmihailenco/msgpack/v5"
)

// Handler processes one claimed job. Returning an error triggers the BullMQ
// retry policy (attempts and exponential backoff from the job options); a nil
// error completes the job and removes it (removeOnComplete=true).
type Handler func(ctx context.Context, job ClaimedJob) error

// Worker consumes the assistant queue with the same lock, retry and stalled
// contracts as BullMQ Worker.
type Worker struct {
	client   *redis.Client
	config   WorkerConfig
	handler  Handler
	stop     chan struct{}
	stopOnce sync.Once
	wg       sync.WaitGroup
}

// NewWorker builds a worker over the shared Redis client.
func NewWorker(client *redis.Client, cfg WorkerConfig, handler Handler) *Worker {
	if cfg.Concurrency < 1 {
		cfg.Concurrency = 1
	}
	if cfg.LockDuration <= 0 {
		cfg.LockDuration = 30 * time.Second
	}
	if cfg.StalledInterval <= 0 {
		cfg.StalledInterval = 30 * time.Second
	}
	if cfg.PollInterval <= 0 {
		cfg.PollInterval = 200 * time.Millisecond
	}
	return &Worker{client: client, config: cfg, handler: handler, stop: make(chan struct{})}
}

// Start launches the claim loops and the stalled detector. It returns
// immediately; Close drains the in-flight handlers.
func (w *Worker) Start(ctx context.Context) {
	w.wg.Add(1)
	go func() {
		defer w.wg.Done()
		w.stalledLoop(ctx)
	}()
	for i := 0; i < w.config.Concurrency; i++ {
		w.wg.Add(1)
		go func(slot int) {
			defer w.wg.Done()
			w.claimLoop(ctx, slot)
		}(i)
	}
}

// Close stops claiming new jobs and waits for the in-flight handlers. The
// context bounds the drain; when it expires the process exits and the job
// locks expire, so BullMQ's stalled detector can hand the job to another
// worker (A2 guarantees the Go claim accepts that re-execution).
func (w *Worker) Close(ctx context.Context) error {
	w.stopOnce.Do(func() { close(w.stop) })
	done := make(chan struct{})
	go func() {
		w.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (w *Worker) claimLoop(ctx context.Context, slot int) {
	loggerPrefix := fmt.Sprintf("api-go: assistant worker slot=%d", slot)
	for {
		select {
		case <-ctx.Done():
			return
		case <-w.stop:
			return
		default:
		}
		claimed, err := w.claim(ctx)
		if err != nil {
			log.Printf("%s claim failed: %v", loggerPrefix, err)
			if !sleepOrStop(ctx, w.stop, time.Second) {
				return
			}
			continue
		}
		if claimed == nil {
			if !sleepOrStop(ctx, w.stop, w.config.PollInterval) {
				return
			}
			continue
		}
		w.runJob(ctx, *claimed, loggerPrefix)
	}
}

// claim runs moveToActive and decodes the returned job hash.
func (w *Worker) claim(ctx context.Context) (*ClaimedJob, error) {
	token, err := randomToken()
	if err != nil {
		return nil, err
	}
	opts := map[string]any{
		"token":        token,
		"lockDuration": w.config.LockDuration.Milliseconds(),
		"limiter":      nil,
	}
	if w.config.WorkerName != "" {
		opts["name"] = w.config.WorkerName
	} else {
		opts["name"] = nil
	}
	packed, err := msgpack.Marshal(opts)
	if err != nil {
		return nil, err
	}
	keys := []string{
		key("wait"),
		key("active"),
		key("prioritized"),
		key("events"),
		key("stalled"),
		key("limiter"),
		key("delayed"),
		key("paused"),
		key("meta"),
		key("pc"),
		key("marker"),
	}
	raw, err := luaScript("moveToActive").Run(ctx, w.client, keys, key(""), time.Now().UnixMilli(), packed).Result()
	if err != nil {
		return nil, err
	}
	items, ok := raw.([]any)
	if !ok || len(items) < 2 {
		return nil, fmt.Errorf("assistant queue: unexpected moveToActive reply %T", raw)
	}
	jobID, _ := items[1].(string)
	if jobID == "" || jobID == "0" {
		return nil, nil
	}
	fields, ok := items[0].([]any)
	if !ok {
		return nil, fmt.Errorf("assistant queue: unexpected job hash reply %T", items[0])
	}
	record, err := decodeJobHash(jobID, fields)
	if err != nil {
		// A job whose hash cannot be parsed cannot be processed. Fail it
		// without retrying so it does not cycle between active and wait.
		_ = w.finish(ctx, ClaimedJob{ID: jobID, Options: JobOptions{}}, token, err)
		return nil, err
	}
	record.Token = token
	return record, nil
}

func decodeJobHash(jobID string, fields []any) (*ClaimedJob, error) {
	values := make(map[string]string, len(fields)/2)
	for i := 0; i+1 < len(fields); i += 2 {
		name, okName := fields[i].(string)
		value, okValue := fields[i+1].(string)
		if !okName || !okValue {
			continue
		}
		values[name] = value
	}
	job := &ClaimedJob{ID: jobID, Name: values["name"]}
	if data := values["data"]; data != "" {
		if err := json.Unmarshal([]byte(data), &job.Data); err != nil {
			return nil, fmt.Errorf("assistant queue: job data is not valid JSON: %w", err)
		}
	}
	if opts := values["opts"]; opts != "" {
		if err := json.Unmarshal([]byte(opts), &job.Options); err != nil {
			return nil, fmt.Errorf("assistant queue: job options are not valid JSON: %w", err)
		}
	}
	job.AttemptsMade = atoiSafe(values["atm"])
	job.StalledCounter = atoiSafe(values["stc"])
	return job, nil
}

func (w *Worker) runJob(ctx context.Context, job ClaimedJob, loggerPrefix string) {
	jobCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	token := job.Token
	renewDone := make(chan struct{})
	if token != "" {
		go w.renewLock(jobCtx, cancel, job.ID, token, renewDone)
	}
	err := w.handler(jobCtx, job)
	close(renewDone)
	cancel()
	// The handler's context cancellation must not decide the job result: a
	// failed renewal means the lock is gone, so completing/failing is a no-op
	// and the stalled detector owns the re-execution.
	if finishErr := w.finish(context.WithoutCancel(ctx), job, token, err); finishErr != nil {
		log.Printf("%s finish failed for job %s: %v", loggerPrefix, job.ID, finishErr)
	}
}

// renewLock extends the lock half-way through its TTL, mirroring the BullMQ
// Worker lock renewer. A zero reply means another owner holds the job.
func (w *Worker) renewLock(ctx context.Context, cancel context.CancelFunc, jobID, token string, done <-chan struct{}) {
	interval := w.config.LockDuration / 2
	if interval < time.Second {
		interval = time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	keys := []string{jobKey(jobID) + ":lock", key("stalled")}
	for {
		select {
		case <-ctx.Done():
			return
		case <-done:
			return
		case <-ticker.C:
			renewCtx, cancelRenew := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
			result, err := luaScript("extendLock").Run(renewCtx, w.client, keys, token, w.config.LockDuration.Milliseconds(), jobID).Result()
			cancelRenew()
			if err != nil {
				log.Printf("api-go: assistant lock renew failed for job %s: %v", jobID, err)
				continue
			}
			if code, ok := result.(int64); ok && code == 0 {
				log.Printf("api-go: assistant lock lost for job %s; cancelling handler", jobID)
				cancel()
				return
			}
		}
	}
}

// finish applies the BullMQ completion/retry decision.
func (w *Worker) finish(ctx context.Context, job ClaimedJob, token string, handlerErr error) error {
	if handlerErr == nil {
		return w.complete(ctx, job, token)
	}
	attempts := job.Options.Attempts
	if attempts <= 0 {
		attempts = 1
	}
	if job.AttemptsMade+1 < attempts {
		delay := exponentialDelay(job.Options.Backoff, job.AttemptsMade+1)
		if delay > 0 {
			return w.retryLater(ctx, job, token, handlerErr, delay)
		}
		return w.retryNow(ctx, job, token, handlerErr)
	}
	return w.fail(ctx, job, token, handlerErr)
}

func (w *Worker) complete(ctx context.Context, job ClaimedJob, token string) error {
	keys := moveToFinishedKeys(job.ID, "completed")
	opts := moveToFinishedOptions(token, job.Options.Attempts, map[string]any{"count": 0})
	args := []any{
		job.ID,
		time.Now().UnixMilli(),
		"returnvalue",
		"null",
		"completed",
		"0",
		key(""),
		opts,
		nil,
	}
	return w.runFinished(ctx, "complete", keys, args)
}

func (w *Worker) fail(ctx context.Context, job ClaimedJob, token string, handlerErr error) error {
	keys := moveToFinishedKeys(job.ID, "failed")
	opts := moveToFinishedOptions(token, job.Options.Attempts, map[string]any{"age": 7 * 24 * 60 * 60, "count": 10_000})
	fields, err := failureFields(handlerErr)
	if err != nil {
		return err
	}
	args := []any{
		job.ID,
		time.Now().UnixMilli(),
		"failedReason",
		handlerErr.Error(),
		"failed",
		"0",
		key(""),
		opts,
		fields,
	}
	return w.runFinished(ctx, "fail", keys, args)
}

func (w *Worker) retryNow(ctx context.Context, job ClaimedJob, token string, handlerErr error) error {
	fields, err := failureFields(handlerErr)
	if err != nil {
		return err
	}
	keys := []string{
		key("active"),
		key("wait"),
		key("paused"),
		jobKey(job.ID),
		key("meta"),
		key("events"),
		key("delayed"),
		key("prioritized"),
		key("pc"),
		key("marker"),
		key("stalled"),
	}
	result, err := luaScript("retryJob").Run(ctx, w.client, keys, key(""), time.Now().UnixMilli(), "LPUSH", job.ID, token, fields).Result()
	if err != nil {
		return err
	}
	return checkScriptCode(result, "retryJob")
}

func (w *Worker) retryLater(ctx context.Context, job ClaimedJob, token string, handlerErr error, delayMs int64) error {
	fields, err := failureFields(handlerErr)
	if err != nil {
		return err
	}
	keys := []string{
		key("marker"),
		key("active"),
		key("prioritized"),
		key("delayed"),
		jobKey(job.ID),
		key("events"),
		key("meta"),
		key("stalled"),
	}
	result, err := luaScript("moveToDelayed").Run(ctx, w.client, keys,
		key(""), time.Now().UnixMilli(), job.ID, token, delayMs, "0", fields).Result()
	if err != nil {
		return err
	}
	return checkScriptCode(result, "moveToDelayed")
}

func (w *Worker) runFinished(ctx context.Context, operation string, keys []string, args []any) error {
	result, err := luaScript("moveToFinished").Run(ctx, w.client, keys, args...).Result()
	if err != nil {
		return err
	}
	return checkScriptCode(result, operation)
}

func checkScriptCode(result any, operation string) error {
	code, ok := result.(int64)
	if !ok {
		return nil
	}
	switch code {
	case 0:
		return nil
	case -1:
		return fmt.Errorf("%s: job key is missing", operation)
	case -2:
		return fmt.Errorf("%s: job lock is missing", operation)
	case -3:
		return fmt.Errorf("%s: job is not in the active list", operation)
	case -4:
		return fmt.Errorf("%s: job has pending children", operation)
	case -6:
		return fmt.Errorf("%s: lock is not owned by this worker", operation)
	case -9:
		return fmt.Errorf("%s: job has failed children", operation)
	default:
		return fmt.Errorf("%s: unexpected BullMQ code %d", operation, code)
	}
}

func moveToFinishedKeys(jobID, target string) []string {
	return []string{
		key("wait"),
		key("active"),
		key("prioritized"),
		key("events"),
		key("stalled"),
		key("limiter"),
		key("delayed"),
		key("paused"),
		key("meta"),
		key("pc"),
		key(target),
		jobKey(jobID),
		key("metrics:" + target),
		key("marker"),
	}
}

func moveToFinishedOptions(token string, attempts int, keepJobs map[string]any) []byte {
	if attempts <= 0 {
		attempts = 1
	}
	opts := map[string]any{
		"token":          token,
		"name":           nil,
		"keepJobs":       keepJobs,
		"limiter":        nil,
		"lockDuration":   30_000,
		"attempts":       attempts,
		"maxMetricsSize": "",
		"fpof":           false,
		"cpof":           false,
		"idof":           false,
		"rdof":           false,
	}
	packed, err := msgpack.Marshal(opts)
	if err != nil {
		return nil
	}
	return packed
}

// failureFields is the objectToFlatArray(fieldsToUpdate) form BullMQ packs:
// a flat ["failedReason", "...", "stacktrace", "[...]"] array.
func failureFields(handlerErr error) ([]byte, error) {
	stack, err := json.Marshal([]string{handlerErr.Error()})
	if err != nil {
		return nil, err
	}
	flat := []any{"failedReason", handlerErr.Error(), "stacktrace", string(stack)}
	return msgpack.Marshal(flat)
}

func exponentialDelay(backoff Backoff, attemptsMade int) int64 {
	if backoff.Type != "exponential" || backoff.Delay <= 0 {
		return 0
	}
	delay := math.Round(math.Pow(2, float64(attemptsMade-1)) * float64(backoff.Delay))
	if delay < 0 || math.IsNaN(delay) || math.IsInf(delay, 0) {
		return 0
	}
	return int64(delay)
}

func (w *Worker) stalledLoop(ctx context.Context) {
	ticker := time.NewTicker(w.config.StalledInterval)
	defer ticker.Stop()
	// Run once on startup so a job left active by a crashed process is moved
	// back before the first interval elapses.
	w.checkStalled(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-w.stop:
			return
		case <-ticker.C:
			w.checkStalled(ctx)
		}
	}
}

// checkStalled runs moveStalledJobsToWait. The script increments the job hash
// field "stc" every time it recovers a job whose lock disappeared; A2 reads
// that field to allow re-claiming the still-running run record.
func (w *Worker) checkStalled(ctx context.Context) {
	keys := []string{
		key("stalled"),
		key("wait"),
		key("active"),
		key("stalled-check"),
		key("meta"),
		key("paused"),
		key("marker"),
		key("events"),
	}
	_, err := luaScript("moveStalledJobsToWait").Run(ctx, w.client, keys,
		w.config.MaxStalledCount, key(""), time.Now().UnixMilli(), w.config.StalledInterval.Milliseconds()).Result()
	if err != nil && !errors.Is(err, context.Canceled) {
		log.Printf("api-go: assistant stalled check failed: %v", err)
	}
}

func sleepOrStop(ctx context.Context, stop <-chan struct{}, duration time.Duration) bool {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-stop:
		return false
	case <-timer.C:
		return true
	}
}

func randomToken() (string, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

func atoiSafe(value string) int {
	if value == "" {
		return 0
	}
	var parsed int
	if _, err := fmt.Sscanf(value, "%d", &parsed); err != nil {
		return 0
	}
	return parsed
}
