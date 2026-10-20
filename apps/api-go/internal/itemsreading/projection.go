package itemsreading

import (
	"context"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// ReadModelBuildInput is the direct projection input used by the
// processed_item outbox: unlike hydration it already holds the exact meta,
// raw and processed snapshots the delivery just wrote, so no additional
// MySQL/Mongo reads are needed.
type ReadModelBuildInput struct {
	Meta      ItemMetaRow
	Raw       *ReadModelRawDoc
	Processed *ReadModelProcessedDoc
	SourceID  *string
}

// BuildReadModelDocument ports buildItemReadModelDocument for a caller that
// supplies the snapshots explicitly. The returned document is the same shape
// the hydration path writes, including the derived search terms and scalar
// compatibility fields.
func BuildReadModelDocument(input ReadModelBuildInput) ReadModelDocument {
	sourceID := ""
	if input.SourceID != nil {
		sourceID = *input.SourceID
	}
	return buildReadModelDocument(buildReadModelInput{
		Meta:      input.Meta,
		Raw:       input.Raw,
		Processed: input.Processed,
		SourceID:  sourceID,
	})
}

// UpsertReadModelProjection writes one projection produced by
// BuildReadModelDocument. The legacy NestJS outbox uses a plain $set of the
// whole patch, so a missing raw snapshot is written as null here instead of
// being $unset like the hydration path. Processed is always present for this
// caller.
func (h *Hydrator) UpsertReadModelProjection(ctx context.Context, doc ReadModelDocument) error {
	if h == nil || h.readModel == nil || h.readModel.mongo == nil {
		return nil
	}
	encoded, err := bson.Marshal(doc)
	if err != nil {
		return err
	}
	var set bson.D
	if err := bson.Unmarshal(encoded, &set); err != nil {
		return err
	}
	if doc.Raw == nil {
		set = append(set, bson.E{Key: "raw", Value: nil})
	}
	if doc.Processed == nil {
		set = append(set, bson.E{Key: "processed", Value: nil})
	}
	_, err = h.readModel.mongo.readModels().UpdateOne(
		ctx,
		bson.D{{Key: "orgId", Value: doc.OrgID}, {Key: "itemMetaId", Value: doc.ItemMetaID}},
		bson.D{{Key: "$set", Value: set}},
		options.UpdateOne().SetUpsert(true),
	)
	return err
}
