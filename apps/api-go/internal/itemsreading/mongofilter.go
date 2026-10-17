package itemsreading

import (
	"context"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// processedSortAtExpression mirrors buildProcessedSortAtExpression: the stored
// sortAt, otherwise the parsed result.published_at, otherwise ingestedAt or
// createdAt.
func processedSortAtExpression() bson.D {
	return bson.D{{Key: "$ifNull", Value: bson.A{
		"$sortAt",
		bson.D{{Key: "$dateFromString", Value: bson.D{
			{Key: "dateString", Value: bson.D{{Key: "$ifNull", Value: bson.A{"$result.published_at", nil}}}},
			{Key: "onError", Value: bson.D{{Key: "$ifNull", Value: bson.A{"$ingestedAt", "$createdAt"}}}},
			{Key: "onNull", Value: bson.D{{Key: "$ifNull", Value: bson.A{"$ingestedAt", "$createdAt"}}}},
		}}},
	}}}
}

// processedContentFilters builds the content predicates shared by the primary
// filter aggregation and the IR3 source fallback, so the two condition sets can
// never drift apart.
func processedContentFilters(filters *ItemFilters) bson.A {
	conditions := bson.A{}
	if filters == nil {
		return conditions
	}
	if len(filters.Regions) > 0 {
		conditions = append(conditions, bson.D{{Key: "$or", Value: bson.A{
			bson.D{{Key: "result.location", Value: bson.D{{Key: "$in", Value: filters.Regions}}}},
			bson.D{{Key: "result.region", Value: bson.D{{Key: "$in", Value: filters.Regions}}}},
		}}})
	}
	if len(filters.Topics) > 0 {
		conditions = append(conditions, bson.D{{Key: "$or", Value: bson.A{
			bson.D{{Key: "result.topics", Value: bson.D{{Key: "$in", Value: filters.Topics}}}},
			bson.D{{Key: "tags", Value: bson.D{{Key: "$in", Value: filters.Topics}}}},
			bson.D{{Key: "result.entities.name", Value: bson.D{{Key: "$in", Value: filters.Topics}}}},
		}}})
	}
	if len(filters.Sentiments) > 0 {
		matchers := make(bson.A, 0, len(filters.Sentiments))
		for _, value := range filters.Sentiments {
			matchers = append(matchers, bson.Regex{Pattern: "^" + EscapeRegex(value) + "$", Options: "i"})
		}
		conditions = append(conditions, bson.D{{Key: "$or", Value: bson.A{
			bson.D{{Key: "result.sentiment", Value: bson.D{{Key: "$in", Value: matchers}}}},
			bson.D{{Key: "result.sentiment_label", Value: bson.D{{Key: "$in", Value: matchers}}}},
			bson.D{{Key: "tags", Value: bson.D{{Key: "$in", Value: matchers}}}},
		}}})
	}
	if len(filters.ContentTypes) > 0 {
		matchers := make(bson.A, 0, len(filters.ContentTypes))
		for _, value := range filters.ContentTypes {
			matchers = append(matchers, bson.Regex{Pattern: "^" + EscapeRegex(value) + "$", Options: "i"})
		}
		conditions = append(conditions, bson.D{{Key: "$or", Value: bson.A{
			bson.D{{Key: "result.content_type", Value: bson.D{{Key: "$in", Value: matchers}}}},
			bson.D{{Key: "result.contentType", Value: bson.D{{Key: "$in", Value: matchers}}}},
		}}})
	}
	if filters.ExcludeDuplicates {
		conditions = append(conditions, bson.D{{Key: "$or", Value: bson.A{
			bson.D{{Key: "duplicateOf", Value: nil}},
			bson.D{{Key: "duplicateOf", Value: bson.D{{Key: "$exists", Value: false}}}},
		}}})
	}
	return conditions
}

// processedDateFilter builds the sortAt date-range predicate.
func processedDateFilter(filters *ItemFilters) (bson.D, bool) {
	if filters == nil || filters.DateRange == nil {
		return nil, false
	}
	rangeDoc := bson.D{}
	if filters.DateRange.Start != nil {
		rangeDoc = append(rangeDoc, bson.E{Key: "$gte", Value: *filters.DateRange.Start})
	}
	if filters.DateRange.End != nil {
		rangeDoc = append(rangeDoc, bson.E{Key: "$lte", Value: *filters.DateRange.End})
	}
	if len(rangeDoc) == 0 {
		return nil, false
	}
	return bson.D{{Key: "sortAt", Value: rangeDoc}}, true
}

// FilterItemMetaIDsPrimary ports the primary branch of
// ItemsSearchQueryService.resolveFilterIds for the legacy (read-model disabled)
// path. The IR3 source fallback is assembled by the search service, which also
// owns the MySQL ProcessedArticle lookup, and re-applies the same content
// predicates through ApplyContentFilters.
func (s *mongoStore) FilterItemMetaIDsPrimary(
	ctx context.Context,
	orgID string,
	filters *ItemFilters,
) ([]string, error) {
	pipeline := mongo.Pipeline{
		{{Key: "$match", Value: bson.D{
			{Key: "orgId", Value: orgID},
			{Key: "status", Value: string(PipelineStageCompleted)},
		}}},
		{{Key: "$addFields", Value: bson.D{{Key: "normalizedSortAt", Value: processedSortAtExpression()}}}},
		{{Key: "$sort", Value: bson.D{
			{Key: "itemMetaId", Value: 1},
			{Key: "createdAt", Value: -1},
			{Key: "_id", Value: -1},
		}}},
		{{Key: "$group", Value: bson.D{
			{Key: "_id", Value: "$itemMetaId"},
			{Key: "itemMetaId", Value: bson.D{{Key: "$first", Value: "$itemMetaId"}}},
			{Key: "tags", Value: bson.D{{Key: "$first", Value: "$tags"}}},
			{Key: "result", Value: bson.D{{Key: "$first", Value: "$result"}}},
			{Key: "sourceId", Value: bson.D{{Key: "$first", Value: "$sourceId"}}},
			{Key: "duplicateOf", Value: bson.D{{Key: "$first", Value: "$duplicateOf"}}},
			{Key: "sortAt", Value: bson.D{{Key: "$first", Value: "$normalizedSortAt"}}},
		}}},
	}
	matchFilters := bson.A{}
	if filters != nil && len(filters.SourceIDs) > 0 {
		matchFilters = append(matchFilters, bson.D{{Key: "sourceId", Value: bson.D{{Key: "$in", Value: filters.SourceIDs}}}})
	}
	matchFilters = append(matchFilters, processedContentFilters(filters)...)
	if dateFilter, ok := processedDateFilter(filters); ok {
		matchFilters = append(matchFilters, dateFilter)
	}
	if len(matchFilters) > 0 {
		pipeline = append(pipeline, bson.D{{Key: "$match", Value: bson.D{{Key: "$and", Value: matchFilters}}}})
	}
	pipeline = append(pipeline, bson.D{{Key: "$project", Value: bson.D{{Key: "_id", Value: 0}, {Key: "itemMetaId", Value: 1}}}})
	return s.aggregateItemMetaIDs(ctx, pipeline)
}

// ApplyContentFilters re-applies the shared content predicates against each
// candidate's latest completed snapshot, so a stale snapshot can never admit a
// row the content filters would have excluded (IR3).
func (s *mongoStore) ApplyContentFilters(
	ctx context.Context,
	orgID string,
	itemMetaIDs []string,
	filters *ItemFilters,
) ([]string, error) {
	contentFilters := processedContentFilters(filters)
	if len(contentFilters) == 0 {
		return DedupeItemMetaIDs(itemMetaIDs), nil
	}
	if len(itemMetaIDs) == 0 {
		return nil, nil
	}
	pipeline := mongo.Pipeline{
		{{Key: "$match", Value: bson.D{
			{Key: "orgId", Value: orgID},
			{Key: "status", Value: string(PipelineStageCompleted)},
			{Key: "itemMetaId", Value: bson.D{{Key: "$in", Value: itemMetaIDs}}},
		}}},
		{{Key: "$addFields", Value: bson.D{{Key: "normalizedSortAt", Value: processedSortAtExpression()}}}},
		{{Key: "$sort", Value: bson.D{
			{Key: "itemMetaId", Value: 1},
			{Key: "createdAt", Value: -1},
			{Key: "_id", Value: -1},
		}}},
		{{Key: "$group", Value: bson.D{
			{Key: "_id", Value: "$itemMetaId"},
			{Key: "itemMetaId", Value: bson.D{{Key: "$first", Value: "$itemMetaId"}}},
			{Key: "tags", Value: bson.D{{Key: "$first", Value: "$tags"}}},
			{Key: "result", Value: bson.D{{Key: "$first", Value: "$result"}}},
			{Key: "sourceId", Value: bson.D{{Key: "$first", Value: "$sourceId"}}},
			{Key: "duplicateOf", Value: bson.D{{Key: "$first", Value: "$duplicateOf"}}},
			{Key: "sortAt", Value: bson.D{{Key: "$first", Value: "$normalizedSortAt"}}},
		}}},
		{{Key: "$match", Value: bson.D{{Key: "$and", Value: contentFilters}}}},
		{{Key: "$project", Value: bson.D{{Key: "_id", Value: 0}, {Key: "itemMetaId", Value: 1}}}},
	}
	return s.aggregateItemMetaIDs(ctx, pipeline)
}

// aggregateItemMetaIDs runs an aggregation that projects itemMetaId.
func (s *mongoStore) aggregateItemMetaIDs(ctx context.Context, pipeline mongo.Pipeline) ([]string, error) {
	cursor, err := s.processedItems().Aggregate(ctx, pipeline)
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)
	out := make([]string, 0, 64)
	for cursor.Next(ctx) {
		var row struct {
			ItemMetaID string `bson:"itemMetaId"`
		}
		if err := cursor.Decode(&row); err != nil {
			return nil, err
		}
		out = append(out, row.ItemMetaID)
	}
	if err := cursor.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// ProcessedIDsByObjectIDs resolves ProcessedItem object ids to itemMetaIds with
// the organization and completed-status predicates the search paths require.
func (s *mongoStore) ProcessedIDsByObjectIDs(
	ctx context.Context,
	orgID string,
	ids []bson.ObjectID,
) ([]string, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	opts := options.Find().
		SetProjection(bson.D{{Key: "itemMetaId", Value: 1}}).
		SetSort(bson.D{{Key: "createdAt", Value: -1}, {Key: "_id", Value: -1}}).
		SetLimit(MaxSearchMatches)
	cursor, err := s.processedItems().Find(ctx, bson.D{
		{Key: "_id", Value: bson.D{{Key: "$in", Value: ids}}},
		{Key: "orgId", Value: orgID},
		{Key: "status", Value: string(PipelineStageCompleted)},
	}, opts)
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)
	out := make([]string, 0, len(ids))
	for cursor.Next(ctx) {
		var row struct {
			ItemMetaID string `bson:"itemMetaId"`
		}
		if err := cursor.Decode(&row); err != nil {
			return nil, err
		}
		out = append(out, row.ItemMetaID)
	}
	if err := cursor.Err(); err != nil {
		return nil, err
	}
	return DedupeItemMetaIDs(out), nil
}

// ProcessedTextIDs ports resolveProcessedSearchIds (Mongo $text recall).
func (s *mongoStore) ProcessedTextIDs(ctx context.Context, orgID string, textQuery string) ([]string, error) {
	if strings.TrimSpace(textQuery) == "" {
		return nil, nil
	}
	opts := options.Find().
		SetProjection(bson.D{
			{Key: "itemMetaId", Value: 1},
			{Key: "score", Value: bson.D{{Key: "$meta", Value: "textScore"}}},
		}).
		SetSort(bson.D{
			{Key: "score", Value: bson.D{{Key: "$meta", Value: "textScore"}}},
			{Key: "createdAt", Value: -1},
		}).
		SetLimit(MaxSearchMatches)
	cursor, err := s.processedItems().Find(ctx, bson.D{
		{Key: "orgId", Value: orgID},
		{Key: "status", Value: string(PipelineStageCompleted)},
		{Key: "$text", Value: bson.D{{Key: "$search", Value: textQuery}}},
	}, opts)
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)
	out := make([]string, 0, 64)
	for cursor.Next(ctx) {
		var row struct {
			ItemMetaID string `bson:"itemMetaId"`
		}
		if err := cursor.Decode(&row); err != nil {
			return nil, err
		}
		out = append(out, row.ItemMetaID)
	}
	if err := cursor.Err(); err != nil {
		return nil, err
	}
	return DedupeItemMetaIDs(out), nil
}

// readModelBaseMatch mirrors buildReadModelBaseMatch.
func readModelBaseMatch(orgID string) bson.D {
	return bson.D{
		{Key: "orgId", Value: orgID},
		{Key: "status", Value: bson.D{{Key: "$ne", Value: string(ItemStatusDuplicate)}}},
	}
}

// readModelMatch mirrors buildReadModelMatch so the read-model filter branch
// keeps the same口径 as NestJS.
func readModelMatch(orgID string, filters *ItemFilters) bson.D {
	base := readModelBaseMatch(orgID)
	conditions := bson.A{base}
	normalized := NormalizeFilters(filters)
	if normalized == nil {
		return base
	}
	if len(normalized.SourceIDs) > 0 {
		conditions = append(conditions, bson.D{{Key: "sourceId", Value: bson.D{{Key: "$in", Value: normalized.SourceIDs}}}})
	}
	if len(normalized.Regions) > 0 {
		values := lowerAll(normalized.Regions)
		if len(values) > 0 {
			conditions = append(conditions, bson.D{{Key: "$or", Value: bson.A{
				bson.D{{Key: "regionKey", Value: bson.D{{Key: "$in", Value: values}}}},
				bson.D{{Key: "locationKey", Value: bson.D{{Key: "$in", Value: values}}}},
			}}})
		}
	}
	if len(normalized.Topics) > 0 {
		values := lowerAll(normalized.Topics)
		if len(values) > 0 {
			conditions = append(conditions, bson.D{{Key: "$or", Value: bson.A{
				bson.D{{Key: "topicKeys", Value: bson.D{{Key: "$in", Value: values}}}},
				bson.D{{Key: "entityKeys", Value: bson.D{{Key: "$in", Value: values}}}},
			}}})
		}
	}
	if len(normalized.Sentiments) > 0 {
		conditions = append(conditions, bson.D{{Key: "sentiment", Value: bson.D{{Key: "$in", Value: lowerAll(normalized.Sentiments)}}}})
	}
	if len(normalized.ContentTypes) > 0 {
		conditions = append(conditions, bson.D{{Key: "contentType", Value: bson.D{{Key: "$in", Value: lowerAll(normalized.ContentTypes)}}}})
	}
	if normalized.ExcludeDuplicates {
		conditions = append(conditions, bson.D{{Key: "$or", Value: bson.A{
			bson.D{{Key: "duplicateOf", Value: nil}},
			bson.D{{Key: "duplicateOf", Value: bson.D{{Key: "$exists", Value: false}}}},
		}}})
	}
	if dateRange := normalized.DateRange; dateRange != nil && (dateRange.Start != nil || dateRange.End != nil) {
		rangeDoc := bson.D{}
		if dateRange.Start != nil {
			rangeDoc = append(rangeDoc, bson.E{Key: "$gte", Value: *dateRange.Start})
		}
		if dateRange.End != nil {
			rangeDoc = append(rangeDoc, bson.E{Key: "$lte", Value: *dateRange.End})
		}
		conditions = append(conditions, bson.D{{Key: "sortAt", Value: rangeDoc}})
	}
	if len(conditions) == 1 {
		return base
	}
	return bson.D{{Key: "$and", Value: conditions}}
}

func lowerAll(values []string) bson.A {
	out := make(bson.A, 0, len(values))
	for _, value := range values {
		trimmed := strings.ToLower(strings.TrimSpace(value))
		if trimmed == "" {
			continue
		}
		out = append(out, trimmed)
	}
	return out
}

// FilterReadModelIDs ports the read-model filter branch.
func (s *mongoStore) FilterReadModelIDs(ctx context.Context, orgID string, filters *ItemFilters) ([]string, error) {
	opts := options.Find().
		SetProjection(bson.D{{Key: "itemMetaId", Value: 1}}).
		SetSort(bson.D{{Key: "sortAt", Value: -1}, {Key: "itemMetaId", Value: -1}}).
		SetLimit(MaxSearchMatches)
	cursor, err := s.readModels().Find(ctx, readModelMatch(orgID, filters), opts)
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)
	out := make([]string, 0, 64)
	for cursor.Next(ctx) {
		var row struct {
			ItemMetaID string `bson:"itemMetaId"`
		}
		if err := cursor.Decode(&row); err != nil {
			return nil, err
		}
		out = append(out, row.ItemMetaID)
	}
	if err := cursor.Err(); err != nil {
		return nil, err
	}
	return DedupeItemMetaIDs(out), nil
}

// ReadModelTextIDs ports the read-model $text recall.
func (s *mongoStore) ReadModelTextIDs(ctx context.Context, orgID string, textQuery string) ([]string, error) {
	if strings.TrimSpace(textQuery) == "" {
		return nil, nil
	}
	opts := options.Find().
		SetProjection(bson.D{
			{Key: "itemMetaId", Value: 1},
			{Key: "score", Value: bson.D{{Key: "$meta", Value: "textScore"}}},
		}).
		SetSort(bson.D{
			{Key: "score", Value: bson.D{{Key: "$meta", Value: "textScore"}}},
			{Key: "sortAt", Value: -1},
			{Key: "itemMetaId", Value: -1},
		}).
		SetLimit(MaxSearchMatches)
	cursor, err := s.readModels().Find(ctx, bson.D{
		{Key: "$and", Value: bson.A{
			readModelBaseMatch(orgID),
			bson.D{{Key: "$text", Value: bson.D{{Key: "$search", Value: textQuery}}}},
		}},
	}, opts)
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)
	out := make([]string, 0, 64)
	for cursor.Next(ctx) {
		var row struct {
			ItemMetaID string `bson:"itemMetaId"`
		}
		if err := cursor.Decode(&row); err != nil {
			return nil, err
		}
		out = append(out, row.ItemMetaID)
	}
	if err := cursor.Err(); err != nil {
		return nil, err
	}
	return DedupeItemMetaIDs(out), nil
}

// ReadModelPrefixIDs ports the read-model prefix recall over the denormalized
// lower-case fields, keeping the stable sortAt DESC, itemMetaId DESC order.
func (s *mongoStore) ReadModelPrefixIDs(ctx context.Context, orgID string, term string) ([]string, error) {
	pattern := "^" + EscapeRegex(strings.ToLower(strings.TrimSpace(term)))
	if pattern == "^" {
		return nil, nil
	}
	prefix := bson.Regex{Pattern: pattern}
	opts := options.Find().
		SetProjection(bson.D{{Key: "itemMetaId", Value: 1}}).
		SetSort(bson.D{{Key: "sortAt", Value: -1}, {Key: "itemMetaId", Value: -1}}).
		SetLimit(MaxSearchMatches)
	cursor, err := s.readModels().Find(ctx, bson.D{
		{Key: "$and", Value: bson.A{
			readModelBaseMatch(orgID),
			bson.D{{Key: "$or", Value: bson.A{
				bson.D{{Key: "titleLower", Value: prefix}},
				bson.D{{Key: "externalIdLower", Value: prefix}},
				bson.D{{Key: "sourceNameLower", Value: prefix}},
				bson.D{{Key: "topicKeys", Value: prefix}},
				bson.D{{Key: "entityKeys", Value: prefix}},
				bson.D{{Key: "regionKey", Value: prefix}},
				bson.D{{Key: "locationKey", Value: prefix}},
			}}},
		}},
	}, opts)
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)
	out := make([]string, 0, 64)
	for cursor.Next(ctx) {
		var row struct {
			ItemMetaID string `bson:"itemMetaId"`
		}
		if err := cursor.Decode(&row); err != nil {
			return nil, err
		}
		out = append(out, row.ItemMetaID)
	}
	if err := cursor.Err(); err != nil {
		return nil, err
	}
	return DedupeItemMetaIDs(out), nil
}

// SourceCountsCached exposes the source-count snapshot used by suggestions.
func (s *mongoStore) SourceCountsCached(ctx context.Context, orgID string) ([]SourceCount, error) {
	return s.SourceCounts(ctx, orgID)
}

// windowStatFromTime builds a WindowStat from an optional timestamp.
func windowStatFromTime(count int, latest *time.Time) WindowStat {
	stat := WindowStat{ItemCountWindow: count}
	if latest != nil {
		value := latest.UTC()
		stat.LatestItemAt = &value
	}
	return stat
}
