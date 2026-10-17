package workspace

import (
	"context"
	"database/sql"
	"encoding/json"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
)

const processedItemsCollection = "processeditems"

// processedItemDoc is one processeditems document. Every optional field is a
// bson.RawValue so a stored null stays distinguishable from a missing field,
// matching a Mongoose lean document.
type processedItemDoc struct {
	ID                         bson.RawValue `bson:"_id"`
	OrgID                      string        `bson:"orgId"`
	ItemMetaID                 bson.RawValue `bson:"itemMetaId"`
	Status                     bson.RawValue `bson:"status"`
	Error                      bson.RawValue `bson:"error"`
	Tags                       bson.RawValue `bson:"tags"`
	Result                     bson.RawValue `bson:"result"`
	DuplicateOf                bson.RawValue `bson:"duplicateOf"`
	DuplicateSimilarity        bson.RawValue `bson:"duplicateSimilarity"`
	LLM                        bson.RawValue `bson:"llm"`
	SummaryEmbeddingModel      bson.RawValue `bson:"summaryEmbeddingModel"`
	SummaryEmbeddingDimensions bson.RawValue `bson:"summaryEmbeddingDimensions"`
	CreatedAt                  bson.RawValue `bson:"createdAt"`
}

// processedItemErrorDoc is the stored error subdocument.
type processedItemErrorDoc struct {
	Message bson.RawValue `bson:"message"`
	Name    bson.RawValue `bson:"name"`
}

// processedItemLlmDoc is the stored llm subdocument.
type processedItemLlmDoc struct {
	Model            bson.RawValue `bson:"model"`
	PromptVersion    bson.RawValue `bson:"promptVersion"`
	PromptTokens     bson.RawValue `bson:"promptTokens"`
	CompletionTokens bson.RawValue `bson:"completionTokens"`
	TotalTokens      bson.RawValue `bson:"totalTokens"`
	CostUSD          bson.RawValue `bson:"costUsd"`
	LatencyMs        bson.RawValue `bson:"latencyMs"`
}

// processedItemByID implements the processedItemById root. The id must be a
// 24-character hex ObjectId; a malformed id is a 400, a missing document is
// null, and duplicateOf is resolved across id spaces to the target's
// ItemMeta id.
func (s *service) processedItemByID(ctx contract.Context) (*ProcessedItemModelGraph, error) {
	rawID, _ := contract.StringArg(ctx.Args, "id")
	id := jsTrim(rawID)
	if !isObjectID(id) {
		return nil, &contract.Failure{Message: "Invalid processed item id", Status: http.StatusBadRequest}
	}
	if s == nil || s.mongo == nil {
		return nil, errMongoUnavailable
	}
	objectID, err := bson.ObjectIDFromHex(id)
	if err != nil {
		return nil, &contract.Failure{Message: "Invalid processed item id", Status: http.StatusBadRequest}
	}
	callCtx := s.call(ctx)
	var doc processedItemDoc
	err = s.mongo.Collection(processedItemsCollection).FindOne(callCtx,
		bson.D{{Key: "_id", Value: objectID}, {Key: "orgId", Value: ctx.Identity.OrgID}}).Decode(&doc)
	if err == mongo.ErrNoDocuments {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	resultToken := normalizedResultToken(doc.Result)
	model := &ProcessedItemModelGraph{
		CreatedAt:                  processedItemCreatedAt(doc.CreatedAt, s.clock()),
		DuplicateOf:                s.resolveDuplicateOf(callCtx, ctx.Identity.OrgID, doc.DuplicateOf),
		DuplicateSimilarity:        rawFiniteFloat(doc.DuplicateSimilarity),
		Error:                      normalizeProcessedItemError(doc.Error),
		ID:                         objectID.Hex(),
		ItemMetaID:                 rawStringOr(doc.ItemMetaID, ""),
		LLM:                        normalizeProcessedItemLlm(doc.LLM),
		Status:                     rawStringOr(doc.Status, ""),
		SummaryEmbeddingDimensions: rawFiniteInt(doc.SummaryEmbeddingDimensions),
		SummaryEmbeddingModel:      rawOptionalString(doc.SummaryEmbeddingModel),
		Tags:                       rawStringSlice(doc.Tags),
	}
	if resultToken != nil {
		text := string(resultToken)
		model.Result = &text
	}
	if len(resultToken) > 0 && resultToken[0] == '{' {
		message := json.RawMessage(append([]byte(nil), resultToken...))
		model.ResultJSON = &message
	}
	eventID, err := s.resolveEventID(callCtx, ctx.Identity.OrgID, id)
	if err != nil {
		return nil, err
	}
	model.EventID = eventID
	return model, nil
}

// isObjectID reports whether the value is exactly 24 hexadecimal characters.
func isObjectID(value string) bool {
	if len(value) != 24 {
		return false
	}
	for index := 0; index < len(value); index++ {
		char := value[index]
		switch {
		case char >= '0' && char <= '9':
		case char >= 'a' && char <= 'f':
		case char >= 'A' && char <= 'F':
		default:
			return false
		}
	}
	return true
}

// normalizedResultToken converts a stored result into the normalized JSON
// token: a JSON string is parsed recursively, an empty or invalid string is
// null, and an object or array is passed through unchanged.
func normalizedResultToken(raw bson.RawValue) json.RawMessage {
	token, ok := bsonValueToJSON(raw)
	if !ok {
		return nil
	}
	return normalizeProcessedResult(token)
}

// normalizeProcessedResult mirrors normalize-processed-result.ts: strings are
// parsed, and a parsed string is parsed again.
func normalizeProcessedResult(token json.RawMessage) json.RawMessage {
	if len(token) == 0 {
		return nil
	}
	if token[0] == '"' {
		var text string
		if err := json.Unmarshal(token, &text); err != nil {
			return nil
		}
		trimmed := jsTrim(text)
		if trimmed == "" || !json.Valid([]byte(trimmed)) {
			return nil
		}
		var inner json.RawMessage
		if err := json.Unmarshal([]byte(trimmed), &inner); err != nil {
			return nil
		}
		return normalizeProcessedResult(inner)
	}
	if string(token) == "null" {
		return nil
	}
	return token
}

// normalizeProcessedItemError extracts the error object. A non-object error
// becomes GraphQL null and a missing message defaults to "Unknown error".
func normalizeProcessedItemError(raw bson.RawValue) *ProcessedItemErrorModelGraph {
	if raw.Type != bson.TypeEmbeddedDocument {
		return nil
	}
	var doc processedItemErrorDoc
	if err := raw.Unmarshal(&doc); err != nil {
		return nil
	}
	message, ok := rawStringValue(doc.Message)
	if !ok {
		message = "Unknown error"
	}
	return &ProcessedItemErrorModelGraph{
		Message: message,
		Name:    rawOptionalString(doc.Name),
	}
}

// normalizeProcessedItemLlm builds the strongly typed llm object. A stored
// value that is not a document, and any non-finite numeric field, becomes
// null so GraphQL Float serialization can never fail.
func normalizeProcessedItemLlm(raw bson.RawValue) *ProcessedItemLlmModel {
	if raw.Type != bson.TypeEmbeddedDocument {
		return nil
	}
	var doc processedItemLlmDoc
	if err := raw.Unmarshal(&doc); err != nil {
		return nil
	}
	return &ProcessedItemLlmModel{
		CompletionTokens: rawFiniteFloat(doc.CompletionTokens),
		CostUSD:          rawFiniteFloat(doc.CostUSD),
		LatencyMs:        rawFiniteFloat(doc.LatencyMs),
		Model:            rawOptionalString(doc.Model),
		PromptTokens:     rawFiniteFloat(doc.PromptTokens),
		PromptVersion:    rawOptionalString(doc.PromptVersion),
		TotalTokens:      rawFiniteFloat(doc.TotalTokens),
	}
}

// resolveDuplicateOf resolves the stored target ProcessedItem._id to the
// target's ItemMeta id. Returning the raw ObjectId would break the console's
// /items/:itemMetaId navigation.
func (s *service) resolveDuplicateOf(ctx context.Context, orgID string, raw bson.RawValue) *string {
	if s == nil || s.mongo == nil || raw.Type != bson.TypeObjectID {
		return nil
	}
	var targetID bson.ObjectID
	if err := raw.Unmarshal(&targetID); err != nil {
		return nil
	}
	var target struct {
		ItemMetaID bson.RawValue `bson:"itemMetaId"`
	}
	err := s.mongo.Collection(processedItemsCollection).FindOne(ctx,
		bson.D{{Key: "_id", Value: targetID}, {Key: "orgId", Value: orgID}},
		options.FindOne().SetProjection(bson.D{{Key: "itemMetaId", Value: 1}})).Decode(&target)
	if err != nil {
		return nil
	}
	itemMetaID, ok := rawStringValue(target.ItemMetaID)
	if !ok {
		return nil
	}
	itemMetaID = strings.TrimSpace(itemMetaID)
	if itemMetaID == "" {
		return nil
	}
	return &itemMetaID
}

// resolveEventID implements the two-step lookup of the event loader: first
// NewsEventItem.processedItemId, then ProcessedArticle.cleanedMarkdownRef to
// NewsEventItem.processedArticleId.
func (s *service) resolveEventID(ctx context.Context, orgID, processedItemID string) (*string, error) {
	if s == nil || s.db == nil {
		return nil, errDatabaseUnavailable
	}
	var direct string
	err := s.db.QueryRowContext(ctx,
		"SELECT eventId FROM NewsEventItem WHERE orgId = ? AND processedItemId = ? "+
			"ORDER BY createdAt DESC LIMIT 1", orgID, processedItemID).Scan(&direct)
	if err == nil {
		return &direct, nil
	}
	if err != sql.ErrNoRows {
		return nil, err
	}

	var processedArticleID string
	err = s.db.QueryRowContext(ctx,
		"SELECT pa.id FROM ProcessedArticle pa JOIN Article a ON a.id = pa.articleId "+
			"WHERE pa.cleanedMarkdownRef = ? AND a.orgId = ? LIMIT 1", processedItemID, orgID).Scan(&processedArticleID)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	var fallback string
	err = s.db.QueryRowContext(ctx,
		"SELECT eventId FROM NewsEventItem WHERE orgId = ? AND processedArticleId = ? LIMIT 1",
		orgID, processedArticleID).Scan(&fallback)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &fallback, nil
}

// rawStringOr reads a BSON string, falling back to the supplied default.
func rawStringOr(value bson.RawValue, fallback string) string {
	text, ok := rawStringValue(value)
	if !ok {
		return fallback
	}
	return text
}

// rawOptionalString reads a BSON string, returning nil for anything else.
func rawOptionalString(value bson.RawValue) *string {
	text, ok := rawStringValue(value)
	if !ok {
		return nil
	}
	return &text
}

// rawStringSlice reads a BSON array of strings, dropping nothing because the
// schema stores strings. A non-array value becomes an empty list.
func rawStringSlice(value bson.RawValue) []string {
	if value.Type == bson.TypeArray {
		var out []string
		if err := value.Unmarshal(&out); err == nil && out != nil {
			return out
		}
	}
	return []string{}
}

// rawFiniteFloat reads a BSON numeric value, returning nil for missing,
// non-numeric, or non-finite values so GraphQL Float cannot fail.
func rawFiniteFloat(value bson.RawValue) *float64 {
	var number float64
	switch value.Type {
	case bson.TypeDouble:
		if err := value.Unmarshal(&number); err != nil {
			return nil
		}
	case bson.TypeInt32:
		var integer int32
		if err := value.Unmarshal(&integer); err != nil {
			return nil
		}
		number = float64(integer)
	case bson.TypeInt64:
		var integer int64
		if err := value.Unmarshal(&integer); err != nil {
			return nil
		}
		number = float64(integer)
	case bson.TypeDecimal128:
		var decimal bson.Decimal128
		if err := value.Unmarshal(&decimal); err != nil {
			return nil
		}
		parsed, err := strconv.ParseFloat(decimal.String(), 64)
		if err != nil {
			return nil
		}
		number = parsed
	default:
		return nil
	}
	if math.IsNaN(number) || math.IsInf(number, 0) {
		return nil
	}
	return &number
}

// rawFiniteInt reads an integral BSON numeric value as an int.
func rawFiniteInt(value bson.RawValue) *int {
	number := rawFiniteFloat(value)
	if number == nil || *number != math.Trunc(*number) {
		return nil
	}
	converted := int(*number)
	return &converted
}

// processedItemCreatedAt reads the document createdAt, falling back to now so
// a non-null DateTime field never renders a zero timestamp.
func processedItemCreatedAt(value bson.RawValue, now time.Time) time.Time {
	if stamp, ok := rawTimeValue(value); ok {
		return stamp
	}
	return now.UTC()
}
