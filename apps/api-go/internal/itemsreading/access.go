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

// ReadModelProjectionBatch loads one read-model projection for many item ids in
// a single organization-scoped query. It is the list-path counterpart of
// ReadModelProjection and exists so a page of edges never issues one query per
// item.
func (s *Service) ReadModelProjectionBatch(
	ctx context.Context,
	orgID string,
	itemMetaIDs []string,
	projection bson.D,
) (map[string]ReadModelDocument, error) {
	out := make(map[string]ReadModelDocument, len(itemMetaIDs))
	if len(itemMetaIDs) == 0 {
		return out, nil
	}
	docs, err := s.mongo.FindReadModelsProjected(ctx, orgID, itemMetaIDs, projection)
	if err != nil {
		return nil, err
	}
	for _, doc := range docs {
		if doc.ItemMetaID == "" {
			continue
		}
		if _, exists := out[doc.ItemMetaID]; exists {
			continue
		}
		out[doc.ItemMetaID] = doc
	}
	return out, nil
}

// RawItemsBound loads the raw documents for many verified ItemMeta bindings in
// one query, so a page of edges never issues one raw lookup per item.
func (s *Service) RawItemsBound(ctx context.Context, bindings map[string]string) (map[string]RawItemDoc, error) {
	return s.mongo.FindRawItemsBound(ctx, bindings)
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
