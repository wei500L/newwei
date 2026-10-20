package accountdata

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// assistantRunsCollection is the Mongoose model("AssistantRun") collection.
const assistantRunsCollection = "assistantruns"

// MongoAssistantRuns reads assistantruns with the projection, filter and sort
// of user-data-export.service.ts loadAssistantRuns.
type MongoAssistantRuns struct {
	collection *mongo.Collection
}

// NewMongoAssistantRuns builds the source. A nil database yields a source that
// fails at request time instead of a typed-nil interface.
func NewMongoAssistantRuns(database *mongo.Database) *MongoAssistantRuns {
	if database == nil {
		return &MongoAssistantRuns{}
	}
	return &MongoAssistantRuns{collection: database.Collection(assistantRunsCollection)}
}

// ForEachAssistantRun streams the caller's runs. The filter is always
// { orgId, triggeredById } so neither another tenant's nor another user's runs
// can appear. The cursor keeps memory bounded for large histories.
func (s *MongoAssistantRuns) ForEachAssistantRun(ctx context.Context, orgID, userID string, yield func(AssistantRun) error) error {
	if s == nil || s.collection == nil {
		return fmt.Errorf("accountdata: mongo is not configured")
	}
	filter := bson.D{{Key: "orgId", Value: orgID}, {Key: "triggeredById", Value: userID}}
	findOptions := options.Find().
		SetSort(bson.D{{Key: "createdAt", Value: -1}, {Key: "_id", Value: -1}}).
		SetProjection(bson.D{
			{Key: "orgId", Value: 1},
			{Key: "type", Value: 1},
			{Key: "conversationId", Value: 1},
			{Key: "status", Value: 1},
			{Key: "input", Value: 1},
			{Key: "output", Value: 1},
			{Key: "summary", Value: 1},
			{Key: "error", Value: 1},
			{Key: "model", Value: 1},
			{Key: "triggeredById", Value: 1},
			{Key: "createdAt", Value: 1},
			{Key: "updatedAt", Value: 1},
		})
	cursor, err := s.collection.Find(ctx, filter, findOptions)
	if err != nil {
		return mongoWrap(err)
	}
	defer func() { _ = cursor.Close(ctx) }()

	for cursor.Next(ctx) {
		var document assistantRunDocument
		if err := cursor.Decode(&document); err != nil {
			return mongoWrap(err)
		}
		run, err := document.toAssistantRun()
		if err != nil {
			return err
		}
		if err := yield(run); err != nil {
			return err
		}
	}
	if err := cursor.Err(); err != nil {
		return mongoWrap(err)
	}
	return nil
}

// assistantRunDocument is the lean() projection decoded into named fields.
type assistantRunDocument struct {
	ID             bson.RawValue `bson:"_id"`
	OrgID          *string       `bson:"orgId"`
	Type           *string       `bson:"type"`
	ConversationID *string       `bson:"conversationId"`
	Status         *string       `bson:"status"`
	Input          bson.RawValue `bson:"input"`
	Output         bson.RawValue `bson:"output"`
	Summary        *string       `bson:"summary"`
	Error          *string       `bson:"error"`
	Model          *string       `bson:"model"`
	TriggeredByID  *string       `bson:"triggeredById"`
	CreatedAt      *time.Time    `bson:"createdAt"`
	UpdatedAt      *time.Time    `bson:"updatedAt"`
}

// toAssistantRun maps one document exactly like loadAssistantRuns.map:
// conversationId/input/output/summary/error/model/triggeredById/createdAt/
// updatedAt use `?? null`, while orgId/type/status keep `undefined` semantics
// (the member is omitted when the stored field is absent).
func (d assistantRunDocument) toAssistantRun() (AssistantRun, error) {
	input, err := marshalMixed(d.Input)
	if err != nil {
		return AssistantRun{}, fmt.Errorf("accountdata: marshal assistant run input: %w", err)
	}
	output, err := marshalMixed(d.Output)
	if err != nil {
		return AssistantRun{}, fmt.Errorf("accountdata: marshal assistant run output: %w", err)
	}
	return AssistantRun{
		ID:             stringifyObjectID(d.ID),
		OrgID:          d.OrgID,
		Type:           d.Type,
		ConversationID: d.ConversationID,
		Status:         d.Status,
		Input:          input,
		Output:         output,
		Summary:        d.Summary,
		Error:          d.Error,
		Model:          d.Model,
		TriggeredByID:  d.TriggeredByID,
		CreatedAt:      formatMongoDate(d.CreatedAt),
		UpdatedAt:      formatMongoDate(d.UpdatedAt),
	}, nil
}

// marshalMixed renders a Mixed BSON value as plain JSON. A missing or null
// value becomes JSON null (`run.input ?? null`). BSON dates become ISO strings
// and ObjectIds become hex strings, matching JSON.stringify on Mongoose lean
// documents.
func marshalMixed(value bson.RawValue) (json.RawMessage, error) {
	if len(value.Value) == 0 || value.Type == bson.TypeNull || value.Type == bson.TypeUndefined {
		return nil, nil
	}
	var decoded any
	if err := value.Unmarshal(&decoded); err != nil {
		return nil, err
	}
	var buffer bytes.Buffer
	if err := writeJSONValue(&buffer, decoded); err != nil {
		return nil, err
	}
	return json.RawMessage(buffer.Bytes()), nil
}

// writeJSONValue renders a decoded BSON value with HTML escaping disabled, so
// the Mixed leaf follows JSON.stringify rather than encoding/json's default.
func writeJSONValue(buffer *bytes.Buffer, value any) error {
	switch typed := value.(type) {
	case nil:
		buffer.WriteString("null")
		return nil
	case bson.D:
		buffer.WriteByte('{')
		for index, element := range typed {
			if index > 0 {
				buffer.WriteByte(',')
			}
			key, err := json.Marshal(element.Key)
			if err != nil {
				return err
			}
			buffer.Write(key)
			buffer.WriteByte(':')
			if err := writeJSONValue(buffer, element.Value); err != nil {
				return err
			}
		}
		buffer.WriteByte('}')
		return nil
	case bson.A:
		buffer.WriteByte('[')
		for index, element := range typed {
			if index > 0 {
				buffer.WriteByte(',')
			}
			if err := writeJSONValue(buffer, element); err != nil {
				return err
			}
		}
		buffer.WriteByte(']')
		return nil
	case bson.ObjectID:
		encoded, _ := json.Marshal(typed.Hex())
		buffer.Write(encoded)
		return nil
	case bson.DateTime:
		encoded, _ := json.Marshal(typed.Time().UTC().Truncate(time.Millisecond).Format(jsDateLayout))
		buffer.Write(encoded)
		return nil
	case time.Time:
		encoded, _ := json.Marshal(typed.UTC().Truncate(time.Millisecond).Format(jsDateLayout))
		buffer.Write(encoded)
		return nil
	case bson.Decimal128:
		encoded, _ := json.Marshal(typed.String())
		buffer.Write(encoded)
		return nil
	case json.Number:
		buffer.WriteString(typed.String())
		return nil
	default:
		var encoded bytes.Buffer
		encoder := json.NewEncoder(&encoded)
		encoder.SetEscapeHTML(false)
		if err := encoder.Encode(typed); err != nil {
			return err
		}
		buffer.Write(bytes.TrimSuffix(encoded.Bytes(), []byte("\n")))
		return nil
	}
}

// stringifyObjectID mirrors stringifyId: a string id is returned unchanged, an
// ObjectId becomes its hex form, anything else becomes null.
func stringifyObjectID(value bson.RawValue) *string {
	switch value.Type {
	case bson.TypeObjectID:
		if id, ok := value.ObjectIDOK(); ok {
			hex := id.Hex()
			return &hex
		}
	case bson.TypeString:
		if text, ok := value.StringValueOK(); ok {
			return &text
		}
	}
	return nil
}

// formatMongoDate mirrors toIsoString for a Date field.
func formatMongoDate(value *time.Time) *string {
	if value == nil {
		return nil
	}
	formatted := value.UTC().Truncate(time.Millisecond).Format(jsDateLayout)
	return &formatted
}
