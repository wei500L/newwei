package analysisqueue

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

// Producer adds analysis jobs to the BullMQ `analysis` queue using the official
// standard-add script. The caller inserts the pending analysisresults document
// first; a failed enqueue is returned as an error so the GraphQL mutation fails
// instead of pretending the run was accepted. There is deliberately no
// cross-store outbox: a Mongo insert followed by a Redis failure can leave a
// pending row behind, which is the same boundary the NestJS submit path has.
type Producer struct {
	client     *redis.Client
	keys       keys
	scripts    queueScripts
	maxRetries int
}

// NewProducer builds a producer over the shared Redis client. The client stays
// owned by main; Close only exists for symmetry and does not close it.
func NewProducer(client *redis.Client, prefix string, maxRetries int) (*Producer, error) {
	if client == nil {
		return nil, fmt.Errorf("analysisqueue: producer requires a redis client")
	}
	scripts, err := loadQueueScripts()
	if err != nil {
		return nil, err
	}
	if maxRetries < 1 {
		maxRetries = 1
	}
	return &Producer{
		client:     client,
		keys:       newKeys(prefix, QueueName),
		scripts:    scripts,
		maxRetries: maxRetries,
	}, nil
}

// Add enqueues one analysis job and returns its BullMQ job id
// (`corr-<id>`, `anomaly-<id>` or `geo-transport-<id>`).
//
// removeOnComplete=true, attempts=ANALYSIS_MAX_RETRIES and the shared failed
// retention ({age:604800,count:10000}) reproduce the NestJS queue.add options.
// The source submit path has no backoff, so no backoff option is written.
func (p *Producer) Add(ctx context.Context, payload Payload) (string, error) {
	if p == nil || p.client == nil {
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
	opts := defaultRedisJobOptions(p.maxRetries)
	packedOpts, err := pack(opts)
	if err != nil {
		return "", err
	}
	packedArgs, err := pack([]any{
		p.keys.Base,
		jobID,
		payload.Type,
		time.Now().UnixMilli(),
		nil, // parentKey
		nil, // parent dependencies key
		nil, // parent data
		nil, // repeat job key
		nil, // deduplication key
	})
	if err != nil {
		return "", err
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
		return "", fmt.Errorf("analysisqueue: add job: %w", err)
	}
	if code := toInt64(result); code < 0 {
		return "", fmt.Errorf("analysisqueue: add job rejected with BullMQ code %d", code)
	}
	returned := toText(result)
	if returned == "" {
		return "", fmt.Errorf("analysisqueue: add job returned no job id")
	}
	return returned, nil
}
