package searchreindex

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

// Redis key prefixes and the organization set, shared with
// SearchReindexJobStore.
const (
	jobKeyPrefix = "search:reindex:job:"
	orgKeyPrefix = "search:reindex:org:"
	orgsSetKey   = "search:reindex:orgs"
)

// Retention windows shared with the NestJS store: queued/running jobs live for
// 12 hours, completed/failed jobs for 1 hour, and at most 200 valid jobs are
// retained per organization.
const (
	activeJobTTL    = 12 * time.Hour
	terminalJobTTL  = time.Hour
	maxRetainedJobs = 200
)

// jobStore persists reindex jobs in Redis. Every write keeps the organization
// list TTL at the active window so the list never expires before a job that can
// still be queried.
type jobStore struct {
	redis *redis.Client
}

// newJobStore wraps the shared Redis client.
func newJobStore(client *redis.Client) *jobStore {
	return &jobStore{redis: client}
}

// jobKey builds the Redis JSON key of one job.
func jobKey(jobID string) string { return jobKeyPrefix + jobID }

// orgKey builds the Redis list key of one organization's job ids.
func orgKey(orgID string) string { return orgKeyPrefix + orgID }

// wrapRedis marks an error as a Redis failure for the HTTP mapping.
func wrapRedis(err error) error {
	if err == nil {
		return nil
	}
	return fmt.Errorf("%w: %v", errRedis, err)
}

// create prunes the current organization first, then persists the queued job,
// its organization set membership and its list entry.
func (s *jobStore) create(ctx context.Context, orgID string, now time.Time) (Job, error) {
	if err := s.prune(ctx, orgID, now); err != nil {
		return Job{}, err
	}
	id, err := newJobID()
	if err != nil {
		return Job{}, err
	}
	timestamp := isoTimestamp(now)
	job := Job{
		ID:        id,
		OrgID:     orgID,
		Status:    JobStatusQueued,
		Indexed:   0,
		CreatedAt: timestamp,
		UpdatedAt: timestamp,
	}
	payload, err := json.Marshal(job)
	if err != nil {
		return Job{}, err
	}
	if err := s.redis.Set(ctx, jobKey(job.ID), payload, activeJobTTL).Err(); err != nil {
		return Job{}, wrapRedis(err)
	}
	if err := s.redis.SAdd(ctx, orgsSetKey, orgID).Err(); err != nil {
		return Job{}, wrapRedis(err)
	}
	if err := s.redis.RPush(ctx, orgKey(orgID), job.ID).Err(); err != nil {
		return Job{}, wrapRedis(err)
	}
	if err := s.redis.Expire(ctx, orgKey(orgID), activeJobTTL).Err(); err != nil {
		return Job{}, wrapRedis(err)
	}
	return job, nil
}

// getForOrg returns the job only when it exists and belongs to orgID. A missing
// key, an unreadable payload and a foreign organization all return nil, matching
// the NestJS getForOrg contract (the controller serializes null).
func (s *jobStore) getForOrg(ctx context.Context, orgID, jobID string) (*Job, error) {
	raw, err := s.redis.Get(ctx, jobKey(jobID)).Bytes()
	if err != nil {
		if errors.Is(err, redis.Nil) {
			return nil, nil
		}
		return nil, wrapRedis(err)
	}
	var job Job
	if err := json.Unmarshal(raw, &job); err != nil {
		return nil, nil
	}
	if job.OrgID != orgID {
		return nil, nil
	}
	return &job, nil
}

// markRunning moves the job to running.
func (s *jobStore) markRunning(ctx context.Context, jobID string, now time.Time) (*Job, error) {
	return s.update(ctx, jobID, func(job *Job) {
		job.Status = JobStatusRunning
		job.UpdatedAt = isoTimestamp(now)
	})
}

// markProgress persists the indexed counter and updatedAt after one batch so a
// polling GET observes real progress instead of a final jump.
func (s *jobStore) markProgress(ctx context.Context, jobID string, indexed int, now time.Time) (*Job, error) {
	return s.update(ctx, jobID, func(job *Job) {
		job.Indexed = indexed
		job.UpdatedAt = isoTimestamp(now)
	})
}

// markCompleted moves the job to completed with the final successful count and
// drops any error text.
func (s *jobStore) markCompleted(ctx context.Context, jobID string, indexed int, now time.Time) (*Job, error) {
	return s.update(ctx, jobID, func(job *Job) {
		job.Status = JobStatusCompleted
		job.Indexed = indexed
		job.Error = ""
		job.UpdatedAt = isoTimestamp(now)
	})
}

// markFailed moves the job to failed while keeping every document that was
// actually written (indexed is the running total including the current batch).
func (s *jobStore) markFailed(ctx context.Context, jobID string, indexed int, message string, now time.Time) (*Job, error) {
	return s.update(ctx, jobID, func(job *Job) {
		job.Status = JobStatusFailed
		job.Indexed = indexed
		job.Error = message
		job.UpdatedAt = isoTimestamp(now)
	})
}

// update reads the job, applies mutate and writes it back with the retention
// that matches the resulting status. A missing or unreadable job returns nil,
// like SearchReindexJobStore.update.
func (s *jobStore) update(ctx context.Context, jobID string, mutate func(*Job)) (*Job, error) {
	raw, err := s.redis.Get(ctx, jobKey(jobID)).Bytes()
	if err != nil {
		if errors.Is(err, redis.Nil) {
			return nil, nil
		}
		return nil, wrapRedis(err)
	}
	var job Job
	if err := json.Unmarshal(raw, &job); err != nil {
		return nil, nil
	}
	mutate(&job)
	payload, err := json.Marshal(job)
	if err != nil {
		return nil, err
	}
	ttl := activeJobTTL
	if job.Status.isTerminal() {
		ttl = terminalJobTTL
	}
	if err := s.redis.Set(ctx, jobKey(jobID), payload, ttl).Err(); err != nil {
		return nil, wrapRedis(err)
	}
	return &job, nil
}

// prune cleans one organization only: it reads the organization list, batch
// loads the job payloads with MGET, and removes expired, missing and over-limit
// history in a single pass. The excess budget is computed from the filtered
// valid list and only terminal jobs are trimmed, so a queued or running job is
// never deleted by history retention. LREM keeps concurrent appends intact
// because the list key is never rewritten as a whole.
func (s *jobStore) prune(ctx context.Context, orgID string, now time.Time) error {
	listKey := orgKey(orgID)
	jobIDs, err := s.redis.LRange(ctx, listKey, 0, -1).Result()
	if err != nil {
		return wrapRedis(err)
	}
	if len(jobIDs) == 0 {
		return wrapRedis(s.redis.SRem(ctx, orgsSetKey, orgID).Err())
	}
	keys := make([]string, 0, len(jobIDs))
	for _, jobID := range jobIDs {
		keys = append(keys, jobKey(jobID))
	}
	payloads, err := s.redis.MGet(ctx, keys...).Result()
	if err != nil {
		return wrapRedis(err)
	}
	stale := make([]string, 0, len(jobIDs))
	terminal := make([]string, 0, len(jobIDs))
	valid := 0
	for index, jobID := range jobIDs {
		// MGet returns the driver's []interface{} payload slice; a missing key
		// arrives as nil. This is the only place the protocol boundary shows.
		raw := ""
		if index < len(payloads) {
			if value, ok := payloads[index].(string); ok {
				raw = value
			}
		}
		if raw == "" {
			stale = append(stale, jobID)
			continue
		}
		var job Job
		if err := json.Unmarshal([]byte(raw), &job); err != nil {
			stale = append(stale, jobID)
			continue
		}
		updatedAt, err := time.Parse(time.RFC3339Nano, job.UpdatedAt)
		if err != nil {
			stale = append(stale, jobID)
			continue
		}
		age := now.Sub(updatedAt)
		if job.Status.isTerminal() {
			if age >= terminalJobTTL {
				stale = append(stale, jobID)
				continue
			}
			terminal = append(terminal, jobID)
			valid++
			continue
		}
		if age >= activeJobTTL {
			stale = append(stale, jobID)
			continue
		}
		valid++
	}
	excess := valid - maxRetainedJobs
	for index := 0; excess > 0 && index < len(terminal); index++ {
		stale = append(stale, terminal[index])
		excess--
	}
	if len(stale) == 0 {
		return nil
	}
	pipeline := s.redis.Pipeline()
	for _, jobID := range stale {
		pipeline.Del(ctx, jobKey(jobID))
		pipeline.LRem(ctx, listKey, 1, jobID)
	}
	if _, err := pipeline.Exec(ctx); err != nil {
		return wrapRedis(err)
	}
	if len(stale) < len(jobIDs) {
		return nil
	}
	remaining, err := s.redis.LLen(ctx, listKey).Result()
	if err != nil {
		return wrapRedis(err)
	}
	if remaining == 0 {
		return wrapRedis(s.redis.SRem(ctx, orgsSetKey, orgID).Err())
	}
	return nil
}
