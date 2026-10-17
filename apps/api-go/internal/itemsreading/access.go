package itemsreading

import (
	"context"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// This file exposes the read paths the GraphQL adapter needs while keeping the
// tenant-binding rules inside the domain package: every method below is
// organization scoped and the adapter never issues a Mongo query itself.

// ReadModelEnabled reports whether ITEMS_READ_MODEL_ENABLED is on.
func (s *Service) ReadModelEnabled() bool {
	return s.readModelEnabled
}

// ReadModelProjection loads one read-model document with an explicit
// projection. The five projections in ReadModelProjections mirror the legacy
// NestJS loaders.
func (s *Service) ReadModelProjection(
	ctx context.Context,
	orgID string,
	itemMetaID string,
	projection bson.D,
) (*ReadModelDocument, error) {
	docs, err := s.mongo.FindReadModelsProjected(ctx, orgID, []string{itemMetaID}, projection)
	if err != nil {
		return nil, err
	}
	for index := range docs {
		if docs[index].ItemMetaID == itemMetaID {
			return &docs[index], nil
		}
	}
	return nil, nil
}

// RawItemBound loads the raw document bound to a verified ItemMeta. A missing
// or malformed mongoRef yields nil.
func (s *Service) RawItemBound(
	ctx context.Context,
	itemMetaID string,
	mongoRef string,
) (*RawItemDoc, error) {
	return s.mongo.FindRawItemBound(ctx, itemMetaID, mongoRef)
}

// ProcessedByKeys loads the status-priority processed document per item id.
func (s *Service) ProcessedByKeys(
	ctx context.Context,
	orgID string,
	itemMetaIDs []string,
	includeResult bool,
) (map[string]ProcessedItemDoc, error) {
	return s.mongo.FindProcessedByKeys(ctx, orgID, itemMetaIDs, includeResult)
}
