package economicqueue

import (
	"context"
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

// manualJobName is the BullMQ job name of a one-off fetch.
const manualJobName = "manual-fetch"

// Producer writes the BullMQ 5.63.2 hash/ZSET/list layout consumed by the
// Go worker and the queue-ops console.
type Producer struct {
	redis   *redis.Client
	keys    keySpace
	scripts queueScripts
}

// NewProducer wraps an existing Redis client. The client must point at the same
// database as the BullMQ connection.
func NewProducer(client *redis.Client) *Producer {
	return newProducerWithName(client, QueueName)
}

func newProducerWithName(client *redis.Client, name string) *Producer {
	return &Producer{redis: client, keys: newKeySpace(Prefix, name), scripts: defaultQueueScripts}
}

// AddManual queues one manual-fetch job and returns immediately. It uses
// addStandardJob so the meta.paused protocol is honored: while the queue is
// paused the id lands in the paused list, not wait.
func (p *Producer) AddManual(ctx context.Context, data JobData) (string, error) {
	if p == nil || p.redis == nil {
		return "", fmt.Errorf("economicqueue: redis is not configured")
	}
	rawData, err := json.Marshal(data)
	if err != nil {
		return "", err
	}
	now := time.Now().UnixMilli()
	args, err := pack([]any{
		p.keys.base,
		"", // let addStandardJob INCR the id
		manualJobName,
		now,
		nil,
		nil,
		nil,
		nil,
		nil,
	})
	if err != nil {
		return "", err
	}
	opts, err := pack(manualOptions{
		RemoveOnComplete: true,
		RemoveOnFail: KeepJobs{
			Age:   int64Ptr(FailedJobRetentionAgeSeconds),
			Count: int64Ptr(FailedJobRetentionCount),
		},
		Attempts:  0,
		Timestamp: now,
	})
	if err != nil {
		return "", err
	}
	keys := []string{
		p.keys.wait(),
		p.keys.paused(),
		p.keys.meta(),
		p.keys.id(),
		p.keys.completed(),
		p.keys.delayed(),
		p.keys.active(),
		p.keys.events(),
		p.keys.marker(),
	}
	result, err := p.scripts.addStandardJob.Run(ctx, p.redis, keys,
		string(args), string(rawData), string(opts)).Result()
	if err != nil {
		return "", err
	}
	switch value := result.(type) {
	case string:
		return value, nil
	case int64:
		return "", fmt.Errorf("economicqueue: add manual job failed with code %d", value)
	default:
		return "", fmt.Errorf("economicqueue: add manual job returned %T", result)
	}
}

// manualOptions is the MessagePack job options addStandardJob stores. The stored
// hash opts is the JSON cjson.encode of this table, so the worker and the
// queue-ops console read the same fields the NestJS producer wrote.
type manualOptions struct {
	RemoveOnComplete bool     `msgpack:"removeOnComplete"`
	RemoveOnFail     KeepJobs `msgpack:"removeOnFail"`
	Attempts         int      `msgpack:"attempts"`
	Timestamp        int64    `msgpack:"timestamp"`
}

// AddRepeat creates or updates one repeatable job and its next delayed
// iteration. Sync removes a changed repeat first, so this function always writes
// the current pattern and the next occurrence.
func (p *Producer) AddRepeat(ctx context.Context, name string, data JobData, repeat RepeatOptions) (RepeatableJob, error) {
	if p == nil || p.redis == nil {
		return RepeatableJob{}, fmt.Errorf("economicqueue: redis is not configured")
	}
	if repeat.Pattern == "" && repeat.Every <= 0 {
		return RepeatableJob{}, fmt.Errorf("economicqueue: repeat requires pattern or every")
	}
	now := time.Now()
	next, ok := nextRepeatMillis(repeat, now.UnixMilli(), 0)
	if !ok {
		return RepeatableJob{}, fmt.Errorf("economicqueue: no next occurrence for repeat")
	}
	key := repeatKey(name, repeat)
	rawData, err := json.Marshal(data)
	if err != nil {
		return RepeatableJob{}, err
	}
	if err := p.storeRepeat(ctx, key, name, repeat, next, rawData, now.UnixMilli()); err != nil {
		return RepeatableJob{}, err
	}
	return RepeatableJob{Key: key, Name: name, Pattern: repeat.Pattern, Every: formatEvery(repeat.Every), TZ: repeat.TZ, Next: next}, nil
}

// ScheduleNextRepeat adds the next iteration for a job that was just claimed by
// a worker. It is a no-op when the scheduler no longer exists or another
// executor already advanced the iteration, which keeps a deleted/replaced
// schedule dead and never creates a duplicate next iteration.
func (p *Producer) ScheduleNextRepeat(ctx context.Context, job Job) error {
	if p == nil || p.redis == nil {
		return fmt.Errorf("economicqueue: redis is not configured")
	}
	if job.Opts.Repeat == nil || job.RepeatJobKey == "" {
		return nil
	}
	repeat := RepeatOptions{
		Pattern: job.Opts.Repeat.Pattern,
		Every:   job.Opts.Repeat.Every,
		TZ:      job.Opts.Repeat.TZ,
	}
	if job.Opts.Repeat.EndDate > 0 {
		end := time.UnixMilli(job.Opts.Repeat.EndDate)
		repeat.EndDate = &end
	}
	prev := job.Opts.PrevMillis
	if prev == 0 {
		prev = job.Timestamp + job.Delay
	}
	next, ok := nextRepeatMillis(repeat, time.Now().UnixMilli(), prev)
	if !ok {
		return nil
	}
	now := time.Now().UnixMilli()
	jobID := repeatIterationJobID(job.RepeatJobKey, next)
	opts := buildRepeatIterationOptions(repeat, job.RepeatJobKey, jobID, next, now)
	rawOpts, err := json.Marshal(opts)
	if err != nil {
		return err
	}
	delay := next - now
	if delay < 0 {
		delay = 0
	}
	result, err := p.scripts.updateRepeat.Run(ctx, p.redis,
		[]string{
			p.keys.repeat(),
			p.keys.delayed(),
			p.keys.events(),
			p.keys.job(jobID),
		},
		job.RepeatJobKey,
		strconv.FormatInt(prev, 10),
		strconv.FormatInt(next, 10),
		jobID,
		job.Name,
		strconv.FormatInt(delay, 10),
		string(rawOpts),
		string(job.Data),
		strconv.FormatInt(now, 10),
	).Int64()
	if err != nil {
		return err
	}
	if result == 0 {
		// Scheduler gone or iteration already advanced; this is the expected
		// outcome for a duplicate scan or a deleted repeat.
		return nil
	}
	return nil
}

func (p *Producer) storeRepeat(ctx context.Context, key, name string, repeat RepeatOptions, next int64, data []byte, now int64) error {
	pipe := p.redis.TxPipeline()
	pipe.ZAdd(ctx, p.keys.repeat(), redis.Z{Score: float64(next), Member: key})
	fields := map[string]any{"name": name}
	if repeat.TZ != "" {
		fields["tz"] = repeat.TZ
	}
	if repeat.Pattern != "" {
		fields["pattern"] = repeat.Pattern
	}
	if repeat.Every > 0 {
		fields["every"] = strconv.FormatInt(repeat.Every, 10)
	}
	if repeat.EndDate != nil {
		fields["endDate"] = strconv.FormatInt(repeat.EndDate.UnixMilli(), 10)
	}
	pipe.HSet(ctx, p.keys.repeatHash(key), fields)
	jobID := repeatIterationJobID(key, next)
	delay := next - now
	if delay < 0 {
		delay = 0
	}
	opts := buildRepeatIterationOptions(repeat, key, jobID, next, now)
	rawOpts, err := json.Marshal(opts)
	if err != nil {
		return err
	}
	pipe.HSet(ctx, p.keys.job(jobID), map[string]any{
		"name":      name,
		"data":      string(data),
		"opts":      string(rawOpts),
		"timestamp": now,
		"delay":     delay,
		"priority":  0,
		"rjk":       key,
	})
	pipe.ZAdd(ctx, p.keys.delayed(), redis.Z{Score: float64(next * 4096), Member: jobID})
	pipe.XAdd(ctx, &redis.XAddArgs{Stream: p.keys.events(), MaxLen: 10000, Approx: true, Values: []any{"event", "delayed", "jobId", jobID, "delay", delay}})
	_, err = pipe.Exec(ctx)
	return err
}

// buildRepeatIterationOptions builds the stored options of one repeat
// iteration. PrevMillis is the iteration's own timestamp so the claim-and-advance
// guard can prove iteration identity.
func buildRepeatIterationOptions(repeat RepeatOptions, key, jobID string, next, now int64) jobOptions {
	delay := next - now
	if delay < 0 {
		delay = 0
	}
	repeatPayload := repeatPayload{
		Pattern: repeat.Pattern,
		Every:   repeat.Every,
		TZ:      repeat.TZ,
		Count:   1,
	}
	if repeat.EndDate != nil {
		repeatPayload.EndDate = repeat.EndDate.UnixMilli()
	}
	if repeat.StartDate != nil {
		repeatPayload.StartDate = repeat.StartDate.UnixMilli()
	}
	return jobOptions{
		RemoveOnComplete: json.RawMessage("true"),
		RemoveOnFail: keepJobs{
			Age:   FailedJobRetentionAgeSeconds,
			Count: FailedJobRetentionCount,
		},
		Attempts:     0,
		Repeat:       &repeatPayload,
		RepeatJobKey: key,
		JobID:        jobID,
		Delay:        delay,
		Timestamp:    now,
		PrevMillis:   next,
	}
}

func repeatIterationJobID(key string, next int64) string {
	return "repeat:" + key + ":" + strconv.FormatInt(next, 10)
}

// ListRepeatable returns every repeat entry with its next timestamp.
func (p *Producer) ListRepeatable(ctx context.Context) ([]RepeatableJob, error) {
	if p == nil || p.redis == nil {
		return nil, fmt.Errorf("economicqueue: redis is not configured")
	}
	values, err := p.redis.ZRangeWithScores(ctx, p.keys.repeat(), 0, -1).Result()
	if err != nil {
		return nil, err
	}
	jobs := make([]RepeatableJob, 0, len(values))
	for _, value := range values {
		key, ok := value.Member.(string)
		if !ok {
			continue
		}
		fields, err := p.redis.HGetAll(ctx, p.keys.repeatHash(key)).Result()
		if err != nil {
			return nil, err
		}
		jobs = append(jobs, RepeatableJob{
			Key:     key,
			Name:    fields["name"],
			Pattern: fields["pattern"],
			Every:   fields["every"],
			TZ:      fields["tz"],
			Next:    int64(value.Score),
		})
	}
	return jobs, nil
}

// RemoveRepeatable removes the repeat entry, its hash and the currently delayed
// next iteration. It does not remove waiting/manual jobs; the claim-side guard
// keeps those from re-creating the schedule.
func (p *Producer) RemoveRepeatable(ctx context.Context, key string) error {
	if p == nil || p.redis == nil {
		return fmt.Errorf("economicqueue: redis is not configured")
	}
	next, err := p.redis.ZScore(ctx, p.keys.repeat(), key).Result()
	if err != nil && err != redis.Nil {
		return err
	}
	pipe := p.redis.TxPipeline()
	pipe.ZRem(ctx, p.keys.repeat(), key)
	pipe.Del(ctx, p.keys.repeatHash(key))
	if err == nil {
		jobID := repeatIterationJobID(key, int64(next))
		pipe.ZRem(ctx, p.keys.delayed(), jobID)
		pipe.Del(ctx, p.keys.job(jobID))
	}
	_, err = pipe.Exec(ctx)
	return err
}

// ClearStaleHighFrequencyQueuedJobs removes waiting/delayed jobs whose name is
// in names and whose scheduled time is already behind now.
func (p *Producer) ClearStaleHighFrequencyQueuedJobs(ctx context.Context, names map[string]bool, now time.Time) (int, error) {
	if p == nil || p.redis == nil || len(names) == 0 {
		return 0, nil
	}
	removed := 0
	waiting, err := p.redis.LRange(ctx, p.keys.wait(), 0, 1999).Result()
	if err != nil {
		return 0, err
	}
	for _, jobID := range waiting {
		fields, err := p.redis.HGetAll(ctx, p.keys.job(jobID)).Result()
		if err != nil {
			return removed, err
		}
		if !names[fields["name"]] {
			continue
		}
		timestamp, err := strconv.ParseInt(fields["timestamp"], 10, 64)
		if err != nil || timestamp >= now.UnixMilli()-1000 {
			continue
		}
		if err := p.removeQueuedJob(ctx, "wait", jobID); err != nil {
			return removed, err
		}
		removed++
	}
	delayed, err := p.redis.ZRangeByScore(ctx, p.keys.delayed(), &redis.ZRangeBy{
		Min: "0", Max: strconv.FormatInt((now.UnixMilli()+1)*4096-1, 10), Count: 2000,
	}).Result()
	if err != nil {
		return removed, err
	}
	for _, jobID := range delayed {
		fields, err := p.redis.HGetAll(ctx, p.keys.job(jobID)).Result()
		if err != nil {
			return removed, err
		}
		if !names[fields["name"]] {
			continue
		}
		timestamp, _ := strconv.ParseInt(fields["timestamp"], 10, 64)
		delay, _ := strconv.ParseInt(fields["delay"], 10, 64)
		if timestamp+delay >= now.UnixMilli() {
			continue
		}
		if err := p.removeQueuedJob(ctx, "delayed", jobID); err != nil {
			return removed, err
		}
		removed++
	}
	return removed, nil
}

func (p *Producer) removeQueuedJob(ctx context.Context, state, jobID string) error {
	pipe := p.redis.TxPipeline()
	switch state {
	case "wait":
		pipe.LRem(ctx, p.keys.wait(), 1, jobID)
	case "delayed":
		pipe.ZRem(ctx, p.keys.delayed(), jobID)
	}
	pipe.Del(ctx, p.keys.job(jobID), p.keys.lock(jobID))
	pipe.XAdd(ctx, &redis.XAddArgs{Stream: p.keys.events(), MaxLen: 10000, Approx: true, Values: []any{"event", "removed", "jobId", jobID}})
	_, err := pipe.Exec(ctx)
	return err
}

func repeatKey(name string, repeat RepeatOptions) string {
	endDate := ""
	if repeat.EndDate != nil {
		endDate = strconv.FormatInt(repeat.EndDate.UnixMilli(), 10)
	}
	suffix := repeat.Pattern
	if suffix == "" {
		suffix = strconv.FormatInt(repeat.Every, 10)
	}
	legacy := strings.Join([]string{name, "", endDate, repeat.TZ, suffix}, ":")
	sum := md5.Sum([]byte(legacy))
	return hex.EncodeToString(sum[:])
}

func formatEvery(every int64) string {
	if every <= 0 {
		return ""
	}
	return strconv.FormatInt(every, 10)
}

func nextRepeatMillis(repeat RepeatOptions, now, prev int64) (int64, bool) {
	if repeat.EndDate != nil && time.UnixMilli(now).After(*repeat.EndDate) {
		return 0, false
	}
	base := now
	if prev > base {
		base = prev
	}
	if repeat.Pattern != "" {
		current := time.UnixMilli(base)
		next, ok := NextPatternMillis(repeat.Pattern, current, repeat.StartDate)
		return next, ok
	}
	current := time.UnixMilli(base)
	return NextEveryMillis(repeat.Every, current)
}
