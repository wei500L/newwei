package itemsreading

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// ErrItemNotFound is the REST detail miss error. The message is the exact
// NestJS sentence.
var ErrItemNotFound = errors.New("Item not found")

// FindRawItemEcho loads the raw document for an already verified,
// organization-scoped ItemMeta and returns it as a presence-preserving echo so
// the legacy Mongoose lean() REST shape is reproduced exactly. The doc must
// satisfy both `_id = mongoRef` and `itemMetaId = itemMetaID`.
func (s *mongoStore) FindRawItemEcho(
	ctx context.Context,
	itemMetaID string,
	mongoRef string,
) (*DocumentEcho, error) {
	trimmedRef := strings.TrimSpace(mongoRef)
	if !isValidObjectIDHex(trimmedRef) {
		return nil, nil
	}
	objectID, err := bson.ObjectIDFromHex(trimmedRef)
	if err != nil {
		return nil, nil
	}
	var echo DocumentEcho
	err = s.rawItems().FindOne(ctx, bson.D{
		{Key: "_id", Value: objectID},
		{Key: "itemMetaId", Value: itemMetaID},
	}).Decode(&echo)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &echo, nil
}

// FindLatestProcessedEcho loads the newest processed document for one item and
// returns the presence-preserving echo used by the legacy REST detail.
func (s *mongoStore) FindLatestProcessedEcho(
	ctx context.Context,
	orgID string,
	itemMetaID string,
) (*DocumentEcho, error) {
	opts := options.FindOne().SetSort(bson.D{{Key: "createdAt", Value: -1}})
	var echo DocumentEcho
	err := s.processedItems().FindOne(ctx, bson.D{
		{Key: "orgId", Value: orgID},
		{Key: "itemMetaId", Value: itemMetaID},
	}, opts).Decode(&echo)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &echo, nil
}

// marshalEcho renders a presence-preserving document, or JSON null.
func marshalEcho(echo *DocumentEcho) (json.RawMessage, error) {
	if echo == nil {
		return json.RawMessage("null"), nil
	}
	encoded, err := json.Marshal(echo)
	if err != nil {
		return nil, err
	}
	return json.RawMessage(encoded), nil
}
