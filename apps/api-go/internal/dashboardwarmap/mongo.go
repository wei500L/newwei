package dashboardwarmap

import (
	"context"
	"log"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

const (
	processedItemsCollection = "processeditems"
	rawItemsCollection       = "rawitems"
)

type mongoStore struct {
	items *mongo.Collection
	raws  *mongo.Collection
}

func newMongoStore(db *mongo.Database) *mongoStore {
	if db == nil {
		return &mongoStore{}
	}
	return &mongoStore{
		items: db.Collection(processedItemsCollection),
		raws:  db.Collection(rawItemsCollection),
	}
}

func (s *mongoStore) Locations(ctx context.Context, orgID string, start, end time.Time, limit int) ([]mongoRow, error) {
	if s == nil || s.items == nil {
		return nil, errMongoUnavailable
	}
	if limit < 1 {
		limit = 1
	}
	if limit > 2500 {
		limit = 2500
	}
	filter := bson.D{
		{Key: "orgId", Value: orgID},
		{Key: "status", Value: "completed"},
		{Key: "hasLocation", Value: true},
		{Key: "duplicateOf", Value: nil},
		{Key: "$or", Value: mongoRangeFilter(start, end)},
	}
	cursor, err := s.items.Find(ctx, filter, options.Find().
		SetSort(bson.D{{Key: "sortAt", Value: -1}, {Key: "ingestedAt", Value: -1}, {Key: "createdAt", Value: -1}}).
		SetLimit(int64(limit)).
		SetProjection(bson.D{
			{Key: "_id", Value: 1},
			{Key: "rawItemId", Value: 1},
			{Key: "sortAt", Value: 1},
			{Key: "ingestedAt", Value: 1},
			{Key: "createdAt", Value: 1},
			{Key: "result.location", Value: 1},
			{Key: "result.title", Value: 1},
			{Key: "result.entities", Value: 1},
			{Key: "result.published_at", Value: 1},
		}))
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)
	var docs []bson.M
	if err := cursor.All(ctx, &docs); err != nil {
		return nil, err
	}
	if len(docs) == 0 {
		return []mongoRow{}, nil
	}
	urls := s.rawURLs(ctx, docs)
	rows := make([]mongoRow, 0, len(docs))
	for _, doc := range docs {
		id := hexID(doc["_id"])
		if id == "" {
			continue
		}
		result, _ := doc["result"].(bson.M)
		if result == nil {
			if generic, ok := doc["result"].(map[string]any); ok {
				result = bson.M(generic)
			}
		}
		location := ""
		title := ""
		var entities any
		var published *time.Time
		if result != nil {
			if text, ok := result["location"].(string); ok {
				location = text
			}
			if text, ok := result["title"].(string); ok {
				title = text
			}
			entities = normalizeBSON(result["entities"])
			published = parseAnyTime(result["published_at"])
		}
		location = trim(location)
		if location == "" {
			continue
		}
		rawID := hexID(doc["rawItemId"])
		var url *string
		if rawID != "" {
			if value, ok := urls[rawID]; ok && value != "" {
				copied := value
				url = &copied
			}
		}
		title = trim(title)
		rows = append(rows, mongoRow{
			ID:          id,
			Location:    location,
			Entities:    entities,
			Title:       title,
			URL:         url,
			SortAt:      parseAnyTime(doc["sortAt"]),
			IngestedAt:  parseAnyTime(doc["ingestedAt"]),
			CreatedAt:   parseAnyTime(doc["createdAt"]),
			PublishedAt: published,
		})
	}
	return rows, nil
}

func (s *mongoStore) rawURLs(ctx context.Context, docs []bson.M) map[string]string {
	out := map[string]string{}
	if s.raws == nil {
		return out
	}
	ids := make([]bson.ObjectID, 0)
	seen := map[string]struct{}{}
	for _, doc := range docs {
		hex := hexID(doc["rawItemId"])
		if hex == "" {
			continue
		}
		if _, ok := seen[hex]; ok {
			continue
		}
		seen[hex] = struct{}{}
		oid, err := bson.ObjectIDFromHex(hex)
		if err != nil {
			continue
		}
		ids = append(ids, oid)
	}
	if len(ids) == 0 {
		return out
	}
	cursor, err := s.raws.Find(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: ids}}}}, options.Find().
		SetProjection(bson.D{{Key: "_id", Value: 1}, {Key: "payload", Value: 1}}))
	if err != nil {
		log.Printf("dashboard war map: raw item url lookup failed")
		return out
	}
	defer cursor.Close(ctx)
	var raws []bson.M
	if err := cursor.All(ctx, &raws); err != nil {
		log.Printf("dashboard war map: raw item url lookup failed")
		return out
	}
	for _, raw := range raws {
		id := hexID(raw["_id"])
		payload, _ := raw["payload"].(bson.M)
		if payload == nil {
			continue
		}
		url, _ := payload["url"].(string)
		url = trim(url)
		if id != "" && url != "" {
			out[id] = url
		}
	}
	return out
}

func timeWindow(start, end time.Time) bson.D {
	return bson.D{{Key: "$gte", Value: start}, {Key: "$lte", Value: end}}
}

func mongoRangeFilter(start, end time.Time) bson.A {
	return bson.A{
		bson.D{{Key: "sortAt", Value: timeWindow(start, end)}},
		bson.D{{Key: "sortAt", Value: bson.D{{Key: "$exists", Value: false}}}, {Key: "ingestedAt", Value: timeWindow(start, end)}},
		bson.D{{Key: "sortAt", Value: nil}, {Key: "ingestedAt", Value: timeWindow(start, end)}},
		bson.D{
			{Key: "sortAt", Value: bson.D{{Key: "$exists", Value: false}}},
			{Key: "ingestedAt", Value: bson.D{{Key: "$exists", Value: false}}},
			{Key: "createdAt", Value: timeWindow(start, end)},
		},
		bson.D{
			{Key: "sortAt", Value: nil},
			{Key: "ingestedAt", Value: bson.D{{Key: "$exists", Value: false}}},
			{Key: "createdAt", Value: timeWindow(start, end)},
		},
	}
}

func trim(value string) string {
	return strings.TrimSpace(value)
}

func hexID(value any) string {
	switch id := value.(type) {
	case bson.ObjectID:
		return id.Hex()
	case string:
		return trim(id)
	default:
		return ""
	}
}

func parseAnyTime(value any) *time.Time {
	switch typed := value.(type) {
	case time.Time:
		if typed.IsZero() {
			return nil
		}
		copied := typed.UTC()
		return &copied
	case bson.DateTime:
		copied := typed.Time().UTC()
		return &copied
	case string:
		parsed, ok := parseLooseTime(typed)
		if !ok {
			return nil
		}
		return &parsed
	case float64:
		copied := time.UnixMilli(int64(typed)).UTC()
		return &copied
	case int64:
		copied := time.UnixMilli(typed).UTC()
		return &copied
	case int32:
		copied := time.UnixMilli(int64(typed)).UTC()
		return &copied
	default:
		return nil
	}
}

func parseLooseTime(value string) (time.Time, bool) {
	value = trim(value)
	if value == "" {
		return time.Time{}, false
	}
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02T15:04:05.000Z", "2006-01-02T15:04:05Z", "2006-01-02"} {
		if parsed, err := time.Parse(layout, value); err == nil {
			return parsed.UTC(), true
		}
	}
	return time.Time{}, false
}

func normalizeBSON(value any) any {
	switch typed := value.(type) {
	case bson.A:
		out := make([]any, 0, len(typed))
		for _, entry := range typed {
			out = append(out, normalizeBSON(entry))
		}
		return out
	case []any:
		out := make([]any, 0, len(typed))
		for _, entry := range typed {
			out = append(out, normalizeBSON(entry))
		}
		return out
	case bson.M:
		out := map[string]any{}
		for key, entry := range typed {
			out[key] = normalizeBSON(entry)
		}
		return out
	case bson.D:
		out := map[string]any{}
		for _, entry := range typed {
			out[entry.Key] = normalizeBSON(entry.Value)
		}
		return out
	default:
		return value
	}
}

var errMongoUnavailable = errString("mongo is not configured")

type errString string

func (e errString) Error() string { return string(e) }
