package pipelineenqueue

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/vmihailenco/msgpack/v5"
)

// EnqueueReplay adds one itemPipeline job with an explicit job id and the
// same job options a normal enqueue uses. It is the DLQ replay entry point.
//
// The caller is responsible for the payload: data must already be the original
// process-item document with the dead-letter envelope stripped (queueops does
// that check). Unlike EnqueueItem this path never resolves or upserts a
// ProcessedItem, because a replay must not create a second pending document for
// an item that already has one, and it never runs the retryIfFailed probe: the
// id is deterministic ("replay-" + the dead-letter job id), so a repeated replay
// is idempotent.
//
// A job id that already exists is not an error. BullMQ's add script returns the
// existing id and emits its "duplicated" event instead of a second "waiting"
// event; this method reports that as success and does not touch the
// organization counters again. The returned id is therefore the id the job
// actually has, which equals jobID on every non-error path.
func (p *Producer) EnqueueReplay(ctx context.Context, jobID string, data json.RawMessage, orgID string) (string, error) {
	if p == nil || p.redis == nil {
		return "", errors.New("pipelineenqueue: redis is not configured")
	}
	if jobID == "" || orgID == "" {
		return "", errors.New("pipelineenqueue: jobId and orgId are required")
	}
	if len(data) == 0 || !json.Valid(data) {
		return "", errors.New("pipelineenqueue: replay data is not a JSON document")
	}

	// The id is deterministic, so an existing hash means this replay (or one
	// retried after a failed cleanup) already added the job.
	exists, err := p.redis.Exists(ctx, QueuePrefixKey+jobID).Result()
	if err != nil {
		return "", err
	}

	jobOpts := jobOptions{
		JobID:            jobID,
		RemoveOnComplete: true,
		RemoveOnFail:     failedRetention{Age: 7 * 24 * 60 * 60, Count: 10_000},
		Attempts:         5,
		Backoff:          backoffOptions{Type: "exponential", Delay: 2000},
	}
	packedOpts, err := msgpack.Marshal(jobOpts)
	if err != nil {
		return "", err
	}

	// BullMQ Redis wire protocol: the add script unpacks a positional MessagePack
	// array. The parent, repeat and deduplication slots are null, exactly like
	// EnqueueItem.
	args := []any{
		QueuePrefixKey,
		jobID,
		"process-item",
		p.now().UnixMilli(),
		nil, // parentKey
		nil, // parentDependenciesKey
		nil, // parent
		nil, // repeatJobKey
		nil, // deduplicationKey
	}
	packedArgs, err := msgpack.Marshal(args)
	if err != nil {
		return "", err
	}

	result, err := p.redis.Eval(ctx, addStandardJobScript, standardJobKeys(), packedArgs,
		string(data), packedOpts).Result()
	if err != nil {
		return "", err
	}
	jobIDResult, err := jobIDFromEval(result)
	if err != nil {
		return "", err
	}
	if jobIDResult == "" {
		return "", fmt.Errorf("pipelineenqueue: replay returned an empty job id")
	}
	if exists == 0 {
		// Only a fresh add emitted the "waiting" event the counter follows.
		p.recordOrgJobCount(ctx, jobIDResult, orgID)
	}
	return jobIDResult, nil
}
