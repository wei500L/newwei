package newseventsingest

import (
	"bytes"
	"encoding/json"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// bsonDocument embeds a BSON document as a value. A bare bson.Raw field would be
// encoded as a binary blob, so every document-valued field uses this type.
type bsonDocument bson.Raw

// MarshalBSON returns the embedded document bytes unchanged.
func (d bsonDocument) MarshalBSON() ([]byte, error) { return []byte(d), nil }

// taskLogDocument is one tasklogs document, matching the Mongoose TaskLog schema
// (queue, jobId, orgId, stage, status, optional message/data, timestamps and the
// version key).
type taskLogDocument struct {
	Queue     string       `bson:"queue"`
	JobID     string       `bson:"jobId"`
	OrgID     string       `bson:"orgId"`
	Stage     string       `bson:"stage"`
	Status    string       `bson:"status"`
	Message   *string      `bson:"message,omitempty"`
	Data      bsonDocument `bson:"data,omitempty"`
	CreatedAt time.Time    `bson:"createdAt"`
	UpdatedAt time.Time    `bson:"updatedAt"`
	Version   int          `bson:"__v"`
}

// TaskLog stage and status literals.
const (
	taskLogQueueNewsEvents        = "news_events"
	categoryGateStage             = "category_gate"
	bertopicClusterStage          = "bertopic_cluster"
	bertopicFailureQueueStage     = "bertopic_failure_queue"
	taskLogStatusCompleted        = "completed"
	taskLogStatusFailed           = "failed"
	categoryGateDecisionAccepted  = "accepted"
	categoryGateDecisionPenalized = "penalized"
	categoryGateDecisionReject    = "reject"
	categoryGateSkippedDisabled   = "skipped_disabled"
	categoryGateNoSignalCategory  = "skipped_no_signal_category"
	categoryGateLowConfidence     = "skipped_low_signal_confidence"
	categoryGateNoEventCategory   = "skipped_no_event_category"
)

// categoryGateDecision is one NewsEventItem-free decision record.
type categoryGateDecision string

// categoryGateLogData is the `data` payload of a category_gate TaskLog.
//
// The field order is the order the NestJS object literal produces after the
// `{...base, ...branch}` spread: the six base members first, then the branch
// members in the order they appear in the source, with the members a branch
// does not set omitted. signalCategory is set twice in the source (the raw
// signal value in the base, the normalized value in most branches); the spread
// keeps the base position and the branch value, which is what this single field
// models.
type categoryGateLogData struct {
	Decision                     categoryGateDecision `bson:"decision"`
	ProcessedItemID              *string              `bson:"processedItemId"`
	ProcessedArticleID           string               `bson:"processedArticleId"`
	SignalCategory               *string              `bson:"signalCategory"`
	SignalCategoryPath           *string              `bson:"signalCategoryPath"`
	SignalConfidence             *float64             `bson:"signalConfidence"`
	Score                        float64              `bson:"score"`
	AdjustedScore                *float64             `bson:"adjustedScore,omitempty"`
	MinCategoryConfidenceForGate *float64             `bson:"minCategoryConfidenceForGate,omitempty"`
	EventCategory                *string              `bson:"eventCategory,omitempty"`
	SignalPath                   *string              `bson:"signalPath,omitempty"`
	EventPath                    *string              `bson:"eventPath,omitempty"`
}

// bertopicClusterLogData is the `data` payload of a bertopic_cluster TaskLog.
type bertopicClusterLogData struct {
	RequestID      string       `bson:"requestId"`
	Language       *string      `bson:"language"`
	EmbeddingModel *string      `bson:"embeddingModel"`
	ClusterCount   int          `bson:"clusterCount"`
	OutlierCount   int          `bson:"outlierCount"`
	DocumentCount  int          `bson:"documentCount"`
	Diagnostics    bsonDocument `bson:"diagnostics,omitempty"`
}

// bertopicFailureLogData is the `data` payload of a bertopic_failure_queue
// TaskLog.
type bertopicFailureLogData struct {
	FailureReason  string  `bson:"failureReason"`
	ClusteringMode string  `bson:"clusteringMode"`
	ItemCount      int     `bson:"itemCount"`
	Language       *string `bson:"language"`
	EmbeddingModel *string `bson:"embeddingModel"`
}

// marshalDocument encodes one typed data payload as a BSON document.
func marshalDocument(payload any) (bsonDocument, error) {
	encoded, err := bson.Marshal(payload)
	if err != nil {
		return nil, err
	}
	return bsonDocument(encoded), nil
}

// jsonLeafToBSONDocument converts one JSON value to the BSON document Mongoose
// writes for a parsed JavaScript object: member order preserved and every number
// stored as a double (JavaScript has a single number type).
//
// bson.D/bson.A are the driver's own document containers — the BSON equivalent
// of a JSON object and array — so they are the only schema-less carriers here;
// no business value is exposed through them.
func jsonLeafToBSONDocument(raw json.RawMessage) (bsonDocument, bool, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || string(trimmed) == "null" {
		return nil, false, nil
	}
	if trimmed[0] != '{' {
		return nil, false, errInvalidJSONLeaf
	}
	var document bson.D
	if err := bson.UnmarshalExtJSON(trimmed, false, &document); err != nil {
		return nil, false, err
	}
	encoded, err := bson.Marshal(nativeBSONDocument(document))
	if err != nil {
		return nil, false, err
	}
	return bsonDocument(encoded), true, nil
}

// nativeBSONDocument rewrites one document so every number is a BSON double.
func nativeBSONDocument(document bson.D) bson.D {
	rewritten := make(bson.D, 0, len(document))
	for _, element := range document {
		rewritten = append(rewritten, bson.E{Key: element.Key, Value: nativeBSONValue(element.Value)})
	}
	return rewritten
}

// nativeBSONValue converts one raw value to its JavaScript-typed Go value so the
// re-encode stores numbers as doubles. A type this converter does not model is
// returned as the original raw value, which the encoder writes unchanged.
func nativeBSONValue(value bson.RawValue) any {
	if number, ok := value.DoubleOK(); ok {
		return number
	}
	if number, ok := value.Int32OK(); ok {
		return float64(number)
	}
	if number, ok := value.Int64OK(); ok {
		return float64(number)
	}
	if text, ok := value.StringValueOK(); ok {
		return text
	}
	if boolean, ok := value.BooleanOK(); ok {
		return boolean
	}
	if value.Type == bson.TypeNull || value.Type == bson.TypeUndefined {
		return nil
	}
	if nested, ok := value.DocumentOK(); ok {
		var document bson.D
		if err := bson.Unmarshal(nested, &document); err != nil {
			return value
		}
		return nativeBSONDocument(document)
	}
	if array, ok := value.ArrayOK(); ok {
		values, err := bson.Raw(array).Values()
		if err != nil {
			return value
		}
		return nativeBSONArray(values)
	}
	return value
}

// nativeBSONArray rewrites one array so every number is a BSON double.
func nativeBSONArray(values []bson.RawValue) bson.A {
	rewritten := make(bson.A, 0, len(values))
	for _, value := range values {
		rewritten = append(rewritten, nativeBSONValue(value))
	}
	return rewritten
}
