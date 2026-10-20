package newsnowhottest

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// rawItemsCollection is the Mongoose collection of RawItem.
const rawItemsCollection = "rawitems"

// matchChunkSize bounds every IN list so MySQL and Mongo keep the statements
// below the default packet and query limits.
const matchChunkSize = 500

type mongoMatchStore struct {
	mongo *mongo.Database
	db    *sql.DB
}

// NewMatchStore builds the production matcher over the shared Mongo database and
// MySQL pool. Both handles are required by the go mode.
func NewMatchStore(database *mongo.Database, db *sql.DB) MatchStore {
	return &mongoMatchStore{mongo: database, db: db}
}

// rawMatchRow is the $topN output document.
type rawMatchRow struct {
	ItemMetaID string    `bson:"itemMetaId"`
	PayloadURL string    `bson:"payloadUrl"`
	FullHash   string    `bson:"fullHash"`
	Full       string    `bson:"full"`
	Base       string    `bson:"base"`
	CreatedAt  time.Time `bson:"createdAt"`
}

// FindTopRawItems implements the batched comparable stage with $topN (Mongo 7.0).
// Each key keeps its twenty newest rows, exactly like one
// find().sort({createdAt:-1}).limit(20) per URL would.
func (s *mongoMatchStore) FindTopRawItems(ctx context.Context, field MatchField, keys []string) ([]RawItemRow, error) {
	if s == nil || s.mongo == nil {
		return nil, errors.New("newsnowhottest: mongo is not configured for URL matching")
	}
	if len(keys) == 0 {
		return nil, nil
	}
	fieldName := string(field)
	pipeline := mongo.Pipeline{
		bson.D{{Key: "$match", Value: bson.D{{
			Key:   fieldName,
			Value: bson.D{{Key: "$in", Value: keys}},
		}}}},
		bson.D{{Key: "$group", Value: bson.D{
			{Key: "_id", Value: "$" + fieldName},
			{Key: "rows", Value: bson.D{{Key: "$topN", Value: bson.D{
				{Key: "n", Value: maxResolveCandidatesPerStage},
				{Key: "sortBy", Value: bson.D{{Key: "createdAt", Value: -1}}},
				{Key: "output", Value: bson.D{
					{Key: "itemMetaId", Value: "$itemMetaId"},
					{Key: "payloadUrl", Value: "$payload.url"},
					{Key: "fullHash", Value: "$urlComparableFullHash"},
					{Key: "full", Value: "$urlComparableFull"},
					{Key: "base", Value: "$urlComparableBase"},
					{Key: "createdAt", Value: "$createdAt"},
				}},
			}}}},
		}}},
	}
	cursor, err := s.mongo.Collection(rawItemsCollection).Aggregate(ctx, pipeline)
	if err != nil {
		return nil, err
	}
	defer func() { _ = cursor.Close(ctx) }()
	var groups []struct {
		Rows []rawMatchRow `bson:"rows"`
	}
	if err := cursor.All(ctx, &groups); err != nil {
		return nil, err
	}
	rows := make([]RawItemRow, 0, len(groups)*4)
	for _, group := range groups {
		for _, row := range group.Rows {
			rows = append(rows, RawItemRow{
				ItemMetaID: strings.TrimSpace(row.ItemMetaID),
				PayloadURL: row.PayloadURL,
				FullHash:   row.FullHash,
				Full:       row.Full,
				Base:       row.Base,
				CreatedAt:  row.CreatedAt,
			})
		}
	}
	return rows, nil
}

// FindTopRawItemsByPayloadPattern implements the level-5 regex lookup with the
// same twenty-row bound as the comparable stages.
func (s *mongoMatchStore) FindTopRawItemsByPayloadPattern(ctx context.Context, pattern string) ([]RawItemRow, error) {
	if s == nil || s.mongo == nil {
		return nil, errors.New("newsnowhottest: mongo is not configured for URL matching")
	}
	projection := bson.D{
		{Key: "itemMetaId", Value: 1},
		{Key: "payload.url", Value: 1},
		{Key: "urlComparableFullHash", Value: 1},
		{Key: "urlComparableFull", Value: 1},
		{Key: "urlComparableBase", Value: 1},
		{Key: "createdAt", Value: 1},
	}
	opts := options.Find().
		SetProjection(projection).
		SetSort(bson.D{{Key: "createdAt", Value: -1}}).
		SetLimit(maxResolveCandidatesPerStage)
	cursor, err := s.mongo.Collection(rawItemsCollection).Find(ctx, bson.D{{
		Key: "payload.url",
		Value: bson.D{
			{Key: "$regex", Value: pattern},
			{Key: "$options", Value: "i"},
		},
	}}, opts)
	if err != nil {
		return nil, err
	}
	defer func() { _ = cursor.Close(ctx) }()
	rows := make([]RawItemRow, 0, maxResolveCandidatesPerStage)
	for cursor.Next(ctx) {
		var document struct {
			ItemMetaID string `bson:"itemMetaId"`
			Payload    struct {
				URL string `bson:"url"`
			} `bson:"payload"`
			FullHash  string    `bson:"urlComparableFullHash"`
			Full      string    `bson:"urlComparableFull"`
			Base      string    `bson:"urlComparableBase"`
			CreatedAt time.Time `bson:"createdAt"`
		}
		if err := cursor.Decode(&document); err != nil {
			return nil, err
		}
		rows = append(rows, RawItemRow{
			ItemMetaID: strings.TrimSpace(document.ItemMetaID),
			PayloadURL: document.Payload.URL,
			FullHash:   document.FullHash,
			Full:       document.Full,
			Base:       document.Base,
			CreatedAt:  document.CreatedAt,
		})
	}
	if err := cursor.Err(); err != nil {
		return nil, err
	}
	return rows, nil
}

// FindItemMetaOrgs resolves the owning organization of the given ItemMeta rows
// with chunked IN queries.
func (s *mongoMatchStore) FindItemMetaOrgs(ctx context.Context, itemMetaIDs []string) (map[string]string, error) {
	if s == nil || s.db == nil {
		return nil, errors.New("newsnowhottest: mysql is not configured for URL matching")
	}
	out := make(map[string]string, len(itemMetaIDs))
	for start := 0; start < len(itemMetaIDs); start += matchChunkSize {
		end := start + matchChunkSize
		if end > len(itemMetaIDs) {
			end = len(itemMetaIDs)
		}
		chunk := itemMetaIDs[start:end]
		placeholders := strings.TrimSuffix(strings.Repeat("?,", len(chunk)), ",")
		arguments := make([]any, 0, len(chunk))
		for _, itemMetaID := range chunk {
			arguments = append(arguments, itemMetaID)
		}
		rows, err := s.db.QueryContext(ctx, "SELECT id, orgId FROM ItemMeta WHERE id IN ("+placeholders+")", arguments...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var id, orgID string
			if err := rows.Scan(&id, &orgID); err != nil {
				_ = rows.Close()
				return nil, err
			}
			out[strings.TrimSpace(id)] = strings.TrimSpace(orgID)
		}
		if err := rows.Err(); err != nil {
			_ = rows.Close()
			return nil, err
		}
		_ = rows.Close()
	}
	return out, nil
}

// FindCompletedProcessedItemIDs batches the ProcessedItem read, keeping at most
// twenty newest ids per itemMetaId like the NestJS limit(20).
func (s *mongoMatchStore) FindCompletedProcessedItemIDs(ctx context.Context, orgID string, itemMetaIDs []string) (map[string][]string, error) {
	if s == nil || s.mongo == nil {
		return nil, errors.New("newsnowhottest: mongo is not configured for URL matching")
	}
	out := make(map[string][]string, len(itemMetaIDs))
	if len(itemMetaIDs) == 0 {
		return out, nil
	}
	opts := options.Find().
		SetProjection(bson.D{{Key: "_id", Value: 1}, {Key: "itemMetaId", Value: 1}}).
		SetSort(bson.D{{Key: "createdAt", Value: -1}})
	cursor, err := s.mongo.Collection(processedItemsCollection).Find(ctx, bson.D{
		{Key: "orgId", Value: orgID},
		{Key: "status", Value: "completed"},
		{Key: "itemMetaId", Value: bson.D{{Key: "$in", Value: itemMetaIDs}}},
	}, opts)
	if err != nil {
		return nil, err
	}
	defer func() { _ = cursor.Close(ctx) }()
	for cursor.Next(ctx) {
		var row struct {
			ID         bson.ObjectID `bson:"_id"`
			ItemMetaID string        `bson:"itemMetaId"`
		}
		if err := cursor.Decode(&row); err != nil {
			return nil, err
		}
		if row.ID.IsZero() {
			continue
		}
		itemMetaID := strings.TrimSpace(row.ItemMetaID)
		if itemMetaID == "" {
			continue
		}
		ids := out[itemMetaID]
		if len(ids) >= maxResolveCandidatesPerStage {
			continue
		}
		out[itemMetaID] = append(ids, row.ID.Hex())
	}
	if err := cursor.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// FindEventRows batches the NewsEventItem read. The caller sorts by createdAt and
// keeps the newest event per itemMetaId, which matches the NestJS
// orderBy(createdAt desc) findFirst.
func (s *mongoMatchStore) FindEventRows(ctx context.Context, orgID string, processedItemIDs []string) ([]EventRow, error) {
	if s == nil || s.db == nil {
		return nil, errors.New("newsnowhottest: mysql is not configured for URL matching")
	}
	rows := make([]EventRow, 0, len(processedItemIDs))
	for start := 0; start < len(processedItemIDs); start += matchChunkSize {
		end := start + matchChunkSize
		if end > len(processedItemIDs) {
			end = len(processedItemIDs)
		}
		chunk := processedItemIDs[start:end]
		placeholders := strings.TrimSuffix(strings.Repeat("?,", len(chunk)), ",")
		arguments := make([]any, 0, len(chunk)+1)
		arguments = append(arguments, orgID)
		for _, processedItemID := range chunk {
			arguments = append(arguments, processedItemID)
		}
		result, err := s.db.QueryContext(ctx,
			"SELECT processedItemId, eventId, createdAt FROM NewsEventItem WHERE orgId = ? AND processedItemId IN ("+placeholders+")",
			arguments...)
		if err != nil {
			return nil, err
		}
		for result.Next() {
			var row EventRow
			if err := result.Scan(&row.ProcessedItemID, &row.EventID, &row.CreatedAt); err != nil {
				_ = result.Close()
				return nil, err
			}
			rows = append(rows, row)
		}
		if err := result.Err(); err != nil {
			_ = result.Close()
			return nil, err
		}
		_ = result.Close()
	}
	return rows, nil
}
