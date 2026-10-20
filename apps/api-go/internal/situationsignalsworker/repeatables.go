package situationsignalsworker

import (
	"context"
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/situationsettings/telegramsched"
)

const (
	// BULLMQ_FAILED_JOB_RETENTION {age: 7 days, count: 10_000} from
	// apps/api/src/common/bullmq-retention.ts. Both the queue defaultJobOptions
	// and every explicit job option of this queue use it for removeOnFail.
	failedRetentionAgeSeconds int64 = 7 * 24 * 60 * 60
	failedRetentionCount      int64 = 10_000
	// The situationMonitorSignals Queue defaultJobOptions:
	// {removeOnComplete: true, removeOnFail: BULLMQ_FAILED_JOB_RETENTION,
	//  attempts: 3, backoff: {type: 'exponential', delay: 1_000}}.
	defaultJobAttempts    = 3
	defaultBackoffDelayMs = 1_000
	backoffExponential    = "exponential"
	// minOrefIntervalMs is the 30 second floor of
	// processor.readNumberEnv('SITUATION_MONITOR_OREF_POLL_INTERVAL_MS', 300_000, 30_000).
	minOrefIntervalMs = 30_000
	// orefRepeatJobID is the opts.jobId of the legacy repeat schedule:
	// `${OREF_POLL_JOB_NAME}:repeat`.
	orefRepeatJobID = OrefPollJobName + ":repeat"
)

// RepeatablesConfig is the poll schedule configuration EnsureRepeatables
// installs. The intervals are already normalized by the caller; EnsureRepeatables
// applies the BullMQ floors once more so a misconfigured caller cannot create a
// too-frequent schedule.
type RepeatablesConfig struct {
	TelegramEnabled    bool
	TelegramIntervalMS int
	OrefIntervalMS     int
}

// EnsureRepeatables is the Go equivalent of
// SituationMonitorSignalsProcessor.ensureRepeatableJobs (A4). It installs the
// same BullMQ state the NestJS producer wrote while it owned the queue:
//
//  1. Removes the legacy Telegram repeat jobs.
//  2. When Telegram is enabled, upserts the BullMQ 5 JobScheduler
//     "telegram-poll:scheduler" and enqueues the Telegram bootstrap job;
//     otherwise removes the scheduler and the queued Telegram poll jobs.
//  3. Adds the legacy Oref repeat job "<oref-poll:repeat>" with
//     repeat={every: OrefIntervalMS}.
//  4. Enqueues the Oref bootstrap job for a fast first run.
//
// Steps 1-2 are shared with the HTTP settings path through
// internal/situationsettings/telegramsched. Failures of steps 1-3 are returned
// so startup can fail; the bootstrap add mirrors the NestJS
// `Promise.allSettled` and only logs.
func EnsureRepeatables(ctx context.Context, client *redis.Client, cfg RepeatablesConfig) error {
	if client == nil {
		return errors.New("situationsignalsworker: ensure repeatables requires a redis client")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if err := telegramsched.New(client).Sync(ctx, cfg.TelegramEnabled, cfg.TelegramIntervalMS); err != nil {
		return fmt.Errorf("situationsignalsworker: sync telegram poll schedule: %w", err)
	}
	if err := ensureOrefRepeat(ctx, client, cfg.OrefIntervalMS); err != nil {
		return fmt.Errorf("situationsignalsworker: ensure oref poll repeat: %w", err)
	}
	// NestJS wraps the bootstrap adds in Promise.allSettled, so a failure never
	// fails onModuleInit. The Telegram bootstrap was already enqueued by
	// telegramsched.Sync when Telegram is enabled.
	if err := addBootstrapJob(ctx, client, SourceOref); err != nil {
		log.Printf(logPrefix+"enqueue oref bootstrap job: %v", err)
	}
	return nil
}

// ensureOrefRepeat mirrors `queue.add(OREF_POLL_JOB_NAME, {type:'poll',
// source:'oref'}, {jobId: 'oref-poll:repeat', removeOnComplete: true,
// removeOnFail: BULLMQ_FAILED_JOB_RETENTION, repeat: {every: orefIntervalMs}})`.
// Queue.add merges the queue defaultJobOptions and Repeat.updateRepeatableJob
// writes the repeat zset member plus the next delayed iteration.
func ensureOrefRepeat(ctx context.Context, client *redis.Client, intervalMS int) error {
	scripts, err := loadQueueScripts()
	if err != nil {
		return err
	}
	keys := newQueueKeys(QueuePrefix, QueueName)
	now := time.Now()
	every := int64(normalizeOrefInterval(intervalMS))
	nextMillis := nextEveryMillis(now.UnixMilli(), every)
	repeatKey := hashRepeatKey(repeatConcatOptions(OrefPollJobName, orefRepeatJobID, every))

	repeatOpts, err := queuePack(map[string]any{
		"name":    OrefPollJobName,
		"endDate": nil,
		"tz":      nil,
		"pattern": nil,
		"every":   every,
	})
	if err != nil {
		return err
	}
	// addRepeatableJob stores the repeat zset member and the repeat hash, and
	// removes the previous delayed iteration when the schedule is overridden.
	if _, err := scripts.addRepeatableJob.Run(ctx, client,
		[]string{keys.Repeat, keys.Delayed},
		nextMillis,
		repeatOpts,
		repeatConcatOptions(OrefPollJobName, orefRepeatJobID, every),
		repeatKey,
		keys.Base,
	).Result(); err != nil {
		return fmt.Errorf("situationsignalsworker: add oref repeat: %w", err)
	}

	data, err := json.Marshal(pollJobData{Type: jobTypePoll, Source: SourceOref})
	if err != nil {
		return fmt.Errorf("situationsignalsworker: encode oref job data: %w", err)
	}
	jobID := repeatDelayedJobID(repeatKey, nextMillis)
	opts, err := queuePack(orefRepeatIterationOptions(jobID, repeatKey, every, now, nextMillis))
	if err != nil {
		return err
	}
	args, err := queueJobArguments(keys.Base, jobID, OrefPollJobName, now.UnixMilli(), repeatKey)
	if err != nil {
		return err
	}
	result, err := scripts.addDelayedJob.Run(ctx, client, []string{
		keys.Marker,
		keys.Meta,
		keys.ID,
		keys.Delayed,
		keys.Completed,
		keys.Events,
	}, args, string(data), opts).Result()
	if err != nil {
		return fmt.Errorf("situationsignalsworker: add oref repeat iteration: %w", err)
	}
	if code := queueNegativeCode(result); code < 0 {
		return fmt.Errorf("situationsignalsworker: add oref repeat iteration rejected with BullMQ code %d", code)
	}
	return nil
}

// orefRepeatIterationOptions is what Repeat.createNextJob + Queue.add store for
// the first Oref iteration: the merged defaultJobOptions, the repeat iteration
// fields and the repeat template (BullMQ stores opts as JSON through the add
// scripts; here it is the MessagePack payload the script decodes).
func orefRepeatIterationOptions(jobID, repeatKey string, every int64, now time.Time, nextMillis int64) map[string]any {
	delay := nextMillis - now.UnixMilli()
	if delay < 0 {
		delay = 0
	}
	return map[string]any{
		"attempts":         defaultJobAttempts,
		"backoff":          map[string]any{"type": backoffExponential, "delay": defaultBackoffDelayMs},
		"removeOnComplete": true,
		"removeOnFail":     failedRetention(),
		"jobId":            jobID,
		"delay":            delay,
		"timestamp":        now.UnixMilli(),
		"prevMillis":       nextMillis,
		"repeatJobKey":     repeatKey,
		"repeat": map[string]any{
			"every": every,
			"jobId": orefRepeatJobID,
			"count": 1,
		},
	}
}

// addBootstrapJob mirrors the NestJS `queue.add('<source>:bootstrap', ...,
// {removeOnComplete: true, removeOnFail: BULLMQ_FAILED_JOB_RETENTION})` for a
// fast first run. Unlike the poll jobs it has no job id, so the add script
// allocates the queue counter id exactly like BullMQ's Job.create.
func addBootstrapJob(ctx context.Context, client *redis.Client, source PollSource) error {
	scripts, err := loadQueueScripts()
	if err != nil {
		return err
	}
	keys := newQueueKeys(QueuePrefix, QueueName)
	now := time.Now()
	data, err := json.Marshal(pollJobData{Type: jobTypePoll, Source: source})
	if err != nil {
		return fmt.Errorf("situationsignalsworker: encode bootstrap job data: %w", err)
	}
	args, err := queueJobArguments(keys.Base, "", bootstrapJobName(source), now.UnixMilli(), "")
	if err != nil {
		return err
	}
	opts, err := queuePack(bootstrapJobOptions())
	if err != nil {
		return err
	}
	result, err := scripts.addStandardJob.Run(ctx, client, []string{
		keys.Wait,
		keys.Paused,
		keys.Meta,
		keys.ID,
		keys.Completed,
		keys.Delayed,
		keys.Active,
		keys.Events,
		keys.Marker,
	}, args, string(data), opts).Result()
	if err != nil {
		return fmt.Errorf("situationsignalsworker: add bootstrap job: %w", err)
	}
	if code := queueNegativeCode(result); code < 0 {
		return fmt.Errorf("situationsignalsworker: add bootstrap job rejected with BullMQ code %d", code)
	}
	return nil
}

// bootstrapJobOptions is the merged Queue.add options of a bootstrap job: the
// queue defaultJobOptions plus the explicit removeOnComplete/removeOnFail.
func bootstrapJobOptions() map[string]any {
	return map[string]any{
		"attempts":         defaultJobAttempts,
		"backoff":          map[string]any{"type": backoffExponential, "delay": defaultBackoffDelayMs},
		"removeOnComplete": true,
		"removeOnFail":     failedRetention(),
	}
}

// bootstrapJobName is the BullMQ name of the fast-first-run job for a source.
func bootstrapJobName(source PollSource) string {
	if source == SourceTelegram {
		return TelegramPollJobName + ":bootstrap"
	}
	return OrefPollJobName + ":bootstrap"
}

// failedRetention is BULLMQ_FAILED_JOB_RETENTION as a fresh option value.
func failedRetention() map[string]any {
	return map[string]any{"age": failedRetentionAgeSeconds, "count": failedRetentionCount}
}

// queueJobArguments is the args array Scripts.addJob packs as ARGV[1]: the key
// prefix, the job id ("" asks the script to allocate one), the job name, the
// timestamp, and the nil parent/deduplication slots. This queue has no parent
// jobs; only the repeat iteration carries a repeat job key.
func queueJobArguments(prefix, jobID, name string, timestampMs int64, repeatJobKey string) ([]byte, error) {
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
	return queuePack(args)
}

// nextEveryMillis aligns an interval to the epoch exactly like BullMQ's every
// repeat strategy: floor(now/every)*every + every.
func nextEveryMillis(millis, everyMs int64) int64 {
	if everyMs <= 0 {
		return millis
	}
	return millis/everyMs*everyMs + everyMs
}

// repeatConcatOptions mirrors Repeat.getRepeatConcatOptions for an every-based
// schedule without end date and without timezone:
// "<name>:<jobId>::<every>".
func repeatConcatOptions(name, jobID string, everyMs int64) string {
	return name + ":" + jobID + ":::" + strconv.FormatInt(everyMs, 10)
}

// hashRepeatKey is Repeat.hash with the default md5 algorithm.
func hashRepeatKey(value string) string {
	sum := md5.Sum([]byte(value))
	return hex.EncodeToString(sum[:])
}

// repeatDelayedJobID is Repeat.getRepeatDelayedJobId for a hashed repeat key:
// "repeat:<md5>:<nextMillis>".
func repeatDelayedJobID(repeatKey string, nextMillis int64) string {
	return "repeat:" + repeatKey + ":" + strconv.FormatInt(nextMillis, 10)
}

// normalizeOrefInterval applies the 30 second floor of
// processor.readNumberEnv('SITUATION_MONITOR_OREF_POLL_INTERVAL_MS', 300_000, 30_000).
func normalizeOrefInterval(intervalMs int) int {
	if intervalMs < minOrefIntervalMs {
		return minOrefIntervalMs
	}
	return intervalMs
}
