package history

import (
	"context"
	"encoding/base64"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

const (
	analysisCollection  = "analysisresults"
	assistantCollection = "assistantruns"
)

type flexDoc struct {
	OID            bson.RawValue `bson:"_id"`
	ID             bson.RawValue `bson:"id"`
	Type           bson.RawValue `bson:"type"`
	Status         bson.RawValue `bson:"status"`
	Summary        bson.RawValue `bson:"summary"`
	Error          bson.RawValue `bson:"error"`
	Input          bson.RawValue `bson:"input"`
	Output         bson.RawValue `bson:"output"`
	ConversationID bson.RawValue `bson:"conversationId"`
	CreatedAt      bson.RawValue `bson:"createdAt"`
}

func (s *service) listAnalysis(ctx context.Context, orgID string, limit int) ([]AnalysisResultModel, error) {
	docs, err := s.findRuns(ctx, analysisCollection, orgID, limit)
	if err != nil {
		return nil, err
	}
	out := make([]AnalysisResultModel, 0, len(docs))
	for _, doc := range docs {
		row, err := mapAnalysis(doc)
		if err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, nil
}

func (s *service) listAssistantRuns(ctx context.Context, orgID string, limit int) ([]AssistantRunModel, error) {
	docs, err := s.findRuns(ctx, assistantCollection, orgID, limit)
	if err != nil {
		return nil, err
	}
	out := make([]AssistantRunModel, 0, len(docs))
	for _, doc := range docs {
		row, err := mapAssistant(doc)
		if err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, nil
}

func (s *service) findRuns(ctx context.Context, collection, orgID string, limit int) ([]flexDoc, error) {
	if s == nil || s.mongo == nil {
		return nil, errMongoUnavailable
	}
	cursor, err := s.mongo.Collection(collection).Find(ctx, bson.D{{Key: "orgId", Value: orgID}}, options.Find().
		SetSort(bson.D{{Key: "createdAt", Value: -1}}).
		SetLimit(int64(limit)))
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)
	docs := make([]flexDoc, 0)
	if err := cursor.All(ctx, &docs); err != nil {
		return nil, err
	}
	return docs, nil
}

func mapAnalysis(doc flexDoc) (AnalysisResultModel, error) {
	input, output, err := mixedPair(doc)
	if err != nil {
		return AnalysisResultModel{}, err
	}
	typeText, typeOK := rawString(doc.Type)
	statusText, statusOK := rawString(doc.Status)
	return AnalysisResultModel{
		CreatedAt: docCreatedAt(doc.CreatedAt),
		Error:     optionalRawString(doc.Error),
		ID:        documentID(doc.OID, doc.ID),
		Input:     input,
		Output:    output,
		Status:    runStatus(statusText, statusOK),
		Summary:   optionalRawString(doc.Summary),
		Type:      analysisType(typeText, typeOK),
	}, nil
}

func mapAssistant(doc flexDoc) (AssistantRunModel, error) {
	input, output, err := mixedPair(doc)
	if err != nil {
		return AssistantRunModel{}, err
	}
	typeText, typeOK := rawString(doc.Type)
	statusText, statusOK := rawString(doc.Status)
	return AssistantRunModel{
		ConversationID: optionalRawString(doc.ConversationID),
		CreatedAt:      docCreatedAt(doc.CreatedAt),
		Error:          optionalRawString(doc.Error),
		ID:             documentID(doc.OID, doc.ID),
		Input:          input,
		Output:         output,
		Status:         runStatus(statusText, statusOK),
		Summary:        optionalRawString(doc.Summary),
		Type:           assistantType(typeText, typeOK),
	}, nil
}

func mixedPair(doc flexDoc) (any, any, error) {
	input, err := rawAny(doc.Input)
	if err != nil {
		return nil, nil, err
	}
	output, err := rawAny(doc.Output)
	if err != nil {
		return nil, nil, err
	}
	return input, output, nil
}

func docCreatedAt(value bson.RawValue) time.Time {
	if parsed, ok := rawTime(value); ok {
		return parsed
	}
	return time.Now()
}

func analysisType(value string, ok bool) string {
	if ok && (value == "geo_transport" || value == "anomaly") {
		return value
	}
	return "correlation"
}

func assistantType(value string, ok bool) string {
	if ok {
		switch value {
		case "query", "report", "forecast":
			return value
		}
	}
	return "query"
}

func runStatus(value string, ok bool) string {
	if ok {
		switch value {
		case "pending", "running", "completed", "failed":
			return value
		}
	}
	return "pending"
}

func documentID(oid, alt bson.RawValue) string {
	if oid.Type == bson.TypeObjectID {
		var id bson.ObjectID
		if err := oid.Unmarshal(&id); err == nil {
			return id.Hex()
		}
	}
	// Nest uses _id.toString() before the stored id field. A string _id is that string.
	if text, ok := rawString(oid); ok {
		return text
	}
	if text, ok := rawString(alt); ok {
		return text
	}
	return ""
}

func optionalRawString(value bson.RawValue) *string {
	text, ok := rawString(value)
	if !ok {
		return nil
	}
	return stringPtr(text)
}

func rawString(value bson.RawValue) (string, bool) {
	if value.Type != bson.TypeString {
		return "", false
	}
	var text string
	if err := value.Unmarshal(&text); err != nil {
		return "", false
	}
	return text, true
}

func rawTime(value bson.RawValue) (time.Time, bool) {
	if rawAbsent(value) {
		return time.Time{}, false
	}
	switch value.Type {
	case bson.TypeDateTime:
		var parsed time.Time
		if err := value.Unmarshal(&parsed); err != nil {
			return time.Time{}, false
		}
		return parsed, true
	case bson.TypeString:
		text, ok := rawString(value)
		if !ok {
			return time.Time{}, false
		}
		parsed, err := time.Parse(time.RFC3339Nano, text)
		if err != nil {
			return time.Time{}, false
		}
		return parsed, true
	default:
		return time.Time{}, false
	}
}

func rawAny(value bson.RawValue) (any, error) {
	if rawAbsent(value) {
		return nil, nil
	}
	var decoded any
	if err := value.Unmarshal(&decoded); err != nil {
		return nil, err
	}
	return bsonToAny(decoded), nil
}

func rawAbsent(value bson.RawValue) bool {
	return value.IsZero() || value.Type == bson.TypeNull || value.Type == bson.TypeUndefined
}

func bsonToAny(value any) any {
	switch typed := value.(type) {
	case nil:
		return nil
	case bson.D:
		out := make(map[string]any, len(typed))
		for _, element := range typed {
			out[element.Key] = bsonToAny(element.Value)
		}
		return out
	case bson.M:
		out := make(map[string]any, len(typed))
		for key, element := range typed {
			out[key] = bsonToAny(element)
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(typed))
		for key, element := range typed {
			out[key] = bsonToAny(element)
		}
		return out
	case bson.A:
		out := make([]any, len(typed))
		for i, element := range typed {
			out[i] = bsonToAny(element)
		}
		return out
	case []any:
		out := make([]any, len(typed))
		for i, element := range typed {
			out[i] = bsonToAny(element)
		}
		return out
	case bson.ObjectID:
		return typed.Hex()
	case bson.DateTime:
		return typed.Time()
	case time.Time:
		return typed
	case bson.Decimal128:
		return typed.String()
	case bson.Binary:
		return base64.StdEncoding.EncodeToString(typed.Data)
	case []byte:
		return base64.StdEncoding.EncodeToString(typed)
	case bson.Timestamp:
		return map[string]any{"t": typed.T, "i": typed.I}
	case bson.Regex:
		return typed.Pattern
	case bson.JavaScript:
		return string(typed)
	case bson.Symbol:
		return string(typed)
	case bson.DBPointer:
		return map[string]any{"db": typed.DB, "oid": typed.Pointer.Hex()}
	case bson.CodeWithScope:
		return map[string]any{"code": string(typed.Code), "scope": bsonToAny(typed.Scope)}
	case bson.Null, bson.Undefined, bson.MinKey, bson.MaxKey:
		return nil
	default:
		return typed
	}
}
