package crawlqueue

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/vmihailenco/msgpack/v5"
)

// Producer writes and controls the three crawl queues through the official
// BullMQ scripts. It is the only Go component that touches the BullMQ protocol
// in this batch.
type Producer struct {
	redis    *redis.Client
	settings *SettingsReader
	activity *Activity
	now      func() time.Time
}

// Options configures NewProducer.
type Options struct {
	Redis *redis.Client
	DB    *sql.DB
	// Now overrides the clock; tests only.
	Now func() time.Time
	// Activity overrides the counter; tests only.
	Activity *Activity
	// Env overrides the environment-derived default settings document.
	Env *EnvDefaults
}

// NewProducer builds the producer on the shared Redis and MySQL handles.
func NewProducer(options Options) *Producer {
	now := options.Now
	if now == nil {
		now = time.Now
	}
	producer := &Producer{
		redis:    options.Redis,
		settings: NewSettingsReader(options.DB, options.Redis, options.Env),
		activity: options.Activity,
		now:      now,
	}
	if producer.activity == nil {
		producer.activity = NewActivity(options.Redis)
	}
	return producer
}

// EnqueueTask is CrawlQueueService.enqueueTask. A deduplicated add returns the
// existing job id and does not increment the activity counter.
func (p *Producer) EnqueueTask(ctx context.Context, taskID, orgID string, options EnqueueOptions) (EnqueueResult, error) {
	if p == nil || p.redis == nil {
		return EnqueueResult{}, errNoRedis
	}
	settings := p.settings.Read(ctx)
	attempts := settings.MaxRetries
	if attempts < 1 {
		attempts = 1
	}
	traceID := strings.TrimSpace(options.TraceID)
	if traceID == "" {
		traceID = newTraceID()
	}
	priorityClass := NormalizePriorityClass(options.PriorityClass)
	queueName := QueueNormal
	if priorityClass == PriorityClassHot {
		queueName = QueueHot
	}
	keys := keysFor(queueName)
	jobID := fmt.Sprintf("%s-%d-%s", taskID, p.now().UnixMilli(), priorityClass)
	deduplicationID := "crawl-task:" + taskID
	priority := ToBullmqPriority(options.SourcePriority)

	data := TaskJobData{
		TaskID:                 taskID,
		OrgID:                  orgID,
		SourceID:               options.SourceID,
		TriggeredByID:          options.TriggeredByID,
		TraceID:                traceID,
		MemoryPressureRequeues: 0,
		PriorityClass:          string(priorityClass),
		SourcePriority:         options.SourcePriority,
	}
	encodedData, err := json.Marshal(data)
	if err != nil {
		return EnqueueResult{}, err
	}

	jobOptions := jobOptions{
		Attempts:         int64(attempts),
		RemoveOnComplete: true,
		RemoveOnFail:     failedRetention{Age: failedRetentionAge, Count: failedRetentionCount},
		JobID:            jobID,
		Deduplication:    &deduplicationOptions{ID: deduplicationID},
		Priority:         priority,
	}
	if settings.RetryBackoffMs != 0 {
		jobOptions.Backoff = &backoffOptions{Type: "exponential", Delay: int64(settings.RetryBackoffMs)}
	}
	encodedOptions, err := msgpack.Marshal(jobOptions)
	if err != nil {
		return EnqueueResult{}, err
	}

	// The Lua script unpacks a positional MessagePack array. Null entries are
	// the unused parent/repeat/deduplication slots, exactly like BullMQ's
	// Scripts.addJob passes them.
	deduplicationKey := keys.dedup + deduplicationID
	arguments := []any{
		Prefix + ":" + queueName + ":",
		jobID,
		JobName,
		p.now().UnixMilli(),
		nil, // parentKey
		nil, // parentDependenciesKey
		nil, // parent
		nil, // repeatJobKey
		deduplicationKey,
	}
	encodedArguments, err := msgpack.Marshal(arguments)
	if err != nil {
		return EnqueueResult{}, err
	}

	script := addStandardJobScript
	scriptKeys := []string{
		keys.wait, keys.paused, keys.meta, keys.id, keys.completed,
		keys.delayed, keys.active, keys.events, keys.marker,
	}
	if priority != nil && *priority != 0 {
		script = addPrioritizedJobScript
		scriptKeys = []string{
			keys.marker, keys.meta, keys.id, keys.prioritized, keys.delayed,
			keys.completed, keys.active, keys.events, keys.pc,
		}
	}
	result, err := p.redis.Eval(ctx, script, scriptKeys, encodedArguments, string(encodedData), encodedOptions).Result()
	if err != nil {
		return EnqueueResult{}, err
	}
	returnedID, err := jobIDFromEval(result)
	if err != nil {
		return EnqueueResult{}, err
	}
	// BullMQ simple-mode deduplication returns the surviving job id. Only a
	// fresh id owns a new active-task slot.
	deduplicated := returnedID != jobID
	if !deduplicated {
		if err := p.activity.MarkTaskQueued(ctx); err != nil {
			log.Printf("crawlqueue: failed to increment crawl activity for task %s: %v", taskID, err)
		}
	}
	return EnqueueResult{JobID: returnedID, Deduplicated: deduplicated}, nil
}

// jobOptions is the JobsOptions map BullMQ packs. Field order follows the
// merged default+add options order; the Lua script only reads keys by name.
type jobOptions struct {
	Attempts         int64                 `msgpack:"attempts"`
	RemoveOnComplete bool                  `msgpack:"removeOnComplete"`
	RemoveOnFail     failedRetention       `msgpack:"removeOnFail"`
	Backoff          *backoffOptions       `msgpack:"backoff,omitempty"`
	JobID            string                `msgpack:"jobId"`
	Deduplication    *deduplicationOptions `msgpack:"de,omitempty"`
	Priority         *int                  `msgpack:"priority,omitempty"`
}

type failedRetention struct {
	Age   int64 `msgpack:"age"`
	Count int64 `msgpack:"count"`
}

type backoffOptions struct {
	Type  string `msgpack:"type"`
	Delay int64  `msgpack:"delay"`
}

type deduplicationOptions struct {
	ID string `msgpack:"id"`
}

// jobIDFromEval normalizes the Lua result into the string job id.
func jobIDFromEval(result any) (string, error) {
	switch value := result.(type) {
	case string:
		return value, nil
	case int64:
		if value < 0 {
			return "", fmt.Errorf("crawlqueue: bullmq add job failed with code %d", value)
		}
		return strconv.FormatInt(value, 10), nil
	case int:
		if value < 0 {
			return "", fmt.Errorf("crawlqueue: bullmq add job failed with code %d", value)
		}
		return strconv.Itoa(value), nil
	case []byte:
		return string(value), nil
	default:
		return "", fmt.Errorf("crawlqueue: unexpected bullmq add reply %T", result)
	}
}

// RemoveQueuedJobs is CrawlQueueService.removeQueuedJobs. It scans waiting,
// delayed, failed and paused jobs in pages of 200 (at most 5000 per state),
// matches on data.taskId, and compensates the activity counter by the number of
// removed jobs.
func (p *Producer) RemoveQueuedJobs(ctx context.Context, taskID string) (int, error) {
	if p == nil || p.redis == nil {
		return 0, errNoRedis
	}
	removed := 0
	for _, keys := range queueEntries() {
		for start := 0; start < removeScanLimit; start += removePageSize {
			end := start + removePageSize - 1
			if end >= removeScanLimit {
				end = removeScanLimit - 1
			}
			ids, err := p.rangeJobIDs(ctx, keys, start, end)
			if err != nil {
				return removed, err
			}
			if len(ids) > 0 {
				matches, err := p.matchingJobs(ctx, keys, ids, taskID)
				if err != nil {
					return removed, err
				}
				for _, id := range matches {
					ok, err := p.removeJob(ctx, keys, id)
					if err != nil {
						log.Printf("crawlqueue: failed to remove job %s from %s: %v", id, keys.queue, err)
						continue
					}
					if ok {
						removed++
					}
				}
			}
			if len(ids) < removePageSize {
				break
			}
		}
	}
	if removed > 0 {
		// B1: the terminal decrement is one Lua script. The removed count was read
		// from a page of job ids, so a producer on another instance can increment
		// the same counter while this batch is applied; a pipelined HINCRBY plus a
		// separate floor-to-zero HSET could drop that increment.
		if err := p.activity.MarkTasksTerminalAtomic(ctx, removed); err != nil {
			log.Printf("crawlqueue: failed to decrement crawl activity: %v", err)
		}
	}
	return removed, nil
}

// rangeJobIDs is getRanges for waiting, delayed, failed and paused. Waiting and
// paused are lists (LRANGE start..end, marker popped first); delayed and failed
// are sorted sets read newest-first (ZREVRANGE).
func (p *Producer) rangeJobIDs(ctx context.Context, keys queueKeys, start, end int) ([]string, error) {
	ids := make([]string, 0, 4*removePageSize)
	for _, state := range []string{"wait", "delayed", "failed", "paused"} {
		var values []string
		var err error
		switch state {
		case "wait", "paused":
			listKey := keys.wait
			if state == "paused" {
				listKey = keys.paused
			}
			values, err = p.listRange(ctx, listKey, start, end)
		default:
			setKey := keys.delayed
			if state == "failed" {
				setKey = keys.failed
			}
			values, err = p.redis.ZRevRange(ctx, setKey, int64(start), int64(end)).Result()
		}
		if err != nil {
			return nil, err
		}
		ids = append(ids, values...)
	}
	return ids, nil
}

// listRange mirrors getRangeInList for a list, including the deprecated v5
// marker handling: a trailing "0:..." marker is popped before the range.
func (p *Producer) listRange(ctx context.Context, listKey string, start, end int) ([]string, error) {
	marker, err := p.redis.LIndex(ctx, listKey, -1).Result()
	if err != nil && err != redis.Nil {
		return nil, err
	}
	if strings.HasPrefix(marker, "0:") {
		length, err := p.redis.LLen(ctx, listKey).Result()
		if err != nil {
			return nil, err
		}
		if length > 1 {
			if err := p.redis.RPop(ctx, listKey).Err(); err != nil {
				return nil, err
			}
		} else {
			return nil, nil
		}
	}
	values, err := p.redis.LRange(ctx, listKey, int64(start), int64(end)).Result()
	if err != nil {
		return nil, err
	}
	return values, nil
}

// matchingJobs reads each job hash's data and keeps the ids whose taskId
// matches. This is the O1 optimisation: it never loads full task objects.
func (p *Producer) matchingJobs(ctx context.Context, keys queueKeys, ids []string, taskID string) ([]string, error) {
	pipe := p.redis.Pipeline()
	commands := make([]*redis.StringCmd, len(ids))
	for index, id := range ids {
		commands[index] = pipe.HGet(ctx, keys.jobKey(id), "data")
	}
	if _, err := pipe.Exec(ctx); err != nil && err != redis.Nil {
		return nil, err
	}
	matches := make([]string, 0, len(ids))
	for index, command := range commands {
		raw, err := command.Result()
		if err != nil {
			continue
		}
		var data struct {
			TaskID string `json:"taskId"`
		}
		if json.Unmarshal([]byte(raw), &data) != nil {
			continue
		}
		if data.TaskID == taskID {
			matches = append(matches, ids[index])
		}
	}
	return matches, nil
}

// removeJob runs the official removeJob script. A zero result means the job is
// locked by another worker, which NestJS treats as a silent skip.
func (p *Producer) removeJob(ctx context.Context, keys queueKeys, jobID string) (bool, error) {
	result, err := p.redis.Eval(ctx, removeJobScript,
		[]string{keys.jobKey(jobID), keys.queuePrefix() + "repeat"},
		jobID, "1", keys.queuePrefix()).Result()
	if err != nil {
		return false, err
	}
	removed, ok := result.(int64)
	if !ok {
		return false, fmt.Errorf("crawlqueue: unexpected removeJob reply %T", result)
	}
	if removed < 0 {
		return false, fmt.Errorf("crawlqueue: removeJob rejected job %s with code %d", jobID, removed)
	}
	return removed == 1, nil
}

// queuePrefix is bull:{queue}:, the ARGV[3] prefix of removeJob.
func (k queueKeys) queuePrefix() string {
	return Prefix + ":" + k.queue + ":"
}

// Pause pauses every crawl queue (wait -> paused, meta.paused=1).
func (p *Producer) Pause(ctx context.Context) error {
	for _, keys := range queueEntries() {
		if err := p.setPaused(ctx, keys, true); err != nil {
			return err
		}
	}
	return nil
}

// Resume resumes every crawl queue.
func (p *Producer) Resume(ctx context.Context) error {
	for _, keys := range queueEntries() {
		if err := p.setPaused(ctx, keys, false); err != nil {
			return err
		}
	}
	return nil
}

// setPaused runs the official pause script with pauseArgs key order.
func (p *Producer) setPaused(ctx context.Context, keys queueKeys, pause bool) error {
	src, dst, arg := keys.wait, keys.paused, "paused"
	if !pause {
		src, dst, arg = keys.paused, keys.wait, "resumed"
	}
	scriptKeys := []string{
		src, dst, keys.meta, keys.prioritized, keys.events, keys.delayed, keys.marker,
	}
	// The official pause script ends with an XADD statement and no return, so
	// Redis answers nil. ioredis treats that as a null reply; go-redis maps it
	// to redis.Nil, which is not an error here.
	err := p.redis.Eval(ctx, pauseScript, scriptKeys, arg).Err()
	if err != nil && err != redis.Nil {
		return err
	}
	return nil
}

// Counts is CrawlQueueService.getJobCounts: hot + normal + legacy.
func (p *Producer) Counts(ctx context.Context) (QueueCounts, error) {
	hot, err := p.countsFor(ctx, keysFor(QueueHot))
	if err != nil {
		return QueueCounts{}, err
	}
	normal, err := p.countsFor(ctx, keysFor(QueueNormal))
	if err != nil {
		return QueueCounts{}, err
	}
	legacy, err := p.countsFor(ctx, keysFor(QueueLegacy))
	if err != nil {
		return QueueCounts{}, err
	}
	return hot.Add(normal).Add(legacy), nil
}

// CountsByQueue is getJobCountsByQueue: hot and normal only.
func (p *Producer) CountsByQueue(ctx context.Context) (hot, normal QueueCounts, err error) {
	hot, err = p.countsFor(ctx, keysFor(QueueHot))
	if err != nil {
		return QueueCounts{}, QueueCounts{}, err
	}
	normal, err = p.countsFor(ctx, keysFor(QueueNormal))
	return hot, normal, err
}

// LegacyCounts is getLegacyJobCounts.
func (p *Producer) LegacyCounts(ctx context.Context) (QueueCounts, error) {
	return p.countsFor(ctx, keysFor(QueueLegacy))
}

// countsFor runs getCounts with the five statuses getJobCounts asks for.
func (p *Producer) countsFor(ctx context.Context, keys queueKeys) (QueueCounts, error) {
	result, err := p.redis.Eval(ctx, getCountsScript, []string{keys.queuePrefix()},
		"wait", "active", "delayed", "failed", "paused").Result()
	if err != nil {
		return QueueCounts{}, err
	}
	values, ok := result.([]any)
	if !ok || len(values) != 5 {
		return QueueCounts{}, fmt.Errorf("crawlqueue: unexpected getCounts reply %T", result)
	}
	numbers := make([]int64, 5)
	for index, value := range values {
		number, ok := value.(int64)
		if !ok {
			return QueueCounts{}, fmt.Errorf("crawlqueue: unexpected getCounts element %T", value)
		}
		numbers[index] = number
	}
	return QueueCounts{
		Waiting: numbers[0],
		Active:  numbers[1],
		Delayed: numbers[2],
		Failed:  numbers[3],
		Paused:  numbers[4],
	}, nil
}

// IsPaused is Queue.isPaused: HEXISTS meta paused.
func (p *Producer) IsPaused(ctx context.Context, queue string) (bool, error) {
	exists, err := p.redis.HExists(ctx, keysFor(queue).meta, "paused").Result()
	if err != nil {
		return false, err
	}
	return exists, nil
}

// PausedByQueue is getPausedByQueue.
func (p *Producer) PausedByQueue(ctx context.Context) (hot, normal bool, err error) {
	hot, err = p.IsPaused(ctx, QueueHot)
	if err != nil {
		return false, false, err
	}
	normal, err = p.IsPaused(ctx, QueueNormal)
	return hot, normal, err
}

// GetGlobalConcurrency is Queue.getGlobalConcurrency: HGET meta concurrency,
// with a falsy value mapping to null.
func (p *Producer) GetGlobalConcurrency(ctx context.Context, queue string) (*int, error) {
	raw, err := p.redis.HGet(ctx, keysFor(queue).meta, "concurrency").Result()
	if err == redis.Nil {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	value, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil || value <= 0 {
		return nil, nil
	}
	return &value, nil
}

// SetGlobalConcurrency is Queue.setGlobalConcurrency: HSET meta concurrency.
func (p *Producer) SetGlobalConcurrency(ctx context.Context, value int) error {
	for _, keys := range queueEntries() {
		if err := p.redis.HSet(ctx, keys.meta, "concurrency", value).Err(); err != nil {
			return err
		}
	}
	return nil
}

// WorkerConcurrencyMessage is the C2 broadcast payload.
type WorkerConcurrencyMessage struct {
	Version        int `json:"version"`
	MaxConcurrency int `json:"maxConcurrency"`
}

// PublishWorkerConcurrency publishes the C2 worker concurrency broadcast. A
// publish failure is returned to the caller, which logs a warning: the setting
// and the Redis meta are already written and NestJS reapplies them on restart.
func (p *Producer) PublishWorkerConcurrency(ctx context.Context, maxConcurrency int) error {
	if p == nil || p.redis == nil {
		return errNoRedis
	}
	payload, err := json.Marshal(WorkerConcurrencyMessage{Version: 1, MaxConcurrency: maxConcurrency})
	if err != nil {
		return err
	}
	return p.redis.Publish(ctx, WorkerConcurrencyChannel, payload).Err()
}

// newTraceID mints a canonical UUID v4 like ensureTraceId.
func newTraceID() string {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "00000000-0000-4000-8000-000000000000"
	}
	buf[6] = (buf[6] & 0x0f) | 0x40
	buf[8] = (buf[8] & 0x3f) | 0x80
	encoded := hex.EncodeToString(buf[:])
	return encoded[0:8] + "-" + encoded[8:12] + "-" + encoded[12:16] + "-" + encoded[16:20] + "-" + encoded[20:32]
}

// SettingsReader exposes the crawl client settings reader the producer uses, so
// the queue status route projects the same document and cache key.
func (p *Producer) SettingsReader() *SettingsReader {
	if p == nil {
		return nil
	}
	return p.settings
}
