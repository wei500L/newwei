package pipelineenqueue

import (
	"context"
	"errors"

	"github.com/redis/go-redis/v9"
)

// This file ports the retryIfFailed behaviour QueueService.enqueueItem relies
// on when the item pipeline job already exists in BullMQ.
//
// NestJS calls queue.add() with the deterministic job id
// `{itemMetaId}-{rawItemId}`; BullMQ's client checks the job hash first and
// throws "Job … already exists" instead of adding a second entry. enqueueItem
// catches that error, re-reads the job and, when the retained job is failed and
// retryIfFailed is set, calls job.retry(). Our producer writes the BullMQ
// protocol directly, so the caller decides using the three probes below:
//
//   - FailedJobExists: the id is retained in the failed set (state "failed").
//   - JobExists: any job hash with that id is alive (waiting/active/delayed/…).
//   - RemoveFailedJob: drop the retained failed job so EnqueueItem can add the
//     identical deterministic id again.
//
// Removing the failed entry and re-adding through EnqueueItem has the same
// observable result as job.retry(): the same job id, the same data, the same
// priority family (wait list versus prioritized set is decided by the same
// priority argument), attemptsMade reset to zero, one waiting entry and one
// "waiting" event. It does not emit the separate "removed" event BullMQ emits
// for a manual removal; no consumer of that event is part of this migration.

// JobExists reports whether any job hash still exists for the deterministic id.
func (p *Producer) JobExists(ctx context.Context, jobID string) (bool, error) {
	if p == nil || p.redis == nil {
		return false, errors.New("pipelineenqueue: redis is not configured")
	}
	exists, err := p.redis.Exists(ctx, QueuePrefixKey+jobID).Result()
	if err != nil {
		return false, err
	}
	return exists > 0, nil
}

// FailedJobExists reports whether the id is still retained in the failed set.
func (p *Producer) FailedJobExists(ctx context.Context, jobID string) (bool, error) {
	if p == nil || p.redis == nil {
		return false, errors.New("pipelineenqueue: redis is not configured")
	}
	_, err := p.redis.ZScore(ctx, QueuePrefixKey+"failed", jobID).Result()
	if errors.Is(err, redis.Nil) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// RemoveFailedJob removes the retained failed job (failed set entry and job
// hash). It returns true when a failed entry was removed, so the caller can
// safely re-add the same deterministic id.
func (p *Producer) RemoveFailedJob(ctx context.Context, jobID string) (bool, error) {
	if p == nil || p.redis == nil {
		return false, errors.New("pipelineenqueue: redis is not configured")
	}
	removed, err := p.redis.ZRem(ctx, QueuePrefixKey+"failed", jobID).Result()
	if err != nil {
		return false, err
	}
	if _, err := p.redis.Del(ctx, QueuePrefixKey+jobID).Result(); err != nil {
		return removed > 0, err
	}
	return removed > 0, nil
}
