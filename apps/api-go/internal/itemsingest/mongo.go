package itemsingest

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

const rawItemsCollection = "rawitems"

// newRawItemDocument builds the exact Mongoose RawItem shape: declared payload
// fields only, the URL comparable triple from the pre-validate hook, source and
// timestamps. prefetchedArticle is intentionally absent.
func newRawItemDocument(itemMetaID, rawItemID, source string, payload NormalizedNewsPayload, now time.Time) (bson.D, error) {
	rawOID, err := bson.ObjectIDFromHex(rawItemID)
	if err != nil {
		return nil, fmt.Errorf("invalid rawItemId %q", rawItemID)
	}
	payloadDoc := bson.D{
		{Key: "url", Value: payload.URL},
		{Key: "keywords", Value: stringSliceValue(payload.Keywords)},
		{Key: "tags", Value: stringSliceValue(payload.Tags)},
		{Key: "summaryHints", Value: stringSliceValue(payload.SummaryHints)},
		{Key: "metadata", Value: rawJSONToBSON(payload.Metadata)},
		{Key: "forceRefresh", Value: payload.ForceRefresh},
	}
	if payload.Language != nil {
		payloadDoc = append(payloadDoc, bson.E{Key: "language", Value: *payload.Language})
	}
	if payload.SourceName != nil {
		payloadDoc = append(payloadDoc, bson.E{Key: "sourceName", Value: *payload.SourceName})
	} else if payload.SourceNameIsNull {
		payloadDoc = append(payloadDoc, bson.E{Key: "sourceName", Value: nil})
	}
	if len(payload.CrawlOptions) > 0 {
		payloadDoc = append(payloadDoc, bson.E{Key: "crawlOptions", Value: rawJSONToBSON(payload.CrawlOptions)})
	}

	comparable := buildComparableURLVariants(payload.URL)
	var full, fullHash, base any
	if comparable != nil {
		full = comparable.Full
		fullHash = comparable.FullHash
		base = comparable.Base
	}
	return bson.D{
		{Key: "_id", Value: rawOID},
		{Key: "itemMetaId", Value: itemMetaID},
		{Key: "payload", Value: payloadDoc},
		{Key: "source", Value: source},
		{Key: "urlComparableFull", Value: full},
		{Key: "urlComparableFullHash", Value: fullHash},
		{Key: "urlComparableBase", Value: base},
		{Key: "createdAt", Value: now.UTC().Truncate(time.Millisecond)},
		{Key: "updatedAt", Value: now.UTC().Truncate(time.Millisecond)},
	}, nil
}

func stringSliceValue(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}

// rawJSONToBSON converts a JSON leaf into driver-encodable values. Numbers keep
// their integer form when they are within int64 range, otherwise they become
// float64 (the JSON/JavaScript number representation).
func rawJSONToBSON(raw json.RawMessage) any {
	if len(bytes.TrimSpace(raw)) == 0 {
		return bson.D{}
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return bson.D{}
	}
	return jsonValueToBSON(value)
}

func jsonValueToBSON(value any) any {
	switch typed := value.(type) {
	case nil:
		return nil
	case bool, string, int32, int64, float64:
		return typed
	case json.Number:
		if integer, err := typed.Int64(); err == nil {
			return integer
		}
		if number, err := typed.Float64(); err == nil {
			return number
		}
		return typed.String()
	case []any:
		out := make(bson.A, 0, len(typed))
		for _, entry := range typed {
			out = append(out, jsonValueToBSON(entry))
		}
		return out
	case map[string]any:
		out := bson.D{}
		for key, entry := range typed {
			out = append(out, bson.E{Key: key, Value: jsonValueToBSON(entry)})
		}
		return out
	default:
		return typed
	}
}

// insertRawItem writes one raw document and applies the duplicate-key rule:
// 11000 is tolerated only when the same _id already exists, in which case the
// existing document wins and is never overwritten.
func (s *Service) insertRawItem(ctx context.Context, doc bson.D) error {
	if s == nil || s.mongo == nil {
		return fmt.Errorf("mongo is not configured")
	}
	_, err := s.mongo.Collection(rawItemsCollection).InsertOne(ctx, doc)
	if err == nil {
		return nil
	}
	if mongo.IsDuplicateKeyError(err) {
		rawOID := documentObjectID(doc)
		if !rawOID.IsZero() {
			count, countErr := s.mongo.Collection(rawItemsCollection).CountDocuments(ctx, bson.D{{Key: "_id", Value: rawOID}})
			if countErr == nil && count > 0 {
				return nil
			}
		}
	}
	return err
}

// insertRawItems performs the unordered bulk insert of the crawl import path.
// The returned error is only descriptive: success is confirmed afterwards by
// reading the ids back, exactly like the NestJS implementation.
func (s *Service) insertRawItems(ctx context.Context, docs []bson.D) error {
	if len(docs) == 0 {
		return nil
	}
	values := make([]any, 0, len(docs))
	for _, doc := range docs {
		values = append(values, doc)
	}
	_, err := s.mongo.Collection(rawItemsCollection).InsertMany(ctx, values, options.InsertMany().SetOrdered(false))
	return err
}

// findExistingRawItemIDs returns the ids that are really present after the
// unordered insert.
func (s *Service) findExistingRawItemIDs(ctx context.Context, rawIDs []string) (map[string]struct{}, error) {
	out := make(map[string]struct{}, len(rawIDs))
	objectIDs := make([]bson.ObjectID, 0, len(rawIDs))
	for _, rawID := range rawIDs {
		objectID, err := bson.ObjectIDFromHex(rawID)
		if err != nil {
			continue
		}
		objectIDs = append(objectIDs, objectID)
	}
	if len(objectIDs) == 0 {
		return out, nil
	}
	cursor, err := s.mongo.Collection(rawItemsCollection).Find(
		ctx,
		bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: objectIDs}}}},
		options.Find().SetProjection(bson.D{{Key: "_id", Value: 1}}),
	)
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)
	for cursor.Next(ctx) {
		var row struct {
			ID bson.ObjectID `bson:"_id"`
		}
		if err := cursor.Decode(&row); err != nil {
			return nil, err
		}
		out[row.ID.Hex()] = struct{}{}
	}
	return out, cursor.Err()
}

// deleteRawItem removes a raw document created by this process that lost the
// ItemMeta CAS. It is scoped by _id only, and the caller must never pass a
// winner's id.
func (s *Service) deleteRawItem(ctx context.Context, rawID string) {
	if s == nil || s.mongo == nil {
		return
	}
	objectID, err := bson.ObjectIDFromHex(rawID)
	if err != nil {
		return
	}
	_, _ = s.mongo.Collection(rawItemsCollection).DeleteOne(ctx, bson.D{{Key: "_id", Value: objectID}})
}

func documentObjectID(doc bson.D) bson.ObjectID {
	for _, element := range doc {
		if element.Key == "_id" {
			if objectID, ok := element.Value.(bson.ObjectID); ok {
				return objectID
			}
		}
	}
	return bson.ObjectID{}
}
