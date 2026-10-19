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

// Producer writes the BullMQ 5.63.2 hash/ZSET/list layout consumed by both the
// NestJS worker (while the worker switch is legacy) and this package's worker.
type Producer struct {
	redis *redis.Client
}

// NewProducer wraps an existing Redis client. The client must point at the same
// database as NestJS's BullMQ connection.
func NewProducer(client *redis.Client) *Producer {
	return &Producer{redis: client}
}

// AddManual queues one manual-fetch job and returns immediately. It never waits
// for a fetch result.
func (p *Producer) AddManual(ctx context.Context, data JobData) (string, error) {
	if p == nil || p.redis == nil {
		return "", fmt.Errorf("economicqueue: redis is not configured")
	}
	jobID, err := p.redis.Incr(ctx, queueKey("id")).Result()
	if err != nil {
		return "", err
	}
	id := strconv.FormatInt(jobID, 10)
	now := time.Now().UnixMilli()
	rawData, err := json.Marshal(data)
	if err != nil {
		return "", err
	}
	opts := jobOptions{
		RemoveOnComplete: json.RawMessage("true"),
		RemoveOnFail: keepJobs{
			Age:   FailedJobRetentionAgeSeconds,
			Count: FailedJobRetentionCount,
		},
		Attempts:  0,
		Timestamp: now,
	}
	rawOpts, err := json.Marshal(opts)
	if err != nil {
		return "", err
	}
	key := queueKey(id)
	pipe := p.redis.TxPipeline()
	pipe.HSet(ctx, key, map[string]any{
		"name":      "manual-fetch",
		"data":      string(rawData),
		"opts":      string(rawOpts),
		"timestamp": now,
		"delay":     0,
		"priority":  0,
	})
	pipe.LPush(ctx, queueKey("wait"), id)
	pipe.XAdd(ctx, &redis.XAddArgs{Stream: queueKey("events"), MaxLen: 10000, Approx: true, Values: []any{"event", "waiting", "jobId", id}})
	if _, err := pipe.Exec(ctx); err != nil {
		return "", err
	}
	return id, nil
}

// AddRepeat creates or updates one repeatable job and its next delayed
// iteration. Sync removes a changed repeat first, so this function always
// writes the current pattern and the next occurrence.
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
// a worker. BullMQ performs this before running the processor, so a failed fetch
// does not stop the schedule.
func (p *Producer) ScheduleNextRepeat(ctx context.Context, job Job) error {
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
	return p.storeRepeat(ctx, job.RepeatJobKey, job.Name, repeat, next, job.Data, now)
}

func (p *Producer) storeRepeat(ctx context.Context, key, name string, repeat RepeatOptions, next int64, data []byte, now int64) error {
	hash := queueKey("repeat:" + key)
	pipe := p.redis.TxPipeline()
	pipe.ZAdd(ctx, queueKey("repeat"), redis.Z{Score: float64(next), Member: key})
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
	pipe.HSet(ctx, hash, fields)
	jobID := "repeat:" + key + ":" + strconv.FormatInt(next, 10)
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
	opts := jobOptions{
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
	rawOpts, err := json.Marshal(opts)
	if err != nil {
		return err
	}
	jobKey := queueKey(jobID)
	pipe.HSet(ctx, jobKey, map[string]any{
		"name":      name,
		"data":      string(data),
		"opts":      string(rawOpts),
		"timestamp": now,
		"delay":     delay,
		"priority":  0,
		"rjk":       key,
	})
	pipe.ZAdd(ctx, queueKey("delayed"), redis.Z{Score: float64(next * 4096), Member: jobID})
	pipe.XAdd(ctx, &redis.XAddArgs{Stream: queueKey("events"), MaxLen: 10000, Approx: true, Values: []any{"event", "delayed", "jobId", jobID, "delay", delay}})
	_, err = pipe.Exec(ctx)
	return err
}

// ListRepeatable returns every repeat entry with its next timestamp.
func (p *Producer) ListRepeatable(ctx context.Context) ([]RepeatableJob, error) {
	if p == nil || p.redis == nil {
		return nil, fmt.Errorf("economicqueue: redis is not configured")
	}
	values, err := p.redis.ZRangeWithScores(ctx, queueKey("repeat"), 0, -1).Result()
	if err != nil {
		return nil, err
	}
	jobs := make([]RepeatableJob, 0, len(values))
	for _, value := range values {
		key, ok := value.Member.(string)
		if !ok {
			continue
		}
		fields, err := p.redis.HGetAll(ctx, queueKey("repeat:"+key)).Result()
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
// next iteration. It does not remove waiting/manual jobs.
func (p *Producer) RemoveRepeatable(ctx context.Context, key string) error {
	if p == nil || p.redis == nil {
		return fmt.Errorf("economicqueue: redis is not configured")
	}
	next, err := p.redis.ZScore(ctx, queueKey("repeat"), key).Result()
	if err != nil && err != redis.Nil {
		return err
	}
	pipe := p.redis.TxPipeline()
	pipe.ZRem(ctx, queueKey("repeat"), key)
	pipe.Del(ctx, queueKey("repeat:"+key))
	if err == nil {
		jobID := "repeat:" + key + ":" + strconv.FormatInt(int64(next), 10)
		pipe.ZRem(ctx, queueKey("delayed"), jobID)
		pipe.Del(ctx, queueKey(jobID))
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
	waiting, err := p.redis.LRange(ctx, queueKey("wait"), 0, 1999).Result()
	if err != nil {
		return 0, err
	}
	for _, jobID := range waiting {
		fields, err := p.redis.HGetAll(ctx, queueKey(jobID)).Result()
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
	delayed, err := p.redis.ZRangeByScore(ctx, queueKey("delayed"), &redis.ZRangeBy{
		Min: "0", Max: strconv.FormatInt((now.UnixMilli()+1)*4096-1, 10), Count: 2000,
	}).Result()
	if err != nil {
		return removed, err
	}
	for _, jobID := range delayed {
		fields, err := p.redis.HGetAll(ctx, queueKey(jobID)).Result()
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
		pipe.LRem(ctx, queueKey("wait"), 1, jobID)
	case "delayed":
		pipe.ZRem(ctx, queueKey("delayed"), jobID)
	}
	pipe.Del(ctx, queueKey(jobID), queueKey(jobID+":lock"))
	pipe.XAdd(ctx, &redis.XAddArgs{Stream: queueKey("events"), MaxLen: 10000, Approx: true, Values: []any{"event", "removed", "jobId", jobID}})
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
