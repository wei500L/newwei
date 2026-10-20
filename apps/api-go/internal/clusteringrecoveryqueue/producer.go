package clusteringrecoveryqueue

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

// Producer adds news-event clustering recovery jobs to the BullMQ queue using
// the official standard-add script. The caller claims the Mongo failure group
// first; a failed enqueue is returned as an error so the caller can release
// the claim instead of pretending the job was accepted.
type Producer struct {
	client  *redis.Client
	keys    keys
	scripts queueScripts
}

// NewProducer builds a producer over the shared Redis client. The client stays
// owned by main; Close does not exist because the producer holds no lease.
func NewProducer(client *redis.Client, prefix string) (*Producer, error) {
	if client == nil {
		return nil, fmt.Errorf("clusteringrecoveryqueue: producer requires a redis client")
	}
	scripts, err := loadQueueScripts()
	if err != nil {
		return nil, err
	}
	return &Producer{
		client:  client,
		keys:    newKeys(prefix, QueueName),
		scripts: scripts,
	}, nil
}

// Add enqueues one LLM backfill job under the caller-provided BullMQ job id.
//
// removeOnComplete=true, attempts=1 and the shared failed retention
// ({age:604800,count:10000}) reproduce the NestJS queue.add options. The
// job data is JSON with the exact NestJS field names, so a NestJS worker can
// consume a Go-produced job and vice versa.
func (p *Producer) Add(ctx context.Context, jobID string, payload Payload) error {
	if p == nil || p.client == nil {
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
	packedOpts, err := pack(defaultRedisJobOptions())
	if err != nil {
		return err
	}
	packedArgs, err := pack([]any{
		p.keys.Base,
		jobID,
		payload.JobType,
		time.Now().UnixMilli(),
		nil, // parentKey
		nil, // parent dependencies key
		nil, // parent data
		nil, // repeat job key
		nil, // deduplication key
	})
	if err != nil {
		return err
	}

	result, err := p.scripts.addStandardJob.Run(ctx, p.client,
		[]string{
			p.keys.Wait,
			p.keys.Paused,
			p.keys.Meta,
			p.keys.ID,
			p.keys.Completed,
			p.keys.Delayed,
			p.keys.Active,
			p.keys.Events,
			p.keys.Marker,
		},
		packedArgs,
		string(data),
		packedOpts,
	).Result()
	if err != nil {
		return fmt.Errorf("clusteringrecoveryqueue: add job: %w", err)
	}
	if code := toInt64(result); code < 0 {
		return fmt.Errorf("clusteringrecoveryqueue: add job rejected with BullMQ code %d", code)
	}
	if returned := toText(result); returned == "" {
		return fmt.Errorf("clusteringrecoveryqueue: add job returned no job id")
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
// make the caller recover a group whose worker is between the completion
// script and the Mongo status write. The six state containers are the exact
// set BullMQ 5.63.2 uses for a non-flow job.
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
