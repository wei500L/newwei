package itemsreading

import (
	"context"
	"database/sql"

	"go.mongodb.org/mongo-driver/v2/mongo"
)

// Hydrator is the narrow write-side read-model port. It constructs only the
// MySQL and Mongo read-model stores, so a background owner (the raw_item
// outbox replay) does not need the JWT authenticator, HTTP readers, search
// clients or model gateways.
type Hydrator struct {
	readModel *readModelService
}

// NewHydrator builds the write-side hydrator from the shared handles.
func NewHydrator(db *sql.DB, mongoDB *mongo.Database) *Hydrator {
	return &Hydrator{readModel: newReadModelService(newMySQLStore(db), newMongoStore(mongoDB))}
}

// HydrateItemReadModel ports hydrateItemReadModel: rebuild and upsert the
// projection for one organization-scoped item.
func (h *Hydrator) HydrateItemReadModel(ctx context.Context, orgID, itemMetaID string) error {
	if h == nil || h.readModel == nil {
		return nil
	}
	_, err := h.readModel.hydrateItemReadModelsBatch(ctx, orgID, []string{itemMetaID})
	return err
}

// HydrateItemReadModels exposes the same 500-row batch used by the read paths.
func (h *Hydrator) HydrateItemReadModels(ctx context.Context, orgID string, itemMetaIDs []string) (map[string]ReadModelDocument, error) {
	if h == nil || h.readModel == nil {
		return map[string]ReadModelDocument{}, nil
	}
	return h.readModel.hydrateItemReadModelsBatch(ctx, orgID, itemMetaIDs)
}
