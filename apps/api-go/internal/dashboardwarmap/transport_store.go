package dashboardwarmap

import (
	"context"
	"errors"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

func (s *mongoStore) states() bool {
	return s != nil && s.transportStates != nil && s.transportTracks != nil
}

func (s *mongoStore) FindTransportState(ctx context.Context, orgID, kind, objectKey string) (map[string]any, bool, error) {
	if !s.states() {
		return nil, false, errMongoUnavailable
	}
	var doc bson.M
	err := s.transportStates.FindOne(ctx, bson.D{
		{Key: "orgId", Value: orgID},
		{Key: "entityKind", Value: kind},
		{Key: "objectKey", Value: objectKey},
	}).Decode(&doc)
	if err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			return nil, false, nil
		}
		return nil, false, err
	}
	normalized, _ := normalizeBSON(doc).(map[string]any)
	return normalized, true, nil
}

func (s *mongoStore) FindTransportTracks(ctx context.Context, orgID, kind, objectKey string, start, end *time.Time, limit int) ([]map[string]any, error) {
	if !s.states() {
		return nil, errMongoUnavailable
	}
	if limit < 1 {
		limit = 1
	}
	filter := bson.D{
		{Key: "orgId", Value: orgID},
		{Key: "entityKind", Value: kind},
		{Key: "objectKey", Value: objectKey},
	}
	if start != nil && end != nil {
		filter = append(filter, bson.E{Key: "observedAt", Value: bson.D{
			{Key: "$gte", Value: *start},
			{Key: "$lte", Value: *end},
		}})
	}
	cursor, err := s.transportTracks.Find(ctx, filter, options.Find().
		SetSort(bson.D{{Key: "observedAt", Value: -1}}).
		SetLimit(int64(limit)))
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)
	var docs []bson.M
	if err := cursor.All(ctx, &docs); err != nil {
		return nil, err
	}
	out := make([]map[string]any, 0, len(docs))
	for _, doc := range docs {
		normalized, _ := normalizeBSON(doc).(map[string]any)
		if normalized != nil {
			out = append(out, normalized)
		}
	}
	return out, nil
}
