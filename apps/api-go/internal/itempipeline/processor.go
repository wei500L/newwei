package itempipeline

// Processor is the Go body of the QueueProcessor worker handler plus the
// 'failed' listener. The BullMQ state machine (worker.go) owns the retry/fail
// decision; this type only performs the business status writes, the TaskLog
// entries and the dead-letter enqueue.

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"time"

	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/wei500L/newwei/apps/api-go/internal/newspipeline"
)

// Pipeline is the news pipeline entry point (newspipeline.Service).
type Pipeline interface {
	Process(ctx context.Context, job newspipeline.Job, raw newspipeline.RawItem) (newspipeline.ProcessResult, error)
}

// Notifier is the org-wide system notification writer (news sources relay).
type Notifier interface {
	NotifySystem(ctx context.Context, orgID, title, body string, data json.RawMessage)
}

// ProcessorOptions wires the queue processor.
type ProcessorOptions struct {
	DB        *sql.DB
	Mongo     *mongo.Database
	Redis     *redis.Client
	Pipeline  Pipeline
	Snapshots SnapshotRefresher
	Notifier  Notifier
	// SourceFailure is the news source circuit/auto-disable configuration
	// (EnvService.newsSourceSchedulerConfig).
	SourceFailure SourceFailureConfig
	// SnapshotWindow is the O2 coalescing window for one news source. Zero
	// uses one second.
	SnapshotWindow time.Duration
	Now            func() time.Time
	Random         func() float64
}

// Processor is the itemPipeline job handler.
type Processor struct {
	db            *sql.DB
	mongo         *mongo.Database
	redis         *redis.Client
	pipeline      Pipeline
	snapshots     *snapshotCoalescer
	notifier      Notifier
	dlq           *dlqProducer
	sourceFailure SourceFailureConfig
	now           func() time.Time
	random        func() float64
	// releaseInflight removes the item's own in-flight dedupe registrations
	// when the job reaches its final failure. Nil when Redis is not configured.
	releaseInflight func(ctx context.Context, orgID, itemMetaID string)
}

// NewProcessor builds the processor. Redis is only required for the DLQ
// producer; the worker needs it anyway, so production wiring always provides it.
func NewProcessor(options ProcessorOptions) (*Processor, error) {
	if options.Pipeline == nil {
		return nil, errors.New("itempipeline: processor requires the news pipeline service")
	}
	now := options.Now
	if now == nil {
		now = time.Now
	}
	random := options.Random
	if random == nil {
		random = defaultRandom
	}
	processor := &Processor{
		db:            options.DB,
		mongo:         options.Mongo,
		redis:         options.Redis,
		pipeline:      options.Pipeline,
		notifier:      options.Notifier,
		sourceFailure: options.SourceFailure,
		now:           now,
		random:        random,
	}
	if options.Snapshots != nil {
		window := options.SnapshotWindow
		if window <= 0 {
			window = time.Second
		}
		processor.snapshots = newSnapshotCoalescer(options.Snapshots, window, now)
	}
	if options.Redis != nil {
		producer, err := newDLQProducer(options.Redis, DefaultPrefix)
		if err != nil {
			return nil, err
		}
		processor.dlq = producer
		redisClient := options.Redis
		processor.releaseInflight = func(ctx context.Context, orgID, itemMetaID string) {
			newspipeline.ReleaseInflightRegistrations(ctx, redisClient, orgID, itemMetaID)
		}
	}
	return processor, nil
}

// Handle is the QueueProcessor worker body:
//
//	validate -> processedItemId -> markProcessingState -> read RawItem ->
//	pipeline.process -> markSuccessState -> TaskLog complete
func (p *Processor) Handle(ctx context.Context, job Job) (json.RawMessage, error) {
	data := job.Payload
	rawItemID := data.RawItemID
	itemMetaID := data.ItemMetaID
	if rawItemID == "" || itemMetaID == "" {
		return nil, NewPermanentError("Queue job missing rawItemId or itemMetaId")
	}
	if data.OrgID == "" {
		return nil, NewPermanentError("Queue job missing orgId")
	}
	orgID := data.OrgID
	processedItemID := p.resolveProcessedItemID(ctx, data)

	p.markProcessingState(ctx, processingState{
		ItemMetaID:      itemMetaID,
		RawItemID:       rawItemID,
		OrgID:           orgID,
		ProcessedItemID: processedItemID,
		PipelineJobID:   data.PipelineJobID,
		SourceID:        data.SourceID,
	})

	rawItem, err := p.readRawItem(ctx, rawItemID)
	if err != nil {
		return nil, err
	}
	if rawItem == nil {
		p.writeTaskLog(ctx, taskLogEntry{
			Queue:   QueueName,
			JobID:   job.ID,
			OrgID:   orgID,
			Stage:   "dedupe",
			Status:  "failed",
			Message: stringPointer("Raw item not found"),
			Data:    job.Data,
		})
		return nil, NewPermanentError("Raw item not found")
	}
	rawItem.ItemMetaID = itemMetaID

	processed, err := p.pipeline.Process(ctx, newspipeline.Job{
		Queue:           QueueName,
		JobID:           job.ID,
		ItemMetaID:      itemMetaID,
		RawItemID:       rawItemID,
		OrgID:           orgID,
		ProcessedItemID: processedItemID,
		PipelineJobID:   data.PipelineJobID,
		SourceID:        data.SourceID,
	}, *rawItem)
	if err != nil {
		return nil, err
	}

	p.markSuccessState(ctx, successState{
		ItemMetaID:    itemMetaID,
		OrgID:         orgID,
		PipelineJobID: data.PipelineJobID,
		SourceID:      data.SourceID,
	})

	processedID := processed.ProcessedItemID
	if processedID == "" {
		processedID = rawItemID
	}
	completeData, err := json.Marshal(struct {
		ProcessedID string `json:"processedId"`
	}{ProcessedID: processedID})
	if err == nil {
		p.writeTaskLog(ctx, taskLogEntry{
			Queue:  QueueName,
			JobID:  job.ID,
			OrgID:  orgID,
			Stage:  "complete",
			Status: "completed",
			Data:   completeData,
		})
	}
	return processed.Document, nil
}

// HandleFailure is the QueueProcessor 'failed' listener: TaskLog, status
// writes, source failure accounting and the dead-letter enqueue.
func (p *Processor) HandleFailure(ctx context.Context, job Job, failure FailureInfo) {
	data := job.Payload
	classified := ClassifyQueueError(failure.Cause)
	orgID := data.OrgID
	if orgID == "" {
		orgID = "unknown"
	}
	rawItemID := data.RawItemID
	itemMetaID := data.ItemMetaID
	processedItemID := p.resolveProcessedItemID(ctx, data)

	attempts := job.Attempts()
	taskData, marshalErr := json.Marshal(struct {
		Attempts          int    `json:"attempts"`
		AttemptsMade      int    `json:"attemptsMade"`
		RemainingAttempts int    `json:"remainingAttempts"`
		ErrorKind         string `json:"errorKind"`
		Reason            string `json:"reason"`
	}{
		Attempts:          attempts,
		AttemptsMade:      failure.AttemptsMade,
		RemainingAttempts: failure.RemainingAttempts,
		ErrorKind:         string(classified.Kind),
		Reason:            classified.Reason,
	})
	if marshalErr != nil {
		taskData = nil
	}
	errorJSON, _ := json.Marshal(classified.Error)
	p.writeTaskLog(ctx, taskLogEntry{
		Queue:  QueueName,
		JobID:  job.ID,
		OrgID:  orgID,
		Stage:  "worker",
		Status: "failed",
		Data:   taskData,
		Error:  errorJSON,
	})

	shouldSendToDLQ := classified.Kind == ErrorKindPermanent || failure.RemainingAttempts == 0
	p.markFailureState(ctx, failureState{
		ItemMetaID:      itemMetaID,
		RawItemID:       rawItemID,
		OrgID:           orgID,
		ProcessedItemID: processedItemID,
		PipelineJobID:   data.PipelineJobID,
		SourceID:        data.SourceID,
		Error:           failure.Cause,
		AttemptsMade:    failure.AttemptsMade,
		FinalFailure:    shouldSendToDLQ,
	})
	if !shouldSendToDLQ {
		return
	}

	// Final failure: this item will never persist, so release its own in-flight
	// dedupe registration. Otherwise a later same-content item would be marked a
	// duplicate of an owner that produced nothing. Best effort only.
	if p.releaseInflight != nil {
		p.releaseInflight(ctx, orgID, itemMetaID)
	}

	originalJobID := job.ID
	var originalJobIDValue any
	if originalJobID != "" {
		originalJobIDValue = originalJobID
	}
	dlqData, err := mergeOrderedJSON(job.Data, []orderedField{
		{Key: "originalQueue", Value: QueueName},
		{Key: "originalJobId", Value: originalJobIDValue},
		{Key: "failedAt", Value: isoMillis(msTime(p.now()))},
		{Key: "attempts", Value: attempts},
		{Key: "attemptsMade", Value: failure.AttemptsMade},
		{Key: "errorKind", Value: string(classified.Kind)},
		{Key: "error", Value: classified.Error},
	})
	if err != nil {
		log.Printf("itempipeline: failed to build dlq payload jobId=%s: %v", job.ID, err)
		return
	}
	if p.dlq == nil {
		log.Printf("itempipeline: dlq producer is not configured; dropping dead letter jobId=%s", job.ID)
		return
	}
	dlqJobID, err := p.dlq.enqueue(ctx, job.ID, failure.AttemptsMade, dlqData)
	if err != nil {
		log.Printf("itempipeline: failed to enqueue job to DLQ jobId=%s: %v", job.ID, err)
		return
	}
	log.Printf("itempipeline: queue job enqueued to DLQ jobId=%s dlqJobId=%s errorKind=%s",
		job.ID, dlqJobID, classified.Kind)
}

// resolveProcessedItemID returns the ProcessedItem id this attempt must use.
// The queue data normally carries it. Legacy/replay jobs may omit it, and the id
// must stay identical across retries so a retry after a lost lease (persist
// succeeded but the acknowledgement was lost) cannot create a second
// ProcessedItem. It reuses the newest ProcessedItem of the item (the same stable
// lookup pipelineenqueue uses), falls back to the raw item id when that is a
// valid ObjectId (the legacy form), and finally mints a deterministic ObjectId
// from (orgId, itemMetaId). Handle and HandleFailure share this resolver, so a
// failure always targets the same document the successful attempt would have
// written.
func (p *Processor) resolveProcessedItemID(ctx context.Context, data Payload) string {
	if data.ProcessedItemID != "" {
		return data.ProcessedItemID
	}
	if p != nil && p.mongo != nil && data.OrgID != "" && data.ItemMetaID != "" {
		if id := p.latestProcessedItemID(ctx, data.OrgID, data.ItemMetaID); id != "" {
			return id
		}
	}
	if data.RawItemID != "" && isValidObjectID(data.RawItemID) {
		return data.RawItemID
	}
	return deterministicProcessedItemID(data.OrgID, data.ItemMetaID)
}

// latestProcessedItemID reads the newest ProcessedItem id for the item. A query
// failure is logged and treated as "none found" so the deterministic fallback
// still yields a stable id.
func (p *Processor) latestProcessedItemID(ctx context.Context, orgID, itemMetaID string) string {
	var row struct {
		ID bson.ObjectID `bson:"_id"`
	}
	err := p.mongo.Collection(processedItemsCollection).FindOne(ctx, bson.D{
		{Key: "orgId", Value: orgID},
		{Key: "itemMetaId", Value: itemMetaID},
	}, options.FindOne().
		SetProjection(bson.D{{Key: "_id", Value: 1}}).
		SetSort(bson.D{{Key: "createdAt", Value: -1}}),
	).Decode(&row)
	if err != nil {
		if !errors.Is(err, mongo.ErrNoDocuments) {
			log.Printf("itempipeline: failed to resolve existing processed item orgId=%s itemMetaId=%s: %v", orgID, itemMetaID, err)
		}
		return ""
	}
	if row.ID.IsZero() {
		return ""
	}
	return row.ID.Hex()
}

// deterministicProcessedItemID derives a stable ObjectId from (orgId, itemMetaId)
// so every attempt of a job without a stored processedItemId computes the same
// id. SHA-256 keeps collisions negligible; its first 12 bytes form the ObjectId.
func deterministicProcessedItemID(orgID, itemMetaID string) string {
	sum := sha256.Sum256([]byte(orgID + "\x00" + itemMetaID))
	var id bson.ObjectID
	copy(id[:], sum[:12])
	return id.Hex()
}

// readRawItem is RawItemModel.findById. A missing document returns (nil, nil);
// an invalid ObjectId returns the Mongoose CastError text (transient).
func (p *Processor) readRawItem(ctx context.Context, rawItemID string) (*newspipeline.RawItem, error) {
	objectID, ok := objectIDFromJSValue(rawItemID)
	if !ok {
		return nil, fmt.Errorf("Cast to ObjectId failed for value %q at path \"_id\"", rawItemID)
	}
	if p.mongo == nil {
		return nil, fmt.Errorf("itempipeline: mongo is not configured")
	}
	var row struct {
		ID      bson.ObjectID `bson:"_id"`
		Payload bson.Raw      `bson:"payload"`
		Source  *string       `bson:"source"`
	}
	err := p.mongo.Collection(rawItemsCollection).FindOne(ctx,
		bson.D{{Key: "_id", Value: objectID}},
		options.FindOne(),
	).Decode(&row)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("itempipeline: read raw item: %w", err)
	}
	payload, err := bson.MarshalExtJSON(row.Payload, false, false)
	if err != nil {
		return nil, fmt.Errorf("itempipeline: decode raw item payload: %w", err)
	}
	return &newspipeline.RawItem{
		ID:      row.ID.Hex(),
		Payload: json.RawMessage(payload),
		Source:  row.Source,
	}, nil
}

// refreshSnapshot coalesces the ops snapshot refresh per news source (O2).
func (p *Processor) refreshSnapshot(ctx context.Context, orgID string, sourceID *string) {
	if p == nil || p.snapshots == nil || sourceID == nil || *sourceID == "" {
		return
	}
	p.snapshots.request(orgID, *sourceID)
}

func stringPointer(value string) *string { return &value }

func defaultRandom() float64 {
	return randomFloat64()
}
