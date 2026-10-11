package contentcatalog

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/personalnews"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

var (
	errMongoUnavailable    = errors.New("content catalog candidate source unavailable")
	errDatabaseUnavailable = errors.New("content catalog database unavailable")
)

func (s *Service) loadAllCandidates(ctx context.Context, orgID string) ([]candidate, taxonomyDescriptor, error) {
	type batch struct {
		rows []candidate
		err  error
	}
	var topics, entities, sources, keywords, geos batch
	var taxonomy taxonomyDescriptor
	var wg sync.WaitGroup
	wg.Add(6)
	go func() { defer wg.Done(); topics.rows, topics.err = s.loadTopicCandidates(ctx, orgID) }()
	go func() { defer wg.Done(); entities.rows, entities.err = s.loadEntityCandidates(ctx, orgID) }()
	go func() { defer wg.Done(); sources.rows, sources.err = s.loadSourceCandidates(ctx, orgID) }()
	go func() { defer wg.Done(); keywords.rows, keywords.err = s.loadKeywordCandidates(ctx, orgID) }()
	go func() { defer wg.Done(); geos.rows, geos.err = s.loadGeoCandidates(ctx, orgID) }()
	go func() { defer wg.Done(); taxonomy = s.loadTaxonomy(ctx, orgID) }()
	wg.Wait()
	if ctx.Err() != nil {
		return nil, taxonomyDescriptor{}, ctx.Err()
	}
	for _, err := range []error{topics.err, entities.err, sources.err, keywords.err, geos.err} {
		if err != nil {
			return nil, taxonomyDescriptor{}, err
		}
	}
	if ctx.Err() != nil {
		return nil, taxonomyDescriptor{}, ctx.Err()
	}
	merged := make([]candidate, 0, len(topics.rows)+len(entities.rows)+len(sources.rows)+len(keywords.rows)+len(geos.rows))
	merged = append(merged, topics.rows...)
	merged = append(merged, entities.rows...)
	merged = append(merged, sources.rows...)
	merged = append(merged, keywords.rows...)
	merged = append(merged, geos.rows...)
	sortCandidates(merged)
	limit := catalogMaxPerKind * len(catalogKinds)
	if len(merged) > limit {
		merged = merged[:limit]
	}
	return merged, taxonomy, nil
}

func (s *Service) processedItems() (*mongo.Collection, error) {
	if s.mdb == nil {
		return nil, errMongoUnavailable
	}
	return s.mdb.Collection(processedItemsCollection), nil
}

func (s *Service) aggregate(ctx context.Context, pipeline mongo.Pipeline, out any) error {
	coll, err := s.processedItems()
	if err != nil {
		return err
	}
	cursor, err := coll.Aggregate(ctx, pipeline)
	if err != nil {
		return err
	}
	defer cursor.Close(ctx)
	return cursor.All(ctx, out)
}

func activityExpr() bson.D {
	fallback := bson.D{{Key: "$ifNull", Value: bson.A{"$ingestedAt", "$createdAt"}}}
	return bson.D{{Key: "$ifNull", Value: bson.A{
		"$sortAt",
		bson.D{{Key: "$convert", Value: bson.D{
			{Key: "input", Value: "$result.published_at"},
			{Key: "to", Value: "date"},
			{Key: "onError", Value: fallback},
			{Key: "onNull", Value: fallback},
		}}},
	}}}
}

func datedPipeline(since time.Time, match bson.D, tail ...bson.D) mongo.Pipeline {
	pipeline := mongo.Pipeline{
		{{Key: "$match", Value: match}},
		{{Key: "$project", Value: bson.D{
			{Key: "createdAt", Value: 1},
			{Key: "ingestedAt", Value: 1},
			{Key: "sortAt", Value: 1},
			{Key: "result", Value: 1},
		}}},
		{{Key: "$addFields", Value: bson.D{{Key: "activityAt", Value: activityExpr()}}}},
		{{Key: "$match", Value: bson.D{{Key: "activityAt", Value: bson.D{{Key: "$gte", Value: since}}}}}},
	}
	return append(pipeline, tail...)
}

type countAgg struct {
	ID         any        `bson:"_id"`
	EntityType any        `bson:"entityType"`
	Count      any        `bson:"count"`
	LastSeenAt *time.Time `bson:"lastSeenAt"`
}

type keywordAgg struct {
	Result     bson.Raw   `bson:"result"`
	ActivityAt *time.Time `bson:"activityAt"`
}

func (s *Service) loadTopicCandidates(ctx context.Context, orgID string) ([]candidate, error) {
	since := sinceWindow(time.Now())
	var rows []countAgg
	err := s.aggregate(ctx, datedPipeline(since, bson.D{
		{Key: "orgId", Value: orgID},
		{Key: "status", Value: "completed"},
		{Key: "result.topics.0", Value: bson.D{{Key: "$exists", Value: true}}},
	},
		bson.D{{Key: "$unwind", Value: "$result.topics"}},
		bson.D{{Key: "$group", Value: bson.D{
			{Key: "_id", Value: "$result.topics"},
			{Key: "count", Value: bson.D{{Key: "$sum", Value: 1}}},
			{Key: "lastSeenAt", Value: bson.D{{Key: "$max", Value: "$activityAt"}}},
		}}},
		bson.D{{Key: "$sort", Value: bson.D{{Key: "count", Value: -1}, {Key: "lastSeenAt", Value: -1}}}},
		bson.D{{Key: "$limit", Value: catalogMaxPerKind * 4}},
	), &rows)
	if err != nil {
		return nil, err
	}
	merged := map[string]*candidate{}
	for _, row := range rows {
		text, _ := row.ID.(string)
		display, normalized := normalizeValue(text, personalnews.KindTopic)
		if normalized == "" {
			continue
		}
		addCount(merged, candidate{
			Kind:            personalnews.KindTopic,
			NormalizedValue: normalized,
			DisplayValue:    display,
			Count:           toPositiveInt(row.Count),
			LastSeenAt:      timeOrNow(row.LastSeenAt),
		})
	}
	return capCandidates(valuesOf(merged)), nil
}

func (s *Service) loadEntityCandidates(ctx context.Context, orgID string) ([]candidate, error) {
	if s.db == nil {
		return nil, errDatabaseUnavailable
	}
	since := sinceWindow(time.Now())
	merged := map[string]*candidate{}
	mysqlRows, err := s.db.QueryContext(ctx, `
SELECT e.canonicalName AS displayValue,
       MAX(e.type) AS entityType,
       COUNT(*) AS count,
       MAX(COALESCE(p.publishedAt, a.crawlAt, a.createdAt)) AS lastSeenAt
FROM ArticleEntityLink l
INNER JOIN KnowledgeEntity e ON e.id = l.entityId
INNER JOIN Article a ON a.id = l.articleId
LEFT JOIN ProcessedArticle p ON p.articleId = a.id AND p.orgId = l.orgId
WHERE l.orgId = ?
  AND COALESCE(p.publishedAt, a.crawlAt, a.createdAt) >= ?
GROUP BY e.canonicalName
HAVING COUNT(*) >= ?
ORDER BY COUNT(*) DESC, MAX(COALESCE(p.publishedAt, a.crawlAt, a.createdAt)) DESC
LIMIT ?`, orgID, since, catalogMinCount, catalogMaxPerKind)
	if err != nil {
		return nil, err
	}
	defer mysqlRows.Close()
	for mysqlRows.Next() {
		var display string
		var entityType sql.NullString
		var count int64
		var last sql.NullTime
		if err := mysqlRows.Scan(&display, &entityType, &count, &last); err != nil {
			return nil, err
		}
		var seen *time.Time
		if last.Valid {
			copied := last.Time
			seen = &copied
		}
		mergeEntity(merged, display, nullString(entityType), count, seen)
	}
	if err := mysqlRows.Err(); err != nil {
		return nil, err
	}

	var mongoRows []countAgg
	err = s.aggregate(ctx, datedPipeline(since, bson.D{
		{Key: "orgId", Value: orgID},
		{Key: "status", Value: "completed"},
		{Key: "result.entities.0", Value: bson.D{{Key: "$exists", Value: true}}},
	},
		bson.D{{Key: "$unwind", Value: "$result.entities"}},
		bson.D{{Key: "$group", Value: bson.D{
			{Key: "_id", Value: "$result.entities.name"},
			{Key: "entityType", Value: bson.D{{Key: "$max", Value: "$result.entities.type"}}},
			{Key: "count", Value: bson.D{{Key: "$sum", Value: 1}}},
			{Key: "lastSeenAt", Value: bson.D{{Key: "$max", Value: "$activityAt"}}},
		}}},
		bson.D{{Key: "$sort", Value: bson.D{{Key: "count", Value: -1}, {Key: "lastSeenAt", Value: -1}}}},
		bson.D{{Key: "$limit", Value: catalogMaxPerKind * 4}},
	), &mongoRows)
	if err != nil {
		return nil, err
	}
	fallback := map[string]*candidate{}
	for _, row := range mongoRows {
		text, _ := row.ID.(string)
		mergeEntity(fallback, text, stringify(row.EntityType), row.Count, row.LastSeenAt)
	}
	for key, entry := range fallback {
		if _, exists := merged[key]; !exists {
			merged[key] = entry
		}
	}
	return capCandidates(valuesOf(merged)), nil
}

func (s *Service) loadSourceCandidates(ctx context.Context, orgID string) ([]candidate, error) {
	if s.db == nil {
		return nil, errDatabaseUnavailable
	}
	since := sinceWindow(time.Now())
	rows, err := s.db.QueryContext(ctx, `
SELECT sourceId, COUNT(*) AS count, MAX(crawlAt) AS lastSeenAt
FROM Article
WHERE orgId = ? AND sourceId IS NOT NULL AND crawlAt >= ?
GROUP BY sourceId`, orgID, since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	type grouped struct {
		id    string
		count int
		last  time.Time
	}
	var groups []grouped
	ids := make([]any, 0)
	for rows.Next() {
		var id sql.NullString
		var count int64
		var last sql.NullTime
		if err := rows.Scan(&id, &count, &last); err != nil {
			return nil, err
		}
		sourceID := strings.TrimSpace(id.String)
		if !id.Valid || sourceID == "" {
			continue
		}
		seen := time.Now()
		if last.Valid {
			seen = last.Time
		}
		groups = append(groups, grouped{id: sourceID, count: toPositiveInt(count), last: seen})
		ids = append(ids, sourceID)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(ids) == 0 {
		return nil, nil
	}
	query := `SELECT id, name, url, language, config FROM NewsSource WHERE orgId = ? AND id IN (` + placeholders(len(ids)) + `)`
	args := append([]any{orgID}, ids...)
	sourceRows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer sourceRows.Close()
	type sourceRow struct {
		name, url string
		language  string
		config    []byte
	}
	byID := map[string]sourceRow{}
	for sourceRows.Next() {
		var id, name, url string
		var language sql.NullString
		var config []byte
		if err := sourceRows.Scan(&id, &name, &url, &language, &config); err != nil {
			return nil, err
		}
		byID[id] = sourceRow{name: name, url: url, language: nullString(language), config: config}
	}
	if err := sourceRows.Err(); err != nil {
		return nil, err
	}
	candidates := make([]candidate, 0, len(groups))
	for _, group := range groups {
		source, ok := byID[group.id]
		if !ok {
			continue
		}
		display := strings.TrimSpace(source.name)
		if display == "" {
			display = group.id
		}
		candidates = append(candidates, candidate{
			Kind:            personalnews.KindSource,
			NormalizedValue: group.id,
			DisplayValue:    display,
			Count:           group.count,
			LastSeenAt:      group.last,
			Metadata:        sourceMetadata(group.id, source.url, source.language, source.config),
		})
	}
	return capCandidates(candidates), nil
}

func (s *Service) loadKeywordCandidates(ctx context.Context, orgID string) ([]candidate, error) {
	since := sinceWindow(time.Now())
	var rows []keywordAgg
	err := s.aggregate(ctx, datedPipeline(since, bson.D{
		{Key: "orgId", Value: orgID},
		{Key: "status", Value: "completed"},
		{Key: "result", Value: bson.D{{Key: "$exists", Value: true}, {Key: "$ne", Value: nil}}},
	},
		bson.D{{Key: "$sort", Value: bson.D{{Key: "activityAt", Value: -1}}}},
		bson.D{{Key: "$limit", Value: keywordDocLimit}},
	), &rows)
	if err != nil {
		return nil, err
	}
	merged := map[string]*candidate{}
	for _, row := range rows {
		decoded, err := decodeBSON(row.Result)
		if err != nil {
			return nil, err
		}
		record, _ := decoded.(map[string]any)
		terms := extractKeywordTerms(record)
		if len(terms) == 0 {
			continue
		}
		last := timeOrNow(row.ActivityAt)
		for _, term := range terms {
			display, normalized := normalizeValue(term, personalnews.KindKeyword)
			if normalized == "" {
				continue
			}
			key := subscriptionKey(personalnews.KindKeyword, normalized)
			if existing := merged[key]; existing != nil {
				existing.Count++
				if last.After(existing.LastSeenAt) {
					existing.LastSeenAt = last
				}
				continue
			}
			copied := keywordMetadata()
			merged[key] = &candidate{
				Kind:            personalnews.KindKeyword,
				NormalizedValue: normalized,
				DisplayValue:    display,
				Count:           1,
				LastSeenAt:      last,
				Metadata:        copied,
			}
		}
	}
	return capCandidates(valuesOf(merged)), nil
}

func (s *Service) loadGeoCandidates(ctx context.Context, orgID string) ([]candidate, error) {
	since := sinceWindow(time.Now())
	locationRows, err := s.loadGeoRows(ctx, orgID, since, "location")
	if err != nil {
		return nil, err
	}
	regionRows, err := s.loadGeoRows(ctx, orgID, since, "region")
	if err != nil {
		return nil, err
	}
	merged := map[string]*candidate{}
	for _, row := range append(locationRows, regionRows...) {
		text, _ := row.ID.(string)
		geo := canonicalizeGeoValue(text)
		if geo.Normalized == "" {
			continue
		}
		var metadata map[string]any
		if geo.CountryCode != "" {
			metadata = map[string]any{"countryCodeAlpha2": geo.CountryCode}
		}
		key := subscriptionKey(personalnews.KindGeo, geo.Normalized)
		count := toPositiveInt(row.Count)
		last := timeOrNow(row.LastSeenAt)
		if existing := merged[key]; existing != nil {
			existing.Count += count
			if last.After(existing.LastSeenAt) {
				existing.LastSeenAt = last
			}
			if existing.Metadata == nil && metadata != nil {
				existing.Metadata = metadata
			}
			continue
		}
		merged[key] = &candidate{
			Kind:            personalnews.KindGeo,
			NormalizedValue: geo.Normalized,
			DisplayValue:    geo.Display,
			Count:           count,
			LastSeenAt:      last,
			Metadata:        metadata,
		}
	}
	return capCandidates(valuesOf(merged)), nil
}

func (s *Service) loadGeoRows(ctx context.Context, orgID string, since time.Time, field string) ([]countAgg, error) {
	var rows []countAgg
	err := s.aggregate(ctx, datedPipeline(since, bson.D{
		{Key: "orgId", Value: orgID},
		{Key: "status", Value: "completed"},
		{Key: "result." + field, Value: bson.D{{Key: "$exists", Value: true}, {Key: "$ne", Value: nil}}},
	},
		bson.D{{Key: "$group", Value: bson.D{
			{Key: "_id", Value: "$result." + field},
			{Key: "count", Value: bson.D{{Key: "$sum", Value: 1}}},
			{Key: "lastSeenAt", Value: bson.D{{Key: "$max", Value: "$activityAt"}}},
		}}},
		bson.D{{Key: "$sort", Value: bson.D{{Key: "count", Value: -1}, {Key: "lastSeenAt", Value: -1}}}},
		bson.D{{Key: "$limit", Value: catalogMaxPerKind * 4}},
	), &rows)
	return rows, err
}

func mergeEntity(target map[string]*candidate, display string, entityType string, count any, last *time.Time) {
	shown, normalized := normalizeValue(display, personalnews.KindEntity)
	if normalized == "" {
		return
	}
	key := subscriptionKey(personalnews.KindEntity, normalized)
	seen := timeOrNow(last)
	amount := toPositiveInt(count)
	if existing := target[key]; existing != nil {
		existing.Count += amount
		if seen.After(existing.LastSeenAt) {
			existing.LastSeenAt = seen
		}
		if metaString(existing.Metadata, "entityType") == "" && entityType != "" {
			if existing.Metadata == nil {
				existing.Metadata = map[string]any{}
			}
			existing.Metadata["entityType"] = entityType
		}
		return
	}
	var metadata map[string]any
	if entityType != "" {
		metadata = map[string]any{"entityType": entityType}
	}
	target[key] = &candidate{
		Kind:            personalnews.KindEntity,
		NormalizedValue: normalized,
		DisplayValue:    shown,
		Count:           amount,
		LastSeenAt:      seen,
		Metadata:        metadata,
	}
}

func addCount(target map[string]*candidate, next candidate) {
	key := subscriptionKey(next.Kind, next.NormalizedValue)
	if existing := target[key]; existing != nil {
		existing.Count += next.Count
		if next.LastSeenAt.After(existing.LastSeenAt) {
			existing.LastSeenAt = next.LastSeenAt
		}
		return
	}
	copied := next
	target[key] = &copied
}

func valuesOf(target map[string]*candidate) []candidate {
	out := make([]candidate, 0, len(target))
	for _, entry := range target {
		out = append(out, *entry)
	}
	return out
}

func capCandidates(items []candidate) []candidate {
	filtered := make([]candidate, 0, len(items))
	for _, item := range items {
		if item.Count >= catalogMinCount {
			filtered = append(filtered, item)
		}
	}
	sortCandidates(filtered)
	if len(filtered) > catalogMaxPerKind {
		filtered = filtered[:catalogMaxPerKind]
	}
	return filtered
}

func sortCandidates(items []candidate) {
	sort.SliceStable(items, func(i, j int) bool {
		if items[i].Count != items[j].Count {
			return items[i].Count > items[j].Count
		}
		return items[i].LastSeenAt.After(items[j].LastSeenAt)
	})
}

func timeOrNow(value *time.Time) time.Time {
	if value == nil || value.IsZero() {
		return time.Now()
	}
	return *value
}

func nullString(value sql.NullString) string {
	if !value.Valid {
		return ""
	}
	return value.String
}

func placeholders(count int) string {
	parts := make([]string, count)
	for i := range parts {
		parts[i] = "?"
	}
	return strings.Join(parts, ",")
}

func sourceMetadata(id, siteURL, language string, config []byte) map[string]any {
	meta := map[string]any{
		"sourceId": id,
		"siteUrl":  siteURL,
	}
	if feed := feedURL(config); feed != "" {
		meta["feedUrl"] = feed
	}
	if language != "" {
		meta["language"] = language
	}
	return meta
}

func feedURL(config []byte) string {
	if len(config) == 0 {
		return ""
	}
	var doc map[string]any
	if json.Unmarshal(config, &doc) != nil || doc == nil {
		return ""
	}
	seed, _ := doc["seed"].(map[string]any)
	if seed == nil {
		return ""
	}
	value, _ := seed["feedUrl"].(string)
	return strings.TrimSpace(value)
}

func decodeBSON(raw bson.Raw) (any, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	var value any
	if err := bson.Unmarshal(raw, &value); err != nil {
		return nil, err
	}
	return bsonToAny(value), nil
}

func bsonToAny(value any) any {
	switch typed := value.(type) {
	case bson.D:
		out := make(map[string]any, len(typed))
		for _, element := range typed {
			out[element.Key] = bsonToAny(element.Value)
		}
		return out
	case bson.M:
		out := make(map[string]any, len(typed))
		for key, element := range typed {
			out[key] = bsonToAny(element)
		}
		return out
	case bson.A:
		out := make([]any, len(typed))
		for i, element := range typed {
			out[i] = bsonToAny(element)
		}
		return out
	default:
		return value
	}
}
