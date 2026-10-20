package pipelineenqueue

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/vmihailenco/msgpack/v5"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// priorityLimit is BullMQ's Job.PRIORITY_LIMIT. Higher values make Queue.add
// throw exactly as NestJS does; lower values are passed through unchanged.
const priorityLimit = 2 * 1024 * 1024

// failedRetention is BULLMQ_FAILED_JOB_RETENTION: seven days or ten thousand
// failed jobs.
type failedRetention struct {
	Age   int64 `msgpack:"age"`
	Count int64 `msgpack:"count"`
}

// backoffOptions is the exponential retry policy used by queue.service.ts.
type backoffOptions struct {
	Type  string `msgpack:"type"`
	Delay int64  `msgpack:"delay"`
}

// jobOptions is the strongly typed subset of BullMQ JobsOptions this chain
// declares. MessagePack encodes it as a map, exactly like msgpackr packs the
// plain object NestJS passes to Queue.add.
type jobOptions struct {
	JobID            string          `msgpack:"jobId"`
	RemoveOnComplete bool            `msgpack:"removeOnComplete"`
	RemoveOnFail     failedRetention `msgpack:"removeOnFail"`
	Attempts         int64           `msgpack:"attempts"`
	Backoff          backoffOptions  `msgpack:"backoff"`
	Priority         *int64          `msgpack:"priority,omitempty"`
}

// jobData is the process-item payload. Field order matches the NestJS object
// literal; optional metadata is omitted when absent.
type jobData struct {
	ItemMetaID      string  `json:"itemMetaId"`
	RawItemID       string  `json:"rawItemId"`
	OrgID           string  `json:"orgId"`
	TraceID         string  `json:"traceId"`
	ProcessedItemID string  `json:"processedItemId"`
	PipelineJobID   *string `json:"pipelineJobId,omitempty"`
	SourceID        *string `json:"sourceId,omitempty"`
}

// EnqueueOptions mirrors the optional arguments of QueueService.enqueueItem.
type EnqueueOptions struct {
	// Priority is the BullMQ job priority. nil means the standard add script.
	Priority *int64
	// TraceID is the request trace. Empty mints a fresh id like ensureTraceId.
	TraceID string
	// PipelineJobID and SourceID are optional pipeline metadata.
	PipelineJobID *string
	SourceID      *string
	// ProcessedItemID overrides the stable id lookup (tests and replay paths).
	ProcessedItemID string
}

// Options wires the producer to the shared Redis client and Mongo database.
// Mongo may be nil in Redis-only tests; the Redis job protocol still runs.
type Options struct {
	Redis *redis.Client
	Mongo *mongo.Database
	Now   func() time.Time
}

// Producer writes the itemPipeline job protocol.
type Producer struct {
	redis *redis.Client
	mongo *mongo.Database
	now   func() time.Time
}

// New builds the producer.
func New(opts Options) *Producer {
	now := opts.Now
	if now == nil {
		now = time.Now
	}
	return &Producer{redis: opts.Redis, mongo: opts.Mongo, now: now}
}

// EnqueueItem ports QueueService.enqueueItem for the two supported job
// branches. It returns the BullMQ job id. A duplicate job is not an error: the
// official script returns the existing id and emits its "duplicated" event.
func (p *Producer) EnqueueItem(
	ctx context.Context,
	orgID, itemMetaID, rawItemID string,
	opts EnqueueOptions,
) (string, error) {
	if p == nil || p.redis == nil {
		return "", errors.New("pipelineenqueue: redis is not configured")
	}
	if orgID == "" || itemMetaID == "" || rawItemID == "" {
		return "", errors.New("pipelineenqueue: orgId, itemMetaId and rawItemId are required")
	}
	if opts.Priority != nil && *opts.Priority > priorityLimit {
		return "", fmt.Errorf("Priority should be between 0 and %d", priorityLimit)
	}

	jobID := itemMetaID + "-" + rawItemID
	traceID := opts.TraceID
	if traceID == "" {
		traceID = newTraceID()
	}
	processedItemID := opts.ProcessedItemID
	if processedItemID == "" {
		processedItemID = p.resolveStableProcessedItemID(ctx, orgID, itemMetaID)
	}

	data, err := json.Marshal(jobData{
		ItemMetaID:      itemMetaID,
		RawItemID:       rawItemID,
		OrgID:           orgID,
		TraceID:         traceID,
		ProcessedItemID: processedItemID,
		PipelineJobID:   opts.PipelineJobID,
		SourceID:        opts.SourceID,
	})
	if err != nil {
		return "", err
	}

	jobOpts := jobOptions{
		JobID:            jobID,
		RemoveOnComplete: true,
		RemoveOnFail:     failedRetention{Age: 7 * 24 * 60 * 60, Count: 10_000},
		Attempts:         5,
		Backoff:          backoffOptions{Type: "exponential", Delay: 2000},
		Priority:         opts.Priority,
	}
	packedOpts, err := msgpack.Marshal(jobOpts)
	if err != nil {
		return "", err
	}

	// This is the BullMQ Redis wire protocol, not business data: the Lua
	// script unpacks a positional MessagePack array. Null entries are the
	// unused parent/repeat/deduplication slots (BullMQ passes null).
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

	keys, script := standardJobKeys(), addStandardJobScript
	if opts.Priority != nil && *opts.Priority != 0 {
		keys, script = prioritizedJobKeys(), addPrioritizedJobScript
	}
	result, err := p.redis.Eval(ctx, script, keys, packedArgs, string(data), packedOpts).Result()
	if err != nil {
		return "", err
	}
	jobIDResult, err := jobIDFromEval(result)
	if err != nil {
		return "", err
	}
	p.upsertPendingProcessedItem(ctx, orgID, itemMetaID, rawItemID, processedItemID, traceID, opts.PipelineJobID, opts.SourceID)
	// The initial status is waiting because this chain never sets a delay.
	p.recordOrgJobCount(ctx, jobID, orgID)
	return jobIDResult, nil
}

// jobIDFromEval normalizes the Lua result into the string job id.
func jobIDFromEval(result any) (string, error) {
	switch value := result.(type) {
	case string:
		return value, nil
	case int64:
		if value < 0 {
			return "", fmt.Errorf("bullmq add job failed with code %d", value)
		}
		return fmt.Sprintf("%d", value), nil
	default:
		return fmt.Sprintf("%v", value), nil
	}
}

func standardJobKeys() []string {
	return []string{
		QueuePrefixKey + "wait",
		QueuePrefixKey + "paused",
		QueuePrefixKey + "meta",
		QueuePrefixKey + "id",
		QueuePrefixKey + "completed",
		QueuePrefixKey + "delayed",
		QueuePrefixKey + "active",
		QueuePrefixKey + "events",
		QueuePrefixKey + "marker",
	}
}

func prioritizedJobKeys() []string {
	return []string{
		QueuePrefixKey + "marker",
		QueuePrefixKey + "meta",
		QueuePrefixKey + "id",
		QueuePrefixKey + "prioritized",
		QueuePrefixKey + "delayed",
		QueuePrefixKey + "completed",
		QueuePrefixKey + "active",
		QueuePrefixKey + "events",
		QueuePrefixKey + "pc",
	}
}

// resolveStableProcessedItemID reuses the newest ProcessedItem of the item, so
// a re-enqueue does not insert a second pending document that hides an older
// completed result. A query failure falls back to a fresh ObjectId, matching
// the NestJS warn-and-mint branch.
func (p *Producer) resolveStableProcessedItemID(ctx context.Context, orgID, itemMetaID string) string {
	if p.mongo == nil {
		return bson.NewObjectID().Hex()
	}
	collection := p.mongo.Collection("processeditems")
	var row struct {
		ID bson.ObjectID `bson:"_id"`
	}
	err := collection.FindOne(ctx, bson.D{
		{Key: "orgId", Value: orgID},
		{Key: "itemMetaId", Value: itemMetaID},
	}, options.FindOne().
		SetProjection(bson.D{{Key: "_id", Value: 1}}).
		SetSort(bson.D{{Key: "createdAt", Value: -1}}),
	).Decode(&row)
	if err != nil {
		if !errors.Is(err, mongo.ErrNoDocuments) {
			log.Printf("pipelineenqueue: failed to resolve existing processed item orgId=%s itemMetaId=%s: %v", orgID, itemMetaID, err)
		}
		return bson.NewObjectID().Hex()
	}
	if row.ID.IsZero() {
		return bson.NewObjectID().Hex()
	}
	return row.ID.Hex()
}

// upsertPendingProcessedItem is the best-effort post-add write. An existing
// document keeps its status/result and only gets the trace and optional
// links refreshed, exactly like the NestJS $set/$setOnInsert pair.
func (p *Producer) upsertPendingProcessedItem(
	ctx context.Context,
	orgID, itemMetaID, rawItemID, processedItemID, traceID string,
	pipelineJobID, sourceID *string,
) {
	if p.mongo == nil {
		return
	}
	processedOID, err := bson.ObjectIDFromHex(processedItemID)
	if err != nil {
		return
	}
	rawOID, err := bson.ObjectIDFromHex(rawItemID)
	if err != nil {
		return
	}
	now := p.now().UTC().Truncate(time.Millisecond)
	_, err = p.mongo.Collection("processeditems").UpdateOne(
		ctx,
		bson.D{{Key: "_id", Value: processedOID}},
		bson.D{
			{Key: "$set", Value: bson.D{
				{Key: "traceId", Value: traceID},
				{Key: "pipelineJobId", Value: pipelineJobID},
				{Key: "sourceId", Value: sourceID},
				{Key: "updatedAt", Value: now},
			}},
			{Key: "$setOnInsert", Value: bson.D{
				{Key: "rawItemId", Value: rawOID},
				{Key: "itemMetaId", Value: itemMetaID},
				{Key: "orgId", Value: orgID},
				{Key: "status", Value: "pending"},
				{Key: "tags", Value: bson.A{}},
				{Key: "createdAt", Value: now},
			}},
		},
		options.UpdateOne().SetUpsert(true),
	)
	if err != nil {
		log.Printf("pipelineenqueue: failed to upsert pending processed item orgId=%s itemMetaId=%s: %v", orgID, itemMetaID, err)
	}
}

// newTraceID returns a canonical UUID v4, the same shape ensureTraceId mints.
func newTraceID() string {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return bson.NewObjectID().Hex()
	}
	buf[6] = (buf[6] & 0x0f) | 0x40
	buf[8] = (buf[8] & 0x3f) | 0x80
	hexed := hex.EncodeToString(buf[:])
	return hexed[0:8] + "-" + hexed[8:12] + "-" + hexed[12:16] + "-" + hexed[16:20] + "-" + hexed[20:32]
}
