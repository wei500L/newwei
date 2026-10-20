package archivereading

import (
	"context"
	"database/sql"
	"strings"
	"time"

	"encoding/json"
)

const (
	maxBaseScan        = 12000
	digestScanBatch    = 400
	calendarScanBatch  = 600
	maxSearchScan      = 500
	lexicalContainsMax = 240
)

// ArchiveRow is one ProcessedArticle joined with its Article and first
// org-scoped NewsEventItem.
type ArchiveRow struct {
	ID                 string
	Title              string
	Summary            string
	Source             string
	PublishedAt        *time.Time
	TopicsJSON         []byte
	EntitiesJSON       []byte
	QualityScore       *float64
	Location           string
	ProcessedAt        time.Time
	CleanedMarkdownRef string
	ArticleID          string
	ArticleOrgID       string
	ArticleURL         string
	ArticleSourceLabel string
	ArticleCrawlAt     time.Time
	EventID            *string
}

// SortAt is ProcessedArticle.publishedAt ?? Article.crawlAt ?? processedAt.
func (r ArchiveRow) SortAt() time.Time {
	if r.PublishedAt != nil {
		return *r.PublishedAt
	}
	if !r.ArticleCrawlAt.IsZero() {
		return r.ArticleCrawlAt
	}
	return r.ProcessedAt
}

// PublishedAtDisplay is the display fallback that never uses processedAt alone.
func (r ArchiveRow) PublishedAtDisplay() *time.Time {
	if r.PublishedAt != nil {
		return r.PublishedAt
	}
	if !r.ArticleCrawlAt.IsZero() {
		value := r.ArticleCrawlAt
		return &value
	}
	return nil
}

// SourceLabelDisplay is ProcessedArticle.source ?? Article.sourceLabel.
func (r ArchiveRow) SourceLabelDisplay() string {
	if strings.TrimSpace(r.Source) != "" {
		return strings.TrimSpace(r.Source)
	}
	return strings.TrimSpace(r.ArticleSourceLabel)
}

// Cursor is the stable (processedAt, id) keyset cursor.
type Cursor struct {
	ProcessedAt time.Time
	ID          string
}

type archiveStore struct {
	db *sql.DB
}

const archiveRowSelect = `SELECT pa.id, pa.title, pa.summary, pa.source, pa.publishedAt, pa.topics, pa.entities,
       pa.qualityScore, pa.location, pa.processedAt, pa.cleanedMarkdownRef,
       a.id, a.orgId, a.url, a.sourceLabel, a.crawlAt,
       (SELECT nei.eventId FROM NewsEventItem nei WHERE nei.processedArticleId = pa.id AND nei.orgId = ? LIMIT 1)
FROM ProcessedArticle pa
INNER JOIN Article a ON a.id = pa.articleId`

func (s *archiveStore) recentBatch(ctx context.Context, orgID string, anchor time.Time, cursor *Cursor, take int) ([]*ArchiveRow, error) {
	args := []any{orgID, orgID, anchor, anchor, anchor}
	where := ` WHERE pa.status = 'completed' AND a.orgId = ?
  AND (pa.publishedAt <= ? OR a.crawlAt <= ? OR pa.processedAt <= ?)`
	where, args = appendCursor(where, args, cursor)
	where += ` ORDER BY pa.processedAt DESC, pa.id DESC LIMIT ?`
	args = append(args, take)
	return s.queryRows(ctx, archiveRowSelect+where, args...)
}

func (s *archiveStore) rangeBatch(ctx context.Context, orgID string, start, end time.Time, cursor *Cursor, take int) ([]*ArchiveRow, error) {
	args := []any{orgID, orgID, start, end, start, end, start, end}
	where := ` WHERE pa.status = 'completed' AND a.orgId = ?
  AND (
    (pa.publishedAt IS NOT NULL AND pa.publishedAt >= ? AND pa.publishedAt <= ?)
    OR (pa.publishedAt IS NULL AND a.crawlAt >= ? AND a.crawlAt <= ?)
    OR (pa.publishedAt IS NULL AND pa.processedAt >= ? AND pa.processedAt <= ?)
  )`
	where, args = appendCursor(where, args, cursor)
	where += ` ORDER BY pa.processedAt DESC, pa.id DESC LIMIT ?`
	args = append(args, take)
	return s.queryRows(ctx, archiveRowSelect+where, args...)
}

func (s *archiveStore) byCleanedRefs(ctx context.Context, orgID string, refs []string, take int) ([]*ArchiveRow, error) {
	if len(refs) == 0 {
		return nil, nil
	}
	args := []any{orgID}
	for _, ref := range refs {
		args = append(args, ref)
	}
	args = append(args, orgID, take)
	where := ` WHERE pa.cleanedMarkdownRef IN (` +
		strings.TrimRight(strings.Repeat("?,", len(refs)), ",") + `) AND pa.status = 'completed' AND a.orgId = ? LIMIT ?`
	return s.queryRows(ctx, archiveRowSelect+where, args...)
}

func (s *archiveStore) detailRow(ctx context.Context, orgID, processedArticleID string) (*ArchiveRow, error) {
	rows, err := s.queryRows(ctx, archiveRowSelect+` WHERE pa.id = ? AND pa.status = 'completed' AND a.orgId = ? LIMIT 1`,
		orgID, processedArticleID, orgID)
	if err != nil || len(rows) == 0 {
		return nil, err
	}
	return rows[0], nil
}

func (s *archiveStore) queryRows(ctx context.Context, query string, args ...any) ([]*ArchiveRow, error) {
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]*ArchiveRow, 0, digestScanBatch)
	for rows.Next() {
		var row ArchiveRow
		var title, summary, source, location, cleanedRef, sourceLabel sql.NullString
		var publishedAt sql.NullTime
		var quality sql.NullFloat64
		var topics, entities []byte
		var eventID sql.NullString
		if err := rows.Scan(&row.ID, &title, &summary, &source, &publishedAt, &topics, &entities,
			&quality, &location, &row.ProcessedAt, &cleanedRef, &row.ArticleID, &row.ArticleOrgID,
			&row.ArticleURL, &sourceLabel, &row.ArticleCrawlAt, &eventID); err != nil {
			return nil, err
		}
		row.Title = title.String
		row.Summary = summary.String
		row.Source = source.String
		row.Location = location.String
		row.CleanedMarkdownRef = cleanedRef.String
		row.ArticleSourceLabel = sourceLabel.String
		row.TopicsJSON = topics
		row.EntitiesJSON = entities
		if publishedAt.Valid {
			value := publishedAt.Time
			row.PublishedAt = &value
		}
		if quality.Valid {
			value := quality.Float64
			row.QualityScore = &value
		}
		if eventID.Valid && strings.TrimSpace(eventID.String) != "" {
			value := eventID.String
			row.EventID = &value
		}
		out = append(out, &row)
	}
	return out, rows.Err()
}

func appendCursor(where string, args []any, cursor *Cursor) (string, []any) {
	if cursor == nil {
		return where, args
	}
	where += ` AND (pa.processedAt < ? OR (pa.processedAt = ? AND pa.id < ?))`
	args = append(args, cursor.ProcessedAt, cursor.ProcessedAt, cursor.ID)
	return where, args
}

// lexicalFullTextIDs runs the MySQL MATCH recall. A failed full-text query is
// logged and reported as an empty candidate list; the contains fallback still
// runs.
func (s *archiveStore) lexicalFullTextIDs(ctx context.Context, orgID string, anchor time.Time, fullTextQuery string) ([]string, error) {
	if strings.TrimSpace(fullTextQuery) == "" {
		return nil, nil
	}
	rows, err := s.db.QueryContext(ctx, `
SELECT pa.id
FROM ProcessedArticle pa
INNER JOIN Article a ON a.id = pa.articleId
WHERE a.orgId = ?
  AND pa.status = 'completed'
  AND (pa.publishedAt <= ? OR a.crawlAt <= ? OR pa.processedAt <= ?)
  AND MATCH(pa.title, pa.summary) AGAINST (? IN BOOLEAN MODE)
ORDER BY pa.processedAt DESC, pa.id DESC
LIMIT ?`, orgID, anchor, anchor, anchor, fullTextQuery, maxSearchScan)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := make([]string, 0, maxSearchScan)
	for rows.Next() {
		var id string
		if rows.Scan(&id) == nil && strings.TrimSpace(id) != "" {
			ids = append(ids, id)
		}
	}
	return ids, rows.Err()
}

// lexicalContainsRows is the fallback title/summary/source/location LIKE recall.
func (s *archiveStore) lexicalContainsRows(ctx context.Context, orgID string, anchor time.Time, terms []string) ([]*ArchiveRow, error) {
	if len(terms) == 0 {
		return nil, nil
	}
	args := []any{orgID, orgID, anchor, anchor, anchor}
	clauses := make([]string, 0, len(terms)*4)
	for _, term := range terms {
		pattern := "%" + escapeLike(term) + "%"
		clauses = append(clauses, "pa.title LIKE ? ESCAPE '\\\\'", "pa.summary LIKE ? ESCAPE '\\\\'",
			"pa.source LIKE ? ESCAPE '\\\\'", "pa.location LIKE ? ESCAPE '\\\\'")
		args = append(args, pattern, pattern, pattern, pattern)
	}
	query := archiveRowSelect + ` WHERE pa.status = 'completed' AND a.orgId = ?
  AND (pa.publishedAt <= ? OR a.crawlAt <= ? OR pa.processedAt <= ?)
  AND (` + strings.Join(clauses, " OR ") + `)
  ORDER BY pa.processedAt DESC, pa.id DESC LIMIT ?`
	args = append(args, lexicalContainsMax)
	return s.queryRows(ctx, query, args...)
}

func (s *archiveStore) rowsByIDs(ctx context.Context, orgID string, ids []string) ([]*ArchiveRow, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	args := []any{orgID}
	for _, id := range ids {
		args = append(args, id)
	}
	args = append(args, orgID, maxSearchScan)
	where := ` WHERE pa.id IN (` + strings.TrimRight(strings.Repeat("?,", len(ids)), ",") +
		`) AND pa.status = 'completed' AND a.orgId = ? LIMIT ?`
	return s.queryRows(ctx, archiveRowSelect+where, args...)
}

func escapeLike(value string) string {
	value = strings.ReplaceAll(value, `\`, `\\`)
	value = strings.ReplaceAll(value, `%`, `\%`)
	value = strings.ReplaceAll(value, `_`, `\_`)
	return value
}

// detailTimeline loads at most 160 entries ordered by bucketStart.
func (s *archiveStore) detailTimeline(ctx context.Context, orgID, eventID string) ([]TimelineEntry, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT id, bucketStart, title, summary
FROM NewsEventTimelineEntry
WHERE orgId = ? AND eventId = ?
ORDER BY bucketStart ASC
LIMIT 160`, orgID, eventID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]TimelineEntry, 0, 16)
	for rows.Next() {
		var entry TimelineEntry
		var title, summary sql.NullString
		if err := rows.Scan(&entry.ID, &entry.BucketStart, &title, &summary); err != nil {
			return nil, err
		}
		entry.Title = nullableString(title)
		entry.Summary = nullableString(summary)
		out = append(out, entry)
	}
	return out, rows.Err()
}

// detailRelated loads at most 12 event items ordered by createdAt DESC.
func (s *archiveStore) detailRelated(ctx context.Context, orgID, eventID string) ([]RelatedArticle, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT nei.processedArticleId, pa.title, pa.summary, pa.publishedAt, a.crawlAt, pa.source, a.sourceLabel, a.url
FROM NewsEventItem nei
INNER JOIN ProcessedArticle pa ON pa.id = nei.processedArticleId
INNER JOIN Article a ON a.id = pa.articleId
WHERE nei.orgId = ? AND nei.eventId = ? AND a.orgId = ?
ORDER BY nei.createdAt DESC
LIMIT 12`, orgID, eventID, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]RelatedArticle, 0, 12)
	for rows.Next() {
		var article RelatedArticle
		var title, summary, source, sourceLabel, url sql.NullString
		var publishedAt, crawlAt sql.NullTime
		if err := rows.Scan(&article.ProcessedArticleID, &title, &summary, &publishedAt, &crawlAt, &source, &sourceLabel, &url); err != nil {
			return nil, err
		}
		article.Title = nullableString(title)
		article.Summary = nullableString(summary)
		article.SourceLabel = nullableString(source)
		if article.SourceLabel == nil {
			article.SourceLabel = nullableString(sourceLabel)
		}
		article.SourceURL = nullableString(url)
		if publishedAt.Valid {
			value := publishedAt.Time
			article.PublishedAt = &value
		} else if crawlAt.Valid {
			value := crawlAt.Time
			article.PublishedAt = &value
		}
		out = append(out, article)
	}
	return out, rows.Err()
}

// eventExists checks the org-scoped NewsEvent before its children are read.
func (s *archiveStore) eventExists(ctx context.Context, orgID, eventID string) (bool, error) {
	var count int
	err := s.db.QueryRowContext(ctx, "SELECT COUNT(1) FROM NewsEvent WHERE id = ? AND orgId = ? LIMIT 1", eventID, orgID).Scan(&count)
	return count > 0, err
}

func nullableString(value sql.NullString) *string {
	if !value.Valid || strings.TrimSpace(value.String) == "" {
		return nil
	}
	trimmed := strings.TrimSpace(value.String)
	return &trimmed
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

// decodeJSONArray decodes a stored JSON array; a malformed or non-array value
// is an empty list, exactly like normalizeStringArray.
func decodeStringArray(raw []byte) []string {
	if len(raw) == 0 {
		return nil
	}
	var values []string
	if err := json.Unmarshal(raw, &values); err != nil {
		return nil
	}
	out := make([]string, 0, len(values))
	for _, value := range values {
		if text := strings.TrimSpace(value); text != "" {
			out = append(out, text)
		}
	}
	return out
}

// decodeEntityNames accepts both the string-array and {name} object forms the
// ProcessedArticle.entities JSON column can contain.
func decodeEntityNames(raw []byte) []Entity {
	if len(raw) == 0 {
		return nil
	}
	var values []any
	if err := json.Unmarshal(raw, &values); err != nil {
		return nil
	}
	out := make([]Entity, 0, len(values))
	for _, value := range values {
		switch typed := value.(type) {
		case string:
			if text := strings.TrimSpace(typed); text != "" {
				out = append(out, Entity{Name: text})
			}
		case map[string]any:
			if text, ok := typed["name"].(string); ok && strings.TrimSpace(text) != "" {
				out = append(out, Entity{Name: strings.TrimSpace(text)})
			}
		}
	}
	return out
}
