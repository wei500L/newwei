package economicqueue

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

// Handler processes one claimed job. Returning an error moves the job to the
// failed set; the handler is responsible for persisting the user-visible fetch
// status exactly once.
type Handler func(ctx context.Context, job Job) error

// WorkerOptions configures the BullMQ-compatible consumer.
type WorkerOptions struct {
	Concurrency int
	// LockDuration bounds one claim. The longest provider chain (three retries
	// at up to 20s plus backoff) must fit below this value.
	LockDuration time.Duration
	Name         string
}

// Worker is the single consumer of bull:akshare-data. It uses one dedicated
// Redis connection for its blocking pop.
type Worker struct {
	redis    *redis.Client
	producer *Producer
	handler  Handler
	opts     WorkerOptions
	stop     context.CancelFunc
	wg       sync.WaitGroup
	once     sync.Once
}

// NewWorker creates a worker. The caller owns the Redis client and closes it
// after Close returns.
func NewWorker(client *redis.Client, handler Handler, opts WorkerOptions) *Worker {
	if opts.Concurrency <= 0 {
		opts.Concurrency = 2
	}
	if opts.LockDuration <= 0 {
		opts.LockDuration = 5 * time.Minute
	}
	if opts.Name == "" {
		opts.Name = "api-go"
	}
	return &Worker{redis: client, producer: NewProducer(client), handler: handler, opts: opts}
}

// Run blocks until the context is cancelled and every in-flight job has
// completed. Call it in a goroutine after catalog and repeat synchronization.
func (w *Worker) Run(ctx context.Context) {
	if w == nil || w.redis == nil || w.handler == nil {
		return
	}
	runCtx, cancel := context.WithCancel(ctx)
	w.stop = cancel
	log.Printf("economicqueue: akshare worker started concurrency=%d", (w.opts.Concurrency))
	semaphore := make(chan struct{}, w.opts.Concurrency)
	for {
		select {
		case <-runCtx.Done():
			w.wg.Wait()
			log.Printf("economicqueue: akshare worker stopped")
			return
		default:
		}
		w.promoteDue(runCtx, time.Now())
		semaphore <- struct{}{}
		jobID, err := w.redis.BRPopLPush(runCtx, queueKey("wait"), queueKey("active"), 2*time.Second).Result()
		if err != nil {
			<-semaphore
			if errors.Is(err, redis.Nil) || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				continue
			}
			log.Printf("economicqueue: blocking pop failed: %v", err)
			time.Sleep(500 * time.Millisecond)
			continue
		}
		job, err := w.claim(runCtx, jobID)
		if err != nil {
			<-semaphore
			log.Printf("economicqueue: claim job %s failed: %v", jobID, err)
			continue
		}
		w.wg.Add(1)
		go func(job Job) {
			defer func() { <-semaphore; w.wg.Done() }()
			w.process(runCtx, job)
		}(job)
	}
}

// Close stops the loop and waits for in-flight jobs.
func (w *Worker) Close(ctx context.Context) error {
	if w == nil {
		return nil
	}
	w.once.Do(func() {
		if w.stop != nil {
			w.stop()
		}
	})
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

func (w *Worker) claim(ctx context.Context, jobID string) (Job, error) {
	fields, err := w.redis.HGetAll(ctx, queueKey(jobID)).Result()
	if err != nil {
		return Job{}, err
	}
	if len(fields) == 0 {
		_ = w.redis.LRem(ctx, queueKey("active"), 1, jobID).Err()
		return Job{}, fmt.Errorf("job hash missing")
	}
	lockKey := queueKey(jobID + ":lock")
	token := fmt.Sprintf("%s:%d", w.opts.Name, time.Now().UnixNano())
	locked, err := w.redis.SetNX(ctx, lockKey, token, w.opts.LockDuration).Result()
	if err != nil {
		return Job{}, err
	}
	if !locked {
		_ = w.redis.LRem(ctx, queueKey("active"), 1, jobID).Err()
		_ = w.redis.LPush(ctx, queueKey("wait"), jobID).Err()
		return Job{}, fmt.Errorf("job is locked")
	}
	var opts jobOptions
	if raw := fields["opts"]; raw != "" {
		if err := json.Unmarshal([]byte(raw), &opts); err != nil {
			_ = w.release(jobID, token)
			return Job{}, fmt.Errorf("invalid job options: %w", err)
		}
	}
	timestamp, _ := strconv.ParseInt(fields["timestamp"], 10, 64)
	delay, _ := strconv.ParseInt(fields["delay"], 10, 64)
	job := Job{
		ID:           jobID,
		Name:         fields["name"],
		Data:         json.RawMessage(fields["data"]),
		Opts:         opts,
		Timestamp:    timestamp,
		Delay:        delay,
		RepeatJobKey: fields["rjk"],
	}
	now := time.Now().UnixMilli()
	pipe := w.redis.TxPipeline()
	pipe.HSet(ctx, queueKey(jobID), "processedOn", now, "pb", w.opts.Name)
	pipe.HIncrBy(ctx, queueKey(jobID), "ats", 1)
	pipe.XAdd(ctx, &redis.XAddArgs{Stream: queueKey("events"), MaxLen: 10000, Approx: true, Values: []any{"event", "active", "jobId", jobID, "prev", "waiting"}})
	if _, err := pipe.Exec(ctx); err != nil {
		_ = w.release(jobID, token)
		return Job{}, err
	}
	// BullMQ schedules the next repeat before executing the processor. A failure
	// in this step is logged but does not fail the current job.
	if job.RepeatJobKey != "" {
		if err := w.producer.ScheduleNextRepeat(ctx, job); err != nil {
			log.Printf("economicqueue: schedule next repeat for %s failed: %v", jobID, err)
		}
	}
	return job, nil
}

func (w *Worker) process(ctx context.Context, job Job) {
	// A job already claimed when shutdown starts must still finish; detach
	// cancellation so only new claims stop.
	handlerCtx := context.WithoutCancel(ctx)
	err := w.handler(handlerCtx, job)
	if err != nil {
		w.finishFailed(job, err)
		return
	}
	w.finishCompleted(job)
}

func (w *Worker) finishCompleted(job Job) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	now := time.Now().UnixMilli()
	pipe := w.redis.TxPipeline()
	pipe.LRem(ctx, queueKey("active"), 1, job.ID)
	pipe.Del(ctx, queueKey(job.ID+":lock"))
	if job.removeOnComplete() {
		pipe.Del(ctx, queueKey(job.ID))
	} else {
		pipe.ZAdd(ctx, queueKey("completed"), redis.Z{Score: float64(now), Member: job.ID})
		pipe.HSet(ctx, queueKey(job.ID), "finishedOn", now, "returnvalue", "null")
	}
	pipe.XAdd(ctx, &redis.XAddArgs{Stream: queueKey("events"), MaxLen: 10000, Approx: true, Values: []any{"event", "completed", "jobId", job.ID, "prev", "active"}})
	if _, err := pipe.Exec(ctx); err != nil {
		log.Printf("economicqueue: complete job %s failed: %v", job.ID, err)
	}
}

func (w *Worker) finishFailed(job Job, jobErr error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	now := time.Now().UnixMilli()
	reason := jobErr.Error()
	runes := []rune(reason)
	if len(runes) > 191 {
		reason = string(runes[:188]) + "..."
	}
	keep := job.Opts.RemoveOnFail
	pipe := w.redis.TxPipeline()
	pipe.LRem(ctx, queueKey("active"), 1, job.ID)
	pipe.Del(ctx, queueKey(job.ID+":lock"))
	if keep.Age == 0 || keep.Count == 0 {
		pipe.Del(ctx, queueKey(job.ID))
	} else {
		pipe.ZAdd(ctx, queueKey("failed"), redis.Z{Score: float64(now), Member: job.ID})
		pipe.HSet(ctx, queueKey(job.ID), "failedReason", reason, "finishedOn", now)
	}
	pipe.XAdd(ctx, &redis.XAddArgs{Stream: queueKey("events"), MaxLen: 10000, Approx: true, Values: []any{"event", "failed", "jobId", job.ID, "failedReason", reason, "prev", "active"}})
	if _, err := pipe.Exec(ctx); err != nil {
		log.Printf("economicqueue: fail job %s failed: %v", job.ID, err)
	}
	w.trimFailed(now, keep)
}

func (w *Worker) trimFailed(now int64, keep keepJobs) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if keep.Age > 0 {
		cutoff := now - keep.Age*1000
		ids, err := w.redis.ZRangeByScore(ctx, queueKey("failed"), &redis.ZRangeBy{Min: "-inf", Max: strconv.FormatInt(cutoff, 10)}).Result()
		if err == nil && len(ids) > 0 {
			for _, id := range ids {
				_ = w.redis.Del(ctx, queueKey(id)).Err()
			}
			_ = w.redis.ZRemRangeByScore(ctx, queueKey("failed"), "-inf", strconv.FormatInt(cutoff, 10)).Err()
		}
	}
	if keep.Count > 0 {
		total, err := w.redis.ZCard(ctx, queueKey("failed")).Result()
		if err != nil || total <= keep.Count {
			return
		}
		victims, err := w.redis.ZRange(ctx, queueKey("failed"), 0, -(keep.Count + 1)).Result()
		if err == nil && len(victims) > 0 {
			for _, id := range victims {
				_ = w.redis.Del(ctx, queueKey(id)).Err()
			}
			_ = w.redis.ZRemRangeByRank(ctx, queueKey("failed"), 0, -(keep.Count + 1)).Err()
		}
	}
}

func (w *Worker) release(jobID, token string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	script := `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) end return 0`
	return w.redis.Eval(ctx, script, []string{queueKey(jobID + ":lock")}, token).Err()
}

const promoteLua = `
local jobs = redis.call('ZRANGEBYSCORE', KEYS[1], 0, ARGV[1], 'LIMIT', 0, 1000)
if #jobs == 0 then return 0 end
redis.call('ZREM', KEYS[1], unpack(jobs))
for _, jobId in ipairs(jobs) do
  redis.call('LPUSH', KEYS[2], jobId)
  redis.call('HSET', KEYS[3] .. jobId, 'delay', 0)
  redis.call('XADD', KEYS[4], 'MAXLEN', '~', 10000, '*', 'event', 'waiting', 'jobId', jobId, 'prev', 'delayed')
end
return #jobs
`

func (w *Worker) promoteDue(ctx context.Context, now time.Time) {
	maxScore := strconv.FormatInt((now.UnixMilli()+1)*4096-1, 10)
	if err := w.redis.Eval(ctx, promoteLua,
		[]string{queueKey("delayed"), queueKey("wait"), queueKey(""), queueKey("events")},
		maxScore).Err(); err != nil && !errors.Is(err, context.Canceled) {
		if !strings.Contains(err.Error(), "context canceled") {
			log.Printf("economicqueue: promote delayed jobs failed: %v", err)
		}
	}
}
