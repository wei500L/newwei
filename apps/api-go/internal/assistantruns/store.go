package assistantruns

import (
	"context"
	"errors"
	"log"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/wei500L/newwei/apps/api-go/internal/assistantqueue"
)

// collection is the Mongoose "AssistantRun" collection name.
const collection = "assistantruns"

// rawItemCollection and processedItemCollection are the Mongoose collection
// names renderNewsItems reads.
const (
	rawItemCollection       = "rawitems"
	processedItemCollection = "processeditems"
)

// bsonDocument embeds a BSON document as a value. A bare bson.Raw field would
// be encoded as a binary blob, so every document-valued field uses this type.
type bsonDocument bson.Raw

// MarshalBSON returns the embedded document bytes unchanged.
func (d bsonDocument) MarshalBSON() ([]byte, error) { return []byte(d), nil }

// runInsert is one new AssistantRun document. It is the subset Mongoose writes
// with timestamps plus __v; optional keys stay absent like an undefined value.
type runInsert struct {
	ID             bson.ObjectID `bson:"_id"`
	OrgID          string        `bson:"orgId"`
	Type           RunType       `bson:"type"`
	Status         RunStatus     `bson:"status"`
	ConversationID *string       `bson:"conversationId,omitempty"`
	Input          bsonDocument  `bson:"input"`
	TriggeredByID  *string       `bson:"triggeredById,omitempty"`
	CreatedAt      time.Time     `bson:"createdAt"`
	UpdatedAt      time.Time     `bson:"updatedAt"`
	Version        int           `bson:"__v"`
}

// createdRun is the projection the submit mutations return.
type createdRun struct {
	orgID          string
	ID             string
	Type           RunType
	Status         RunStatus
	ConversationID *string
	CreatedAt      time.Time
}

// runRecord is one claimed run with its raw input/output documents.
type runRecord struct {
	ID             bson.ObjectID
	OrgID          string
	Type           RunType
	Status         RunStatus
	ConversationID *string
	Input          bson.Raw
	Output         bson.Raw
	Summary        *string
	Error          *string
	CreatedAt      time.Time
}

type runDocument struct {
	ID             bson.ObjectID `bson:"_id"`
	OrgID          string        `bson:"orgId"`
	Type           RunType       `bson:"type"`
	Status         RunStatus     `bson:"status"`
	ConversationID bson.RawValue `bson:"conversationId"`
	Input          bson.RawValue `bson:"input"`
	Output         bson.RawValue `bson:"output"`
	Summary        bson.RawValue `bson:"summary"`
	Error          bson.RawValue `bson:"error"`
	CreatedAt      bson.RawValue `bson:"createdAt"`
}

// historyDocument is the conversation-history projection.
type historyDocument struct {
	Input     bson.RawValue `bson:"input"`
	Output    bson.RawValue `bson:"output"`
	Summary   bson.RawValue `bson:"summary"`
	CreatedAt bson.RawValue `bson:"createdAt"`
}

// Store owns the AssistantRun and news-rendering Mongo reads/writes. Every
// query is org-scoped except the rawitem lookup, which is keyed by the
// organization's own item refs exactly like the NestJS RawItemModel.find.
type Store struct {
	mongo *mongo.Database
}

// NewStore binds the store to the shared Mongo database.
func NewStore(database *mongo.Database) *Store {
	return &Store{mongo: database}
}

func (s *Store) collection(name string) (*mongo.Collection, error) {
	if s == nil || s.mongo == nil {
		return nil, errors.New("mongo is not configured")
	}
	return s.mongo.Collection(name), nil
}

// insert creates one run document and returns its id and creation time.
func (s *Store) insert(ctx context.Context, orgID string, typ RunType, conversationID *string, input bson.Raw, triggeredBy *string) (createdRun, error) {
	collection, err := s.collection("assistantruns")
	if err != nil {
		return createdRun{}, err
	}
	now := time.Now().UTC()
	doc := runInsert{
		ID:             bson.NewObjectID(),
		OrgID:          orgID,
		Type:           typ,
		Status:         RunStatusPending,
		ConversationID: conversationID,
		Input:          bsonDocument(input),
		TriggeredByID:  triggeredBy,
		CreatedAt:      now,
		UpdatedAt:      now,
	}
	if _, err := collection.InsertOne(ctx, doc); err != nil {
		return createdRun{}, err
	}
	return createdRun{orgID: orgID, ID: doc.ID.Hex(), Type: typ, Status: RunStatusPending, ConversationID: conversationID, CreatedAt: now}, nil
}

// CreateQuery creates a pending query run.
func (s *Store) CreateQuery(ctx context.Context, orgID string, input QueryInput, triggeredBy *string) (createdRun, error) {
	raw, err := bson.Marshal(input)
	if err != nil {
		return createdRun{}, err
	}
	conversationID := input.ConversationID
	return s.insert(ctx, orgID, RunTypeQuery, &conversationID, bson.Raw(raw), triggeredBy)
}

// CreateReport creates a pending report run.
func (s *Store) CreateReport(ctx context.Context, orgID string, input ReportInput, triggeredBy *string) (createdRun, error) {
	raw, err := bson.Marshal(input)
	if err != nil {
		return createdRun{}, err
	}
	return s.insert(ctx, orgID, RunTypeReport, nil, bson.Raw(raw), triggeredBy)
}

// CreateForecast creates a pending forecast run.
func (s *Store) CreateForecast(ctx context.Context, orgID string, input ForecastInput, triggeredBy *string) (createdRun, error) {
	raw, err := bson.Marshal(input)
	if err != nil {
		return createdRun{}, err
	}
	return s.insert(ctx, orgID, RunTypeForecast, nil, bson.Raw(raw), triggeredBy)
}

// claimStatuses is the A2 claim predicate: pending and failed are the normal
// retry states; a job recovered by the stalled detector (stc > 0) may also
// claim its still-running record. BullMQ guarantees one lock holder, so this
// cannot race a live handler.
func claimStatuses(stalledCounter int) []RunStatus {
	statuses := []RunStatus{RunStatusPending, RunStatusFailed}
	if stalledCounter > 0 {
		statuses = append(statuses, RunStatusRunning)
	}
	return statuses
}

// Claim moves a run to running and returns it.
func (s *Store) Claim(ctx context.Context, job assistantqueue.ClaimedJob) (*runRecord, error) {
	collection, err := s.collection("assistantruns")
	if err != nil {
		return nil, err
	}
	objectID, err := bson.ObjectIDFromHex(job.Data.RunID)
	if err != nil {
		return nil, err
	}
	statuses := claimStatuses(job.StalledCounter)
	filter := bson.D{
		{Key: "_id", Value: objectID},
		{Key: "status", Value: bson.D{{Key: "$in", Value: statuses}}},
	}
	update := bson.D{
		{Key: "$set", Value: bson.D{
			{Key: "status", Value: RunStatusRunning},
			{Key: "updatedAt", Value: time.Now().UTC()},
		}},
		{Key: "$unset", Value: bson.D{{Key: "error", Value: ""}}},
	}
	var doc runDocument
	err = collection.FindOneAndUpdate(ctx, filter, update, options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&doc)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return doc.toRecord(), nil
}

func (d runDocument) toRecord() *runRecord {
	record := &runRecord{
		ID:     d.ID,
		OrgID:  d.OrgID,
		Type:   d.Type,
		Status: d.Status,
	}
	if d.ConversationID.Type == bson.TypeString {
		value := d.ConversationID.StringValue()
		record.ConversationID = &value
	}
	if d.Input.Type == bson.TypeEmbeddedDocument {
		record.Input = bson.Raw(d.Input.Document())
	}
	if d.Output.Type == bson.TypeEmbeddedDocument {
		record.Output = bson.Raw(d.Output.Document())
	}
	if d.Summary.Type == bson.TypeString {
		value := d.Summary.StringValue()
		record.Summary = &value
	}
	if d.Error.Type == bson.TypeString {
		value := d.Error.StringValue()
		record.Error = &value
	}
	if d.CreatedAt.Type == bson.TypeDateTime {
		record.CreatedAt = time.UnixMilli(d.CreatedAt.DateTime()).UTC()
	}
	return record
}

// SaveCompleted writes status=completed, output and summary, and clears error.
func (s *Store) SaveCompleted(ctx context.Context, runID string, orgID string, output bson.Raw, summary string) error {
	return s.save(ctx, runID, orgID, bson.D{
		{Key: "status", Value: RunStatusCompleted},
		{Key: "output", Value: bsonDocument(output)},
		{Key: "summary", Value: summary},
	}, true)
}

// SaveFailed writes status=failed and the error. summary is only changed for a
// partial stream summary, matching the NestJS branch.
func (s *Store) SaveFailed(ctx context.Context, runID string, orgID string, errMessage string, summary *string) error {
	set := bson.D{
		{Key: "status", Value: RunStatusFailed},
		{Key: "error", Value: errMessage},
	}
	if summary != nil {
		set = append(set, bson.E{Key: "summary", Value: *summary})
	}
	return s.save(ctx, runID, orgID, set, false)
}

// SaveBlocked writes the guardrail refusal as a completed run with a blocked
// output and no error.
func (s *Store) SaveBlocked(ctx context.Context, runID string, orgID string, output BlockedOutput) error {
	raw, err := bson.Marshal(output)
	if err != nil {
		return err
	}
	return s.save(ctx, runID, orgID, bson.D{
		{Key: "status", Value: RunStatusCompleted},
		{Key: "output", Value: bsonDocument(raw)},
		{Key: "summary", Value: output.Summary},
	}, true)
}

// save performs updateOne({_id, orgId}). A zero match is a warning, never an
// upsert: if deleteRun removed the record while the job was running, the job
// ends without recreating it (Q1).
func (s *Store) save(ctx context.Context, runID string, orgID string, set bson.D, clearError bool) error {
	collection, err := s.collection("assistantruns")
	if err != nil {
		return err
	}
	objectID, err := bson.ObjectIDFromHex(runID)
	if err != nil {
		return err
	}
	set = append(set, bson.E{Key: "updatedAt", Value: time.Now().UTC()})
	update := bson.D{{Key: "$set", Value: set}}
	if clearError {
		update = append(update, bson.E{Key: "$unset", Value: bson.D{{Key: "error", Value: ""}}})
	}
	result, err := collection.UpdateOne(ctx, bson.D{
		{Key: "_id", Value: objectID},
		{Key: "orgId", Value: orgID},
	}, update)
	if err != nil {
		return err
	}
	if result.MatchedCount == 0 {
		log.Printf("api-go: assistant run %s no longer exists; result was not written", runID)
	}
	return nil
}

// runState is the deleteRun projection.
type runState struct {
	Type   RunType
	Status RunStatus
}

// GetState reads {type,status} by _id and orgId. A malformed id or a read
// error returns (nil, false), exactly like the NestJS try/catch.
func (s *Store) GetState(ctx context.Context, orgID, runID string) (*runState, bool) {
	collection, err := s.collection("assistantruns")
	if err != nil {
		return nil, false
	}
	objectID, err := bson.ObjectIDFromHex(runID)
	if err != nil {
		return nil, false
	}
	var doc struct {
		Type   RunType   `bson:"type"`
		Status RunStatus `bson:"status"`
	}
	err = collection.FindOne(ctx, bson.D{
		{Key: "_id", Value: objectID},
		{Key: "orgId", Value: orgID},
	}, options.FindOne().SetProjection(bson.D{
		{Key: "type", Value: 1},
		{Key: "status", Value: 1},
	})).Decode(&doc)
	if err != nil {
		return nil, false
	}
	return &runState{Type: doc.Type, Status: doc.Status}, true
}

// Delete removes the run by _id and orgId. It reports whether a document was
// deleted.
func (s *Store) Delete(ctx context.Context, orgID, runID string) (bool, error) {
	collection, err := s.collection("assistantruns")
	if err != nil {
		return false, err
	}
	objectID, err := bson.ObjectIDFromHex(runID)
	if err != nil {
		return false, nil
	}
	result, err := collection.DeleteOne(ctx, bson.D{
		{Key: "_id", Value: objectID},
		{Key: "orgId", Value: orgID},
	})
	if err != nil {
		return false, err
	}
	return result.DeletedCount > 0, nil
}

// History reads the last ten earlier query runs of one conversation, newest
// first, with the same projection and filters as
// buildQueryConversationHistoryMessages.
func (s *Store) History(ctx context.Context, orgID, conversationID, runID string, before time.Time) ([]historyDocument, error) {
	collection, err := s.collection("assistantruns")
	if err != nil {
		return nil, err
	}
	objectID, err := bson.ObjectIDFromHex(runID)
	if err != nil {
		return nil, err
	}
	cursor, err := collection.Find(ctx, bson.D{
		{Key: "orgId", Value: orgID},
		{Key: "type", Value: RunTypeQuery},
		{Key: "conversationId", Value: conversationID},
		{Key: "createdAt", Value: bson.D{{Key: "$lt", Value: before}}},
		{Key: "_id", Value: bson.D{{Key: "$ne", Value: objectID}}},
	}, options.Find().SetProjection(bson.D{
		{Key: "input", Value: 1},
		{Key: "output", Value: 1},
		{Key: "summary", Value: 1},
		{Key: "createdAt", Value: 1},
	}).SetSort(bson.D{
		{Key: "createdAt", Value: -1},
		{Key: "_id", Value: -1},
	}).SetLimit(10))
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)
	var docs []historyDocument
	if err := cursor.All(ctx, &docs); err != nil {
		return nil, err
	}
	return docs, nil
}

// renderedNewsItem is one projection of renderNewsItems' aggregation.
type processedResult struct {
	Title      *string `bson:"title"`
	Summary    *string `bson:"summary"`
	Sentiment  *string `bson:"sentiment"`
	SentimentL *string `bson:"sentiment_label"`
	Published  *string `bson:"published_at"`
}

type processedGroup struct {
	ItemMetaID string           `bson:"itemMetaId"`
	Result     *processedResult `bson:"result"`
}

type rawPayload struct {
	URL        *string `bson:"url"`
	SourceName *string `bson:"sourceName"`
}

type rawItemDocument struct {
	ID      bson.ObjectID `bson:"_id"`
	Payload *rawPayload   `bson:"payload"`
}

// RenderNewsItems ports renderNewsItems: load the raw payloads by mongoRef and
// the latest completed processed result per item meta id, then merge. The
// processed aggregation is org-scoped; the raw lookup is keyed by the caller's
// own mongoRefs.
func (s *Store) RenderNewsItems(ctx context.Context, orgID string, rows []NewsSourceRow) ([]RenderedItem, error) {
	itemMetaIDs := make([]string, 0, len(rows))
	mongoRefs := make([]bson.ObjectID, 0, len(rows))
	for _, row := range rows {
		itemMetaIDs = append(itemMetaIDs, row.ID)
		if row.MongoRef != nil && *row.MongoRef != "" {
			if objectID, err := bson.ObjectIDFromHex(*row.MongoRef); err == nil {
				mongoRefs = append(mongoRefs, objectID)
			}
		}
	}
	rawByRef := make(map[string]rawPayload)
	if len(mongoRefs) > 0 {
		collection, err := s.collection(rawItemCollection)
		if err != nil {
			return nil, err
		}
		cursor, err := collection.Find(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: mongoRefs}}}},
			options.Find().SetProjection(bson.D{
				{Key: "payload.url", Value: 1},
				{Key: "payload.sourceName", Value: 1},
			}))
		if err != nil {
			return nil, err
		}
		var docs []rawItemDocument
		if err := cursor.All(ctx, &docs); err != nil {
			cursor.Close(ctx)
			return nil, err
		}
		_ = cursor.Close(ctx)
		for _, doc := range docs {
			if doc.Payload != nil {
				rawByRef[doc.ID.Hex()] = *doc.Payload
			}
		}
	}
	processedByMeta := make(map[string]processedResult)
	if len(itemMetaIDs) > 0 {
		collection, err := s.collection(processedItemCollection)
		if err != nil {
			return nil, err
		}
		pipeline := bson.A{
			bson.D{{Key: "$match", Value: bson.D{
				{Key: "orgId", Value: orgID},
				{Key: "itemMetaId", Value: bson.D{{Key: "$in", Value: itemMetaIDs}}},
				{Key: "status", Value: "completed"},
				{Key: "duplicateOf", Value: nil},
			}}},
			bson.D{{Key: "$sort", Value: bson.D{
				{Key: "itemMetaId", Value: 1},
				{Key: "createdAt", Value: -1},
			}}},
			bson.D{{Key: "$group", Value: bson.D{
				{Key: "_id", Value: "$itemMetaId"},
				{Key: "result", Value: bson.D{{Key: "$first", Value: "$result"}}},
			}}},
			bson.D{{Key: "$project", Value: bson.D{
				{Key: "_id", Value: 0},
				{Key: "itemMetaId", Value: "$_id"},
				{Key: "result", Value: bson.D{
					{Key: "title", Value: "$result.title"},
					{Key: "summary", Value: "$result.summary"},
					{Key: "sentiment_label", Value: "$result.sentiment_label"},
					{Key: "sentiment", Value: "$result.sentiment"},
					{Key: "published_at", Value: "$result.published_at"},
				}},
			}}},
		}
		cursor, err := collection.Aggregate(ctx, pipeline)
		if err != nil {
			return nil, err
		}
		var groups []processedGroup
		if err := cursor.All(ctx, &groups); err != nil {
			cursor.Close(ctx)
			return nil, err
		}
		_ = cursor.Close(ctx)
		for _, group := range groups {
			if group.Result == nil {
				continue
			}
			if _, exists := processedByMeta[group.ItemMetaID]; exists {
				continue
			}
			processedByMeta[group.ItemMetaID] = *group.Result
		}
	}
	return mergeRenderedNews(rows, rawByRef, processedByMeta), nil
}

// mergeRenderedNews is the pure merge of the item list, the raw payloads and
// the latest processed result. It mirrors the final object literal of
// renderNewsItems: title falls back to the meta name, sentiment prefers
// sentiment_label, publishedAt prefers the processed value and URL/source come
// from the raw payload.
func mergeRenderedNews(rows []NewsSourceRow, rawByRef map[string]rawPayload, processedByMeta map[string]processedResult) []RenderedItem {
	out := make([]RenderedItem, 0, len(rows))
	for _, row := range rows {
		item := RenderedItem{ItemMetaID: row.ID, Title: row.Name}
		if row.PublishedAt != nil {
			value := row.PublishedAt.UTC().Format("2006-01-02T15:04:05.000Z")
			item.PublishedAt = &value
		}
		if row.MongoRef != nil {
			if payload, ok := rawByRef[*row.MongoRef]; ok {
				item.URL = payload.URL
				item.Source = payload.SourceName
			}
		}
		if result, ok := processedByMeta[row.ID]; ok {
			if result.Title != nil {
				item.Title = result.Title
			}
			item.Summary = result.Summary
			if result.SentimentL != nil {
				item.Sentiment = result.SentimentL
			} else {
				item.Sentiment = result.Sentiment
			}
			if result.Published != nil {
				item.PublishedAt = result.Published
			}
		}
		out = append(out, item)
	}
	return out
}

// NewsSourceRow is the item-list projection the renderer consumes. It is the
// subset of itemsreading.ItemMetaRow renderNewsItems reads.
type NewsSourceRow struct {
	ID          string
	MongoRef    *string
	Name        *string
	PublishedAt *time.Time
}
