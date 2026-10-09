package dashboardwarmap

import (
	"context"
	"database/sql"
	"encoding/json"
	"time"
)

const alertScanLimit = 1000
const eventArticleLimit = 2500
const markerArticleLimit = 500

const alertSQL = `
SELECT e.triggeredAt, e.severity, e.context
FROM AlertEvent e
INNER JOIN AlertRule r ON r.id = e.ruleId
WHERE e.triggeredAt >= ? AND e.triggeredAt <= ?
  AND r.orgId = ?
ORDER BY e.triggeredAt DESC
LIMIT ?`

const eventArticleSQL = `
SELECT pa.location, pa.processedAt, pa.eventAt
FROM ProcessedArticle pa
WHERE pa.orgId = ?
  AND pa.status = 'completed'
  AND pa.hasLocation = 1
  AND pa.eventAt >= ? AND pa.eventAt <= ?
ORDER BY pa.eventAt DESC, pa.articleId DESC
LIMIT ?`

const markerArticleSQL = `
SELECT pa.id, pa.title, pa.location, pa.publishedAt, pa.eventAt, pa.processedAt, pa.entities,
       a.url, a.crawlAt, a.titleGuess
FROM ProcessedArticle pa
INNER JOIN Article a ON a.id = pa.articleId
WHERE pa.orgId = ?
  AND pa.status = 'completed'
  AND pa.hasLocation = 1
  AND pa.eventAt >= ? AND pa.eventAt <= ?
ORDER BY pa.eventAt DESC, pa.articleId DESC
LIMIT ?`

type mysqlStore struct {
	db *sql.DB
}

func (s *mysqlStore) Alerts(ctx context.Context, orgID string, start, end time.Time) ([]alertRow, error) {
	rows, err := s.db.QueryContext(ctx, alertSQL, start.UTC(), end.UTC(), orgID, alertScanLimit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []alertRow
	for rows.Next() {
		var triggered time.Time
		var severity string
		var context []byte
		if err := rows.Scan(&triggered, &severity, &context); err != nil {
			return nil, err
		}
		out = append(out, alertRow{
			TriggeredAt: triggered.UTC(),
			Severity:    severity,
			Context:     decodeObject(context),
		})
	}
	return out, rows.Err()
}

func (s *mysqlStore) EventArticles(ctx context.Context, orgID string, start, end time.Time) ([]articlePoint, error) {
	rows, err := s.db.QueryContext(ctx, eventArticleSQL, orgID, start.UTC(), end.UTC(), eventArticleLimit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []articlePoint
	for rows.Next() {
		var location sql.NullString
		var processed, eventAt sql.NullTime
		if err := rows.Scan(&location, &processed, &eventAt); err != nil {
			return nil, err
		}
		out = append(out, articlePoint{
			Location:    location.String,
			ProcessedAt: nullTime(processed),
			EventAt:     nullTime(eventAt),
		})
	}
	return out, rows.Err()
}

func (s *mysqlStore) MarkerArticles(ctx context.Context, orgID string, start, end time.Time) ([]markerRow, error) {
	rows, err := s.db.QueryContext(ctx, markerArticleSQL, orgID, start.UTC(), end.UTC(), markerArticleLimit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []markerRow
	for rows.Next() {
		var id string
		var title, location, url, titleGuess sql.NullString
		var published, eventAt, processed, crawl sql.NullTime
		var entities []byte
		if err := rows.Scan(&id, &title, &location, &published, &eventAt, &processed, &entities, &url, &crawl, &titleGuess); err != nil {
			return nil, err
		}
		row := markerRow{
			ID:          id,
			Title:       title.String,
			Location:    location.String,
			Entities:    decodeJSON(entities),
			PublishedAt: nullTime(published),
			EventAt:     nullTime(eventAt),
			ProcessedAt: nullTime(processed),
			CrawlAt:     nullTime(crawl),
			TitleGuess:  titleGuess.String,
		}
		row.SortAt = firstTime(row.EventAt, row.PublishedAt, row.CrawlAt, row.ProcessedAt)
		if url.Valid {
			value := url.String
			row.URL = &value
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

func (s *mysqlStore) Setting(ctx context.Context, key string) ([]byte, bool, error) {
	var raw []byte
	err := s.db.QueryRowContext(ctx, "SELECT value FROM SystemSetting WHERE `key` = ?", key).Scan(&raw)
	if err == sql.ErrNoRows {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return raw, true, nil
}

func nullTime(value sql.NullTime) *time.Time {
	if !value.Valid {
		return nil
	}
	copied := value.Time.UTC()
	return &copied
}

func decodeObject(raw []byte) map[string]any {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	var payload any
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil
	}
	object, _ := payload.(map[string]any)
	if object == nil {
		return nil
	}
	return object
}

func decodeJSON(raw []byte) any {
	if len(raw) == 0 {
		return nil
	}
	var payload any
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil
	}
	return payload
}
