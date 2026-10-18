package searchreindex

import (
	"context"
	"fmt"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

const (
	// itemReadModelsCollection is the Mongoose default collection name of
	// ItemReadModel (packages/mongo/src/models/item-read-model.ts).
	itemReadModelsCollection = "itemreadmodels"
	// reindexBatchSize is the maximum number of documents per Mongo page and
	// per Elasticsearch bulk request.
	reindexBatchSize = 500
)

// itemReadModelDocument is the projected Mongo document the rebuild needs. The
// projection below deliberately excludes raw.payload, processed.result and every
// other large field.
type itemReadModelDocument struct {
	OrgID       string    `bson:"orgId"`
	ItemMetaID  string    `bson:"itemMetaId"`
	Title       string    `bson:"title"`
	ExternalID  string    `bson:"externalId"`
	SourceName  *string   `bson:"sourceName"`
	Summary     *string   `bson:"summary"`
	Topics      []string  `bson:"topics"`
	Entities    []string  `bson:"entities"`
	Region      *string   `bson:"region"`
	Location    *string   `bson:"location"`
	Sentiment   *string   `bson:"sentiment"`
	ContentType *string   `bson:"contentType"`
	SearchText  *string   `bson:"searchText"`
	SortAt      time.Time `bson:"sortAt"`
	CreatedAt   time.Time `bson:"createdAt"`
}

// reindexProjection keeps only the fields the Elasticsearch document uses. _id is
// excluded because it never reaches the index.
var reindexProjection = bson.D{
	{Key: "_id", Value: 0},
	{Key: "orgId", Value: 1},
	{Key: "itemMetaId", Value: 1},
	{Key: "title", Value: 1},
	{Key: "externalId", Value: 1},
	{Key: "sourceName", Value: 1},
	{Key: "summary", Value: 1},
	{Key: "topics", Value: 1},
	{Key: "entities", Value: 1},
	{Key: "region", Value: 1},
	{Key: "location", Value: 1},
	{Key: "sentiment", Value: 1},
	{Key: "contentType", Value: 1},
	{Key: "searchText", Value: 1},
	{Key: "sortAt", Value: 1},
	{Key: "createdAt", Value: 1},
}

// mongoSource pages through the organization's read model.
type mongoSource struct {
	collection *mongo.Collection
}

// newMongoSource binds the item read model collection. A nil database leaves the
// source nil, so the rebuild fails closed instead of writing an empty index.
func newMongoSource(database *mongo.Database) *mongoSource {
	if database == nil {
		return nil
	}
	return &mongoSource{collection: database.Collection(itemReadModelsCollection)}
}

// nextBatch returns one ascending itemMetaId page. The cursor advances with
// "$gt lastItemMetaId" instead of an ever growing skip, the page size is capped
// at reindexBatchSize and the query always carries orgId.
func (s *mongoSource) nextBatch(ctx context.Context, orgID, cursor string) ([]ItemSearchDocument, error) {
	filter := bson.D{{Key: "orgId", Value: orgID}}
	if cursor != "" {
		filter = append(filter, bson.E{Key: "itemMetaId", Value: bson.D{{Key: "$gt", Value: cursor}}})
	}
	result, err := s.collection.Find(ctx, filter, options.Find().
		SetProjection(reindexProjection).
		SetSort(bson.D{{Key: "itemMetaId", Value: 1}}).
		SetLimit(reindexBatchSize))
	if err != nil {
		return nil, fmt.Errorf("%w: %v", errMongo, err)
	}
	var documents []itemReadModelDocument
	if err := result.All(ctx, &documents); err != nil {
		return nil, fmt.Errorf("%w: %v", errMongo, err)
	}
	searchDocuments := make([]ItemSearchDocument, 0, len(documents))
	for _, document := range documents {
		searchDocument, err := buildSearchDocument(document)
		if err != nil {
			return nil, err
		}
		searchDocuments = append(searchDocuments, searchDocument)
	}
	return searchDocuments, nil
}

// buildSearchDocument converts one projected read model row into the index
// document. A null array becomes an empty array and a null text field stays
// null, preserving the existing document shape; both timestamps must be real
// dates so the index never receives an invalid date string.
func buildSearchDocument(document itemReadModelDocument) (ItemSearchDocument, error) {
	if document.SortAt.IsZero() {
		return ItemSearchDocument{}, fmt.Errorf("reindex document %s has no valid sortAt", document.ItemMetaID)
	}
	if document.CreatedAt.IsZero() {
		return ItemSearchDocument{}, fmt.Errorf("reindex document %s has no valid createdAt", document.ItemMetaID)
	}
	topics := document.Topics
	if topics == nil {
		topics = []string{}
	}
	entities := document.Entities
	if entities == nil {
		entities = []string{}
	}
	searchText := ""
	if document.SearchText != nil {
		searchText = *document.SearchText
	}
	return ItemSearchDocument{
		OrgID:       document.OrgID,
		ItemMetaID:  document.ItemMetaID,
		Title:       document.Title,
		ExternalID:  document.ExternalID,
		SourceName:  document.SourceName,
		Summary:     document.Summary,
		Topics:      topics,
		Entities:    entities,
		Region:      document.Region,
		Location:    document.Location,
		Sentiment:   document.Sentiment,
		ContentType: document.ContentType,
		SearchText:  searchText,
		SortAt:      isoTimestamp(document.SortAt),
		CreatedAt:   isoTimestamp(document.CreatedAt),
	}, nil
}
