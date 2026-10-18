package rsstranslation

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/wei500L/newwei/apps/api-go/internal/itemsreading"
)

// processedItemsCollection is the Mongoose ProcessedItemModel collection.
const processedItemsCollection = "processeditems"

// processedStatusCompleted is the completed pipeline status stored on the
// processed document.
const processedStatusCompleted = "completed"

// processedRecord is the projected translation source of one item. An item
// whose newest document exists but carries no usable result is still present in
// the map with empty fields, so the caller emits an itemId-only translation.
type processedRecord struct {
	Title           *string
	Summary         *string
	KeyPoints       []string
	CleanedMarkdown *string
}

// fetchLatestProcessedRecords selects the newest completed processed document
// per item entirely inside Mongo.
//
// The NestJS implementation loads every historical result for the requested
// items and keeps the first row after a `createdAt DESC` sort. This port pushes
// that selection into the database with a $sort + $group pipeline so only one
// document per item ever reaches Go. The sort keeps `createdAt DESC` and adds
// `_id DESC` as a deterministic tie-breaker for documents created in the same
// millisecond, where the JavaScript Map.set loop depended on the undefined
// order of equal keys. The tenant filter (orgId), the completed status and the
// item id set are exactly the NestJS query; no extra restriction such as
// duplicateOf is added.
func (s *Service) fetchLatestProcessedRecords(ctx context.Context, orgID string, itemIDs []string) (map[string]processedRecord, error) {
	if s.mongo == nil {
		return nil, errors.New("mongo is not configured")
	}
	pipeline := mongo.Pipeline{
		bson.D{{Key: "$match", Value: bson.D{
			{Key: "orgId", Value: orgID},
			{Key: "status", Value: processedStatusCompleted},
			{Key: "itemMetaId", Value: bson.D{{Key: "$in", Value: itemIDs}}},
		}}},
		bson.D{{Key: "$sort", Value: bson.D{
			{Key: "createdAt", Value: -1},
			{Key: "_id", Value: -1},
		}}},
		bson.D{{Key: "$group", Value: bson.D{
			{Key: "_id", Value: "$itemMetaId"},
			{Key: "itemMetaId", Value: bson.D{{Key: "$first", Value: "$itemMetaId"}}},
			{Key: "result", Value: bson.D{{Key: "$first", Value: "$result"}}},
		}}},
		bson.D{{Key: "$project", Value: bson.D{
			{Key: "itemMetaId", Value: 1},
			{Key: "result", Value: 1},
		}}},
	}
	cursor, err := s.mongo.Collection(processedItemsCollection).Aggregate(ctx, pipeline)
	if err != nil {
		return nil, err
	}
	defer func() { _ = cursor.Close(ctx) }()

	out := make(map[string]processedRecord, len(itemIDs))
	for cursor.Next(ctx) {
		var row struct {
			ItemMetaID string                `bson:"itemMetaId"`
			Result     itemsreading.OpenJSON `bson:"result"`
		}
		if err := cursor.Decode(&row); err != nil {
			return nil, err
		}
		id := strings.TrimSpace(row.ItemMetaID)
		if id == "" {
			continue
		}
		if _, exists := out[id]; exists {
			continue
		}
		out[id] = decodeProcessedResult(row.Result)
	}
	if err := cursor.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// processedResultFields is the typed leaf view of one processed result. Leaves
// keep the raw JSON so a non-string title or a wrong-typed key_points entry is
// dropped per field, exactly like the JavaScript normalize helpers, instead of
// failing the whole document.
type processedResultFields struct {
	Title           json.RawMessage `json:"title"`
	Headline        json.RawMessage `json:"headline"`
	Summary         json.RawMessage `json:"summary"`
	Abstract        json.RawMessage `json:"abstract"`
	KeyPoints       json.RawMessage `json:"key_points"`
	CleanedMarkdown json.RawMessage `json:"cleaned_markdown"`
}

// decodeProcessedResult ports parseProcessedResult plus the field projection:
// the result may be an object or a JSON string (including a double-encoded
// one). An absent, blank, malformed, array or scalar result becomes an empty
// field payload instead of falling back to an older document.
func decodeProcessedResult(raw itemsreading.OpenJSON) processedRecord {
	value := raw.Bytes()
	for {
		trimmed := strings.TrimSpace(string(value))
		if trimmed == "" || trimmed == "null" {
			return processedRecord{}
		}
		if trimmed[0] == '"' {
			var inner string
			if err := json.Unmarshal([]byte(trimmed), &inner); err != nil {
				return processedRecord{}
			}
			value = []byte(inner)
			continue
		}
		if trimmed[0] != '{' {
			return processedRecord{}
		}
		value = []byte(trimmed)
		break
	}
	var fields processedResultFields
	if err := json.Unmarshal(value, &fields); err != nil {
		return processedRecord{}
	}
	return processedRecord{
		Title:           firstNonEmptyPtr(rawTextValue(fields.Title), rawTextValue(fields.Headline)),
		Summary:         firstNonEmptyPtr(rawTextValue(fields.Summary), rawTextValue(fields.Abstract)),
		KeyPoints:       rawTextList(fields.KeyPoints),
		CleanedMarkdown: rawTextValue(fields.CleanedMarkdown),
	}
}

// rawTextValue mirrors normalizeNonEmptyString for one raw JSON leaf.
func rawTextValue(raw json.RawMessage) *string {
	if len(raw) == 0 {
		return nil
	}
	var text string
	if err := json.Unmarshal(raw, &text); err != nil {
		return nil
	}
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

// rawTextList mirrors normalizeStringList for one raw JSON leaf.
func rawTextList(raw json.RawMessage) []string {
	if len(raw) == 0 {
		return nil
	}
	var entries []json.RawMessage
	if err := json.Unmarshal(raw, &entries); err != nil {
		return nil
	}
	out := make([]string, 0, len(entries))
	for _, entry := range entries {
		if text := rawTextValue(entry); text != nil {
			out = append(out, *text)
		}
	}
	return out
}

// firstNonEmptyPtr returns the first non-nil value.
func firstNonEmptyPtr(values ...*string) *string {
	for _, value := range values {
		if value != nil {
			return value
		}
	}
	return nil
}
