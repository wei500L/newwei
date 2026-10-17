package itemsreading

import (
	"context"
	"errors"
	"sort"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// Collection names. They follow the Mongoose model names registered in
// packages/mongo/src/models: RawItem -> rawitems, ProcessedItem ->
// processeditems, ItemReadModel -> itemreadmodels. They are declared once so a
// future rename is a single edit.
const (
	rawItemsCollection       = "rawitems"
	processedItemsCollection = "processeditems"
	itemReadModelsCollection = "itemreadmodels"
)

// mongoStore is the strongly typed Mongo access layer. Every query that can
// filter by tenant carries orgId; RawItem has no orgId column, so it is always
// bound through a verified, organization-scoped ItemMeta document instead.
type mongoStore struct {
	db *mongo.Database
}

// newMongoStore wraps a Mongo database handle.
func newMongoStore(db *mongo.Database) *mongoStore {
	return &mongoStore{db: db}
}

func (s *mongoStore) rawItems() *mongo.Collection { return s.db.Collection(rawItemsCollection) }
func (s *mongoStore) processedItems() *mongo.Collection {
	return s.db.Collection(processedItemsCollection)
}
func (s *mongoStore) readModels() *mongo.Collection { return s.db.Collection(itemReadModelsCollection) }

// FindRawItemBound loads one raw document for an already verified,
// organization-scoped ItemMeta. The document must satisfy both `_id = mongoRef`
// and `itemMetaId = itemMetaId`; anything else yields no document, so a foreign
// raw document cannot be surfaced through a cross-organization reference.
func (s *mongoStore) FindRawItemBound(
	ctx context.Context,
	itemMetaID string,
	mongoRef string,
) (*RawItemDoc, error) {
	trimmedRef := strings.TrimSpace(mongoRef)
	if !isValidObjectIDHex(trimmedRef) {
		return nil, nil
	}
	objectID, err := bson.ObjectIDFromHex(trimmedRef)
	if err != nil {
		return nil, nil
	}
	var doc RawItemDoc
	err = s.rawItems().FindOne(ctx, bson.D{
		{Key: "_id", Value: objectID},
		{Key: "itemMetaId", Value: itemMetaID},
	}).Decode(&doc)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &doc, nil
}

// FindRawItemsBound loads raw documents for many `itemMetaId -> mongoRef`
// bindings produced from organization-scoped ItemMeta rows. Documents whose own
// itemMetaId does not match the meta that referenced them are dropped.
func (s *mongoStore) FindRawItemsBound(
	ctx context.Context,
	bindings map[string]string,
) (map[string]RawItemDoc, error) {
	out := make(map[string]RawItemDoc, len(bindings))
	if len(bindings) == 0 {
		return out, nil
	}
	itemMetaIDByRef := make(map[string]string, len(bindings))
	refs := make([]bson.ObjectID, 0, len(bindings))
	for itemMetaID, mongoRef := range bindings {
		trimmedRef := strings.TrimSpace(mongoRef)
		if !isValidObjectIDHex(trimmedRef) {
			continue
		}
		objectID, err := bson.ObjectIDFromHex(trimmedRef)
		if err != nil {
			continue
		}
		itemMetaIDByRef[trimmedRef] = itemMetaID
		refs = append(refs, objectID)
	}
	if len(refs) == 0 {
		return out, nil
	}
	cursor, err := s.rawItems().Find(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: refs}}}})
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)
	for cursor.Next(ctx) {
		var doc RawItemDoc
		if err := cursor.Decode(&doc); err != nil {
			return nil, err
		}
		expected := itemMetaIDByRef[doc.HexID()]
		if expected == "" || doc.ItemMetaID != expected {
			continue
		}
		if _, exists := out[expected]; exists {
			continue
		}
		out[expected] = doc
	}
	if err := cursor.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// FindLatestProcessed loads the most recent processed document for one item.
// This is the REST detail rule; the GraphQL nested field deliberately uses the
// status-priority rule in FindProcessedByKeys instead.
func (s *mongoStore) FindLatestProcessed(
	ctx context.Context,
	orgID string,
	itemMetaID string,
) (*ProcessedItemDoc, error) {
	opts := options.FindOne().SetSort(bson.D{{Key: "createdAt", Value: -1}})
	var doc ProcessedItemDoc
	err := s.processedItems().FindOne(ctx, bson.D{
		{Key: "orgId", Value: orgID},
		{Key: "itemMetaId", Value: itemMetaID},
	}, opts).Decode(&doc)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &doc, nil
}

// processedProjection returns the projection for the GraphQL processed field.
func processedProjection(includeResult bool) bson.D {
	projection := bson.D{
		{Key: "itemMetaId", Value: 1},
		{Key: "status", Value: 1},
		{Key: "error", Value: 1},
		{Key: "tags", Value: 1},
		{Key: "duplicateOf", Value: 1},
		{Key: "duplicateSimilarity", Value: 1},
		{Key: "summaryEmbeddingModel", Value: 1},
		{Key: "summaryEmbeddingDimensions", Value: 1},
		{Key: "llm", Value: 1},
		{Key: "createdAt", Value: 1},
		{Key: "updatedAt", Value: 1},
	}
	if includeResult {
		projection = append(projection, bson.E{Key: "result", Value: 1})
	}
	return projection
}

// FindProcessedByKeys loads one processed document per item using the legacy
// status priority (completed > failed > processing > pending) and, within the
// same priority, the newest createdAt.
func (s *mongoStore) FindProcessedByKeys(
	ctx context.Context,
	orgID string,
	itemMetaIDs []string,
	includeResult bool,
) (map[string]ProcessedItemDoc, error) {
	out := make(map[string]ProcessedItemDoc, len(itemMetaIDs))
	if len(itemMetaIDs) == 0 {
		return out, nil
	}
	opts := options.Find().
		SetProjection(processedProjection(includeResult)).
		SetSort(bson.D{{Key: "createdAt", Value: -1}, {Key: "_id", Value: -1}})
	cursor, err := s.processedItems().Find(ctx, bson.D{
		{Key: "orgId", Value: orgID},
		{Key: "itemMetaId", Value: bson.D{{Key: "$in", Value: itemMetaIDs}}},
	}, opts)
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)
	for cursor.Next(ctx) {
		var doc ProcessedItemDoc
		if err := cursor.Decode(&doc); err != nil {
			return nil, err
		}
		if doc.ItemMetaID == "" {
			continue
		}
		existing, ok := out[doc.ItemMetaID]
		if !ok || statusPriority(doc.Status) > statusPriority(existing.Status) {
			out[doc.ItemMetaID] = doc
		}
	}
	if err := cursor.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// statusPriority ports the processed-item loader status ranking.
func statusPriority(status string) int {
	switch status {
	case "completed":
		return 3
	case "failed":
		return 2
	case "processing":
		return 1
	default:
		return 0
	}
}

// readModelProjectionMeta mirrors ITEM_READ_MODEL_META_ROW_PROJECTION.
func readModelProjectionMeta() bson.D {
	return bson.D{
		{Key: "orgId", Value: 1},
		{Key: "itemMetaId", Value: 1},
		{Key: "meta.id", Value: 1},
		{Key: "meta.externalId", Value: 1},
		{Key: "meta.name", Value: 1},
		{Key: "meta.status", Value: 1},
		{Key: "meta.mongoRef", Value: 1},
		{Key: "meta.version", Value: 1},
		{Key: "meta.publishedAt", Value: 1},
		{Key: "meta.sortAt", Value: 1},
		{Key: "meta.createdAt", Value: 1},
		{Key: "meta.updatedAt", Value: 1},
		{Key: "publishedAt", Value: 1},
	}
}

// FindReadModelsByIDs loads full read-model documents for the requested
// organization. The query is always organization scoped.
func (s *mongoStore) FindReadModelsByIDs(
	ctx context.Context,
	orgID string,
	ids []string,
) (map[string]ReadModelDocument, error) {
	out := make(map[string]ReadModelDocument, len(ids))
	if len(ids) == 0 {
		return out, nil
	}
	cursor, err := s.readModels().Find(ctx, bson.D{
		{Key: "orgId", Value: orgID},
		{Key: "itemMetaId", Value: bson.D{{Key: "$in", Value: ids}}},
	})
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)
	for cursor.Next(ctx) {
		var doc ReadModelDocument
		if err := cursor.Decode(&doc); err != nil {
			return nil, err
		}
		if doc.ItemMetaID == "" {
			continue
		}
		if _, exists := out[doc.ItemMetaID]; exists {
			continue
		}
		out[doc.ItemMetaID] = doc
	}
	if err := cursor.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// FindReadModelsProjected loads read-model documents with an explicit
// projection. It is used by the GraphQL nested field, whose five projections
// mirror the legacy loaders.
func (s *mongoStore) FindReadModelsProjected(
	ctx context.Context,
	orgID string,
	ids []string,
	projection bson.D,
) ([]ReadModelDocument, error) {
	out := make([]ReadModelDocument, 0, len(ids))
	if len(ids) == 0 {
		return out, nil
	}
	opts := options.Find().SetProjection(projection)
	cursor, err := s.readModels().Find(ctx, bson.D{
		{Key: "orgId", Value: orgID},
		{Key: "itemMetaId", Value: bson.D{{Key: "$in", Value: ids}}},
	}, opts)
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)
	for cursor.Next(ctx) {
		var doc ReadModelDocument
		if err := cursor.Decode(&doc); err != nil {
			return nil, err
		}
		out = append(out, doc)
	}
	if err := cursor.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// ReadModelProjections exposes the five read-model projections the GraphQL
// nested field needs.
var ReadModelProjections = struct {
	Meta             bson.D
	Raw              bson.D
	RawPreview       bson.D
	Processed        bson.D
	ProcessedPreview bson.D
}{
	Meta: readModelProjectionMeta(),
	Raw:  bson.D{{Key: "orgId", Value: 1}, {Key: "itemMetaId", Value: 1}, {Key: "raw", Value: 1}},
	RawPreview: bson.D{
		{Key: "orgId", Value: 1},
		{Key: "itemMetaId", Value: 1},
		{Key: "raw.payload.url", Value: 1},
		{Key: "raw.payload.link", Value: 1},
		{Key: "raw.payload.sourceUrl", Value: 1},
		{Key: "raw.payload.sourceName", Value: 1},
		{Key: "raw.payload.source_name", Value: 1},
		{Key: "raw.payload.source", Value: 1},
		{Key: "raw.payload.publisher", Value: 1},
		{Key: "raw.payload.siteName", Value: 1},
		{Key: "raw.payload.site_name", Value: 1},
		{Key: "raw.payload.thumbnail", Value: 1},
		{Key: "raw.payload.thumbnailUrl", Value: 1},
		{Key: "raw.payload.image", Value: 1},
		{Key: "raw.payload.imageUrl", Value: 1},
		{Key: "raw.payload.image_url", Value: 1},
		{Key: "raw.payload.summary", Value: 1},
		{Key: "raw.payload.abstract", Value: 1},
		{Key: "raw.payload.description", Value: 1},
		{Key: "raw.payload.sentiment_label", Value: 1},
		{Key: "raw.payload.sentimentLabel", Value: 1},
		{Key: "raw.payload.sentiment", Value: 1},
		{Key: "raw.payload.region", Value: 1},
		{Key: "raw.payload.country", Value: 1},
		{Key: "raw.payload.area", Value: 1},
		{Key: "raw.payload.location", Value: 1},
		{Key: "raw.payload.ticker", Value: 1},
		{Key: "raw.payload.symbol", Value: 1},
		{Key: "raw.payload.price", Value: 1},
		{Key: "raw.payload.changePercent", Value: 1},
		{Key: "raw.payload.change_percent", Value: 1},
		{Key: "raw.payload.change", Value: 1},
		{Key: "raw.payload.history", Value: 1},
		{Key: "raw.payload.metadata.thumbnail", Value: 1},
		{Key: "raw.payload.metadata.thumbnailUrl", Value: 1},
		{Key: "raw.payload.metadata.image", Value: 1},
		{Key: "raw.payload.metadata.imageUrl", Value: 1},
		{Key: "raw.payload.metadata.image_url", Value: 1},
		{Key: "raw.payload.metadata.summary", Value: 1},
		{Key: "raw.payload.metadata.abstract", Value: 1},
		{Key: "raw.payload.metadata.description", Value: 1},
		{Key: "raw.payload.metadata.sentiment_label", Value: 1},
		{Key: "raw.payload.metadata.sentimentLabel", Value: 1},
		{Key: "raw.payload.metadata.sentiment", Value: 1},
		{Key: "raw.payload.metadata.region", Value: 1},
		{Key: "raw.payload.metadata.country", Value: 1},
		{Key: "raw.payload.metadata.area", Value: 1},
		{Key: "raw.payload.metadata.location", Value: 1},
		{Key: "raw.payload.metadata.ticker", Value: 1},
		{Key: "raw.payload.metadata.symbol", Value: 1},
		{Key: "raw.payload.metadata.price", Value: 1},
		{Key: "raw.payload.metadata.changePercent", Value: 1},
		{Key: "raw.payload.metadata.change_percent", Value: 1},
		{Key: "raw.payload.metadata.change", Value: 1},
		{Key: "raw.payload.metadata.history", Value: 1},
	},
	Processed: bson.D{{Key: "orgId", Value: 1}, {Key: "itemMetaId", Value: 1}, {Key: "processed", Value: 1}},
	ProcessedPreview: bson.D{
		{Key: "orgId", Value: 1},
		{Key: "itemMetaId", Value: 1},
		{Key: "publishedAt", Value: 1},
		{Key: "sourceName", Value: 1},
		{Key: "title", Value: 1},
		{Key: "language", Value: 1},
		{Key: "summary", Value: 1},
		{Key: "sentiment", Value: 1},
		{Key: "contentType", Value: 1},
		{Key: "topics", Value: 1},
		{Key: "entities", Value: 1},
		{Key: "qualityScore", Value: 1},
		{Key: "location", Value: 1},
		{Key: "region", Value: 1},
		{Key: "processed.id", Value: 1},
		{Key: "processed.itemMetaId", Value: 1},
		{Key: "processed.status", Value: 1},
		{Key: "processed.error", Value: 1},
		{Key: "processed.tags", Value: 1},
		{Key: "processed.duplicateOf", Value: 1},
		{Key: "processed.duplicateSimilarity", Value: 1},
		{Key: "processed.summaryEmbeddingModel", Value: 1},
		{Key: "processed.summaryEmbeddingDimensions", Value: 1},
		{Key: "processed.llm", Value: 1},
		{Key: "processed.createdAt", Value: 1},
	},
}

// UpsertReadModels writes hydrated read-model documents. The filter always
// contains orgId + itemMetaId; a missing raw/processed snapshot is `$unset`
// rather than written as an explicit null, because the GraphQL resolvers treat
// a stored null as authoritative and would stop falling back to the Mongo
// loaders before the outbox delivery produces the snapshot.
func (s *mongoStore) UpsertReadModels(ctx context.Context, docs []ReadModelDocument) error {
	if len(docs) == 0 {
		return nil
	}
	models := make([]mongo.WriteModel, 0, len(docs))
	for _, doc := range docs {
		update := bson.D{{Key: "$set", Value: doc}}
		unset := bson.D{}
		if doc.Raw == nil {
			unset = append(unset, bson.E{Key: "raw", Value: ""})
		}
		if doc.Processed == nil {
			unset = append(unset, bson.E{Key: "processed", Value: ""})
		}
		if len(unset) > 0 {
			update = append(update, bson.E{Key: "$unset", Value: unset})
		}
		models = append(models, mongo.NewUpdateOneModel().
			SetFilter(bson.D{
				{Key: "orgId", Value: doc.OrgID},
				{Key: "itemMetaId", Value: doc.ItemMetaID},
			}).
			SetUpdate(update).
			SetUpsert(true))
	}
	_, err := s.readModels().BulkWrite(ctx, models, options.BulkWrite().SetOrdered(false))
	return err
}

// ListLatestProcessedSnapshots pages the newest completed snapshot per item.
// It mirrors ItemsSearchService.listLatestProcessedSnapshots: the (createdAt,
// _id) descending cursor keeps paging until every requested item was seen (or
// the collection is exhausted), so facets are never silently truncated to the
// first batch.
func (s *mongoStore) ListLatestProcessedSnapshots(
	ctx context.Context,
	orgID string,
	itemMetaIDs []string,
) ([]ProcessedItemDoc, error) {
	match := bson.D{
		{Key: "orgId", Value: orgID},
		{Key: "status", Value: string(PipelineStageCompleted)},
	}
	pending := make(map[string]struct{}, len(itemMetaIDs))
	if len(itemMetaIDs) > 0 {
		match = append(match, bson.E{Key: "itemMetaId", Value: bson.D{{Key: "$in", Value: itemMetaIDs}}})
		for _, id := range itemMetaIDs {
			pending[id] = struct{}{}
		}
	}
	seen := make(map[string]struct{}, len(itemMetaIDs))
	snapshots := make([]ProcessedItemDoc, 0, 64)
	projection := bson.D{
		{Key: "itemMetaId", Value: 1},
		{Key: "status", Value: 1},
		{Key: "tags", Value: 1},
		{Key: "result", Value: 1},
		{Key: "sourceId", Value: 1},
		{Key: "duplicateOf", Value: 1},
		{Key: "sortAt", Value: 1},
		{Key: "ingestedAt", Value: 1},
		{Key: "createdAt", Value: 1},
	}
	var cursorCreatedAt *time.Time
	var cursorID *bson.ObjectID
	for {
		pageMatch := append(bson.D{}, match...)
		if cursorCreatedAt != nil && cursorID != nil {
			pageMatch = append(pageMatch, bson.E{Key: "$or", Value: bson.A{
				bson.D{{Key: "createdAt", Value: bson.D{{Key: "$lt", Value: *cursorCreatedAt}}}},
				bson.D{
					{Key: "createdAt", Value: *cursorCreatedAt},
					{Key: "_id", Value: bson.D{{Key: "$lt", Value: *cursorID}}},
				},
			}})
		}
		opts := options.Find().
			SetProjection(projection).
			SetSort(bson.D{{Key: "createdAt", Value: -1}, {Key: "_id", Value: -1}}).
			SetLimit(LatestProcessedSnapshotBatchSize)
		cursor, err := s.processedItems().Find(ctx, pageMatch, opts)
		if err != nil {
			return nil, err
		}
		batch := make([]ProcessedItemDoc, 0, LatestProcessedSnapshotBatchSize)
		for cursor.Next(ctx) {
			var doc ProcessedItemDoc
			if err := cursor.Decode(&doc); err != nil {
				cursor.Close(ctx)
				return nil, err
			}
			batch = append(batch, doc)
		}
		closeErr := cursor.Err()
		cursor.Close(ctx)
		if closeErr != nil {
			return nil, closeErr
		}
		if len(batch) == 0 {
			break
		}
		for _, record := range batch {
			if record.ItemMetaID == "" {
				continue
			}
			if _, ok := seen[record.ItemMetaID]; ok {
				continue
			}
			seen[record.ItemMetaID] = struct{}{}
			delete(pending, record.ItemMetaID)
			snapshots = append(snapshots, record)
		}
		if len(itemMetaIDs) > 0 && len(pending) == 0 {
			break
		}
		last := batch[len(batch)-1]
		if last.CreatedAt.IsZero() || last.MongoID.IsZero() {
			break
		}
		createdAt := last.CreatedAt.Time
		cursorCreatedAt = &createdAt
		cursorID = &last.MongoID
		if len(batch) < LatestProcessedSnapshotBatchSize {
			break
		}
	}
	return snapshots, nil
}

// VectorCandidate is one ProcessedItem row used by the local cosine fallback.
type VectorCandidate struct {
	ItemMetaID       string
	SummaryEmbedding []float64
}

// VectorCandidates loads the Mongo fallback scan window for the vector recall.
func (s *mongoStore) VectorCandidates(
	ctx context.Context,
	orgID string,
	model string,
	cutoff time.Time,
) ([]VectorCandidate, error) {
	opts := options.Find().
		SetProjection(bson.D{{Key: "itemMetaId", Value: 1}, {Key: "summaryEmbedding", Value: 1}}).
		SetSort(bson.D{{Key: "createdAt", Value: -1}}).
		SetLimit(VectorSearchMaxCandidates)
	cursor, err := s.processedItems().Find(ctx, bson.D{
		{Key: "orgId", Value: orgID},
		{Key: "status", Value: string(PipelineStageCompleted)},
		{Key: "summaryEmbeddingModel", Value: model},
		{Key: "summaryEmbedding", Value: bson.D{{Key: "$exists", Value: true}, {Key: "$ne", Value: bson.A{}}}},
		{Key: "duplicateOf", Value: nil},
		{Key: "createdAt", Value: bson.D{{Key: "$gte", Value: cutoff}}},
	}, opts)
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)
	out := make([]VectorCandidate, 0, 128)
	for cursor.Next(ctx) {
		var record struct {
			ItemMetaID       string    `bson:"itemMetaId"`
			SummaryEmbedding []float64 `bson:"summaryEmbedding"`
		}
		if err := cursor.Decode(&record); err != nil {
			return nil, err
		}
		if strings.TrimSpace(record.ItemMetaID) == "" {
			continue
		}
		out = append(out, VectorCandidate{
			ItemMetaID:       record.ItemMetaID,
			SummaryEmbedding: record.SummaryEmbedding,
		})
	}
	if err := cursor.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// SourceCount is one source-count snapshot entry.
type SourceCount struct {
	Source           string
	NormalizedSource string
	Count            int
}

// SourceCounts scans the newest completed processed documents and counts the
// source alias used by the suggestions payload.
func (s *mongoStore) SourceCounts(ctx context.Context, orgID string) ([]SourceCount, error) {
	opts := options.Find().
		SetProjection(bson.D{{Key: "result", Value: 1}}).
		SetSort(bson.D{{Key: "createdAt", Value: -1}}).
		SetLimit(SearchSuggestionsMaxSourceScan)
	cursor, err := s.processedItems().Find(ctx, bson.D{
		{Key: "orgId", Value: orgID},
		{Key: "status", Value: string(PipelineStageCompleted)},
	}, opts)
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)
	counts := make(map[string]int)
	order := make([]string, 0, 32)
	for cursor.Next(ctx) {
		var record struct {
			Result OpenJSON `bson:"result"`
		}
		if err := cursor.Decode(&record); err != nil {
			return nil, err
		}
		fields := decodeResultProjection(record.Result)
		source := pickResultString(fields, []string{"source", "sourceName", "source_name", "publisher"})
		if source == "" {
			continue
		}
		if _, ok := counts[source]; !ok {
			order = append(order, source)
		}
		counts[source]++
	}
	if err := cursor.Err(); err != nil {
		return nil, err
	}
	out := make([]SourceCount, 0, len(order))
	for _, source := range order {
		out = append(out, SourceCount{
			Source:           source,
			NormalizedSource: strings.ToLower(source),
			Count:            counts[source],
		})
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Count != out[j].Count {
			return out[i].Count > out[j].Count
		}
		return localeCompare(out[i].Source, out[j].Source) < 0
	})
	return out, nil
}

// SuggestionFields is the typed projection of a processed result used by the
// semantic suggestion recall.
type SuggestionFields struct {
	Topics     []string
	Regions    []string
	Sources    []string
	Sentiments []string
}

// SemanticFieldsForItems loads the newest completed processed document per item
// and extracts the suggestion values.
func (s *mongoStore) SemanticFieldsForItems(
	ctx context.Context,
	orgID string,
	itemMetaIDs []string,
) (map[string]SuggestionFields, error) {
	out := make(map[string]SuggestionFields, len(itemMetaIDs))
	if len(itemMetaIDs) == 0 {
		return out, nil
	}
	opts := options.Find().
		SetProjection(bson.D{
			{Key: "itemMetaId", Value: 1},
			{Key: "tags", Value: 1},
			{Key: "result", Value: 1},
			{Key: "createdAt", Value: 1},
		}).
		SetSort(bson.D{{Key: "createdAt", Value: -1}}).
		SetLimit(len(itemMetaIDs) * 3)
	cursor, err := s.processedItems().Find(ctx, bson.D{
		{Key: "orgId", Value: orgID},
		{Key: "status", Value: string(PipelineStageCompleted)},
		{Key: "itemMetaId", Value: bson.D{{Key: "$in", Value: itemMetaIDs}}},
	}, opts)
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)
	seen := make(map[string]struct{}, len(itemMetaIDs))
	for cursor.Next(ctx) {
		var record struct {
			ItemMetaID string   `bson:"itemMetaId"`
			Tags       []string `bson:"tags"`
			Result     OpenJSON `bson:"result"`
		}
		if err := cursor.Decode(&record); err != nil {
			return nil, err
		}
		itemMetaID := strings.TrimSpace(record.ItemMetaID)
		if itemMetaID == "" {
			continue
		}
		if _, ok := seen[itemMetaID]; ok {
			continue
		}
		seen[itemMetaID] = struct{}{}
		out[itemMetaID] = collectSuggestionValues(record.Tags, record.Result)
	}
	if err := cursor.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// WindowStat is a per-source RSS window aggregate.
type WindowStat struct {
	ItemCountWindow int
	LatestItemAt    *time.Time
}

// RssWindowStats aggregates completed processed documents inside the window.
func (s *mongoStore) RssWindowStats(
	ctx context.Context,
	orgID string,
	sourceIDs []string,
	since time.Time,
) (map[string]WindowStat, error) {
	out := make(map[string]WindowStat, len(sourceIDs))
	if len(sourceIDs) == 0 {
		return out, nil
	}
	pipeline := mongo.Pipeline{
		{{Key: "$match", Value: bson.D{
			{Key: "orgId", Value: orgID},
			{Key: "status", Value: string(PipelineStageCompleted)},
			{Key: "sourceId", Value: bson.D{{Key: "$in", Value: sourceIDs}}},
			{Key: "createdAt", Value: bson.D{{Key: "$gte", Value: since}}},
		}}},
		{{Key: "$group", Value: bson.D{
			{Key: "_id", Value: "$sourceId"},
			{Key: "itemCountWindow", Value: bson.D{{Key: "$sum", Value: 1}}},
			{Key: "latestItemAt", Value: bson.D{{Key: "$max", Value: "$createdAt"}}},
		}}},
	}
	cursor, err := s.processedItems().Aggregate(ctx, pipeline)
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)
	for cursor.Next(ctx) {
		var row struct {
			ID              string    `bson:"_id"`
			ItemCountWindow int       `bson:"itemCountWindow"`
			LatestItemAt    time.Time `bson:"latestItemAt"`
		}
		if err := cursor.Decode(&row); err != nil {
			return nil, err
		}
		if strings.TrimSpace(row.ID) == "" {
			continue
		}
		stat := WindowStat{ItemCountWindow: row.ItemCountWindow}
		if !row.LatestItemAt.IsZero() {
			value := row.LatestItemAt.UTC()
			stat.LatestItemAt = &value
		}
		out[row.ID] = stat
	}
	if err := cursor.Err(); err != nil {
		return nil, err
	}
	return out, nil
}
