package queueorgstats

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/bullmqwire"
)

// ErrNoRedis is returned when the command client is missing.
var ErrNoRedis = errors.New("queueorgstats: redis is not configured")

// ErrNoBlockingOptions is returned when the dedicated XREAD connection
// configuration is missing.
var ErrNoBlockingOptions = errors.New("queueorgstats: blocking redis options are not configured")

// Store is the Redis surface the tracker needs. The production implementation is
// redisStore; the tracker tests substitute a fake so the transition branches and
// the lease behaviour are testable without Redis.
//
// The methods are the QueueOrgStatsService calls of the NestJS tracker
// (queue-org-stats.tracker.ts:57-96), with the same inputs and the same
// all-or-nothing script semantics.
type Store interface {
	// ReadStream is one blocking XREAD of the itemPipeline event stream. It
	// returns no events when the block expires.
	ReadStream(ctx context.Context, lastID string, count int64, block time.Duration) ([]StreamEvent, error)
	// GetJobMeta returns the meta hash of one job. found is false when the hash
	// is absent, the org id is empty or the stored status is not a tracked
	// state, exactly like QueueOrgStatsService.getJobMeta returning null.
	GetJobMeta(ctx context.Context, jobID string) (meta JobMeta, found bool, err error)
	// GetJob returns the decoded job hash, or nil when the job no longer exists
	// (Queue.getJob returns undefined for a removed job).
	GetJob(ctx context.Context, jobID string) (*bullmqwire.Job, error)
	// UpsertJobMetaAndCount runs upsertAndTransitionScript.
	UpsertJobMetaAndCount(ctx context.Context, input UpsertJobMetaInput) error
	// TransitionTerminalAndRemove runs terminalAndRemoveScript: the terminal
	// status is counted and the meta hash is deleted.
	TransitionTerminalAndRemove(ctx context.Context, jobID, orgID string, status JobStatus) error
	// RemoveJob runs removeJobScript: the last recorded status is decremented
	// and the meta hash is deleted.
	RemoveJob(ctx context.Context, orgID, jobID string) error
	// Close releases the blocking connection.
	Close() error
}

// redisStore is the production Store. Commands run on the shared client; the
// blocking XREAD runs on a dedicated connection because a connection parked in
// XREAD BLOCK cannot serve the lease, HMGET or script calls.
type redisStore struct {
	commands *redis.Client
	blocking *redis.Client
	keys     bullmqwire.Keys
}

// newRedisStore builds the Redis store over the shared command client and the
// dedicated blocking client.
func newRedisStore(commands, blocking *redis.Client) *redisStore {
	return &redisStore{
		commands: commands,
		blocking: blocking,
		keys:     queueKeys,
	}
}

// ReadStream blocks on the event stream. redis.Nil is the "no entry within the
// block" answer and is not an error.
func (s *redisStore) ReadStream(ctx context.Context, lastID string, count int64, block time.Duration) ([]StreamEvent, error) {
	if s == nil || s.blocking == nil {
		return nil, ErrNoRedis
	}
	streams, err := s.blocking.XRead(ctx, &redis.XReadArgs{
		Streams: []string{s.keys.Events, lastID},
		Count:   count,
		Block:   block,
	}).Result()
	if errors.Is(err, redis.Nil) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	events := make([]StreamEvent, 0, len(streams))
	for _, stream := range streams {
		for _, message := range stream.Messages {
			events = append(events, StreamEvent{
				ID:    message.ID,
				Event: streamField(message.Values, streamFieldEvent),
				JobID: streamField(message.Values, streamFieldJobID),
			})
		}
	}
	return events, nil
}

// GetJobMeta mirrors QueueOrgStatsService.getJobMeta: it reads the four meta
// fields with one HMGET and normalizes the keep flags to "1" (any other stored
// value reads as false, exactly like `keepCompleted === "1" ? "1" : "0"`).
func (s *redisStore) GetJobMeta(ctx context.Context, jobID string) (JobMeta, bool, error) {
	if s == nil || s.commands == nil {
		return JobMeta{}, false, ErrNoRedis
	}
	values, err := s.commands.HMGet(ctx, metaKey(jobID),
		metaFieldOrgID, metaFieldStatus, metaFieldKeepCompleted, metaFieldKeepFailed).Result()
	if err != nil {
		return JobMeta{}, false, fmt.Errorf("queueorgstats: read job meta %s: %w", jobID, err)
	}
	orgID := redisString(hmgetValue(values, 0))
	status := redisString(hmgetValue(values, 1))
	if orgID == "" || !isTrackedStatus(status) {
		return JobMeta{}, false, nil
	}
	return JobMeta{
		OrgID:         orgID,
		Status:        JobStatus(status),
		KeepCompleted: redisString(hmgetValue(values, 2)) == keepFlagTrue,
		KeepFailed:    redisString(hmgetValue(values, 3)) == keepFlagTrue,
	}, true, nil
}

// GetJob decodes the job hash with the shared BullMQ reader. The tracker needs
// the same decoding as the queue console, so it does not parse the hash itself.
func (s *redisStore) GetJob(ctx context.Context, jobID string) (*bullmqwire.Job, error) {
	if s == nil || s.commands == nil {
		return nil, ErrNoRedis
	}
	job, err := bullmqwire.ReadJob(ctx, s.commands, s.keys, jobID)
	if err != nil {
		return nil, fmt.Errorf("queueorgstats: read job %s: %w", jobID, err)
	}
	return job, nil
}

// UpsertJobMetaAndCount is QueueOrgStatsService.upsertJobMetaAndCount.
func (s *redisStore) UpsertJobMetaAndCount(ctx context.Context, input UpsertJobMetaInput) error {
	if s == nil || s.commands == nil {
		return ErrNoRedis
	}
	err := s.commands.Eval(ctx, upsertAndTransitionScript,
		[]string{metaKey(input.JobID), countsKey(input.Meta.OrgID)},
		string(input.Meta.Status),
		input.Meta.OrgID,
		keepFlag(input.Meta.KeepCompleted),
		keepFlag(input.Meta.KeepFailed),
		strconv.Itoa(metaTTLSeconds),
		strconv.Itoa(countsTTLSeconds),
	).Err()
	if err := ignoreNilReply(err); err != nil {
		return fmt.Errorf("queueorgstats: upsert job meta %s: %w", input.JobID, err)
	}
	return nil
}

// TransitionTerminalAndRemove is the TERMINAL_AND_REMOVE branch of
// QueueOrgStatsService.transitionJob.
func (s *redisStore) TransitionTerminalAndRemove(ctx context.Context, jobID, orgID string, status JobStatus) error {
	if s == nil || s.commands == nil {
		return ErrNoRedis
	}
	err := s.commands.Eval(ctx, terminalAndRemoveScript,
		[]string{metaKey(jobID), countsKey(orgID)},
		string(status),
		strconv.Itoa(countsTTLSeconds),
	).Err()
	if err := ignoreNilReply(err); err != nil {
		return fmt.Errorf("queueorgstats: terminal transition %s: %w", jobID, err)
	}
	return nil
}

// RemoveJob is QueueOrgStatsService.removeJob.
func (s *redisStore) RemoveJob(ctx context.Context, orgID, jobID string) error {
	if s == nil || s.commands == nil {
		return ErrNoRedis
	}
	err := s.commands.Eval(ctx, removeJobScript,
		[]string{metaKey(jobID), countsKey(orgID)},
		strconv.Itoa(countsTTLSeconds),
	).Err()
	if err := ignoreNilReply(err); err != nil {
		return fmt.Errorf("queueorgstats: remove job meta %s: %w", jobID, err)
	}
	return nil
}

// ignoreNilReply normalizes the answer of a counter script. All three scripts
// return the previous status, which is Lua false when the meta hash had none;
// go-redis reports that reply as redis.Nil even though the script ran. Only a
// real Redis error is reported to the caller.
func ignoreNilReply(err error) error {
	if err == nil || errors.Is(err, redis.Nil) {
		return nil
	}
	return err
}

// Close closes the dedicated blocking connection. The shared command client is
// owned by the gateway and is left open.
func (s *redisStore) Close() error {
	if s == nil || s.blocking == nil {
		return nil
	}
	return s.blocking.Close()
}

// streamField reads one stream entry field. The map is the XREAD protocol
// payload, not business data; a missing or non-string field reads as "".
func streamField(values map[string]any, name string) string {
	if values == nil {
		return ""
	}
	return redisString(values[name])
}

// hmgetValue reads one HMGET slot. As with streamField, the slice is the go-redis
// protocol result; an absent field arrives as nil and reads as "".
func hmgetValue(values []any, index int) any {
	if index < 0 || index >= len(values) {
		return nil
	}
	return values[index]
}

// redisString normalizes a go-redis value to a string.
func redisString(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return typed
	case []byte:
		return string(typed)
	case int64:
		return strconv.FormatInt(typed, 10)
	default:
		return ""
	}
}
