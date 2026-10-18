package itemsreading

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

// This file adds the store queries the GraphQL list branches need on top of the
// REST primitives: composite (time, id) cursor paging, one-page meta row
// lookup, cursor time lookup, the non-read-model processed feature scan and the
// batched NewsEventItem link. Every query stays organization scoped; the raw
// feature scan is bound to itemMetaId values that were already read from
// organization-scoped ItemMeta rows, so it cannot surface a foreign document.

// FindListableItemMetaRows loads the organization-scoped ItemMeta rows for a
// candidate id set, excluding the duplicate status exactly like
// ItemsReadModelService.fetchItemMetaRowsByIds in non-read-model mode.
func (s *mySQLStore) FindListableItemMetaRows(
	ctx context.Context,
	orgID string,
	ids []string,
) (map[string]ItemMetaRow, error) {
	out := make(map[string]ItemMetaRow, len(ids))
	ordered := DedupeItemMetaIDs(ids)
	if len(ordered) == 0 {
		return out, nil
	}
	query := "SELECT " + itemMetaColumns + " FROM `ItemMeta`" + itemMetaBaseWhere +
		mySQLInPredicate("`id`", len(ordered))
	args := make(mySQLArgs, 0, len(ordered)+1)
	args = append(args, orgID)
	for _, id := range ordered {
		args = append(args, id)
	}
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items, err := mySQLScanItemMetaRows(rows)
	if err != nil {
		return nil, err
	}
	for _, row := range items {
		out[row.ID] = row
	}
	return out, nil
}

// ListItemMetaAfterCursor pages ItemMeta strictly after the composite
// (time, id) cursor boundary. Advance is `time < t OR (time = t AND id < id)`,
// matching the Prisma OR clause in listWithCursor; a plain offset would skip or
// repeat rows when several rows share the same timestamp. limit is take+1 so the
// caller can decide hasNextPage from the extra row.
func (s *mySQLStore) ListItemMetaAfterCursor(
	ctx context.Context,
	orgID string,
	scopedIDs []string,
	orderBy ItemsOrderBy,
	cursorTime time.Time,
	cursorID string,
	limit int,
) ([]ItemMetaRow, error) {
	if scopedIDs != nil && len(scopedIDs) == 0 {
		return []ItemMetaRow{}, nil
	}
	orderColumn := "`createdAt`"
	if orderBy == ItemsOrderByPublishedDesc {
		orderColumn = "`sortAt`"
	}
	query := "SELECT " + itemMetaColumns + " FROM `ItemMeta`" + itemMetaBaseWhere
	args := make(mySQLArgs, 0, len(scopedIDs)+4)
	args = append(args, orgID)
	if len(scopedIDs) > 0 {
		query += mySQLInPredicate("`id`", len(scopedIDs))
		for _, id := range scopedIDs {
			args = append(args, id)
		}
	}
	query += " AND (" + orderColumn + " < ? OR (" + orderColumn + " = ? AND `id` < ?))"
	args = append(args, cursorTime, cursorTime, cursorID)
	query += mySQLItemMetaOrderClause(orderBy)
	query += " LIMIT ?"
	args = append(args, limit)

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return mySQLScanItemMetaRows(rows)
}

// ReadModelSortKeys is the cursor row lookup result: the two time columns the
// time orderings can order by.
type ReadModelSortKeys struct {
	SortAt    *time.Time
	CreatedAt *time.Time
}

// FindReadModelSortKeys reads the time columns of one read-model document. It
// is the fallback used when a cursor payload carries an id without a usable
// timestamp; a missing document yields nil so the caller returns the empty
// page instead of silently restarting from the first page.
func (s *mongoStore) FindReadModelSortKeys(
	ctx context.Context,
	orgID string,
	itemMetaID string,
) (*ReadModelSortKeys, error) {
	trimmed := strings.TrimSpace(itemMetaID)
	if trimmed == "" {
		return nil, nil
	}
	opts := options.FindOne().SetProjection(bson.D{
		{Key: "createdAt", Value: 1},
		{Key: "sortAt", Value: 1},
	})
	var row struct {
		CreatedAt *ISOTime `bson:"createdAt"`
		SortAt    *ISOTime `bson:"sortAt"`
	}
	err := s.readModels().FindOne(ctx, bson.D{
		{Key: "orgId", Value: orgID},
		{Key: "itemMetaId", Value: trimmed},
	}, opts).Decode(&row)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	keys := &ReadModelSortKeys{}
	if row.SortAt != nil && !row.SortAt.IsZero() {
		value := row.SortAt.Time
		keys.SortAt = &value
	}
	if row.CreatedAt != nil && !row.CreatedAt.IsZero() {
		value := row.CreatedAt.Time
		keys.CreatedAt = &value
	}
	return keys, nil
}

// ListReadModelMetaRowsAfterCursor is the read-model twin of
// ListItemMetaAfterCursor: the same composite boundary over the denormalized
// collection, ordered by sortAt or createdAt with itemMetaId as the tie-break so
// rows sharing a timestamp are never skipped or repeated.
func (s *mongoStore) ListReadModelMetaRowsAfterCursor(
	ctx context.Context,
	orgID string,
	scopedIDs []string,
	orderBy ItemsOrderBy,
	cursorTime time.Time,
	cursorID string,
	limit int,
) ([]ReadModelDocument, error) {
	if scopedIDs != nil && len(scopedIDs) == 0 {
		return []ReadModelDocument{}, nil
	}
	orderField := "createdAt"
	if orderBy == ItemsOrderByPublishedDesc {
		orderField = "sortAt"
	}
	match := bson.D{{Key: "$and", Value: bson.A{
		readModelScopedMatch(orgID, scopedIDs),
		bson.D{{Key: "$or", Value: bson.A{
			bson.D{{Key: orderField, Value: bson.D{{Key: "$lt", Value: cursorTime}}}},
			bson.D{{Key: orderField, Value: cursorTime}, {Key: "itemMetaId", Value: bson.D{{Key: "$lt", Value: cursorID}}}},
		}}},
	}}}
	opts := options.Find().
		SetProjection(readModelProjectionMeta()).
		SetSort(bson.D{{Key: orderField, Value: -1}, {Key: "itemMetaId", Value: -1}}).
		SetLimit(int64(limit))
	cursor, err := s.readModels().Find(ctx, match, opts)
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)
	out := make([]ReadModelDocument, 0, limit)
	for cursor.Next(ctx) {
		var doc ReadModelDocument
		if err := cursor.Decode(&doc); err != nil {
			return nil, err
		}
		out = append(out, doc)
	}
	if err := cursor.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// FindProcessedResultsByItemMetaIDs returns the newest completed processed
// document's result per item id for the non-read-model relevance document. The
// scan is limited to len(ids)*3 rows and keeps the first row per item, mirroring
// the `$sort createdAt desc` + Map.set-if-absent loop in NestJS.
func (s *mongoStore) FindProcessedResultsByItemMetaIDs(
	ctx context.Context,
	orgID string,
	itemMetaIDs []string,
) (map[string]OpenJSON, error) {
	out := make(map[string]OpenJSON, len(itemMetaIDs))
	ordered := DedupeItemMetaIDs(itemMetaIDs)
	if len(ordered) == 0 {
		return out, nil
	}
	opts := options.Find().
		SetProjection(bson.D{{Key: "itemMetaId", Value: 1}, {Key: "result", Value: 1}}).
		SetSort(bson.D{{Key: "createdAt", Value: -1}}).
		SetLimit(int64(len(ordered) * 3))
	cursor, err := s.processedItems().Find(ctx, bson.D{
		{Key: "orgId", Value: orgID},
		{Key: "status", Value: string(PipelineStageCompleted)},
		{Key: "itemMetaId", Value: bson.D{{Key: "$in", Value: ordered}}},
	}, opts)
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)
	for cursor.Next(ctx) {
		var row struct {
			ItemMetaID string   `bson:"itemMetaId"`
			Result     OpenJSON `bson:"result"`
		}
		if err := cursor.Decode(&row); err != nil {
			return nil, err
		}
		id := strings.TrimSpace(row.ItemMetaID)
		if id == "" {
			continue
		}
		if _, exists := out[id]; exists {
			continue
		}
		out[id] = row.Result
	}
	if err := cursor.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// ProcessedFeatureAggregate is one item's non-read-model personalization
// features: the stored source plus the result document and the ids of the
// processed snapshots that can link to a NewsEventItem.
type ProcessedFeatureAggregate struct {
	ItemMetaID       string
	SourceID         *string
	Source           *string
	Result           OpenJSON
	ProcessedItemIDs []string
}

// AggregateProcessedFeatures ports the ProcessedItemModel.aggregate in
// loadCandidateFeatures: for every itemMetaId with a completed processed
// document it keeps the newest snapshot's sourceId/source/result and up to 12
// processed document ids.
func (s *mongoStore) AggregateProcessedFeatures(
	ctx context.Context,
	orgID string,
	itemMetaIDs []string,
) ([]ProcessedFeatureAggregate, error) {
	ordered := DedupeItemMetaIDs(itemMetaIDs)
	if len(ordered) == 0 {
		return nil, nil
	}
	pipeline := mongo.Pipeline{
		bson.D{{Key: "$match", Value: bson.D{
			{Key: "orgId", Value: orgID},
			{Key: "status", Value: string(PipelineStageCompleted)},
			{Key: "itemMetaId", Value: bson.D{{Key: "$in", Value: ordered}}},
		}}},
		bson.D{{Key: "$sort", Value: bson.D{{Key: "createdAt", Value: -1}}}},
		bson.D{{Key: "$group", Value: bson.D{
			{Key: "_id", Value: "$itemMetaId"},
			{Key: "itemMetaId", Value: bson.D{{Key: "$first", Value: "$itemMetaId"}}},
			{Key: "sourceId", Value: bson.D{{Key: "$first", Value: "$sourceId"}}},
			{Key: "source", Value: bson.D{{Key: "$first", Value: "$source"}}},
			{Key: "result", Value: bson.D{{Key: "$first", Value: "$result"}}},
			{Key: "processedItemIds", Value: bson.D{{Key: "$push", Value: bson.D{{Key: "$toString", Value: "$_id"}}}}},
		}}},
		bson.D{{Key: "$project", Value: bson.D{
			{Key: "itemMetaId", Value: 1},
			{Key: "sourceId", Value: 1},
			{Key: "source", Value: 1},
			{Key: "result", Value: 1},
			{Key: "processedItemIds", Value: bson.D{{Key: "$slice", Value: bson.A{"$processedItemIds", 12}}}},
		}}},
	}
	cursor, err := s.processedItems().Aggregate(ctx, pipeline)
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)
	out := make([]ProcessedFeatureAggregate, 0, len(ordered))
	for cursor.Next(ctx) {
		var row struct {
			ItemMetaID       string   `bson:"itemMetaId"`
			SourceID         *string  `bson:"sourceId"`
			Source           *string  `bson:"source"`
			Result           OpenJSON `bson:"result"`
			ProcessedItemIDs []string `bson:"processedItemIds"`
		}
		if err := cursor.Decode(&row); err != nil {
			return nil, err
		}
		if strings.TrimSpace(row.ItemMetaID) == "" {
			continue
		}
		out = append(out, ProcessedFeatureAggregate{
			ItemMetaID:       row.ItemMetaID,
			SourceID:         row.SourceID,
			Source:           row.Source,
			Result:           row.Result,
			ProcessedItemIDs: row.ProcessedItemIDs,
		})
	}
	if err := cursor.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// RawDomainRow is one item's URL-derived domain feature.
type RawDomainRow struct {
	ItemMetaID string
	URL        *string
}

// AggregateRawDomains ports the RawItemModel.aggregate that feeds the
// personalized domain feature: the newest raw document per itemMetaId, keeping
// only payload.url. The match is by itemMetaId because the raw collection has no
// orgId column; the ids come from organization-scoped ItemMeta rows, so the scan
// cannot reach a foreign document.
func (s *mongoStore) AggregateRawDomains(
	ctx context.Context,
	itemMetaIDs []string,
) ([]RawDomainRow, error) {
	ordered := DedupeItemMetaIDs(itemMetaIDs)
	if len(ordered) == 0 {
		return nil, nil
	}
	pipeline := mongo.Pipeline{
		bson.D{{Key: "$match", Value: bson.D{
			{Key: "itemMetaId", Value: bson.D{{Key: "$in", Value: ordered}}},
		}}},
		bson.D{{Key: "$sort", Value: bson.D{{Key: "createdAt", Value: -1}}}},
		bson.D{{Key: "$group", Value: bson.D{
			{Key: "_id", Value: "$itemMetaId"},
			{Key: "itemMetaId", Value: bson.D{{Key: "$first", Value: "$itemMetaId"}}},
			{Key: "url", Value: bson.D{{Key: "$first", Value: "$payload.url"}}},
		}}},
	}
	cursor, err := s.rawItems().Aggregate(ctx, pipeline)
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)
	out := make([]RawDomainRow, 0, len(ordered))
	for cursor.Next(ctx) {
		var row struct {
			ItemMetaID string  `bson:"itemMetaId"`
			URL        *string `bson:"url"`
		}
		if err := cursor.Decode(&row); err != nil {
			return nil, err
		}
		if strings.TrimSpace(row.ItemMetaID) == "" {
			continue
		}
		out = append(out, RawDomainRow{ItemMetaID: row.ItemMetaID, URL: row.URL})
	}
	if err := cursor.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// NewsEventItemEventIDsByProcessedItemIDs ports the Prisma findMany over
// NewsEventItem for the personalized event feature. It returns up to 8 unique
// event ids per processed item, newest membership first; every row carries
// orgId so a processed id from another tenant can never contribute an event.
func (s *mySQLStore) NewsEventItemEventIDsByProcessedItemIDs(
	ctx context.Context,
	orgID string,
	processedItemIDs []string,
) (map[string][]string, error) {
	out := make(map[string][]string, len(processedItemIDs))
	ordered := DedupeItemMetaIDs(processedItemIDs)
	if len(ordered) == 0 {
		return out, nil
	}
	query := "SELECT processedItemId, eventId FROM NewsEventItem WHERE orgId = ?" +
		mySQLInPredicate("`processedItemId`", len(ordered)) +
		" ORDER BY `createdAt` DESC, `id` DESC"
	args := make(mySQLArgs, 0, len(ordered)+1)
	args = append(args, orgID)
	for _, id := range ordered {
		args = append(args, id)
	}
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var processedID, eventID sql.NullString
		if err := rows.Scan(&processedID, &eventID); err != nil {
			return nil, err
		}
		normalizedProcessed := normalizeBehaviorID(processedID.String)
		normalizedEvent := normalizeBehaviorID(eventID.String)
		if normalizedProcessed == "" || normalizedEvent == "" {
			continue
		}
		bucket := out[normalizedProcessed]
		if stringInSlice(bucket, normalizedEvent) {
			continue
		}
		bucket = append(bucket, normalizedEvent)
		if len(bucket) > 8 {
			bucket = bucket[:8]
		}
		out[normalizedProcessed] = bucket
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}
