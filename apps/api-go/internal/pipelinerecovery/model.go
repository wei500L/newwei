package pipelinerecovery

import (
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// jsISOLayout is Date.prototype.toISOString: millisecond precision, UTC.
const jsISOLayout = "2006-01-02T15:04:05.000Z"

// formatJSTime renders a time the way NestJS serializes a Date.
func formatJSTime(value time.Time) string {
	return value.UTC().Format(jsISOLayout)
}

// nowMillis is the millisecond-truncated UTC clock used for fallbacks.
func nowMillis() time.Time {
	return time.Now().UTC().Truncate(time.Millisecond)
}

// rawStored reports whether a BSON field exists at all.
func rawStored(value bson.RawValue) bool {
	return value.Type != 0 && value.Type != bson.TypeUndefined
}

// rawString decodes a BSON string; every other type reads as absent, which is
// what Mongoose sees as a non-string value.
func rawString(value bson.RawValue) *string {
	if value.Type != bson.TypeString {
		return nil
	}
	var decoded string
	if err := value.Unmarshal(&decoded); err != nil {
		return nil
	}
	return &decoded
}

// rawTime decodes a BSON date.
func rawTime(value bson.RawValue) *time.Time {
	if value.Type != bson.TypeDateTime {
		return nil
	}
	var decoded time.Time
	if err := value.Unmarshal(&decoded); err != nil {
		return nil
	}
	return &decoded
}

// rawObjectIDString renders an ObjectID field as its hex string.
func rawObjectIDString(value bson.RawValue) string {
	if value.Type != bson.TypeObjectID {
		return ""
	}
	var decoded bson.ObjectID
	if err := value.Unmarshal(&decoded); err != nil {
		return ""
	}
	return decoded.Hex()
}

// RunStage is one stage entry of a run.
type RunStage struct {
	Stage  string      `json:"stage"`
	Status string      `json:"status"`
	At     string      `json:"at"`
	Error  *StageError `json:"error"`
}

// StageError mirrors the error sub-object. NestJS builds it from the stored
// error document and drops the keys whose value is not a string (undefined is
// not serialized), hence omitempty on the two pointers.
type StageError struct {
	Name    *string `json:"name,omitempty"`
	Message *string `json:"message,omitempty"`
}

// RunSummary is one processed-item run.
type RunSummary struct {
	JobID           string     `json:"jobId"`
	RawItemID       string     `json:"rawItemId"`
	ProcessedItemID string     `json:"processedItemId"`
	Status          string     `json:"status"`
	CreatedAt       string     `json:"createdAt"`
	UpdatedAt       string     `json:"updatedAt"`
	Stages          []RunStage `json:"stages"`
}

// RunsResponse is the GET runs body.
type RunsResponse struct {
	ItemMetaID string       `json:"itemMetaId"`
	ItemStatus string       `json:"itemStatus"`
	MongoRef   string       `json:"mongoRef"`
	Runs       []RunSummary `json:"runs"`
}

// itemMetaRow is the MySQL projection of ItemMeta.
type itemMetaRow struct {
	ID       string
	Status   string
	MongoRef string
}

// processedItemRow is the ProcessedItem projection used to build runs.
type processedItemRow struct {
	ID        bson.RawValue `bson:"_id"`
	RawItemID bson.RawValue `bson:"rawItemId"`
	Status    bson.RawValue `bson:"status"`
	CreatedAt bson.RawValue `bson:"createdAt"`
	UpdatedAt bson.RawValue `bson:"updatedAt"`
}

// taskLogRow is the TaskLog projection used to build stages.
type taskLogRow struct {
	JobID     bson.RawValue `bson:"jobId"`
	Stage     bson.RawValue `bson:"stage"`
	Status    bson.RawValue `bson:"status"`
	Error     bson.RawValue `bson:"error"`
	CreatedAt bson.RawValue `bson:"createdAt"`
}

// stageErrorFromRaw mirrors the NestJS mapping: a truthy stored error becomes an
// object whose name/message are filled only when they are strings.
func stageErrorFromRaw(value bson.RawValue) *StageError {
	if !rawStored(value) || value.Type == bson.TypeNull {
		return nil
	}
	stageError := &StageError{}
	if value.Type != bson.TypeEmbeddedDocument {
		return stageError
	}
	var document struct {
		Name    bson.RawValue `bson:"name"`
		Message bson.RawValue `bson:"message"`
	}
	if err := value.Unmarshal(&document); err != nil {
		return stageError
	}
	stageError.Name = rawString(document.Name)
	stageError.Message = rawString(document.Message)
	return stageError
}

// statusString mirrors `String(log.status ?? "pending")` and
// `String(record.status ?? "unknown")` for the values both writers use: the
// schema enforces a string enum, so a non-string value falls back instead of
// rendering JavaScript's "[object Object]".
func statusString(value bson.RawValue, fallback string) string {
	if decoded := rawString(value); decoded != nil {
		return *decoded
	}
	return fallback
}
