package newsevents

import (
	"context"
	"database/sql"
	"encoding/json"
	"strings"
	"time"
)

const day = 24 * time.Hour

type eventRow struct {
	ID                               string
	Status                           string
	Language                         *string
	PrimaryTopic                     *string
	PrimaryEntity                    *string
	Title                            *string
	Summary                          *string
	StartAt                          time.Time
	LastAt                           time.Time
	ItemCount                        int
	RepresentativeProcessedArticleID *string
	RepresentativeProcessedItemID    *string
	Metadata                         json.RawMessage
	CreatedAt                        time.Time
	UpdatedAt                        time.Time
}

type itemRow struct {
	ID                 string
	EventID            string
	ProcessedArticleID string
	ProcessedItemID    *string
	Similarity         *float64
	AssignedBy         string
	CreatedAt          time.Time
	ArticleRowID       string
	ArticleID          string
	Title              *string
	Summary            *string
	PublishedAt        *time.Time
	Language           *string
	ProcessedAt        time.Time
	Category           *string
	KeyPoints          json.RawMessage
	Source             *string
	URL                string
	SourceLabel        *string
	CrawlAt            time.Time
	SourceID           string
	ArticlePK          string
}

type timelineRow struct {
	ID                   string
	EventID              string
	BucketStart          time.Time
	Title                *string
	Summary              *string
	KeyPoints            json.RawMessage
	ReferencedArticleIDs json.RawMessage
	CreatedAt            time.Time
	UpdatedAt            time.Time
}

type orgSettings struct {
	Force    bool
	ForceMin int
	Backfill int
	Lookback int
}

func defaultSettings() orgSettings {
	return orgSettings{Force: false, ForceMin: 1, Backfill: 30, Lookback: 30}
}

func (s *service) loadSettings(ctx context.Context, orgID string) orgSettings {
	out := defaultSettings()
	if s == nil || s.db == nil {
		return out
	}
	var raw []byte
	err := s.db.QueryRowContext(ctx,
		"SELECT value FROM SystemSetting WHERE `key` = ? LIMIT 1",
		"news_event_settings:"+orgID,
	).Scan(&raw)
	if err != nil || len(raw) == 0 {
		return out
	}
	var doc map[string]any
	if json.Unmarshal(raw, &doc) != nil || doc == nil {
		return out
	}
	if value, ok := doc["forceAuthoritativeMode"].(bool); ok {
		out.Force = value
	}
	out.ForceMin = clampSettingInt(doc["forceMinAuthoritativeSources"], 1, 5, 1)
	out.ForceMin = clampInt(out.ForceMin, 1, 10)
	out.Backfill = clampSettingInt(doc["backfillDays"], 1, 365, 30)
	out.Lookback = clampSettingInt(doc["lookbackDays"], 1, 180, 30)
	return out
}

func (s *service) loadPolicyJSON(ctx context.Context, orgID string) []byte {
	if s == nil || s.db == nil {
		return nil
	}
	var raw []byte
	err := s.db.QueryRowContext(ctx,
		"SELECT value FROM SystemSetting WHERE `key` = ? LIMIT 1",
		"news_event_source_policy:"+orgID,
	).Scan(&raw)
	if err != nil {
		return nil
	}
	return raw
}

func (s *service) listEventRows(ctx context.Context, orgID string, limit, windowDays int, status, entity string) ([]eventRow, error) {
	since := s.clock().Add(-time.Duration(windowDays) * day)
	query := `
SELECT id, status, language, primaryTopic, primaryEntity, title, summary,
       startAt, lastAt,
       (SELECT COUNT(*) FROM NewsEventItem i WHERE i.eventId = NewsEvent.id),
       representativeProcessedArticleId, representativeProcessedItemId,
       metadata, createdAt, updatedAt
FROM NewsEvent
WHERE orgId = ? AND lastAt >= ?`
	args := []any{orgID, since}
	if status != "" {
		query += " AND status = ?"
		args = append(args, status)
	}
	if entity != "" {
		query += " AND primaryEntity = ?"
		args = append(args, entity)
	}
	query += " ORDER BY lastAt DESC, startAt DESC LIMIT ?"
	args = append(args, limit)
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]eventRow, 0)
	for rows.Next() {
		row, err := scanEvent(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

func (s *service) loadEvent(ctx context.Context, orgID, eventID string) (*eventRow, error) {
	row := s.db.QueryRowContext(ctx, `
SELECT id, status, language, primaryTopic, primaryEntity, title, summary,
       startAt, lastAt,
       (SELECT COUNT(*) FROM NewsEventItem i WHERE i.eventId = NewsEvent.id),
       representativeProcessedArticleId, representativeProcessedItemId,
       metadata, createdAt, updatedAt
FROM NewsEvent
WHERE orgId = ? AND id = ?
LIMIT 1`, orgID, eventID)
	scanned, err := scanEvent(row)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &scanned, nil
}

type scanner interface {
	Scan(dest ...any) error
}

func scanEvent(row scanner) (eventRow, error) {
	var out eventRow
	var language, topic, entity, title, summary sql.NullString
	var representativeArticle, representativeItem sql.NullString
	var metadata []byte
	err := row.Scan(
		&out.ID, &out.Status, &language, &topic, &entity, &title, &summary,
		&out.StartAt, &out.LastAt, &out.ItemCount,
		&representativeArticle, &representativeItem,
		&metadata, &out.CreatedAt, &out.UpdatedAt,
	)
	if err != nil {
		return eventRow{}, err
	}
	out.Language = nullString(language)
	out.PrimaryTopic = nullString(topic)
	out.PrimaryEntity = nullString(entity)
	out.Title = nullString(title)
	out.Summary = nullString(summary)
	out.RepresentativeProcessedArticleID = nullString(representativeArticle)
	out.RepresentativeProcessedItemID = nullString(representativeItem)
	out.Metadata = nullJSON(metadata)
	return out, nil
}

func (s *service) loadItems(ctx context.Context, eventID string, limit int) ([]itemRow, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT i.id, i.eventId, i.processedArticleId, i.processedItemId, i.similarity, i.assignedBy, i.createdAt,
       pa.id, pa.articleId, pa.title, pa.summary, pa.publishedAt, pa.language, pa.processedAt,
       pa.category, pa.keyPoints, pa.source,
       a.id, a.url, a.sourceLabel, a.crawlAt, a.sourceId
FROM NewsEventItem i
JOIN ProcessedArticle pa ON pa.id = i.processedArticleId
JOIN Article a ON a.id = pa.articleId
WHERE i.eventId = ?
ORDER BY i.createdAt DESC
LIMIT ?`, eventID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]itemRow, 0)
	for rows.Next() {
		item, err := scanItem(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

func scanItem(rows *sql.Rows) (itemRow, error) {
	var out itemRow
	var processedItem, title, summary, language, category, source, label, sourceID sql.NullString
	var similarity sql.NullFloat64
	var published sql.NullTime
	var keyPoints []byte
	err := rows.Scan(
		&out.ID, &out.EventID, &out.ProcessedArticleID, &processedItem, &similarity, &out.AssignedBy, &out.CreatedAt,
		&out.ArticleRowID, &out.ArticleID, &title, &summary, &published, &language, &out.ProcessedAt,
		&category, &keyPoints, &source,
		&out.ArticlePK, &out.URL, &label, &out.CrawlAt, &sourceID,
	)
	if err != nil {
		return itemRow{}, err
	}
	out.ProcessedItemID = nullString(processedItem)
	if similarity.Valid {
		value := similarity.Float64
		out.Similarity = &value
	}
	out.Title = nullString(title)
	out.Summary = nullString(summary)
	if published.Valid {
		value := published.Time
		out.PublishedAt = &value
	}
	out.Language = nullString(language)
	out.Category = nullString(category)
	out.KeyPoints = nullJSON(keyPoints)
	out.Source = nullString(source)
	out.SourceLabel = nullString(label)
	out.SourceID = strings.TrimSpace(sourceID.String)
	return out, nil
}

func (s *service) loadTimeline(ctx context.Context, eventID string, since *time.Time, limit int) ([]timelineRow, error) {
	query := `
SELECT id, eventId, bucketStart, title, summary, keyPoints, referencedArticleIds, createdAt, updatedAt
FROM NewsEventTimelineEntry
WHERE eventId = ?`
	args := []any{eventID}
	if since != nil {
		query += " AND bucketStart >= ?"
		args = append(args, *since)
	}
	query += " ORDER BY bucketStart ASC LIMIT ?"
	args = append(args, limit)
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]timelineRow, 0)
	for rows.Next() {
		var row timelineRow
		var title, summary sql.NullString
		var keyPoints, refs []byte
		if err := rows.Scan(&row.ID, &row.EventID, &row.BucketStart, &title, &summary, &keyPoints, &refs, &row.CreatedAt, &row.UpdatedAt); err != nil {
			return nil, err
		}
		row.Title = nullString(title)
		row.Summary = nullString(summary)
		row.KeyPoints = nullJSON(keyPoints)
		row.ReferencedArticleIDs = nullJSON(refs)
		out = append(out, row)
	}
	return out, rows.Err()
}

type heatItem struct {
	EventID   string
	CreatedAt time.Time
	SourceID  string
}

func (s *service) loadHeatItems(ctx context.Context, orgID string, eventIDs []string, since time.Time) ([]heatItem, error) {
	if len(eventIDs) == 0 {
		return nil, nil
	}
	query := `
SELECT nei.eventId, nei.createdAt, a.sourceId
FROM NewsEventItem nei
JOIN ProcessedArticle pa ON pa.id = nei.processedArticleId
JOIN Article a ON a.id = pa.articleId
WHERE nei.orgId = ? AND nei.eventId IN (` + placeholders(len(eventIDs)) + `) AND nei.createdAt >= ?`
	args := make([]any, 0, len(eventIDs)+2)
	args = append(args, orgID)
	for _, id := range eventIDs {
		args = append(args, id)
	}
	args = append(args, since)
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]heatItem, 0)
	for rows.Next() {
		var item heatItem
		var sourceID sql.NullString
		if err := rows.Scan(&item.EventID, &item.CreatedAt, &sourceID); err != nil {
			return nil, err
		}
		item.SourceID = strings.TrimSpace(sourceID.String)
		out = append(out, item)
	}
	return out, rows.Err()
}

type authorityItem struct {
	EventID     string
	URL         string
	SourceLabel string
}

func (s *service) loadAuthorityItems(ctx context.Context, orgID string, eventIDs []string, since time.Time) ([]authorityItem, error) {
	if len(eventIDs) == 0 {
		return nil, nil
	}
	query := `
SELECT nei.eventId, a.url, a.sourceLabel
FROM NewsEventItem nei
JOIN ProcessedArticle pa ON pa.id = nei.processedArticleId
JOIN Article a ON a.id = pa.articleId
WHERE nei.orgId = ? AND nei.eventId IN (` + placeholders(len(eventIDs)) + `) AND nei.createdAt >= ?`
	args := make([]any, 0, len(eventIDs)+2)
	args = append(args, orgID)
	for _, id := range eventIDs {
		args = append(args, id)
	}
	args = append(args, since)
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]authorityItem, 0)
	for rows.Next() {
		var item authorityItem
		var rawURL, label sql.NullString
		if err := rows.Scan(&item.EventID, &rawURL, &label); err != nil {
			return nil, err
		}
		item.URL = rawURL.String
		item.SourceLabel = label.String
		out = append(out, item)
	}
	return out, rows.Err()
}

type categoryRow struct {
	EventID         string
	ProcessedItemID string
	Category        string
}

func (s *service) loadCategoryRows(ctx context.Context, orgID string, eventIDs []string, since time.Time) ([]categoryRow, error) {
	if len(eventIDs) == 0 {
		return nil, nil
	}
	query := `
SELECT nei.eventId, nei.processedItemId, pa.category
FROM NewsEventItem nei
JOIN ProcessedArticle pa ON pa.id = nei.processedArticleId
WHERE nei.orgId = ? AND nei.eventId IN (` + placeholders(len(eventIDs)) + `) AND pa.processedAt >= ?`
	args := make([]any, 0, len(eventIDs)+2)
	args = append(args, orgID)
	for _, id := range eventIDs {
		args = append(args, id)
	}
	args = append(args, since)
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]categoryRow, 0)
	for rows.Next() {
		var row categoryRow
		var processedItem, category sql.NullString
		if err := rows.Scan(&row.EventID, &processedItem, &category); err != nil {
			return nil, err
		}
		row.ProcessedItemID = strings.TrimSpace(processedItem.String)
		row.Category = category.String
		out = append(out, row)
	}
	return out, rows.Err()
}

func nullString(value sql.NullString) *string {
	if !value.Valid {
		return nil
	}
	copy := value.String
	return &copy
}

func nullJSON(raw []byte) json.RawMessage {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	return append(json.RawMessage(nil), raw...)
}

func placeholders(n int) string {
	if n <= 0 {
		return ""
	}
	return strings.Repeat("?,", n-1) + "?"
}
