// Package telegramsched owns the Redis side of the situation-monitor Telegram
// poll schedule. It is the Go equivalent of
// apps/api/src/modules/situation-monitor/signals/situation-monitor-telegram-scheduler.ts
// and speaks the BullMQ 5.63.2 JobScheduler protocol (addJobScheduler /
// removeJobScheduler), not the legacy hashed repeat protocol.
package telegramsched

import (
	"context"
	"crypto/md5"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/vmihailenco/msgpack/v5"
)

const (
	// QueueName is SITUATION_MONITOR_SIGNALS_QUEUE_NAME.
	QueueName = "situationMonitorSignals"
	// Prefix is BullMQ's default key prefix; the NestJS queue is created
	// without a prefix option.
	Prefix = "bull"
	// PollJobName is TELEGRAM_POLL_JOB_NAME.
	PollJobName = "telegram-poll"
	// PollSchedulerID is TELEGRAM_POLL_SCHEDULER_ID.
	PollSchedulerID = PollJobName + ":scheduler"
	// MinIntervalMillis is the 15 second floor upsertTelegramPollScheduler
	// applies with Math.max(15_000, Math.floor(intervalMs)).
	MinIntervalMillis = 15_000
	// failedRetentionAgeSeconds / Count mirror BULLMQ_FAILED_JOB_RETENTION
	// {age: 604800, count: 10000}.
	failedRetentionAgeSeconds = 604_800
	failedRetentionCount      = 10_000
)

// Scheduler writes the Telegram poll job scheduler into the shared BullMQ
// queue. It is safe for concurrent use; the caller owns the Redis client.
type Scheduler struct {
	redis *redis.Client
	keys  queueKeys
	now   func() time.Time
}

// queueKeys mirrors the BullMQ QueueKeys constructor for the default prefix.
type queueKeys struct {
	prefix      string
	active      string
	wait        string
	paused      string
	id          string
	delayed     string
	prioritized string
	repeat      string
	meta        string
	events      string
	pc          string
	marker      string
}

// New wires the scheduler to the shared Redis client.
func New(client *redis.Client) *Scheduler {
	base := Prefix + ":" + QueueName
	key := func(suffix string) string { return base + ":" + suffix }
	return &Scheduler{
		redis: client,
		keys: queueKeys{
			prefix:      base + ":",
			active:      key("active"),
			wait:        key("wait"),
			paused:      key("paused"),
			id:          key("id"),
			delayed:     key("delayed"),
			prioritized: key("prioritized"),
			repeat:      key("repeat"),
			meta:        key("meta"),
			events:      key("events"),
			pc:          key("pc"),
			marker:      key("marker"),
		},
		now: time.Now,
	}
}

// Sync is syncTelegramScheduleBestEffort without the catch: it removes legacy
// repeat entries, then either removes or upserts the JobScheduler and adds the
// one-shot bootstrap job. The caller logs a warning and keeps the HTTP response
// on any error, exactly like the NestJS controller.
func (s *Scheduler) Sync(ctx context.Context, enabled bool, intervalMs int) error {
	if s == nil || s.redis == nil {
		return errors.New("telegramsched: redis is not configured")
	}
	scripts, err := loadScripts()
	if err != nil {
		return err
	}
	if err := s.removeLegacyRepeatJobs(ctx, scripts); err != nil {
		return err
	}
	if !enabled {
		if err := s.removePollScheduler(ctx, scripts); err != nil {
			return err
		}
		return s.removeQueuedPollJobs(ctx, scripts)
	}
	if err := s.upsertPollScheduler(ctx, scripts, intervalMs); err != nil {
		return err
	}
	return s.addBootstrapJob(ctx, scripts)
}

// removeLegacyRepeatJobs mirrors removeLegacyTelegramRepeatJobs: read every
// member of the repeat zset, keep the ones whose repeat hash name equals
// TELEGRAM_POLL_JOB_NAME, and run removeRepeatableByKey for each.
func (s *Scheduler) removeLegacyRepeatJobs(ctx context.Context, scripts schedulerScripts) error {
	members, err := s.redis.ZRange(ctx, s.keys.repeat, 0, -1).Result()
	if err != nil {
		return fmt.Errorf("telegramsched: list repeatable jobs: %w", err)
	}
	for _, repeatKey := range members {
		fields, err := s.redis.HGetAll(ctx, s.keys.repeat+":"+repeatKey).Result()
		if err != nil {
			return fmt.Errorf("telegramsched: read repeatable job %q: %w", repeatKey, err)
		}
		if fields["name"] != PollJobName {
			continue
		}
		if _, err := scripts.removeRepeatable.Run(ctx, s.redis,
			[]string{s.keys.repeat, s.keys.delayed, s.keys.events},
			legacyRepeatJobID(repeatKey), removalConcatOptions(repeatKey), repeatKey, s.keys.prefix,
		).Result(); err != nil {
			return fmt.Errorf("telegramsched: remove legacy repeat %q: %w", repeatKey, err)
		}
	}
	return nil
}

// upsertPollScheduler mirrors upsertTelegramPollScheduler. BullMQ calls
// JobScheduler.upsertJobScheduler with {override:true}, which executes
// addJobScheduler-11 and stores the next iteration in the repeat zset + hash.
func (s *Scheduler) upsertPollScheduler(ctx context.Context, scripts schedulerScripts, intervalMs int) error {
	every := intervalMs
	if every < MinIntervalMillis {
		every = MinIntervalMillis
	}
	now := s.now().UnixMilli()

	schedulerOpts, err := msgpack.Marshal(map[string]any{
		"name":      PollJobName,
		"startDate": nil,
		"endDate":   nil,
		"tz":        nil,
		"pattern":   nil,
		"every":     int64(every),
		"limit":     nil,
		"offset":    nil,
	})
	if err != nil {
		return fmt.Errorf("telegramsched: encode scheduler options: %w", err)
	}
	templateOpts, err := msgpack.Marshal(map[string]any{
		"removeOnComplete": true,
		"removeOnFail":     failedRetention(),
	})
	if err != nil {
		return fmt.Errorf("telegramsched: encode template options: %w", err)
	}
	// JobScheduler.getNextJobOpts runs before the script and uses the still
	// undefined nextMillis for an every schedule, so jobId ends in ":undefined"
	// and delay is NaN. addJobFromScheduler overwrites both fields; keeping the
	// same shape makes the packed argument identical in meaning.
	delayedOpts, err := msgpack.Marshal(map[string]any{
		"removeOnComplete": true,
		"removeOnFail":     failedRetention(),
		"jobId":            "repeat:" + PollSchedulerID + ":undefined",
		"delay":            0.0,
		"timestamp":        now,
		"repeatJobKey":     PollSchedulerID,
		"repeat": map[string]any{
			"every":  int64(every),
			"offset": nil,
			"count":  int64(1),
		},
	})
	if err != nil {
		return fmt.Errorf("telegramsched: encode delayed options: %w", err)
	}

	if _, err := scripts.addJobScheduler.Run(ctx, s.redis, []string{
		s.keys.repeat,
		s.keys.delayed,
		s.keys.wait,
		s.keys.paused,
		s.keys.meta,
		s.keys.prioritized,
		s.keys.marker,
		s.keys.id,
		s.keys.events,
		s.keys.pc,
		s.keys.active,
	},
		// ARGV[1] is recomputed from `every` inside the script.
		"0",
		schedulerOpts,
		PollSchedulerID,
		`{"type":"poll","source":"telegram"}`,
		templateOpts,
		delayedOpts,
		now,
		s.keys.prefix,
		"",
	).Result(); err != nil {
		return fmt.Errorf("telegramsched: upsert poll scheduler: %w", err)
	}
	return nil
}

// removePollScheduler mirrors removeTelegramPollScheduler.
func (s *Scheduler) removePollScheduler(ctx context.Context, scripts schedulerScripts) error {
	if _, err := scripts.removeJobScheduler.Run(ctx, s.redis,
		[]string{s.keys.repeat, s.keys.delayed, s.keys.events},
		PollSchedulerID, s.keys.prefix,
	).Result(); err != nil {
		return fmt.Errorf("telegramsched: remove poll scheduler: %w", err)
	}
	return nil
}

// addBootstrapJob mirrors the queue.add(`${TELEGRAM_POLL_JOB_NAME}:bootstrap`,
// ...) call: one ordinary wait-list job with removeOnComplete and the shared
// failed-job retention. It has no job id, so the script allocates the counter id
// exactly like BullMQ's Job.create.
func (s *Scheduler) addBootstrapJob(ctx context.Context, scripts schedulerScripts) error {
	now := s.now().UnixMilli()
	args, err := msgpack.Marshal([]any{
		s.keys.prefix,
		"",
		PollJobName + ":bootstrap",
		now,
		nil, // parentKey
		nil, // parent dependencies key
		nil, // parent {id, queueKey}
		nil, // repeat job key
		nil, // deduplication key
	})
	if err != nil {
		return fmt.Errorf("telegramsched: encode bootstrap arguments: %w", err)
	}
	opts, err := msgpack.Marshal(map[string]any{
		"removeOnFail":     failedRetention(),
		"removeOnComplete": true,
	})
	if err != nil {
		return fmt.Errorf("telegramsched: encode bootstrap options: %w", err)
	}
	result, err := scripts.addStandardJob.Run(ctx, s.redis, []string{
		s.keys.wait,
		s.keys.paused,
		s.keys.meta,
		s.keys.id,
		s.keys.prefix + "completed",
		s.keys.delayed,
		s.keys.active,
		s.keys.events,
		s.keys.marker,
	}, args, `{"type":"poll","source":"telegram"}`, opts).Result()
	if err != nil {
		return fmt.Errorf("telegramsched: add bootstrap job: %w", err)
	}
	if code := negativeCode(result); code < 0 {
		return fmt.Errorf("telegramsched: add bootstrap job rejected with BullMQ code %d", code)
	}
	return nil
}

// removeQueuedPollJobs mirrors removeQueuedTelegramPollJobs while reading only
// the fields it needs (O1). BullMQ's sanitizeJobTypes turns the request
// ['wait','waiting','prioritized','delayed'] into wait, paused, prioritized and
// delayed, so those are the four collections inspected here. Job names come
// from one pipelined HGET per id instead of a full Job.fromId decode.
func (s *Scheduler) removeQueuedPollJobs(ctx context.Context, scripts schedulerScripts) error {
	ids, err := s.pendingJobIDs(ctx)
	if err != nil {
		return err
	}
	if len(ids) == 0 {
		return nil
	}
	pipe := s.redis.Pipeline()
	nameCmds := make([]*redis.StringCmd, len(ids))
	for index, id := range ids {
		nameCmds[index] = pipe.HGet(ctx, s.keys.prefix+id, "name")
	}
	if _, err := pipe.Exec(ctx); err != nil && !errors.Is(err, redis.Nil) {
		return fmt.Errorf("telegramsched: read queued job names: %w", err)
	}
	for index, id := range ids {
		name, err := nameCmds[index].Result()
		if errors.Is(err, redis.Nil) {
			continue
		}
		if err != nil {
			return fmt.Errorf("telegramsched: read queued job %q: %w", id, err)
		}
		if !strings.HasPrefix(name, PollJobName) {
			continue
		}
		// removeChildren is "1" like job.remove(). A locked job reports a
		// negative code; Promise.allSettled ignores it, so this does too.
		result, err := scripts.removeJob.Run(ctx, s.redis,
			[]string{s.keys.prefix + id, s.keys.repeat},
			id, "1", s.keys.prefix,
		).Result()
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			log.Printf("telegramsched: remove queued job %q: %v", id, err)
			continue
		}
		if code := negativeCode(result); code < 0 {
			log.Printf("telegramsched: queued job %q is locked or a scheduler iteration (code %d)", id, code)
		}
	}
	return nil
}

// pendingJobIDs returns the union of the four BullMQ collections, preserving
// the first occurrence order and skipping duplicates.
func (s *Scheduler) pendingJobIDs(ctx context.Context) ([]string, error) {
	waiting, err := s.redis.LRange(ctx, s.keys.wait, 0, -1).Result()
	if err != nil {
		return nil, fmt.Errorf("telegramsched: list wait: %w", err)
	}
	paused, err := s.redis.LRange(ctx, s.keys.paused, 0, -1).Result()
	if err != nil {
		return nil, fmt.Errorf("telegramsched: list paused: %w", err)
	}
	prioritized, err := s.redis.ZRange(ctx, s.keys.prioritized, 0, -1).Result()
	if err != nil {
		return nil, fmt.Errorf("telegramsched: list prioritized: %w", err)
	}
	delayed, err := s.redis.ZRange(ctx, s.keys.delayed, 0, -1).Result()
	if err != nil {
		return nil, fmt.Errorf("telegramsched: list delayed: %w", err)
	}
	total := len(waiting) + len(paused) + len(prioritized) + len(delayed)
	seen := make(map[string]bool, total)
	out := make([]string, 0, total)
	for _, group := range [][]string{waiting, paused, prioritized, delayed} {
		for _, id := range group {
			if id == "" || seen[id] {
				continue
			}
			seen[id] = true
			out = append(out, id)
		}
	}
	return out, nil
}

// failedRetention is BULLMQ_FAILED_JOB_RETENTION as a fresh option value.
func failedRetention() map[string]any {
	return map[string]any{"age": failedRetentionAgeSeconds, "count": failedRetentionCount}
}

// negativeCode reports a BullMQ negative script result, which the JavaScript
// client turns into a finishedErrors throw. Non-numeric results are 0.
func negativeCode(result any) int64 {
	switch typed := result.(type) {
	case int64:
		return typed
	case int:
		return int64(typed)
	default:
		return 0
	}
}

// hashRepeatKey is Repeat.hash with the default md5 algorithm.
func hashRepeatKey(value string) string {
	sum := md5.Sum([]byte(value))
	return hex.EncodeToString(sum[:])
}

// legacyRepeatJobID is getRepeatJobId as called by removeRepeatableByKey:
// repeat:<hash(name + id + hash(key))>: with the id read from keyToData(key).
func legacyRepeatJobID(repeatKey string) string {
	name, jobID := splitRepeatKey(repeatKey)
	namespace := hashRepeatKey(repeatKey)
	return "repeat:" + hashRepeatKey(name+jobID+namespace) + ":"
}

// removalConcatOptions is Scripts.getRepeatConcatOptions(repeatConcatOptions,
// repeatJobKey): a key with more than two segments is itself the concat form,
// otherwise removeRepeatableByKey passes an empty string.
func removalConcatOptions(repeatKey string) string {
	if strings.Count(repeatKey, ":") > 1 {
		return repeatKey
	}
	return ""
}

// splitRepeatKey mirrors the name/id part of Repeat.keyToData.
func splitRepeatKey(repeatKey string) (string, string) {
	parts := strings.Split(repeatKey, ":")
	name := parts[0]
	jobID := ""
	if len(parts) > 1 {
		jobID = parts[1]
	}
	return name, jobID
}
