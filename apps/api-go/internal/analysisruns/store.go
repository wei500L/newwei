package analysisruns

// This file owns the analysisresults Mongo documents: the initial pending
// insert, the claim/lease token, and the fencing-complete/fail updates.

import (
	"context"
	"fmt"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// analysisResultsCollection is the Mongoose collection shared with NestJS.
const analysisResultsCollection = "analysisresults"

// OutputDocument is the closed set of persisted outputs. The unexported marker
// keeps every new value inside this package instead of an untyped map.
type OutputDocument interface {
	analysisOutput()
}

func (CorrelationOutput) analysisOutput()  {}
func (AnomalyOutput) analysisOutput()      {}
func (GeoTransportOutput) analysisOutput() {}

// PendingRecord is the result of the initial insert: the ObjectId hex and the
// createdAt timestamp the mutation returns.
type PendingRecord struct {
	ID        string
	CreatedAt time.Time
}

// Record is a loaded analysisresults document. Input/Output are BSON leaves;
// the service decodes them into the named input/output types.
type Record struct {
	ID            bson.ObjectID `bson:"_id"`
	OrgID         string        `bson:"orgId"`
	Type          Type          `bson:"type"`
	Status        Status        `bson:"status"`
	Input         bson.RawValue `bson:"input"`
	Output        bson.RawValue `bson:"output"`
	Summary       *string       `bson:"summary"`
	Error         *string       `bson:"error"`
	TriggeredByID *string       `bson:"triggeredById"`
	RunToken      *string       `bson:"runToken"`
	CreatedAt     time.Time     `bson:"createdAt"`
	UpdatedAt     time.Time     `bson:"updatedAt"`
}

// Store persists analysisresults documents in the shared Mongo database.
type Store struct {
	mongo *mongo.Database
}

// NewStore builds the store over the shared Mongo connection.
func NewStore(database *mongo.Database) *Store {
	return &Store{mongo: database}
}

type insertDocument[T any] struct {
	ID            bson.ObjectID `bson:"_id"`
	OrgID         string        `bson:"orgId"`
	Type          Type          `bson:"type"`
	Status        Status        `bson:"status"`
	Input         T             `bson:"input"`
	TriggeredByID *string       `bson:"triggeredById,omitempty"`
	CreatedAt     time.Time     `bson:"createdAt"`
	UpdatedAt     time.Time     `bson:"updatedAt"`
	Version       int           `bson:"__v"`
}

// InsertPending writes the pending document before the job is enqueued. A
// subsequent enqueue failure is returned to the caller and leaves the row
// behind, matching the source's non-transactional boundary.
func InsertPending[T any](
	ctx context.Context,
	store *Store,
	orgID string,
	analysisType Type,
	input T,
	triggeredByID *string,
) (PendingRecord, error) {
	if store == nil || store.mongo == nil {
		return PendingRecord{}, fmt.Errorf("analysisruns: mongo is not configured")
	}
	now := nowMillis()
	document := insertDocument[T]{
		ID:            bson.NewObjectID(),
		OrgID:         orgID,
		Type:          analysisType,
		Status:        StatusPending,
		Input:         input,
		TriggeredByID: triggeredByID,
		CreatedAt:     now,
		UpdatedAt:     now,
	}
	if _, err := store.mongo.Collection(analysisResultsCollection).InsertOne(ctx, document); err != nil {
		return PendingRecord{}, fmt.Errorf("analysisruns: insert pending result: %w", err)
	}
	return PendingRecord{ID: document.ID.Hex(), CreatedAt: now}, nil
}

// Load reads a record by id. A missing document is (Record{}, false, nil).
func (s *Store) Load(ctx context.Context, id bson.ObjectID) (Record, bool, error) {
	if s == nil || s.mongo == nil {
		return Record{}, false, fmt.Errorf("analysisruns: mongo is not configured")
	}
	var record Record
	err := s.mongo.Collection(analysisResultsCollection).FindOne(ctx, bson.D{{Key: "_id", Value: id}}).Decode(&record)
	if err == mongo.ErrNoDocuments {
		return Record{}, false, nil
	}
	if err != nil {
		return Record{}, false, fmt.Errorf("analysisruns: load result: %w", err)
	}
	return record, true, nil
}

// Claim transitions pending/failed/running to running and installs this
// attempt's fencing token.
//
// Recovering a running document is required by GAP-ANALYSIS-001: BullMQ stalled
// recovery re-delivers a job whose previous worker died after writing running.
// The caller only reaches Claim after moveToActive handed it the current lock,
// so the new token is the only lease that may write the terminal state. An old
// worker's conditional update matches zero documents.
func (s *Store) Claim(ctx context.Context, id bson.ObjectID, token string) (Record, bool, error) {
	if s == nil || s.mongo == nil {
		return Record{}, false, fmt.Errorf("analysisruns: mongo is not configured")
	}
	now := nowMillis()
	filter := bson.D{
		{Key: "_id", Value: id},
		{Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{
			string(StatusPending), string(StatusFailed), string(StatusRunning),
		}}}},
	}
	update := bson.D{
		{Key: "$set", Value: bson.D{
			{Key: "status", Value: string(StatusRunning)},
			{Key: "runToken", Value: token},
			{Key: "updatedAt", Value: now},
		}},
		{Key: "$unset", Value: bson.D{{Key: "error", Value: ""}}},
	}
	var record Record
	err := s.mongo.Collection(analysisResultsCollection).FindOneAndUpdate(ctx, filter, update,
		options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&record)
	if err == mongo.ErrNoDocuments {
		return Record{}, false, nil
	}
	if err != nil {
		return Record{}, false, fmt.Errorf("analysisruns: claim result: %w", err)
	}
	return record, true, nil
}

// Complete writes the successful terminal state only while this attempt still
// owns the fencing token. A false return means the lease was superseded; the
// caller must not publish a completed event or notify.
func (s *Store) Complete(ctx context.Context, id bson.ObjectID, token string, output OutputDocument, summary string) (bool, error) {
	if s == nil || s.mongo == nil {
		return false, fmt.Errorf("analysisruns: mongo is not configured")
	}
	filter := bson.D{
		{Key: "_id", Value: id},
		{Key: "runToken", Value: token},
		{Key: "status", Value: string(StatusRunning)},
	}
	update := bson.D{
		{Key: "$set", Value: bson.D{
			{Key: "status", Value: string(StatusCompleted)},
			{Key: "output", Value: output},
			{Key: "summary", Value: summary},
			{Key: "updatedAt", Value: nowMillis()},
		}},
		{Key: "$unset", Value: bson.D{{Key: "error", Value: ""}}},
	}
	result, err := s.mongo.Collection(analysisResultsCollection).UpdateOne(ctx, filter, update)
	if err != nil {
		return false, fmt.Errorf("analysisruns: complete result: %w", err)
	}
	return result.MatchedCount > 0, nil
}

// Fail writes the failed terminal state under the same fencing token. When the
// stream produced a partial summary it is stored; otherwise the previous
// summary is left untouched, matching the source.
func (s *Store) Fail(ctx context.Context, id bson.ObjectID, token, message, partialSummary string, hasPartial bool) (bool, error) {
	if s == nil || s.mongo == nil {
		return false, fmt.Errorf("analysisruns: mongo is not configured")
	}
	filter := bson.D{
		{Key: "_id", Value: id},
		{Key: "runToken", Value: token},
		{Key: "status", Value: string(StatusRunning)},
	}
	set := bson.D{
		{Key: "status", Value: string(StatusFailed)},
		{Key: "error", Value: message},
		{Key: "updatedAt", Value: nowMillis()},
	}
	if hasPartial {
		set = append(set, bson.E{Key: "summary", Value: partialSummary})
	}
	update := bson.D{{Key: "$set", Value: set}}
	result, err := s.mongo.Collection(analysisResultsCollection).UpdateOne(ctx, filter, update)
	if err != nil {
		return false, fmt.Errorf("analysisruns: fail result: %w", err)
	}
	return result.MatchedCount > 0, nil
}

// decodeInput decodes a stored input leaf into the named input type.
func decodeInput[T any](raw bson.RawValue) (T, error) {
	var out T
	if raw.IsZero() || raw.Type == bson.TypeNull || raw.Type == bson.TypeUndefined {
		return out, fmt.Errorf("analysisruns: result input is missing")
	}
	if err := raw.Unmarshal(&out); err != nil {
		return out, fmt.Errorf("analysisruns: decode result input: %w", err)
	}
	return out, nil
}

func nowMillis() time.Time {
	return time.Now().UTC().Truncate(time.Millisecond)
}
