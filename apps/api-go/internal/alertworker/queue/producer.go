package queue

import (
	"bytes"
	"context"
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

// ProducerStore is the subset of the shared go-redis client this producer uses.
// It is satisfied by *redis.Client; the interface exists so unit tests can
// substitute a script recorder.
type ProducerStore interface {
	redis.Scripter
	ZRangeWithScores(ctx context.Context, key string, start, stop int64) *redis.ZSliceCmd
	HGetAll(ctx context.Context, key string) *redis.MapStringStringCmd
	Exists(ctx context.Context, keys ...string) *redis.IntCmd
}

// Producer writes the BullMQ 5.63.2 alerts jobs: one-shot evaluations,
// deliveries, the scan schedule and every rule schedule. It holds no connection
// of its own and is safe for concurrent use as long as the client is.
type Producer struct {
	client  ProducerStore
	keys    Keys
	scripts queueScripts
	now     func() time.Time
}

// NewProducer builds a producer over the shared Redis client.
func NewProducer(client ProducerStore, prefix string) (*Producer, error) {
	if client == nil {
		return nil, errors.New("alertworker/queue: producer requires a redis client")
	}
	if prefix == "" {
		prefix = Prefix
	}
	scripts, err := loadQueueScripts()
	if err != nil {
		return nil, err
	}
	return &Producer{
		client:  client,
		keys:    NewKeys(prefix, QueueName),
		scripts: scripts,
		now:     time.Now,
	}, nil
}

// ScanJobData is the `scan-active-rules` payload: {"type":"scan"}.
type ScanJobData struct {
	Type string `json:"type"`
}

// EvaluateJobData is the one-shot evaluation payload written by
// enqueueRuleCheck and triggerRuleCheck.
type EvaluateJobData struct {
	Type    string `json:"type"`
	RuleID  string `json:"ruleId"`
	OrgID   string `json:"orgId"`
	TraceID string `json:"traceId"`
}

// ScheduleJobData is the repeat-iteration payload written by
// ensureRuleSchedule. It carries no traceId, exactly like the NestJS service.
type ScheduleJobData struct {
	Type   string `json:"type"`
	RuleID string `json:"ruleId"`
	OrgID  string `json:"orgId"`
}

// DeliverJobData is the delivery payload written by enqueueNotificationJobs.
// ScheduledAtMs is added and removed by the delivery handler through
// Job.updateData, so the field order matches `{...job.data, scheduledAtMs}`.
type DeliverJobData struct {
	Type          string `json:"type"`
	DeliveryID    string `json:"deliveryId"`
	OrgID         string `json:"orgId"`
	TraceID       string `json:"traceId"`
	ScheduledAtMs *int64 `json:"scheduledAtMs,omitempty"`
}

// MarshalJobData encodes job data exactly like JSON.stringify: compact output
// and no HTML escaping (Go escapes <, > and & by default).
func MarshalJobData(value any) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, fmt.Errorf("alertworker/queue: encode job data: %w", err)
	}
	encoded := buffer.Bytes()
	// json.Encoder appends a newline that JSON.stringify does not produce.
	return bytes.TrimSuffix(encoded, []byte("\n")), nil
}

// AddEvaluateJob adds one one-shot evaluation job, equivalent to
// AlertsService.enqueueRuleCheck: job id `evaluate:<ruleId>:<ms>`,
// removeOnComplete, the shared failed-job retention and the traceId in the
// payload.
func (p *Producer) AddEvaluateJob(ctx context.Context, ruleID, orgID, traceID string) error {
	return p.addEvaluateJob(ctx, EvaluateJobSpec{RuleID: ruleID, OrgID: orgID, TraceID: traceID})
}

// AddDeliveryJob adds one external delivery job, equivalent to
// enqueueNotificationJobs: job id `deliver-<deliveryId>`, attempts = delay
// table length + 1 = 4 and the custom `alertNotifications` backoff.
func (p *Producer) AddDeliveryJob(ctx context.Context, deliveryID, orgID, traceID string) error {
	data, err := MarshalJobData(DeliverJobData{
		Type:       JobTypeDeliver,
		DeliveryID: deliveryID,
		OrgID:      orgID,
		TraceID:    traceID,
	})
	if err != nil {
		return err
	}
	opts := map[string]any{
		"attempts":         4,
		"backoff":          map[string]any{"type": "alertNotifications"},
		"jobId":            "deliver-" + deliveryID,
		"removeOnComplete": true,
		"removeOnFail":     failedRetention(),
	}
	return p.addStandardJob(ctx, DeliveryJobName(deliveryID), "deliver-"+deliveryID, data, p.now().UnixMilli(), opts)
}

// EvaluateJobSpec is one rule to evaluate in a scan batch.
type EvaluateJobSpec struct {
	RuleID  string
	OrgID   string
	TraceID string
}

// evaluateJobPipelineBatch is the scan batch size: one Redis pipeline per 100
// jobs instead of one round trip per job.
const evaluateJobPipelineBatch = 100

// pipelinedStore is implemented by *redis.Client. The batch path uses it when
// available and falls back to one command per job otherwise, so a test store
// with only the single-command surface still works.
type pipelinedStore interface {
	Pipeline() redis.Pipeliner
}

// AddEvaluateJobs queues the scan batch through Redis pipelines, equivalent to
// AlertsService.enqueueActiveRuleChecks (which adds the same jobs through
// ALERT_RULE_TASK_CONCURRENCY workers). The jobId, data and opts of every job
// are identical to the single-job path; a pipeline only batches independent
// EVALSHA calls, so the resulting Redis state is the same.
func (p *Producer) AddEvaluateJobs(ctx context.Context, jobs []EvaluateJobSpec) error {
	if len(jobs) == 0 {
		return nil
	}
	store, ok := p.client.(pipelinedStore)
	if !ok {
		for _, spec := range jobs {
			if err := p.addEvaluateJob(ctx, spec); err != nil {
				return err
			}
		}
		return nil
	}
	sha := p.scripts.addStandardJob.Hash()
	for start := 0; start < len(jobs); start += evaluateJobPipelineBatch {
		end := start + evaluateJobPipelineBatch
		if end > len(jobs) {
			end = len(jobs)
		}
		pipe := store.Pipeline()
		commands := make([]*redis.Cmd, 0, end-start)
		fallback := make([]EvaluateJobSpec, 0)
		for _, spec := range jobs[start:end] {
			jobID := p.evaluateJobID(spec.RuleID)
			data, err := p.evaluateJobData(spec)
			if err != nil {
				return err
			}
			args, err := MarshalMsgpack(buildJobArguments(p.keys.Base, jobID, RuleJobName(spec.RuleID), p.now().UnixMilli(), ""))
			if err != nil {
				return err
			}
			encodedOpts, err := MarshalMsgpack(evaluateJobOptions(jobID))
			if err != nil {
				return err
			}
			commands = append(commands, pipe.EvalSha(ctx, sha, []string{
				p.keys.Wait, p.keys.Paused, p.keys.Meta, p.keys.ID, p.keys.Completed,
				p.keys.Delayed, p.keys.Active, p.keys.Events, p.keys.Marker,
			}, args, data, encodedOpts))
			fallback = append(fallback, spec)
		}
		// Exec returns the first command error; the per-command errors decide
		// whether this batch is usable, and a missing script cache is retried
		// through the single-job path (which falls back to EVAL).
		_, _ = pipe.Exec(ctx)
		for index, command := range commands {
			if command.Err() == nil {
				continue
			}
			if !isNoScriptError(command.Err()) {
				return fmt.Errorf("alertworker/queue: batch add job: %w", command.Err())
			}
			if err := p.addEvaluateJob(ctx, fallback[index]); err != nil {
				return err
			}
		}
	}
	return nil
}

// addEvaluateJob adds one one-shot evaluation job outside a pipeline.
func (p *Producer) addEvaluateJob(ctx context.Context, spec EvaluateJobSpec) error {
	data, err := p.evaluateJobData(spec)
	if err != nil {
		return err
	}
	jobID := p.evaluateJobID(spec.RuleID)
	return p.addStandardJob(ctx, RuleJobName(spec.RuleID), jobID, data, p.now().UnixMilli(), evaluateJobOptions(jobID))
}

func (p *Producer) evaluateJobID(ruleID string) string {
	return "evaluate:" + ruleID + ":" + strconv.FormatInt(p.now().UnixMilli(), 10)
}

func (p *Producer) evaluateJobData(spec EvaluateJobSpec) ([]byte, error) {
	return MarshalJobData(EvaluateJobData{
		Type:    JobTypeEvaluate,
		RuleID:  spec.RuleID,
		OrgID:   spec.OrgID,
		TraceID: spec.TraceID,
	})
}

func evaluateJobOptions(jobID string) map[string]any {
	return map[string]any{
		"attempts":         0,
		"jobId":            jobID,
		"removeOnComplete": true,
		"removeOnFail":     failedRetention(),
	}
}

func isNoScriptError(err error) bool {
	return err != nil && strings.Contains(strings.ToUpper(err.Error()), "NOSCRIPT")
}

// EnsureScanSchedule adds (or replaces) the `scan-active-rules` repeat
// schedule, equivalent to AlertsService.scheduleScanJob. The job id, the
// interval and the retained options are the ones NestJS writes, so the call is
// idempotent and the two implementations cannot drift.
func (p *Producer) EnsureScanSchedule(ctx context.Context, intervalMs int64) error {
	data, err := MarshalJobData(ScanJobData{Type: JobTypeScan})
	if err != nil {
		return err
	}
	opts := map[string]any{
		"attempts":         0,
		"jobId":            JobNameScan,
		"removeOnComplete": true,
		"removeOnFail":     failedRetention(),
	}
	return p.ensureRepeatable(ctx, JobNameScan, JobNameScan, data, intervalMs, opts)
}

// EnsureRuleSchedule replaces one rule's repeat schedule, equivalent to
// AlertsService.ensureRuleSchedule: the every interval is floored at 60
// seconds, the job id is `evaluate-<ruleId>` and the payload has no traceId.
//
// The existing one-shot jobs of the rule are removed first, exactly like the
// NestJS method, and addRepeatableJob's override path removes the previously
// scheduled iteration, so changing checkIntervalSec cannot leave the old
// interval behind.
func (p *Producer) EnsureRuleSchedule(ctx context.Context, ruleID, orgID string, checkIntervalSec int) error {
	if err := p.RemoveRuleJobs(ctx, ruleID, false); err != nil {
		return err
	}
	data, err := MarshalJobData(ScheduleJobData{
		Type:   JobTypeEvaluate,
		RuleID: ruleID,
		OrgID:  orgID,
	})
	if err != nil {
		return err
	}
	every := int64(checkIntervalSec)
	if every < 60 {
		every = 60
	}
	opts := map[string]any{
		"attempts":         0,
		"removeOnComplete": true,
		"removeOnFail":     failedRetention(),
	}
	return p.ensureRepeatable(ctx, RuleJobName(ruleID), "evaluate-"+ruleID, data, every*1000, opts)
}

// RemoveRuleJobs removes the rule's schedules and pending one-shot jobs,
// equivalent to AlertsService.removeJob(ruleId, includeRepeats). A repeat hash
// does not contain its own zset member, so the member is matched through the
// `bull:alerts:repeat:<key>` hash `name` field.
func (p *Producer) RemoveRuleJobs(ctx context.Context, ruleID string, includeRepeats bool) error {
	if includeRepeats {
		if err := p.removeRepeatablesByName(ctx, RuleJobName(ruleID)); err != nil {
			return err
		}
	}
	for _, jobID := range []string{"evaluate-" + ruleID, "evaluate:" + ruleID, RuleJobName(ruleID)} {
		if err := p.removeJobIfPresent(ctx, jobID); err != nil {
			return err
		}
	}
	return nil
}

// removeRepeatablesByName removes every repeat schedule whose stored name
// matches, mirroring AlertsService.removeJob's getRepeatableJobs loop.
func (p *Producer) removeRepeatablesByName(ctx context.Context, name string) error {
	members, err := p.client.ZRangeWithScores(ctx, p.keys.Repeat, 0, -1).Result()
	if err != nil {
		return fmt.Errorf("alertworker/queue: list repeatable jobs: %w", err)
	}
	for _, member := range members {
		repeatKey, ok := member.Member.(string)
		if !ok || repeatKey == "" {
			continue
		}
		fields, err := p.client.HGetAll(ctx, p.keys.Repeat+":"+repeatKey).Result()
		if err != nil {
			return fmt.Errorf("alertworker/queue: read repeatable job: %w", err)
		}
		if fields["name"] != name {
			continue
		}
		if err := p.removeRepeatable(ctx, repeatKey); err != nil {
			return err
		}
	}
	return nil
}

// removeJobIfPresent mirrors Queue.remove: the job is only deleted when it
// exists, so removing an unknown id is a no-op and never raises BullMQ's
// "locked by another worker" error.
func (p *Producer) removeJobIfPresent(ctx context.Context, jobID string) error {
	exists, err := p.client.Exists(ctx, p.keys.Job(jobID)).Result()
	if err != nil {
		return fmt.Errorf("alertworker/queue: check job %s: %w", jobID, err)
	}
	if exists == 0 {
		return nil
	}
	return p.removeJob(ctx, jobID)
}

func (p *Producer) removeJob(ctx context.Context, jobID string) error {
	result, err := p.scripts.removeJob.Run(ctx, p.client,
		[]string{p.keys.Job(jobID), p.keys.Repeat},
		jobID, 1, p.keys.Base,
	).Result()
	if err != nil {
		return fmt.Errorf("alertworker/queue: remove job %s: %w", jobID, err)
	}
	if code := toInt64(result); code < 0 {
		return fmt.Errorf("alertworker/queue: remove job %s rejected with BullMQ code %d", jobID, code)
	}
	return nil
}

// removeRepeatable mirrors Repeat.removeRepeatableByKey: for a hashed repeat
// key the legacy job id is derived from the key itself and the concat form is
// empty, and the script deletes the next delayed iteration plus the hash.
func (p *Producer) removeRepeatable(ctx context.Context, repeatKey string) error {
	result, err := p.scripts.removeRepeatable.Run(ctx, p.client,
		[]string{p.keys.Repeat, p.keys.Delayed, p.keys.Events},
		legacyRepeatJobID(repeatKey), removalConcatOptions(repeatKey), repeatKey, p.keys.Base,
	).Result()
	if err != nil {
		return fmt.Errorf("alertworker/queue: remove repeatable job: %w", err)
	}
	if code := toInt64(result); code < 0 {
		return fmt.Errorf("alertworker/queue: remove repeatable job rejected with BullMQ code %d", code)
	}
	return nil
}

// ensureRepeatable is Repeat.updateRepeatableJob(name, data, opts, {override:true}):
// it writes the repeat hash and zset entry, then creates the next delayed
// iteration whose id is `repeat:<md5>:<nextMillis>`.
func (p *Producer) ensureRepeatable(ctx context.Context, name, jobID string, data []byte, everyMs int64, baseOpts map[string]any) error {
	nowMs := p.now().UnixMilli()
	nextMillis := nextRepeatMillis(nowMs, everyMs)

	legacyKey := repeatConcatOptions(name, jobID, everyMs)
	repeatKey := hashRepeatKey(legacyKey)
	repeatOpts, err := MarshalMsgpack(map[string]any{
		"name":    name,
		"endDate": nil,
		"tz":      nil,
		"pattern": nil,
		"every":   everyMs,
	})
	if err != nil {
		return err
	}
	if _, err := p.scripts.addRepeatableJob.Run(ctx, p.client,
		[]string{p.keys.Repeat, p.keys.Delayed},
		nextMillis, repeatOpts, legacyKey, repeatKey, p.keys.Base,
	).Result(); err != nil {
		return fmt.Errorf("alertworker/queue: add repeatable job: %w", err)
	}

	iterationID := repeatDelayedJobID(repeatKey, nextMillis)
	delay := nextMillis - nowMs
	if delay < 0 {
		delay = 0
	}
	opts := make(map[string]any, len(baseOpts)+6)
	for key, value := range baseOpts {
		opts[key] = value
	}
	opts["jobId"] = iterationID
	opts["delay"] = delay
	opts["timestamp"] = nowMs
	opts["prevMillis"] = nextMillis
	opts["repeat"] = repeatIterationOptions(everyMs, jobID, 1)

	return p.addJob(ctx, name, iterationID, data, nowMs, opts, repeatKey)
}

// repeatIterationOptions is the nested opts.repeat of one iteration. BullMQ
// builds it from the repeat options and adds `count` (the 1-based iteration
// number) and `offset`; cmsgpack drops the nil-valued keys.
func repeatIterationOptions(everyMs int64, jobID string, count int64) map[string]any {
	return map[string]any{
		"every":     everyMs,
		"jobId":     jobID,
		"count":     count,
		"offset":    nil,
		"startDate": nil,
		"endDate":   nil,
	}
}

// addStandardJob runs BullMQ's addStandardJob path.
func (p *Producer) addStandardJob(ctx context.Context, name, jobID string, data []byte, timestampMs int64, opts map[string]any) error {
	return p.addJob(ctx, name, jobID, data, timestampMs, opts, "")
}

// addJob selects the delayed or the standard add script exactly like
// Scripts.addJob: a positive opts.delay takes the delayed path.
func (p *Producer) addJob(ctx context.Context, name, jobID string, data []byte, timestampMs int64, opts map[string]any, repeatJobKey string) error {
	args, err := MarshalMsgpack(buildJobArguments(p.keys.Base, jobID, name, timestampMs, repeatJobKey))
	if err != nil {
		return err
	}
	encodedOpts, err := MarshalMsgpack(opts)
	if err != nil {
		return err
	}
	delay, _ := opts["delay"].(int64)
	var result any
	if delay > 0 {
		result, err = p.scripts.addDelayedJob.Run(ctx, p.client,
			[]string{p.keys.Marker, p.keys.Meta, p.keys.ID, p.keys.Delayed, p.keys.Completed, p.keys.Events},
			args, data, encodedOpts,
		).Result()
	} else {
		result, err = p.scripts.addStandardJob.Run(ctx, p.client,
			[]string{p.keys.Wait, p.keys.Paused, p.keys.Meta, p.keys.ID, p.keys.Completed, p.keys.Delayed, p.keys.Active, p.keys.Events, p.keys.Marker},
			args, data, encodedOpts,
		).Result()
	}
	if err != nil {
		return fmt.Errorf("alertworker/queue: add job %s: %w", jobID, err)
	}
	// A duplicate job id is not an error in BullMQ 5.63.2: handleDuplicatedJob
	// emits a "duplicated" event and returns the job id string, so Queue.add
	// resolves with the existing job.
	if code := toInt64(result); code < 0 {
		return fmt.Errorf("alertworker/queue: add job %s rejected with BullMQ code %d", jobID, code)
	}
	return nil
}

// buildJobArguments is the args array Scripts.addJob packs as ARGV[1]. Rule and
// delivery jobs have no parent and no deduplication id, so slots 5-7 and 9 stay
// nil.
func buildJobArguments(prefix, jobID, name string, timestampMs int64, repeatJobKey string) []any {
	args := []any{
		prefix,
		jobID,
		name,
		timestampMs,
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

// failedRetention is BULLMQ_FAILED_JOB_RETENTION as a fresh option value.
func failedRetention() map[string]any {
	return map[string]any{"age": int64(FailedRetentionAgeSeconds), "count": int64(FailedRetentionCount)}
}

// repeatConcatOptions mirrors Repeat's getRepeatConcatOptions for an
// every-based schedule: name:jobId:endDate:tz:every with empty end date and tz.
func repeatConcatOptions(name, jobID string, everyMs int64) string {
	return name + ":" + jobID + ":::" + strconv.FormatInt(everyMs, 10)
}

// hashRepeatKey is Repeat.hash with the default md5 algorithm.
func hashRepeatKey(value string) string {
	sum := md5.Sum([]byte(value))
	return hex.EncodeToString(sum[:])
}

// nextRepeatMillis is Repeat's getNextMillis for the every strategy: the next
// interval boundary after millis.
func nextRepeatMillis(millis, everyMs int64) int64 {
	if everyMs <= 0 {
		return millis
	}
	return millis/everyMs*everyMs + everyMs
}

// repeatDelayedJobID is Repeat.getRepeatDelayedJobId for a hashed key.
func repeatDelayedJobID(repeatKey string, nextMillis int64) string {
	return "repeat:" + repeatKey + ":" + strconv.FormatInt(nextMillis, 10)
}

// legacyRepeatJobID is Repeat.getRepeatJobId as called by
// removeRepeatableByKey: repeat:<hash(name + id + hash(key))>: with the id read
// from keyToData(key).
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
