package itempipeline

// Dead-letter queue writes. QueueProcessor's 'failed' listener enqueues the
// original job data plus the failure context into itemPipelineDlq with
//
//	jobId: `dlq-itemPipeline-${job.id}-${attemptsMade}`
//	options: removeOnComplete/removeOnFail = BULLMQ_DLQ_JOB_RETENTION,
//	         attempts 1
//
// The job is a normal BullMQ job (same official addStandardJob script as the
// producer), so any consumer sees the same hash/event semantics.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/bullmq"
)

// orderedField is one member appended to the spread DLQ payload.
type orderedField struct {
	Key   string
	Value any
}

// mergeOrderedJSON spreads base (a JSON object) and appends fields in order,
// reproducing `{...data, originalQueue: ..., ...}`. Later keys overwrite
// earlier ones and keep their first position, exactly like object spread.
func mergeOrderedJSON(base json.RawMessage, fields []orderedField) (json.RawMessage, error) {
	trimmed := bytes.TrimSpace(base)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		trimmed = []byte("{}")
	}
	if trimmed[0] != '{' || trimmed[len(trimmed)-1] != '}' {
		return nil, fmt.Errorf("itempipeline: job data is not a JSON object")
	}
	type member struct {
		key     string
		encoded []byte
	}
	members := make([]member, 0, 8)
	body := bytes.TrimSpace(trimmed[1 : len(trimmed)-1])
	if len(body) > 0 {
		decoder := json.NewDecoder(bytes.NewReader(append(append([]byte("{"), body...), '}')))
		token, err := decoder.Token()
		if err != nil {
			return nil, err
		}
		if delim, ok := token.(json.Delim); !ok || delim != '{' {
			return nil, fmt.Errorf("itempipeline: job data is not a JSON object")
		}
		for decoder.More() {
			keyToken, err := decoder.Token()
			if err != nil {
				return nil, err
			}
			key, ok := keyToken.(string)
			if !ok {
				return nil, fmt.Errorf("itempipeline: job data key is not a string")
			}
			var raw json.RawMessage
			if err := decoder.Decode(&raw); err != nil {
				return nil, err
			}
			members = append(members, member{key: key, encoded: raw})
		}
	}
	for _, field := range fields {
		encoded, err := json.Marshal(field.Value)
		if err != nil {
			return nil, err
		}
		replaced := false
		for index := range members {
			if members[index].key == field.Key {
				members[index].encoded = encoded
				replaced = true
				break
			}
		}
		if !replaced {
			members = append(members, member{key: field.Key, encoded: encoded})
		}
	}
	var buffer bytes.Buffer
	buffer.WriteByte('{')
	for index, entry := range members {
		if index > 0 {
			buffer.WriteByte(',')
		}
		encodedKey, err := json.Marshal(entry.key)
		if err != nil {
			return nil, err
		}
		buffer.Write(encodedKey)
		buffer.WriteByte(':')
		buffer.Write(entry.encoded)
	}
	buffer.WriteByte('}')
	return buffer.Bytes(), nil
}

// dlqProducer adds jobs to itemPipelineDlq through the shared BullMQ Queue. It
// owns no worker; the DLQ is drained by whatever the deployment configures.
type dlqProducer struct {
	queue *bullmq.Queue
	keys  keys
}

func newDLQProducer(client *redis.Client, prefix string) (*dlqProducer, error) {
	if client == nil {
		return nil, fmt.Errorf("itempipeline: dlq producer requires a redis client")
	}
	if prefix == "" {
		prefix = DefaultPrefix
	}
	return &dlqProducer{
		queue: bullmq.NewQueue(client, prefix, DLQQueueName),
		keys:  newKeys(prefix, DLQQueueName),
	}, nil
}

// enqueue adds the dead-letter job and returns the BullMQ job id.
func (d *dlqProducer) enqueue(ctx context.Context, originalJobID string, attemptsMade int, data json.RawMessage) (string, error) {
	jobID := fmt.Sprintf("dlq-%s-%s-%d", QueueName, originalJobID, attemptsMade)
	age := int64(DLQRetentionAgeSeconds)
	count := int64(DLQRetentionCount)
	attempts := int64(1)
	return d.queue.Add(ctx, "dlq", data, bullmq.JobOptions{
		JobID:            jobID,
		RemoveOnComplete: bullmq.KeepJobs{Age: &age, Count: &count},
		RemoveOnFail:     bullmq.KeepJobs{Age: &age, Count: &count},
		Attempts:         &attempts,
	})
}
