// Package alertqueue writes BullMQ jobs for the "alerts" queue.
//
// It is a producer only. The NestJS AlertsProcessor remains the single consumer
// of the queue: it scans, evaluates, writes alert events, delivers by SMTP,
// webhook and in-app notification, and publishes alertEvents subscriptions. Go
// never starts a worker and never registers the scan repeatable job, so there
// is no duplicate consumption and no duplicate delivery.
//
// # Protocol
//
// The Redis layout and the write scripts replicate BullMQ 5.63.2 byte-for-byte:
//
//   - prefix "bull", queue "alerts", so every key starts with "bull:alerts:".
//   - job hashes live at bull:alerts:<jobId> and carry name, data (JSON), opts
//     (JSON re-encoded by the Lua script with cjson from the msgpack options),
//     timestamp, delay, priority and, for a repeat iteration, rjk.
//   - the one-shot evaluation job is added through addStandardJob-9, which
//     LPUSHes its id onto bull:alerts:wait and touches bull:alerts:marker.
//   - a repeat schedule is the bull:alerts:repeat sorted set plus the
//     bull:alerts:repeat:<md5> hash written by addRepeatableJob-2, and the next
//     iteration is a delayed job added through addDelayedJob-6 (or
//     addStandardJob-9 when its delay is already 0).
//
// Job options and the msgpack argument array follow classes/scripts.js: ARGV[1]
// is the msgpack argument array, ARGV[2] is the JSON data and ARGV[3] is the
// msgpack options. BullMQ's Packr is created with encodeUndefinedAsNil, so a
// missing array slot is MessagePack nil in both clients and the scripts observe
// identical arguments.
//
// # Failure semantics
//
// Every write happens after the MySQL transaction commits, exactly like the
// NestJS service. A Redis failure is returned to the caller; the database write
// is not rolled back and there is no automatic replay through the legacy
// gateway, because a replay would apply the mutation twice (and a retried
// upsert-create would insert a second rule).
package alertqueue

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

const (
	// Prefix is BullMQ's default key prefix; the NestJS Queue uses it too.
	Prefix = "bull"
	// QueueName is ALERTS_QUEUE_NAME in apps/api.
	QueueName = "alerts"

	// failedRetentionAgeSeconds and failedRetentionCount mirror
	// BULLMQ_FAILED_JOB_RETENTION (7 days, 10k) used as the queue's
	// defaultJobOptions.removeOnFail and explicitly on every rule job.
	failedRetentionAgeSeconds = 7 * 24 * 60 * 60
	failedRetentionCount      = 10_000

	jobTypeEvaluate = "evaluate"
	// minScheduleIntervalSec mirrors Math.max(60, checkIntervalSec).
	minScheduleIntervalSec = 60
)

// Store is the subset of the shared go-redis client this producer uses. It is
// satisfied by *redis.Client; it is an interface so tests can substitute a
// script recorder without a live Redis.
type Store interface {
	redis.Scripter
	ZRangeWithScores(ctx context.Context, key string, start, stop int64) *redis.ZSliceCmd
	HGetAll(ctx context.Context, key string) *redis.MapStringStringCmd
}

// Producer writes the three alerts-queue operations the migrated GraphQL roots
// need. It holds no connection of its own and is safe for concurrent use as
// long as the underlying client is.
type Producer struct {
	client Store
	now    func() time.Time
}

// New returns a producer that writes through client. The caller owns the
// client's lifecycle (the API process shares one go-redis client); nothing here
// needs to be closed.
func New(client Store) *Producer {
	if client == nil {
		panic("alertqueue: New requires a redis client")
	}
	return &Producer{client: client, now: time.Now}
}

// evaluateJobData is the one-shot evaluation payload. Field order is the JSON
// key order NestJS writes: {"type","ruleId","orgId","traceId"}.
type evaluateJobData struct {
	Type    string `json:"type"`
	RuleID  string `json:"ruleId"`
	OrgID   string `json:"orgId"`
	TraceID string `json:"traceId"`
}

// scheduleJobData is the repeat-iteration payload. It intentionally omits
// traceId, like ensureRuleSchedule in the NestJS service.
type scheduleJobData struct {
	Type   string `json:"type"`
	RuleID string `json:"ruleId"`
	OrgID  string `json:"orgId"`
}

// RuleJobName is the BullMQ job name for a rule. The NestJS worker branches on
// the "evaluate-rule" prefix.
func RuleJobName(ruleID string) string {
	return "evaluate-rule:" + ruleID
}

// EnqueueRuleCheck adds one evaluation job, equivalent to
// AlertsService.enqueueRuleCheck: job id evaluate:<ruleId>:<ms>, traceId
// carried in the payload, removeOnComplete and the shared failed-job retention.
func (p *Producer) EnqueueRuleCheck(ctx context.Context, ruleID, orgID, traceID string) error {
	// The NestJS method calls Date.now() once for the job id and lets the Job
	// constructor stamp the hash timestamp, so the two are separate clock reads.
	enqueuedAt := p.now().UnixMilli()
	jobID := "evaluate:" + ruleID + ":" + strconv.FormatInt(enqueuedAt, 10)
	data, err := json.Marshal(evaluateJobData{
		Type:    jobTypeEvaluate,
		RuleID:  ruleID,
		OrgID:   orgID,
		TraceID: traceID,
	})
	if err != nil {
		return fmt.Errorf("alertqueue: encode evaluate data: %w", err)
	}
	opts := map[string]any{
		"attempts":         0,
		"removeOnFail":     failedRetention(),
		"jobId":            jobID,
		"removeOnComplete": true,
	}
	return p.addJob(ctx, jobID, RuleJobName(ruleID), data, p.now().UnixMilli(), opts, "")
}

// EnsureRuleSchedule replaces the rule's repeat schedule, equivalent to
// AlertsService.ensureRuleSchedule plus the B3 fix: every existing schedule for
// the rule is removed first, so changing checkIntervalSec cannot leave the old
// interval behind and pausing a rule cannot leave an active schedule. When the
// rule is not active only the removal happens.
func (p *Producer) EnsureRuleSchedule(ctx context.Context, ruleID, orgID string, checkIntervalSec int, active bool) error {
	if err := p.RemoveRuleJobs(ctx, ruleID); err != nil {
		return err
	}
	if !active {
		return nil
	}
	every := int64(checkIntervalSec)
	if every < minScheduleIntervalSec {
		every = minScheduleIntervalSec
	}
	every *= 1000

	name := RuleJobName(ruleID)
	// The undecorated job id ("evaluate-<ruleId>") is what getRepeatConcatOptions
	// hashes; it is not the id of any job that exists in the queue.
	repeatJobID := "evaluate-" + ruleID
	concatOptions := repeatConcatOptions(name, repeatJobID, every)
	repeatKey := hashRepeatKey(concatOptions)
	nextMillis := nextRepeatMillis(p.now().UnixMilli(), every)

	repeatOpts, err := marshalMsgpack(map[string]any{
		"name":  name,
		"every": every,
	})
	if err != nil {
		return fmt.Errorf("alertqueue: encode repeat options: %w", err)
	}
	if err := addRepeatableJobScript.Run(ctx, p.client,
		[]string{p.key("repeat"), p.key("delayed")},
		nextMillis, string(repeatOpts), concatOptions, repeatKey, p.keyPrefix(),
	).Err(); err != nil {
		return fmt.Errorf("alertqueue: add repeatable job: %w", err)
	}

	data, err := json.Marshal(scheduleJobData{
		Type:   jobTypeEvaluate,
		RuleID: ruleID,
		OrgID:  orgID,
	})
	if err != nil {
		return fmt.Errorf("alertqueue: encode schedule data: %w", err)
	}
	now := p.now().UnixMilli()
	delay := nextMillis - now
	if delay < 0 {
		delay = 0
	}
	delayedJobID := repeatDelayedJobID(repeatKey, nextMillis)
	opts := map[string]any{
		"attempts":         0,
		"removeOnFail":     failedRetention(),
		"jobId":            delayedJobID,
		"repeat":           map[string]any{"every": every, "jobId": repeatJobID, "count": 1},
		"removeOnComplete": true,
		"delay":            delay,
		"timestamp":        now,
		"prevMillis":       nextMillis,
	}
	return p.addJob(ctx, delayedJobID, name, data, now, opts, repeatKey)
}

// RemoveRuleJobs removes every schedule and pending job of one rule, equivalent
// to AlertsService.removeJob(ruleId, true).
//
// A repeat hash does not contain its own zset member, so the member cannot be
// matched by parsing its key: the producer reads the set and then the
// bull:alerts:repeat:<key> hash, comparing its name with evaluate-rule:<id>.
func (p *Producer) RemoveRuleJobs(ctx context.Context, ruleID string) error {
	members, err := p.client.ZRangeWithScores(ctx, p.key("repeat"), 0, -1).Result()
	if err != nil {
		return fmt.Errorf("alertqueue: list repeatable jobs: %w", err)
	}
	for _, member := range members {
		repeatKey, ok := member.Member.(string)
		if !ok || repeatKey == "" {
			continue
		}
		fields, err := p.client.HGetAll(ctx, p.key("repeat:"+repeatKey)).Result()
		if err != nil {
			return fmt.Errorf("alertqueue: read repeatable job: %w", err)
		}
		if fields["name"] != RuleJobName(ruleID) {
			continue
		}
		if err := p.removeRepeatable(ctx, repeatKey); err != nil {
			return err
		}
	}
	for _, jobID := range []string{
		"evaluate-" + ruleID,
		"evaluate:" + ruleID,
		RuleJobName(ruleID),
	} {
		if err := p.removeJob(ctx, jobID); err != nil {
			return err
		}
	}
	return nil
}

// addJob runs BullMQ's addStandardJob/addDelayedJob path. It selects the
// delayed script when opts carries a positive delay, exactly like
// Scripts.addJob.
func (p *Producer) addJob(ctx context.Context, jobID, name string, data []byte, timestamp int64, opts map[string]any, repeatJobKey string) error {
	encodedArgs, err := marshalMsgpack(buildJobArguments(p.keyPrefix(), jobID, name, timestamp, repeatJobKey))
	if err != nil {
		return fmt.Errorf("alertqueue: encode job arguments: %w", err)
	}
	encodedOpts, err := marshalMsgpack(opts)
	if err != nil {
		return fmt.Errorf("alertqueue: encode job options: %w", err)
	}

	delay, _ := opts["delay"].(int64)
	if delay > 0 {
		result, err := addDelayedJobScript.Run(ctx, p.client, []string{
			p.key("marker"),
			p.key("meta"),
			p.key("id"),
			p.key("delayed"),
			p.key("completed"),
			p.key("events"),
		}, string(encodedArgs), string(data), string(encodedOpts)).Result()
		if err != nil {
			return fmt.Errorf("alertqueue: add delayed job: %w", err)
		}
		return negativeJobResult(result)
	}

	result, err := addStandardJobScript.Run(ctx, p.client, []string{
		p.key("wait"),
		p.key("paused"),
		p.key("meta"),
		p.key("id"),
		p.key("completed"),
		p.key("delayed"),
		p.key("active"),
		p.key("events"),
		p.key("marker"),
	}, string(encodedArgs), string(data), string(encodedOpts)).Result()
	if err != nil {
		return fmt.Errorf("alertqueue: add job: %w", err)
	}
	return negativeJobResult(result)
}

// buildJobArguments is the args array Scripts.addJob packs as ARGV[1]. Rules
// jobs have no parent and no deduplication id, so slots 5-7 and 9 stay nil.
func buildJobArguments(prefix, jobID, name string, timestamp int64, repeatJobKey string) []any {
	args := []any{
		prefix,
		jobID,
		name,
		timestamp,
		nil, // parentKey
		nil, // parent dependencies key
		nil, // parent {id, queueKey}
		nil, // repeat job key
		nil, // deduplication key
	}
	if repeatJobKey != "" {
		args[7] = repeatJobKey
	}
	return args
}

// removeRepeatable mirrors Repeat.removeRepeatableByKey: the legacy repeat job
// id is derived from the repeat key, the old concat form is empty for a hashed
// key, and the script deletes the next delayed job and the repeat hash.
func (p *Producer) removeRepeatable(ctx context.Context, repeatKey string) error {
	_, err := removeRepeatableScript.Run(ctx, p.client, []string{
		p.key("repeat"),
		p.key("delayed"),
		p.key("events"),
	}, legacyRepeatJobID(repeatKey), removalConcatOptions(repeatKey), repeatKey, p.keyPrefix()).Result()
	if err != nil {
		return fmt.Errorf("alertqueue: remove repeatable job: %w", err)
	}
	return nil
}

// removeJob mirrors Scripts.remove + the removeJob-2 script. removeChildren is
// "0"; a negative result means the job is a job-scheduler iteration or locked,
// which the NestJS client would also surface as an error.
func (p *Producer) removeJob(ctx context.Context, jobID string) error {
	result, err := removeJobScript.Run(ctx, p.client,
		[]string{p.key(jobID), p.key("repeat")},
		jobID, "0", p.keyPrefix(),
	).Result()
	if err != nil {
		return fmt.Errorf("alertqueue: remove job: %w", err)
	}
	return negativeJobResult(result)
}

// keyPrefix is the empty-suffix BullMQ queue key: the prefix used to build job keys.
func (p *Producer) keyPrefix() string {
	return Prefix + ":" + QueueName + ":"
}

func (p *Producer) key(suffix string) string {
	return p.keyPrefix() + suffix
}

// failedRetention is BULLMQ_FAILED_JOB_RETENTION as a fresh option value.
func failedRetention() map[string]any {
	return map[string]any{"age": failedRetentionAgeSeconds, "count": failedRetentionCount}
}

// negativeJobResult turns BullMQ's negative script codes into an error, matching
// the finishedErrors throw in the NestJS client.
func negativeJobResult(result any) error {
	switch typed := result.(type) {
	case int64:
		if typed < 0 {
			return fmt.Errorf("alertqueue: redis script returned %d", typed)
		}
	case int:
		if typed < 0 {
			return fmt.Errorf("alertqueue: redis script returned %d", typed)
		}
	}
	return nil
}

// repeatConcatOptions mirrors getRepeatConcatOptions for an every-based
// schedule: name:jobId:endDate:tz:every with the empty end date and timezone.
func repeatConcatOptions(name, jobID string, every int64) string {
	return name + ":" + jobID + ":::" + strconv.FormatInt(every, 10)
}

// hashRepeatKey is Repeat.hash with the default md5 algorithm.
func hashRepeatKey(value string) string {
	sum := md5.Sum([]byte(value))
	return hex.EncodeToString(sum[:])
}

// nextRepeatMillis is the every strategy in getNextMillis: the next interval
// boundary after millis.
func nextRepeatMillis(millis, every int64) int64 {
	return millis/every*every + every
}

// repeatDelayedJobID is getRepeatDelayedJobId for a hashed (colon-free) repeat
// key.
func repeatDelayedJobID(repeatKey string, nextMillis int64) string {
	return "repeat:" + repeatKey + ":" + strconv.FormatInt(nextMillis, 10)
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
