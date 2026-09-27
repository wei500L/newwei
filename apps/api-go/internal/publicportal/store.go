package publicportal

import (
	"context"
	"database/sql"
	"encoding/json"
	"strconv"
	"strings"
	"time"
)

const (
	publicOrgSlugKey = "public_portal_org_slug"
	policyKeyPrefix  = "news_event_source_policy:"
	pageSize         = 96
)

// Org 是公开门户允许发布的唯一组织。
type Org struct {
	ID   string `json:"id"`
	Slug string `json:"slug"`
	Name string `json:"name"`
}

// EventRow 是一页活跃事件的原始行。Status 用于服务层再拒归档行。
type EventRow struct {
	ID            string
	OrgID         string
	Status        string
	Title         string
	Summary       string
	PrimaryTopic  string
	PrimaryEntity string
	Language      string
	StartAt       time.Time
	LastAt        time.Time
}

// PageCursor 是 (lastAt, startAt, id) 降序游标。
type PageCursor struct {
	LastAt  time.Time
	StartAt time.Time
	ID      string
}

// HeatItem 是近 4 小时内的事件条目（热度）。
type HeatItem struct {
	EventID   string
	CreatedAt time.Time
	SourceID  string
}

// AuthorityItem 是权威窗口内的事件条目（来源分类）。
type AuthorityItem struct {
	EventID     string
	URL         string
	SourceLabel string
}

// Store 是公开门户的只读查询。orgId 由调用方传入，不来自请求参数。
type Store interface {
	PublicOrg(ctx context.Context) (*Org, error)
	ListEventPage(ctx context.Context, orgID string, cursor *PageCursor, excludeEventID string) ([]EventRow, error)
	ItemCounts(ctx context.Context, orgID string, eventIDs []string) (map[string]int, error)
	HeatItems(ctx context.Context, orgID string, eventIDs []string, since time.Time) ([]HeatItem, error)
	AuthorityItems(ctx context.Context, orgID string, eventIDs []string, since time.Time) ([]AuthorityItem, error)
	// SourcePolicy 读取该组织已持久化的来源策略。查询失败返回 error，
	// 调用方改用默认名单（对齐 Nest resolveSourcePolicy 的 catch）。
	SourcePolicy(ctx context.Context, orgID string) (matcher, error)
}

// MySQLStore 使用与 user-settings 相同的 *sql.DB 连接池。
type MySQLStore struct {
	db *sql.DB
}

func NewMySQLStore(db *sql.DB) *MySQLStore {
	return &MySQLStore{db: db}
}

func (s *MySQLStore) PublicOrg(ctx context.Context) (*Org, error) {
	var raw []byte
	err := s.db.QueryRowContext(ctx, "SELECT value FROM SystemSetting WHERE `key` = ? LIMIT 1", publicOrgSlugKey).Scan(&raw)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	slug := parsePublicOrgSlug(raw)
	if slug == "" {
		return nil, nil
	}
	var org Org
	err = s.db.QueryRowContext(ctx,
		"SELECT id, slug, name FROM Org WHERE slug = ? AND isActive = 1 LIMIT 1",
		slug,
	).Scan(&org.ID, &org.Slug, &org.Name)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &org, nil
}

// parsePublicOrgSlug 只接受 SystemSetting 里的字符串或 {slug}。
// 空、数字、数组都不构成公开组织，调用方不得改查「最近组织」。
func parsePublicOrgSlug(raw []byte) string {
	if len(raw) == 0 {
		return ""
	}
	var asString string
	if err := json.Unmarshal(raw, &asString); err == nil {
		return normalizeSlug(asString)
	}
	var asObject struct {
		Slug any `json:"slug"`
	}
	if err := json.Unmarshal(raw, &asObject); err == nil {
		if text, ok := asObject.Slug.(string); ok {
			return normalizeSlug(text)
		}
	}
	return ""
}

func normalizeSlug(value string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return ""
	}
	return strings.ToLower(trimmed)
}

func (s *MySQLStore) ListEventPage(ctx context.Context, orgID string, cursor *PageCursor, excludeEventID string) ([]EventRow, error) {
	query := `
SELECT id, orgId, status, title, summary, primaryTopic, primaryEntity, language, startAt, lastAt
FROM NewsEvent
WHERE orgId = ? AND status = 'active' AND title IS NOT NULL AND summary IS NOT NULL`
	args := []any{orgID}
	if excludeEventID != "" {
		query += " AND id <> ?"
		args = append(args, excludeEventID)
	}
	if cursor != nil {
		query += " AND (lastAt < ? OR (lastAt = ? AND startAt < ?) OR (lastAt = ? AND startAt = ? AND id < ?))"
		args = append(args, cursor.LastAt, cursor.LastAt, cursor.StartAt, cursor.LastAt, cursor.StartAt, cursor.ID)
	}
	query += " ORDER BY lastAt DESC, startAt DESC, id DESC LIMIT " + strconv.Itoa(pageSize)

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]EventRow, 0, pageSize)
	for rows.Next() {
		var row EventRow
		var title, summary, topic, entity, language sql.NullString
		if err := rows.Scan(
			&row.ID, &row.OrgID, &row.Status,
			&title, &summary, &topic, &entity, &language,
			&row.StartAt, &row.LastAt,
		); err != nil {
			return nil, err
		}
		row.Title = title.String
		row.Summary = summary.String
		row.PrimaryTopic = topic.String
		row.PrimaryEntity = entity.String
		row.Language = language.String
		out = append(out, row)
	}
	return out, rows.Err()
}

func (s *MySQLStore) ItemCounts(ctx context.Context, orgID string, eventIDs []string) (map[string]int, error) {
	out := map[string]int{}
	if len(eventIDs) == 0 {
		return out, nil
	}
	query := "SELECT eventId, COUNT(*) FROM NewsEventItem WHERE orgId = ? AND eventId IN (" + placeholders(len(eventIDs)) + ") GROUP BY eventId"
	args := make([]any, 0, len(eventIDs)+1)
	args = append(args, orgID)
	for _, id := range eventIDs {
		args = append(args, id)
	}
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var count int
		if err := rows.Scan(&id, &count); err != nil {
			return nil, err
		}
		out[id] = count
	}
	return out, rows.Err()
}

func (s *MySQLStore) HeatItems(ctx context.Context, orgID string, eventIDs []string, since time.Time) ([]HeatItem, error) {
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
	out := make([]HeatItem, 0)
	for rows.Next() {
		var item HeatItem
		var sourceID sql.NullString
		if err := rows.Scan(&item.EventID, &item.CreatedAt, &sourceID); err != nil {
			return nil, err
		}
		item.SourceID = strings.TrimSpace(sourceID.String)
		out = append(out, item)
	}
	return out, rows.Err()
}

func (s *MySQLStore) AuthorityItems(ctx context.Context, orgID string, eventIDs []string, since time.Time) ([]AuthorityItem, error) {
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
	out := make([]AuthorityItem, 0)
	for rows.Next() {
		var item AuthorityItem
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

func (s *MySQLStore) SourcePolicy(ctx context.Context, orgID string) (matcher, error) {
	var raw []byte
	err := s.db.QueryRowContext(ctx,
		"SELECT value FROM SystemSetting WHERE `key` = ? LIMIT 1",
		policyKeyPrefix+orgID,
	).Scan(&raw)
	if err == sql.ErrNoRows {
		return defaultMatcher(), nil
	}
	if err != nil {
		return matcher{}, err
	}
	return parseSourcePolicy(raw), nil
}

func placeholders(n int) string {
	if n <= 0 {
		return ""
	}
	return strings.Repeat("?,", n-1) + "?"
}
