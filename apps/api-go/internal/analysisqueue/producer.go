package analysisqueue

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/bullmq"
)

// Producer adds analysis jobs to the BullMQ `analysis` queue through the shared
// bullmq.Queue. The caller inserts the pending analysisresults document first; a
// failed enqueue is returned as an error so the GraphQL mutation fails instead of
// pretending the run was accepted. There is deliberately no cross-store outbox: a
// Mongo insert followed by a Redis failure can leave a pending row behind, which
// is the same boundary the NestJS submit path has.
type Producer struct {
	queue      *bullmq.Queue
	maxRetries int
}

// NewProducer builds a producer over the shared Redis client. The client stays
// owned by main; Close only exists for symmetry and does not close it.
func NewProducer(client *redis.Client, prefix string, maxRetries int) (*Producer, error) {
	if client == nil {
		return nil, fmt.Errorf("analysisqueue: producer requires a redis client")
	}
	if maxRetries < 1 {
		maxRetries = 1
	}
	return &Producer{queue: bullmq.NewQueue(client, prefix, QueueName), maxRetries: maxRetries}, nil
}

// Add enqueues one analysis job and returns its BullMQ job id
// (`corr-<id>`, `anomaly-<id>` or `geo-transport-<id>`).
//
// removeOnComplete=true, attempts=ANALYSIS_MAX_RETRIES and the shared failed
// retention ({age:604800,count:10000}) reproduce the NestJS queue.add options.
// The source submit path has no backoff, so no backoff option is written.
func (p *Producer) Add(ctx context.Context, payload Payload) (string, error) {
	if p == nil || p.queue == nil {
		return "", fmt.Errorf("analysisqueue: producer is not configured")
	}
	if payload.AnalysisID == "" {
		return "", ErrInvalidJobID
	}
	idPrefix, err := JobIDPrefix(payload.Type)
	if err != nil {
		return "", err
	}
	jobID := idPrefix + payload.AnalysisID

	data, err := json.Marshal(payload)
	if err != nil {
		return "", fmt.Errorf("analysisqueue: encode job data: %w", err)
	}
	attempts := int64(p.maxRetries)
	age, count := int64(FailedRetentionAgeSeconds), int64(FailedRetentionCount)
	jobIDResult, err := p.queue.Add(ctx, payload.Type, data, bullmq.JobOptions{
		JobID:            jobID,
		Attempts:         &attempts,
		RemoveOnComplete: true,
		RemoveOnFail:     bullmq.KeepJobs{Age: &age, Count: &count},
	})
	if err != nil {
		return "", fmt.Errorf("analysisqueue: add job: %w", err)
	}
	if jobIDResult == "" {
		return "", fmt.Errorf("analysisqueue: add job returned no job id")
	}
	return jobIDResult, nil
}
