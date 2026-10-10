package dashboardspacetime

import (
	"context"
	"database/sql"
	"errors"
	"math"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

type geoRow struct {
	ID          string
	ArticleID   string
	Title       string
	Location    string
	CleanedRef  string
	Published   *time.Time
	EventAt     *time.Time
	Processed   *time.Time
	URL         *string
	SourceLabel *string
	CrawlAt     *time.Time
}

type propRow struct {
	ProcessedItemID string
	ArticleID       string
	CleanedRef      string
	Title           string
	Published       *time.Time
	Processed       *time.Time
	URL             string
	SourceLabel     string
	SourceNull      bool
	CrawlAt         *time.Time
}

type dupLink struct {
	Child      string
	Parent     string
	Similarity *float64
}

type articleReader interface {
	Geo(ctx context.Context, orgID string, start, end time.Time, eventID string) ([]geoRow, error)
	Propagation(ctx context.Context, orgID, eventID string, start, end time.Time) ([]propRow, error)
}

type itemReader interface {
	Sentiments(ctx context.Context, orgID string, ids []string) (map[string]string, bool)
	Duplicates(ctx context.Context, orgID string, ids []string) ([]dupLink, bool)
}

type snapshotCache interface {
	Load(ctx context.Context, orgID, id string) ([]byte, bool, error)
	Save(ctx context.Context, orgID, id string, body []byte) error
}

type mysqlArticles struct {
	db *sql.DB
}

func (s *mysqlArticles) Geo(ctx context.Context, orgID string, start, end time.Time, eventID string) ([]geoRow, error) {
	if s == nil || s.db == nil {
		return nil, errors.New("mysql is not configured")
	}
	query := `
SELECT pa.id, pa.articleId, pa.title, pa.location, pa.cleanedMarkdownRef,
       pa.publishedAt, pa.eventAt, pa.processedAt, a.url, a.sourceLabel, a.crawlAt
FROM ProcessedArticle pa
INNER JOIN Article a ON a.id = pa.articleId
WHERE pa.orgId = ?
  AND pa.status = 'completed'
  AND pa.hasLocation = 1
  AND pa.eventAt >= ? AND pa.eventAt <= ?`
	args := []any{orgID, start.UTC(), end.UTC()}
	if eventID != "" {
		query += `
  AND EXISTS (
    SELECT 1 FROM NewsEventItem nei
    WHERE nei.processedArticleId = pa.id AND nei.orgId = ? AND nei.eventId = ?
  )`
		args = append(args, orgID, eventID)
	}
	query += `
ORDER BY pa.eventAt DESC, pa.articleId DESC
LIMIT ?`
	args = append(args, maxGeoRecords)
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]geoRow, 0)
	for rows.Next() {
		var row geoRow
		var title, location, cleaned sql.NullString
		var published, eventAt, processed, crawl sql.NullTime
		var articleURL, source sql.NullString
		if err := rows.Scan(&row.ID, &row.ArticleID, &title, &location, &cleaned, &published, &eventAt, &processed, &articleURL, &source, &crawl); err != nil {
			return nil, err
		}
		row.Title = title.String
		row.Location = location.String
		row.CleanedRef = cleaned.String
		row.Published = nullTime(published)
		row.EventAt = nullTime(eventAt)
		row.Processed = nullTime(processed)
		row.CrawlAt = nullTime(crawl)
		if articleURL.Valid {
			value := articleURL.String
			row.URL = &value
		}
		if source.Valid {
			value := source.String
			row.SourceLabel = &value
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

func (s *mysqlArticles) Propagation(ctx context.Context, orgID, eventID string, start, end time.Time) ([]propRow, error) {
	if s == nil || s.db == nil {
		return nil, errors.New("mysql is not configured")
	}
	rows, err := s.db.QueryContext(ctx, `
SELECT nei.processedItemId, pa.id, pa.cleanedMarkdownRef, pa.title,
       pa.publishedAt, pa.processedAt, a.url, a.sourceLabel, a.crawlAt
FROM NewsEventItem nei
INNER JOIN ProcessedArticle pa ON pa.id = nei.processedArticleId
INNER JOIN Article a ON a.id = pa.articleId
WHERE nei.orgId = ? AND nei.eventId = ?
  AND pa.status = 'completed' AND pa.orgId = ?
  AND pa.eventAt >= ? AND pa.eventAt <= ?
ORDER BY nei.createdAt DESC
LIMIT ?`, orgID, eventID, orgID, start.UTC(), end.UTC(), propRowLimit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]propRow, 0)
	for rows.Next() {
		var row propRow
		var processedItem, cleaned, title, source sql.NullString
		var published, processed, crawl sql.NullTime
		var articleURL string
		if err := rows.Scan(&processedItem, &row.ArticleID, &cleaned, &title, &published, &processed, &articleURL, &source, &crawl); err != nil {
			return nil, err
		}
		row.ProcessedItemID = processedItem.String
		row.CleanedRef = cleaned.String
		row.Title = title.String
		row.URL = articleURL
		row.SourceNull = !source.Valid
		row.SourceLabel = source.String
		row.Published = nullTime(published)
		row.Processed = nullTime(processed)
		row.CrawlAt = nullTime(crawl)
		out = append(out, row)
	}
	return out, rows.Err()
}

func nullTime(value sql.NullTime) *time.Time {
	if !value.Valid {
		return nil
	}
	copied := value.Time.UTC()
	return &copied
}

type mongoItems struct {
	coll *mongo.Collection
}

func (m *mongoItems) Sentiments(ctx context.Context, orgID string, ids []string) (map[string]string, bool) {
	unique := uniqueStrings(ids)
	if len(unique) == 0 {
		return map[string]string{}, true
	}
	oids := make([]bson.ObjectID, 0, len(unique))
	for _, id := range unique {
		oid, err := bson.ObjectIDFromHex(id)
		if err != nil {
			return nil, false
		}
		oids = append(oids, oid)
	}
	if m == nil || m.coll == nil {
		return nil, false
	}
	cursor, err := m.coll.Find(ctx, bson.M{"_id": bson.M{"$in": oids}, "orgId": orgID, "status": "completed"}, options.Find().SetProjection(bson.D{{Key: "_id", Value: 1}, {Key: "result", Value: 1}}))
	if err != nil {
		return nil, false
	}
	defer cursor.Close(ctx)
	var docs []bson.M
	if err := cursor.All(ctx, &docs); err != nil {
		return nil, false
	}
	out := make(map[string]string, len(docs))
	for _, doc := range docs {
		id := mongoID(doc["_id"])
		if id == "" {
			continue
		}
		out[id] = sentimentFromResult(asMap(doc["result"]))
	}
	return out, true
}

func (m *mongoItems) Duplicates(ctx context.Context, orgID string, ids []string) ([]dupLink, bool) {
	oids := make([]bson.ObjectID, 0, len(ids))
	for _, id := range ids {
		oid, err := bson.ObjectIDFromHex(id)
		if err != nil {
			continue
		}
		oids = append(oids, oid)
	}
	if len(oids) == 0 {
		return nil, true
	}
	if m == nil || m.coll == nil {
		return nil, false
	}
	cursor, err := m.coll.Find(ctx, bson.M{"_id": bson.M{"$in": oids}, "orgId": orgID, "status": "completed"}, options.Find().SetProjection(bson.D{
		{Key: "_id", Value: 1},
		{Key: "duplicateOf", Value: 1},
		{Key: "duplicateSimilarity", Value: 1},
	}))
	if err != nil {
		return nil, false
	}
	defer cursor.Close(ctx)
	var docs []bson.M
	if err := cursor.All(ctx, &docs); err != nil {
		return nil, false
	}
	links := make([]dupLink, 0)
	for _, doc := range docs {
		child := mongoID(doc["_id"])
		parent := mongoID(doc["duplicateOf"])
		if child == "" || parent == "" {
			continue
		}
		links = append(links, dupLink{Child: child, Parent: parent, Similarity: floatPtr(doc["duplicateSimilarity"])})
	}
	return links, true
}

func bsonMap(value bson.M) map[string]any {
	if value == nil {
		return nil
	}
	out := make(map[string]any, len(value))
	for key, item := range value {
		out[key] = item
	}
	return out
}

func mongoID(value any) string {
	switch typed := value.(type) {
	case bson.ObjectID:
		return typed.Hex()
	case string:
		return extractObjectID(typed)
	default:
		return ""
	}
}

func asMap(value any) map[string]any {
	switch typed := value.(type) {
	case bson.M:
		return bsonMap(typed)
	case map[string]any:
		return typed
	case bson.D:
		out := make(map[string]any, len(typed))
		for _, elem := range typed {
			out[elem.Key] = elem.Value
		}
		return out
	default:
		return nil
	}
}

func floatPtr(value any) *float64 {
	var parsed float64
	switch typed := value.(type) {
	case float64:
		parsed = typed
	case float32:
		parsed = float64(typed)
	case int32:
		parsed = float64(typed)
	case int64:
		parsed = float64(typed)
	case int:
		parsed = float64(typed)
	default:
		return nil
	}
	if math.IsNaN(parsed) || math.IsInf(parsed, 0) {
		return nil
	}
	return &parsed
}

func uniqueStrings(values []string) []string {
	out := make([]string, 0, len(values))
	seen := map[string]struct{}{}
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	return out
}

type redisSnapshots struct {
	client *redis.Client
}

func (r redisSnapshots) Load(ctx context.Context, orgID, id string) ([]byte, bool, error) {
	if r.client == nil || id == "" {
		return nil, false, errors.New("redis is not configured")
	}
	raw, err := r.client.Get(ctx, snapshotKeyPrefix+orgID+":"+id).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return raw, true, nil
}

func (r redisSnapshots) Save(ctx context.Context, orgID, id string, body []byte) error {
	if r.client == nil || id == "" {
		return errors.New("redis is not configured")
	}
	return r.client.Set(ctx, snapshotKeyPrefix+orgID+":"+id, body, snapshotTTL).Err()
}
