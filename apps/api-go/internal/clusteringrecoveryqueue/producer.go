package clusteringrecoveryqueue

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/bullmq"
)

// Producer adds news-event clustering recovery jobs to the BullMQ queue through
// the shared bullmq.Queue. The caller claims the Mongo failure group first; a
// failed enqueue is returned as an error so the caller can release the claim
// instead of pretending the job was accepted.
type Producer struct {
	client *redis.Client
	queue  *bullmq.Queue
	keys   keys
}

// NewProducer builds a producer over the shared Redis client. The client stays
// owned by main; Close does not exist because the producer holds no lease.
func NewProducer(client *redis.Client, prefix string) (*Producer, error) {
	if client == nil {
		return nil, fmt.Errorf("clusteringrecoveryqueue: producer requires a redis client")
	}
	return &Producer{
		client: client,
		queue:  bullmq.NewQueue(client, prefix, QueueName),
		keys:   newKeys(prefix, QueueName),
	}, nil
}

// Add enqueues one LLM backfill job under the caller-provided BullMQ job id.
//
// removeOnComplete=true, attempts=1 and the shared failed retention
// ({age:604800,count:10000}) reproduce the NestJS queue.add options. The job data
// is JSON with the exact NestJS field names, so a NestJS worker can consume a
// Go-produced job and vice versa.
func (p *Producer) Add(ctx context.Context, jobID string, payload Payload) error {
	if p == nil || p.queue == nil {
		return fmt.Errorf("clusteringrecoveryqueue: producer is not configured")
	}
	if jobID == "" {
		return ErrInvalidJobID
	}
	if payload.JobType != JobTypeLlmBackfill {
		return ErrInvalidJobType
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("clusteringrecoveryqueue: encode job data: %w", err)
	}
	attempts := int64(1)
	age, count := int64(FailedRetentionAgeSeconds), int64(FailedRetentionCount)
	if _, err := p.queue.Add(ctx, payload.JobType, data, bullmq.JobOptions{
		JobID:            jobID,
		Attempts:         &attempts,
		RemoveOnComplete: true,
		RemoveOnFail:     bullmq.KeepJobs{Age: &age, Count: &count},
	}); err != nil {
		return fmt.Errorf("clusteringrecoveryqueue: add job: %w", err)
	}
	return nil
}

// JobIsActive reports whether the job id is currently in any BullMQ state that
// still owns the group: wait, active, delayed, prioritized, paused or
// waiting-children. It is the liveness probe of the stale-processing recovery
// rule: a group whose activeJobId is not in any of those states, and whose
// lastAttemptAt is older than the retry window, can no longer complete on its
// own.
//
// The probe is intentionally read-only and does not look at the job hash:
// BullMQ removes the hash of a completed job, so hash absence alone would also
// make the caller recover a group whose worker is between the completion script
// and the Mongo status write. The six state containers are the exact set BullMQ
// 5.63.2 uses for a non-flow job.
func (p *Producer) JobIsActive(ctx context.Context, jobID string) (bool, error) {
	if p == nil || p.client == nil {
		return false, fmt.Errorf("clusteringrecoveryqueue: producer is not configured")
	}
	if jobID == "" {
		return false, nil
	}
	for _, list := range []string{p.keys.Wait, p.keys.Active, p.keys.Paused} {
		if _, err := p.client.LPos(ctx, list, jobID, redis.LPosArgs{}).Result(); err == nil {
			return true, nil
		} else if !errors.Is(err, redis.Nil) {
			return false, fmt.Errorf("clusteringrecoveryqueue: probe %s: %w", list, err)
		}
	}
	for _, sorted := range []string{p.keys.Prioritized, p.keys.Delayed, p.keys.WaitingChildren} {
		if _, err := p.client.ZScore(ctx, sorted, jobID).Result(); err == nil {
			return true, nil
		} else if !errors.Is(err, redis.Nil) {
			return false, fmt.Errorf("clusteringrecoveryqueue: probe %s: %w", sorted, err)
		}
	}
	return false, nil
}
