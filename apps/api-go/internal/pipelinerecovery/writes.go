package pipelinerecovery

import (
	"context"
	"database/sql"
	"errors"
	"strings"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/wei500L/newwei/apps/api-go/internal/httpx"
	"github.com/wei500L/newwei/apps/api-go/internal/itemsingest"
	"github.com/wei500L/newwei/apps/api-go/internal/pipelineenqueue"
)

const (
	// rawItemsCollection is the Mongoose default collection name of RawItem.
	rawItemsCollection = "rawitems"
	// itemStatusPending is ItemStatus.Pending (apps/api/src/common/pipeline-status.ts).
	itemStatusPending = "pending"
	// itemStatusDuplicate is ItemStatus.Duplicate.
	itemStatusDuplicate = "duplicate"
)

// ReplayResult is the POST /api/admin/quality/pipeline/replay body.
type ReplayResult struct {
	ItemMetaID string `json:"itemMetaId"`
	RawItemID  string `json:"rawItemId"`
	QueueJobID string `json:"queueJobId,omitempty"`
}

// RollbackResult is the POST /api/admin/quality/pipeline/rollback body.
type RollbackResult struct {
	ItemMetaID      string `json:"itemMetaId"`
	RawItemID       string `json:"rawItemId"`
	ProcessedItemID string `json:"processedItemId"`
	QueueJobID      string `json:"queueJobId,omitempty"`
}

// storedRawItem is the RawItem projection the clone needs. Payload is kept as
// the raw sub-document so the clone stores exactly the source payload.
type storedRawItem struct {
	ItemMetaID bson.RawValue `bson:"itemMetaId"`
	Payload    bson.RawValue `bson:"payload"`
}

// Replay mirrors PipelineRecoveryService.replay:
//
//   - the ItemMeta must belong to the caller's organization (404 otherwise);
//   - a duplicate item is rejected (400 "Cannot replay duplicate item");
//   - rawItemId defaults to itemMeta.mongoRef and must pass
//     Types.ObjectId.isValid (400 "Invalid rawItemId");
//   - the RawItem must exist (404 "Raw item not found") and belong to this item
//     (400 "rawItemId does not belong to item");
//   - a new RawItem is cloned with source "replay";
//   - ItemMeta.mongoRef moves to the clone and its status becomes pending;
//   - the item is re-enqueued and the clone id plus job id are returned.
//
// The order is intentionally identical to NestJS. If the enqueue fails, the
// ItemMeta has already moved to the clone; the raw_item outbox (#96) only
// replays its own MongoOutbox rows, so it does not repair that state (Q1).
func (s *Service) Replay(ctx context.Context, orgID, itemMetaID, rawItemID string) (ReplayResult, error) {
	itemMeta, err := s.itemMetaForWrite(ctx, orgID, itemMetaID)
	if err != nil {
		return ReplayResult{}, err
	}
	if itemMeta.Status == itemStatusDuplicate {
		return ReplayResult{}, newStatus(400, "Cannot replay duplicate item")
	}
	sourceRawID := itemMeta.MongoRef
	if trimmed := strings.TrimSpace(rawItemID); trimmed != "" {
		sourceRawID = trimmed
	}
	sourceOID, ok := parseObjectID(sourceRawID)
	if !ok {
		return ReplayResult{}, newStatus(400, "Invalid rawItemId")
	}
	raw, err := s.findRawItem(ctx, sourceOID)
	if err != nil {
		return ReplayResult{}, err
	}
	if !rawBelongsTo(raw, itemMetaID) {
		return ReplayResult{}, newStatus(400, "rawItemId does not belong to item")
	}

	clonedID := bson.NewObjectID()
	if err := s.insertClonedRawItem(ctx, clonedID, itemMetaID, raw); err != nil {
		return ReplayResult{}, err
	}

	if _, err := s.db.ExecContext(ctx,
		"UPDATE ItemMeta SET mongoRef = ?, status = ?, updatedAt = ? WHERE id = ?",
		clonedID.Hex(), itemStatusPending, nowMillis(), itemMetaID); err != nil {
		return ReplayResult{}, err
	}

	jobID, err := s.enqueueItem(ctx, orgID, itemMetaID, clonedID.Hex(), "")
	if err != nil {
		return ReplayResult{}, err
	}
	return ReplayResult{ItemMetaID: itemMetaID, RawItemID: clonedID.Hex(), QueueJobID: jobID}, nil
}

// Rollback mirrors PipelineRecoveryService.rollback:
//
//   - the same ItemMeta lookup, duplicate check and rawItemId validation;
//   - ItemMeta.status becomes pending without changing mongoRef;
//   - a new ProcessedItem is upserted with status pending, tags [] and a
//     createdAt timestamp;
//   - the item is re-enqueued with that processed item id.
func (s *Service) Rollback(ctx context.Context, orgID, itemMetaID, rawItemID string) (RollbackResult, error) {
	itemMeta, err := s.itemMetaForWrite(ctx, orgID, itemMetaID)
	if err != nil {
		return RollbackResult{}, err
	}
	if itemMeta.Status == itemStatusDuplicate {
		return RollbackResult{}, newStatus(400, "Cannot rollback duplicate item")
	}
	sourceRawID := itemMeta.MongoRef
	if trimmed := strings.TrimSpace(rawItemID); trimmed != "" {
		sourceRawID = trimmed
	}
	sourceOID, ok := parseObjectID(sourceRawID)
	if !ok {
		return RollbackResult{}, newStatus(400, "Invalid rawItemId")
	}
	raw, err := s.findRawItem(ctx, sourceOID)
	if err != nil {
		return RollbackResult{}, err
	}
	if !rawBelongsTo(raw, itemMetaID) {
		return RollbackResult{}, newStatus(400, "rawItemId does not belong to item")
	}

	if _, err := s.db.ExecContext(ctx,
		"UPDATE ItemMeta SET status = ?, updatedAt = ? WHERE id = ?",
		itemStatusPending, nowMillis(), itemMetaID); err != nil {
		return RollbackResult{}, err
	}

	processedID := bson.NewObjectID()
	now := nowMillis()
	update := bson.D{
		{Key: "$set", Value: bson.D{
			{Key: "rawItemId", Value: sourceOID},
			{Key: "itemMetaId", Value: itemMetaID},
			{Key: "orgId", Value: orgID},
			{Key: "status", Value: itemStatusPending},
			{Key: "updatedAt", Value: now},
		}},
		{Key: "$setOnInsert", Value: bson.D{
			{Key: "_id", Value: processedID},
			{Key: "createdAt", Value: now},
			{Key: "tags", Value: bson.A{}},
			// Mongoose applies setDefaultsOnInsert (true by default) to every
			// schema path whose default is not undefined. These are the
			// ProcessedItem defaults, so the upserted document matches the one
			// Mongoose inserts for the same update.
			{Key: "traceId", Value: nil},
			{Key: "pipelineJobId", Value: nil},
			{Key: "sourceId", Value: nil},
			{Key: "hasLocation", Value: false},
			{Key: "summaryEmbeddingModel", Value: nil},
			{Key: "summaryEmbeddingDimensions", Value: nil},
			{Key: "duplicateOf", Value: nil},
			{Key: "duplicateSimilarity", Value: nil},
			{Key: "result", Value: processedItemResultDefaults()},
		}},
	}
	collection := s.processedItems()
	if collection == nil {
		return RollbackResult{}, errors.New("pipelinerecovery: mongo is not configured")
	}
	if _, err := collection.UpdateOne(ctx,
		bson.D{{Key: "_id", Value: processedID}},
		update,
		options.UpdateOne().SetUpsert(true)); err != nil {
		return RollbackResult{}, err
	}

	jobID, err := s.enqueueItem(ctx, orgID, itemMetaID, sourceRawID, processedID.Hex())
	if err != nil {
		return RollbackResult{}, err
	}
	return RollbackResult{
		ItemMetaID:      itemMetaID,
		RawItemID:       sourceRawID,
		ProcessedItemID: processedID.Hex(),
		QueueJobID:      jobID,
	}, nil
}

// itemMetaForWrite is the org-scoped ItemMeta lookup both writes start with.
func (s *Service) itemMetaForWrite(ctx context.Context, orgID, itemMetaID string) (itemMetaRow, error) {
	if s == nil || s.db == nil {
		return itemMetaRow{}, errors.New("pipelinerecovery: mysql is not configured")
	}
	if s.mongo == nil {
		return itemMetaRow{}, errors.New("pipelinerecovery: mongo is not configured")
	}
	var itemMeta itemMetaRow
	err := s.db.QueryRowContext(ctx,
		"SELECT id, status, mongoRef FROM ItemMeta WHERE id = ? AND orgId = ? LIMIT 1",
		itemMetaID, orgID).Scan(&itemMeta.ID, &itemMeta.Status, &itemMeta.MongoRef)
	if errors.Is(err, sql.ErrNoRows) {
		return itemMetaRow{}, newStatus(404, "Item not found")
	}
	if err != nil {
		return itemMetaRow{}, err
	}
	return itemMeta, nil
}

// findRawItem mirrors RawItemModel.findById(id).lean() and the "Raw item not
// found" 404.
func (s *Service) findRawItem(ctx context.Context, id bson.ObjectID) (storedRawItem, error) {
	collection := s.rawItems()
	if collection == nil {
		return storedRawItem{}, errors.New("pipelinerecovery: mongo is not configured")
	}
	var raw storedRawItem
	err := collection.FindOne(ctx, bson.D{{Key: "_id", Value: id}}).Decode(&raw)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return storedRawItem{}, newStatus(404, "Raw item not found")
	}
	if err != nil {
		return storedRawItem{}, err
	}
	return raw, nil
}

// rawBelongsTo mirrors `raw.itemMetaId !== itemMetaId`: undefined never equals
// the requested id.
func rawBelongsTo(raw storedRawItem, itemMetaID string) bool {
	stored, ok := raw.ItemMetaID.StringValueOK()
	return ok && stored == itemMetaID
}

// insertClonedRawItem mirrors RawItemModel.create({itemMetaId, payload, source:
// "replay"}): the client-side _id, the payload copy, the pre-validate URL
// columns and both timestamps. RawItem has no orgId column, so tenant scope is
// carried by itemMetaId only.
func (s *Service) insertClonedRawItem(ctx context.Context, id bson.ObjectID, itemMetaID string, raw storedRawItem) error {
	collection := s.rawItems()
	if collection == nil {
		return errors.New("pipelinerecovery: mongo is not configured")
	}
	payload, ok := raw.Payload.DocumentOK()
	if !ok {
		return errors.New("pipelinerecovery: raw item payload is not a document")
	}
	var comparableFull, comparableHash, comparableBase any
	if url, ok := payload.Lookup("url").StringValueOK(); ok {
		if full, fullHash, base, ok := itemsingest.ComparableURLVariants(url); ok {
			comparableFull = full
			comparableHash = fullHash
			comparableBase = base
		}
	}
	now := nowMillis()
	_, err := collection.InsertOne(ctx, bson.D{
		{Key: "_id", Value: id},
		{Key: "itemMetaId", Value: itemMetaID},
		{Key: "payload", Value: payload},
		{Key: "source", Value: "replay"},
		{Key: "urlComparableFull", Value: comparableFull},
		{Key: "urlComparableFullHash", Value: comparableHash},
		{Key: "urlComparableBase", Value: comparableBase},
		{Key: "createdAt", Value: now},
		{Key: "updatedAt", Value: now},
	})
	return err
}

// enqueueItem calls the exported pipelineenqueue producer, which is the port of
// QueueService.enqueueItem. An empty processedItemID keeps the producer's stable
// lookup; rollback passes the id it just created.
//
// The trace id comes from the request context, which mirrors
// ensureTraceId(getCurrentTraceId()) inside the NestJS service: the job data
// carries the same value the gateway returned in x-trace-id.
func (s *Service) enqueueItem(ctx context.Context, orgID, itemMetaID, rawItemID, processedItemID string) (string, error) {
	if s.producer == nil {
		return "", errors.New("pipelinerecovery: item pipeline producer is not configured")
	}
	jobID, err := s.producer.EnqueueItem(ctx, orgID, itemMetaID, rawItemID,
		pipelineenqueue.EnqueueOptions{
			ProcessedItemID: processedItemID,
			TraceID:         httpx.TraceIDFromContext(ctx),
		})
	if err != nil {
		return "", err
	}
	return jobID, nil
}

// rawItems is the RawItem collection; nil without a Mongo database.
func (s *Service) rawItems() *mongo.Collection {
	if s == nil || s.mongo == nil {
		return nil
	}
	return s.mongo.Collection(rawItemsCollection)
}

// processedItems is the ProcessedItem collection.
func (s *Service) processedItems() *mongo.Collection {
	if s == nil || s.mongo == nil {
		return nil
	}
	return s.mongo.Collection(processedItemsCollection)
}

// parseObjectID mirrors Types.ObjectId.isValid plus the driver cast:
//
//   - 24 hex characters are the normal ObjectId form;
//   - a 12-byte string is accepted and used as the raw ObjectId bytes, which is
//     what `new Types.ObjectId(value)` does in mongoose.
func parseObjectID(value string) (bson.ObjectID, bool) {
	if len(value) == 24 {
		if id, err := bson.ObjectIDFromHex(value); err == nil {
			return id, true
		}
	}
	if len(value) == 12 {
		var id bson.ObjectID
		copy(id[:], []byte(value))
		return id, true
	}
	return bson.ObjectID{}, false
}

// processedItemResultDefaults is the set of ProcessedItemResultSchema defaults
// Mongoose materializes through setDefaultsOnInsert. Paths whose default is
// undefined (stage_meta, cleaned_markdown_source) and required paths without a
// default (cleaned_markdown) are absent, exactly like the Mongoose behaviour.
func processedItemResultDefaults() bson.D {
	return bson.D{
		{Key: "title", Value: nil},
		{Key: "subtitle", Value: nil},
		{Key: "author", Value: nil},
		{Key: "source", Value: nil},
		{Key: "published_at", Value: nil},
		{Key: "language", Value: nil},
		{Key: "location", Value: nil},
		{Key: "category", Value: nil},
		{Key: "content_type", Value: nil},
		{Key: "category_path", Value: nil},
		{Key: "category_labels", Value: bson.A{}},
		{Key: "category_confidence", Value: nil},
		{Key: "category_reason", Value: nil},
		{Key: "category_method", Value: nil},
		{Key: "category_candidates", Value: bson.A{}},
		{Key: "sentiment", Value: nil},
		{Key: "sentiment_label", Value: nil},
		{Key: "topics", Value: bson.A{}},
		{Key: "summary", Value: nil},
		{Key: "key_points", Value: bson.A{}},
		{Key: "entities", Value: bson.A{}},
		{Key: "kg_relations", Value: bson.A{}},
		{Key: "removed_noise_types", Value: bson.A{}},
		{Key: "quality_score", Value: nil},
		{Key: "llm_model", Value: nil},
		{Key: "llm_prompt_version", Value: nil},
	}
}
