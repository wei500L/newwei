package processeditemoutbox

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	mathrand "math/rand"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf16"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/wei500L/newwei/apps/api-go/internal/itemsreading"
	"github.com/wei500L/newwei/apps/api-go/internal/vectorclient"
)

const (
	rawItemsCollection       = "rawitems"
	processedItemsCollection = "processeditems"
	itemReadModelsCollection = "itemreadmodels"

	defaultBatchSize   = 10
	defaultConcurrency = 4
	defaultTickBudget  = 240 * time.Second
)

// VectorConfigSource resolves the effective vector-service settings (stored
// SystemSetting overlaid on the VECTOR_SERVICE_* environment defaults).
type VectorConfigSource interface {
	EffectiveVectorConfig(ctx context.Context) (vectorclient.Config, error)
}

// VectorWriter is the vector-go upsert port.
type VectorWriter interface {
	Upsert(ctx context.Context, cfg vectorclient.Config, request vectorclient.UpsertRequest) error
}

// Options wires the delivery owner. DB, Mongo, the config source and the vector
// writer are required in go mode; tests may substitute the two vector ports.
type Options struct {
	DB           *sql.DB
	Mongo        *mongo.Database
	VectorConfig VectorConfigSource
	VectorWriter VectorWriter
	Now          func() time.Time
	Rand         func() float64
	BatchSize    int
	Concurrency  int
	TickBudget   time.Duration
}

// Service executes the processed_item outbox compensation chain. It never
// schedules itself; Scheduler owns the five-minute wall-clock tick and the
// Redis scan lease.
type Service struct {
	store        *mysqlStore
	mongo        *mongo.Database
	hydrator     *itemsreading.Hydrator
	vectorConfig VectorConfigSource
	vector       VectorWriter
	now          func() time.Time
	random       func() float64
	batchSize    int
	concurrency  int
	tickBudget   time.Duration
}

// NewService builds the delivery owner with production defaults.
func NewService(options Options) *Service {
	now := options.Now
	if now == nil {
		now = time.Now
	}
	random := options.Rand
	if random == nil {
		random = randFloat
	}
	batchSize := options.BatchSize
	if batchSize <= 0 {
		batchSize = defaultBatchSize
	}
	concurrency := options.Concurrency
	if concurrency <= 0 {
		concurrency = defaultConcurrency
	}
	budget := options.TickBudget
	if budget <= 0 {
		budget = defaultTickBudget
	}
	return &Service{
		store:        &mysqlStore{db: options.DB},
		mongo:        options.Mongo,
		hydrator:     itemsreading.NewHydrator(options.DB, options.Mongo),
		vectorConfig: options.VectorConfig,
		vector:       options.VectorWriter,
		now:          now,
		random:       random,
		batchSize:    batchSize,
		concurrency:  concurrency,
		tickBudget:   budget,
	}
}

// RunTick drains due batches until none remain or the tick budget is spent.
// A batch is allowed to finish after the deadline so no delivery is abandoned
// mid-write; the budget only gates starting the next batch.
func (s *Service) RunTick(ctx context.Context, budget time.Duration) {
	if s == nil || s.store == nil {
		return
	}
	if budget <= 0 {
		budget = s.tickBudget
	}
	deadline := s.now().Add(budget)
	for {
		if ctx.Err() != nil || !s.now().Before(deadline) {
			return
		}
		ids, err := s.store.listDueIDs(ctx, s.now(), s.batchSize)
		if err != nil {
			log.Printf("processeditemoutbox: scan failed: %v", err)
			return
		}
		if len(ids) == 0 {
			return
		}
		if claimed := s.processBatch(ctx, ids); claimed == 0 {
			// Every selected row was claimed by another executor. Re-scanning
			// immediately would spin until the budget expires.
			return
		}
	}
}

func (s *Service) processBatch(ctx context.Context, ids []string) int {
	workers := s.concurrency
	if workers > len(ids) {
		workers = len(ids)
	}
	if workers < 1 {
		return 0
	}
	work := make(chan string)
	var wg sync.WaitGroup
	var claimed atomic.Int64
	for index := 0; index < workers; index++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for id := range work {
				if ctx.Err() != nil {
					continue
				}
				if s.deliverOne(ctx, id) {
					claimed.Add(1)
				}
			}
		}()
	}
	for _, id := range ids {
		if ctx.Err() != nil {
			break
		}
		work <- id
	}
	close(work)
	wg.Wait()
	return int(claimed.Load())
}

// deliverOne claims first, then reads and validates the payload. The order is
// the O1 optimization: the scan no longer transfers the embedding just to
// discover that another executor won the row.
func (s *Service) deliverOne(ctx context.Context, id string) bool {
	claimed, err := s.store.claim(ctx, id, s.now())
	if err != nil {
		log.Printf("processeditemoutbox: claim failed outboxId=%s: %v", id, err)
		return false
	}
	if claimed == nil {
		return false
	}
	raw, err := s.store.loadPayload(ctx, id)
	if err != nil {
		s.fail(ctx, claimed, err)
		return true
	}
	payload, err := ParsePayload(raw)
	if err != nil {
		// Invalid payloads are parked only after the claim, but the final state
		// is still dead. The claimed attempts value already equals the legacy
		// pre-claim attempts + 1.
		s.markDead(ctx, claimed, "Invalid outbox payload", "OutboxDeliveryError")
		return true
	}
	if err := s.deliver(ctx, claimed, payload); err != nil {
		s.fail(ctx, claimed, err)
	}
	return true
}

func (s *Service) deliver(ctx context.Context, claimed *claimedEntry, payload *Payload) error {
	document := payload.Document
	itemMeta, err := s.store.findItemMeta(ctx, document.ItemMetaID)
	if err != nil {
		return fmt.Errorf("read item metadata: %w", err)
	}
	ingestedAt := s.now()
	if itemMeta != nil && !itemMeta.CreatedAt.IsZero() {
		ingestedAt = itemMeta.CreatedAt.Time
	}
	rawItem, err := s.findRawItem(ctx, document.RawItemID)
	if err != nil {
		return err
	}
	rawPayload := rawObject(rawItem)
	publishedAt := publishedAtFor(document, itemMeta, rawPayload)
	cleanedTitle := cleanedItemName(document.Result.Title)
	shouldUpdateName := cleanedTitle != "" && (itemMeta == nil || itemMeta.Name == "" ||
		strings.Contains(itemMeta.Name, "http://") ||
		strings.Contains(itemMeta.Name, "https://") ||
		strings.Contains(itemMeta.Name, "://"))

	created, err := s.writeProcessedItem(ctx, document, ingestedAt, publishedAtOr(ingestedAt, publishedAt))
	if err != nil {
		return err
	}
	if err := s.upsertVector(ctx, document, created); err != nil {
		return err
	}

	now := s.now()
	if err := s.store.updateItemMeta(ctx, document.ItemMetaID, cleanedTitle, shouldUpdateName, publishedAt, publishedAtOr(ingestedAt, publishedAt), now); err != nil {
		return err
	}
	if itemMeta != nil {
		if err := s.upsertReadModel(ctx, document, itemMeta, rawItem, created, cleanedTitle, shouldUpdateName, publishedAt, ingestedAt, now); err != nil {
			return err
		}
	}
	if err := s.store.deleteOutbox(ctx, claimed.ID); err != nil {
		return fmt.Errorf("delete outbox: %w", err)
	}
	return nil
}

func (s *Service) findRawItem(ctx context.Context, rawItemID string) (*itemsreading.RawItemDoc, error) {
	objectID, err := bson.ObjectIDFromHex(rawItemID)
	if err != nil {
		return nil, fmt.Errorf("rawItemId is not an ObjectId: %w", err)
	}
	opts := options.FindOne().SetProjection(bson.D{
		{Key: "itemMetaId", Value: 1},
		{Key: "source", Value: 1},
		{Key: "payload", Value: 1},
		{Key: "createdAt", Value: 1},
		{Key: "updatedAt", Value: 1},
	})
	var document itemsreading.RawItemDoc
	err = s.mongo.Collection(rawItemsCollection).FindOne(ctx, bson.D{{Key: "_id", Value: objectID}}, opts).Decode(&document)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read raw item: %w", err)
	}
	return &document, nil
}

// writeProcessedItem ports writeProcessedItemFromPayload. The Mongo update is
// idempotent, so a failed later step can replay it safely.
func (s *Service) writeProcessedItem(ctx context.Context, document Document, ingestedAt, sortAt time.Time) (*itemsreading.ProcessedItemDoc, error) {
	processedID, err := bson.ObjectIDFromHex(document.ID)
	if err != nil {
		return nil, fmt.Errorf("processed item _id is not an ObjectId: %w", err)
	}
	rawItemID, err := bson.ObjectIDFromHex(document.RawItemID)
	if err != nil {
		return nil, fmt.Errorf("processed item rawItemId is not an ObjectId: %w", err)
	}
	resultBytes, err := json.Marshal(document.Result)
	if err != nil {
		return nil, err
	}
	var result bson.D
	if err := bson.UnmarshalExtJSON(resultBytes, false, &result); err != nil {
		return nil, err
	}
	now := s.now()
	update := bson.D{
		{Key: "rawItemId", Value: rawItemID},
		{Key: "itemMetaId", Value: document.ItemMetaID},
		{Key: "orgId", Value: document.OrgID},
		{Key: "sourceId", Value: document.SourceID},
		{Key: "ingestedAt", Value: ingestedAt},
		{Key: "sortAt", Value: sortAt},
		{Key: "status", Value: document.Status},
		{Key: "hasLocation", Value: hasLocation(document.Result)},
		{Key: "tags", Value: document.Tags},
		{Key: "result", Value: result},
		{Key: "llm", Value: document.LLM},
		{Key: "summaryEmbeddingModel", Value: document.SummaryEmbeddingModel},
		{Key: "summaryEmbeddingDimensions", Value: embeddingDimensions(document)},
		{Key: "duplicateSimilarity", Value: document.DuplicateSimilarity},
		{Key: "updatedAt", Value: now},
	}
	if document.SummaryEmbeddingSet && document.SummaryEmbedding != nil {
		update = append(update, bson.E{Key: "summaryEmbedding", Value: document.SummaryEmbedding})
	}
	if duplicateID, ok := normalizedObjectID(document.DuplicateOf); ok {
		update = append(update, bson.E{Key: "duplicateOf", Value: duplicateID})
	}
	updateDoc := bson.D{{Key: "$set", Value: update}}
	if truthyRaw(document.Error, document.ErrorSet) {
		update, err = appendErrorField(update, document.Error)
		if err != nil {
			return nil, err
		}
		updateDoc[0] = bson.E{Key: "$set", Value: update}
	} else {
		updateDoc = append(updateDoc, bson.E{Key: "$unset", Value: bson.D{{Key: "error", Value: ""}}})
	}
	updateDoc = append(updateDoc, bson.E{Key: "$setOnInsert", Value: bson.D{
		{Key: "_id", Value: processedID},
		{Key: "createdAt", Value: now},
		{Key: "traceId", Value: nil},
		{Key: "pipelineJobId", Value: nil},
		{Key: "duplicateOf", Value: nil},
	}})

	opts := options.FindOneAndUpdate().SetUpsert(true).SetReturnDocument(options.After)
	var created itemsreading.ProcessedItemDoc
	err = s.mongo.Collection(processedItemsCollection).FindOneAndUpdate(
		ctx,
		bson.D{{Key: "_id", Value: processedID}},
		updateDoc,
		opts,
	).Decode(&created)
	if err != nil {
		if mongo.IsDuplicateKeyError(err) {
			findErr := s.mongo.Collection(processedItemsCollection).FindOne(ctx, bson.D{{Key: "_id", Value: processedID}}).Decode(&created)
			if findErr == nil {
				return &created, nil
			}
		}
		return nil, fmt.Errorf("write processed item: %w", err)
	}
	return &created, nil
}

func (s *Service) upsertVector(ctx context.Context, document Document, created *itemsreading.ProcessedItemDoc) error {
	if document.DuplicateOf != nil && *document.DuplicateOf != "" {
		return nil
	}
	if !document.SummaryEmbeddingSet || len(document.SummaryEmbedding) == 0 {
		return nil
	}
	model := ""
	if document.SummaryEmbeddingModel != nil {
		model = strings.TrimSpace(*document.SummaryEmbeddingModel)
	}
	if model == "" {
		return nil
	}
	if s.vectorConfig == nil || s.vector == nil {
		return errors.New("vector service ports are not configured")
	}
	config, err := s.vectorConfig.EffectiveVectorConfig(ctx)
	if err != nil {
		return err
	}
	createdAtMs := s.now().UnixMilli()
	if created != nil && !created.CreatedAt.IsZero() {
		createdAtMs = created.CreatedAt.Time.UnixMilli()
	}
	return s.vector.Upsert(ctx, config, vectorclient.UpsertRequest{
		OrgID:          document.OrgID,
		EmbeddingModel: model,
		Points: []vectorclient.Point{{
			ProcessedItemID: document.ID,
			ItemMetaID:      document.ItemMetaID,
			CreatedAtMs:     createdAtMs,
			Vector:          document.SummaryEmbedding,
		}},
	})
}

func (s *Service) upsertReadModel(
	ctx context.Context,
	document Document,
	itemMeta *itemsreading.ItemMetaRow,
	rawItem *itemsreading.RawItemDoc,
	created *itemsreading.ProcessedItemDoc,
	cleanedTitle string,
	shouldUpdateName bool,
	publishedAt *time.Time,
	ingestedAt time.Time,
	now time.Time,
) error {
	nextName := itemMeta.Name
	if shouldUpdateName {
		nextName = cleanedTitle
	}
	nextPublishedAt := itemMeta.PublishedAt
	if publishedAt != nil {
		value := itemsreading.NewISOTime(*publishedAt)
		nextPublishedAt = &value
	}
	nextSortAt := itemMeta.SortAt
	if nextPublishedAt != nil {
		nextSortAt = *nextPublishedAt
	} else if nextSortAt.IsZero() {
		nextSortAt = itemsreading.NewISOTime(ingestedAt)
	}
	sourceID := ""
	if document.SourceID != nil && strings.TrimSpace(*document.SourceID) != "" {
		sourceID = strings.TrimSpace(*document.SourceID)
	} else {
		sourceID = rawMetadataSourceID(rawItem)
	}
	mongoRef := strings.TrimSpace(itemMeta.MongoRef)
	if mongoRef == "" {
		mongoRef = document.RawItemID
	}
	meta := *itemMeta
	meta.Name = nextName
	meta.Status = string(itemsreading.ItemStatusCompleted)
	meta.MongoRef = mongoRef
	meta.PublishedAt = nextPublishedAt
	meta.SortAt = nextSortAt
	meta.UpdatedAt = itemsreading.NewISOTime(now)

	createdAt := itemsreading.NewISOTime(now)
	updatedAt := createdAt
	if created != nil {
		if !created.CreatedAt.IsZero() {
			createdAt = created.CreatedAt
		}
		if !created.UpdatedAt.IsZero() {
			updatedAt = created.UpdatedAt
		}
	}
	resultBytes, err := json.Marshal(document.Result)
	if err != nil {
		return err
	}
	processed := &itemsreading.ReadModelProcessedDoc{
		ID:                         document.ID,
		ItemMetaID:                 document.ItemMetaID,
		RawItemID:                  stringPointer(document.RawItemID),
		SourceID:                   optionalNonEmpty(sourceID),
		Status:                     document.Status,
		Error:                      readModelError(document.Error),
		Tags:                       document.Tags,
		Result:                     itemsreading.NewOpenJSON(resultBytes),
		DuplicateOf:                document.DuplicateOf,
		DuplicateSimilarity:        document.DuplicateSimilarity,
		SummaryEmbeddingModel:      document.SummaryEmbeddingModel,
		SummaryEmbeddingDimensions: embeddingDimensions(document),
		Llm:                        readModelLLM(document.LLM),
		CreatedAt:                  createdAt,
		UpdatedAt:                  updatedAt,
	}
	var rawSnapshot *itemsreading.ReadModelRawDoc
	if rawItem != nil {
		rawCreatedAt := rawItem.CreatedAt
		if rawCreatedAt.IsZero() {
			rawCreatedAt = itemMeta.CreatedAt
		}
		rawUpdatedAt := rawItem.UpdatedAt
		if rawUpdatedAt.IsZero() {
			rawUpdatedAt = itemMeta.UpdatedAt
		}
		rawPayload := rawItem.Payload
		if !rawPayload.Valid() {
			rawPayload = itemsreading.NewOpenJSON([]byte("{}"))
		}
		rawSnapshot = &itemsreading.ReadModelRawDoc{
			ID:         rawItem.HexID(),
			ItemMetaID: rawItem.ItemMetaID,
			Source:     rawItem.Source,
			Payload:    rawPayload,
			CreatedAt:  rawCreatedAt,
			UpdatedAt:  rawUpdatedAt,
		}
	}
	source := optionalNonEmpty(sourceID)
	readModel := itemsreading.BuildReadModelDocument(itemsreading.ReadModelBuildInput{
		Meta:      meta,
		Raw:       rawSnapshot,
		Processed: processed,
		SourceID:  source,
	})
	return s.hydrator.UpsertReadModelProjection(ctx, readModel)
}

func (s *Service) fail(ctx context.Context, claimed *claimedEntry, err error) {
	attempts := claimed.Attempts
	if attempts < 1 {
		attempts = 1
	}
	message := errorMessage(err)
	if attempts >= maxAttempts {
		s.markDead(ctx, claimed, message, errorName(err))
		return
	}
	now := s.now()
	availableAt := now.Add(s.backoffDelay(attempts))
	if updateErr := s.store.markFailed(ctx, claimed.ID, attempts, message, availableAt, now); updateErr != nil {
		log.Printf("processeditemoutbox: write failure state failed outboxId=%s: %v", claimed.ID, updateErr)
	}
}

func (s *Service) markDead(ctx context.Context, claimed *claimedEntry, message, name string) {
	now := s.now()
	if err := s.store.markDead(ctx, claimed.ID, claimed.Attempts, message, now); err != nil {
		log.Printf("processeditemoutbox: mark dead failed outboxId=%s: %v", claimed.ID, err)
	}
	s.compensateDead(ctx, claimed.ID, message, name)
}

// compensateDead ports the dead-letter compensation. A missing or invalid
// payload is not compensated: its ids cannot be trusted. Every other failure
// only logs a warning, exactly like the NestJS implementation.
func (s *Service) compensateDead(ctx context.Context, outboxID, message, name string) {
	raw, err := s.store.loadPayload(ctx, outboxID)
	if err != nil {
		log.Printf("processeditemoutbox: read dead payload failed outboxId=%s: %v", outboxID, err)
		return
	}
	payload, err := ParsePayload(raw)
	if err != nil {
		return
	}
	document := payload.Document
	if document.ID == "" || document.ItemMetaID == "" {
		return
	}
	processedID, err := bson.ObjectIDFromHex(document.ID)
	if err != nil {
		log.Printf("processeditemoutbox: dead payload processed id is invalid outboxId=%s: %v", outboxID, err)
		return
	}
	errorMessage := truncateUTF16(message, 2000)
	failure := bson.D{{Key: "message", Value: errorMessage}, {Key: "name", Value: name}}
	now := s.now()
	_, err = s.mongo.Collection(processedItemsCollection).UpdateOne(
		ctx,
		bson.D{{Key: "_id", Value: processedID}, {Key: "status", Value: "processing"}},
		bson.D{{Key: "$set", Value: bson.D{
			{Key: "status", Value: "failed"},
			{Key: "error", Value: failure},
			{Key: "updatedAt", Value: now},
		}}},
	)
	if err != nil {
		log.Printf("processeditemoutbox: compensate processed item failed outboxId=%s: %v", outboxID, err)
		return
	}
	_, err = s.mongo.Collection(itemReadModelsCollection).UpdateOne(
		ctx,
		bson.D{{Key: "orgId", Value: document.OrgID}, {Key: "itemMetaId", Value: document.ItemMetaID}},
		bson.D{{Key: "$set", Value: bson.D{
			{Key: "status", Value: string(itemsreading.ItemStatusFailed)},
			{Key: "processed.status", Value: "failed"},
			{Key: "processed.error", Value: failure},
			{Key: "updatedAt", Value: now},
		}}},
	)
	if err != nil {
		log.Printf("processeditemoutbox: compensate read model failed outboxId=%s: %v", outboxID, err)
	}
}

// backoffDelay ports computeBackoffDelay:
// round(30000 * 2^(min(attempt,5)-1) * (0.5 + random)).
func (s *Service) backoffDelay(attempt int) time.Duration {
	exponent := math.Min(float64(attempt), backoffCap)
	if exponent < 1 {
		exponent = 1
	}
	exponential := float64(retryBaseDelay) * math.Pow(2, exponent-1)
	jitter := 0.5 + s.random()
	return time.Duration(math.Round(exponential * jitter))
}

func publishedAtFor(document Document, itemMeta *itemsreading.ItemMetaRow, rawPayload json.RawMessage) *time.Time {
	if document.Result.PublishedAt != nil {
		if parsed, ok := parseDateTimeValue(*document.Result.PublishedAt); ok {
			return &parsed
		}
	}
	if itemMeta != nil && itemMeta.PublishedAt != nil {
		value := itemMeta.PublishedAt.Time
		return &value
	}
	if candidate := rawPublishedAt(rawPayload); candidate != "" {
		if parsed, ok := parseDateTimeValue(candidate); ok {
			return &parsed
		}
	}
	return nil
}

func publishedAtOr(fallback time.Time, value *time.Time) time.Time {
	if value != nil {
		return *value
	}
	return fallback
}

// rawObject returns the RawItem payload only when it is a JSON object.
func rawObject(raw *itemsreading.RawItemDoc) json.RawMessage {
	if raw == nil || !raw.Payload.Valid() {
		return nil
	}
	trimmed := bytes.TrimSpace(raw.Payload.Bytes())
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return nil
	}
	return trimmed
}

// rawPublishedAt implements `rawPayload.publishedAt ?? rawPayload.published_at`
// for string or date candidates. A present but non-null publishedAt wins even
// when it is not a parseable value.
func rawPublishedAt(payload json.RawMessage) string {
	if len(payload) == 0 {
		return ""
	}
	var shape struct {
		PublishedAt      json.RawMessage `json:"publishedAt"`
		PublishedAtSnake json.RawMessage `json:"published_at"`
	}
	if err := json.Unmarshal(payload, &shape); err != nil {
		return ""
	}
	for _, candidate := range []json.RawMessage{shape.PublishedAt, shape.PublishedAtSnake} {
		trimmed := bytes.TrimSpace(candidate)
		if len(trimmed) == 0 || string(trimmed) == "null" {
			continue
		}
		var text string
		if err := json.Unmarshal(trimmed, &text); err != nil {
			return ""
		}
		return text
	}
	return ""
}

func rawMetadataSourceID(raw *itemsreading.RawItemDoc) string {
	payload := rawObject(raw)
	if len(payload) == 0 {
		return ""
	}
	var shape struct {
		Metadata json.RawMessage `json:"metadata"`
	}
	if err := json.Unmarshal(payload, &shape); err != nil {
		return ""
	}
	metadata := bytes.TrimSpace(shape.Metadata)
	if len(metadata) == 0 || metadata[0] != '{' {
		return ""
	}
	var record struct {
		SourceID *string `json:"sourceId"`
	}
	if err := json.Unmarshal(metadata, &record); err != nil || record.SourceID == nil {
		return ""
	}
	return strings.TrimSpace(*record.SourceID)
}

func cleanedItemName(title *string) string {
	if title == nil {
		return ""
	}
	trimmed := strings.TrimSpace(*title)
	if trimmed == "" {
		return ""
	}
	return toItemMetaName(trimmed)
}

// toItemMetaName ports toItemMetaName. JavaScript counts UTF-16 code units, so
// emoji still follow the 191/190 cut.
func toItemMetaName(value string) string {
	units := utf16.Encode([]rune(value))
	if len(units) <= 191 {
		return value
	}
	head := string(utf16.Decode(units[:190]))
	return strings.TrimRightFunc(head, isSpaceRune) + "…"
}

func isSpaceRune(r rune) bool {
	switch r {
	case ' ', '\t', '\n', '\v', '\f', '\r', '\u00a0', '\u1680', '\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff':
		return true
	}
	return r >= '\u2000' && r <= '\u200a'
}

func hasLocation(result CleanedNews) bool {
	return result.Location != nil && strings.TrimSpace(*result.Location) != ""
}

func embeddingDimensions(document Document) *int {
	if !document.SummaryEmbeddingSet || document.SummaryEmbedding == nil {
		return nil
	}
	value := len(document.SummaryEmbedding)
	return &value
}

func normalizedObjectID(value *string) (bson.ObjectID, bool) {
	if value == nil || *value == "" {
		return bson.NilObjectID, false
	}
	objectID, err := bson.ObjectIDFromHex(*value)
	if err != nil {
		return bson.NilObjectID, false
	}
	return objectID, true
}

func truthyRaw(raw json.RawMessage, set bool) bool {
	if !set {
		return false
	}
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || string(trimmed) == "null" || string(trimmed) == "false" || string(trimmed) == "0" || string(trimmed) == `""` {
		return false
	}
	return true
}

// appendErrorField keeps the open error leaf byte-exact for the shapes the
// ProcessedItem sub-schema accepts. Objects become BSON documents; scalars use
// the matching BSON primitive. Arrays are rejected instead of being silently
// coerced, because the generated payload never produces one.
func appendErrorField(update bson.D, raw json.RawMessage) (bson.D, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return update, nil
	}
	switch trimmed[0] {
	case '{':
		var value bson.D
		if err := bson.UnmarshalExtJSON(trimmed, false, &value); err != nil {
			return update, err
		}
		return append(update, bson.E{Key: "error", Value: value}), nil
	case '"':
		var value string
		if err := json.Unmarshal(trimmed, &value); err != nil {
			return update, err
		}
		return append(update, bson.E{Key: "error", Value: value}), nil
	case 't', 'f':
		var value bool
		if err := json.Unmarshal(trimmed, &value); err != nil {
			return update, err
		}
		return append(update, bson.E{Key: "error", Value: value}), nil
	default:
		decoder := json.NewDecoder(bytes.NewReader(trimmed))
		decoder.UseNumber()
		var number json.Number
		if err := decoder.Decode(&number); err != nil {
			return update, errors.New("processed item error must be an object or scalar")
		}
		if integer, err := number.Int64(); err == nil {
			return append(update, bson.E{Key: "error", Value: integer}), nil
		}
		value, err := number.Float64()
		if err != nil {
			return update, err
		}
		return append(update, bson.E{Key: "error", Value: value}), nil
	}
}

func readModelError(raw json.RawMessage) *itemsreading.ProcessedItemErrorDoc {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return nil
	}
	var record struct {
		Message json.RawMessage `json:"message"`
		Name    json.RawMessage `json:"name"`
	}
	if err := json.Unmarshal(trimmed, &record); err != nil {
		return nil
	}
	message := "Unknown error"
	if text := jsonStringValue(record.Message); strings.TrimSpace(text) != "" {
		message = text
	}
	var name *string
	if text := jsonStringValue(record.Name); text != "" {
		name = &text
	}
	return &itemsreading.ProcessedItemErrorDoc{Message: message, Name: name}
}

func jsonStringValue(raw json.RawMessage) string {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || string(trimmed) == "null" {
		return ""
	}
	var value string
	if err := json.Unmarshal(trimmed, &value); err != nil {
		return ""
	}
	return value
}

func readModelLLM(llm LLMMetadata) *itemsreading.ProcessedItemLlmDoc {
	return &itemsreading.ProcessedItemLlmDoc{
		Model: llm.Model, PromptVersion: llm.PromptVersion,
		PromptTokens: llm.PromptTokens, CompletionTokens: llm.CompletionTokens,
		TotalTokens: llm.TotalTokens, CostUSD: llm.CostUSD, LatencyMs: llm.LatencyMs,
	}
}

func optionalNonEmpty(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

func errorMessage(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func errorName(err error) string {
	return vectorclient.ErrorName(err)
}

// truncateUTF16 mirrors String.prototype.slice(0, limit): it counts UTF-16
// code units, not runes.
func truncateUTF16(value string, limit int) string {
	units := utf16.Encode([]rune(value))
	if len(units) <= limit {
		return value
	}
	return string(utf16.Decode(units[:limit]))
}

func randFloat() float64 {
	return mathrand.Float64()
}
