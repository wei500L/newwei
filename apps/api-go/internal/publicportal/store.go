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

// EventDetail 是一条事件及其 metadata。归档与否由服务层判断。
type EventDetail struct {
	EventRow
	Metadata []byte
}

// TimelineEntry 是公开时间线的一行。ReferencedArticleIDs 只保留字符串。
type TimelineEntry struct {
	ID                   string
	BucketStart          time.Time
	Title                string
	Summary              string
	ReferencedArticleIDs []string
}

// BriefItem 是 brief 选源与条目回退共用的事件条目。
type BriefItem struct {
	CreatedAt          time.Time
	ProcessedItemID    string
	ProcessedArticleID string
	ArticleID          string
	URL                string
	SourceLabel        string
	CrawlAt            time.Time
	HasCrawlAt         bool
	Title              string
	Summary            string
	KeyPoints          []string
	PublishedAt        time.Time
	HasPublishedAt     bool
	ProcessedAt        time.Time
	Source             string
}

// ArticleRow 是确实挂在该组织该事件上的引用文章。
type ArticleRow struct {
	ID           string
	URL          string
	SourceLabel  string
	Title        string
	PublishedAt  time.Time
	HasPublished bool
}

// Store 是公开门户的查询。orgId 由调用方传入，不来自请求参数。
// 详情会写回 NewsEvent.metadata.briefV1，不改其他表。
type Store interface {
	PublicOrg(ctx context.Context) (*Org, error)
	ListEventPage(ctx context.Context, orgID string, cursor *PageCursor, excludeEventID string) ([]EventRow, error)
	ItemCounts(ctx context.Context, orgID string, eventIDs []string) (map[string]int, error)
	HeatItems(ctx context.Context, orgID string, eventIDs []string, since time.Time) ([]HeatItem, error)
	AuthorityItems(ctx context.Context, orgID string, eventIDs []string, since time.Time) ([]AuthorityItem, error)
	// SourcePolicy 读取该组织已持久化的来源策略。查询失败返回 error，
	// 调用方改用默认名单（对齐 Nest resolveSourcePolicy 的 catch）。
	SourcePolicy(ctx context.Context, orgID string) (matcher, error)
	LoadEvent(ctx context.Context, orgID, eventID string) (*EventDetail, error)
	Timeline(ctx context.Context, orgID, eventID string, since time.Time) ([]TimelineEntry, error)
	BriefItems(ctx context.Context, orgID, eventID string, limit int) ([]BriefItem, error)
	ReferencedArticles(ctx context.Context, orgID, eventID string, articleIDs []string, limit int) ([]ArticleRow, error)
	// TimelineWindowDays 对齐 news event settings 的 max(backfill, lookback)。
	// 缺省或读失败时为 30，不让设置查询打垮详情。
	TimelineWindowDays(ctx context.Context, orgID string) int
	SaveEventMetadata(ctx context.Context, orgID, eventID string, metadata []byte) error
	// GatewaySettings 读取模型网关 profile 与 proxy governance 的原始 JSON。
	// 没有对应行时该侧为 nil。
	GatewaySettings(ctx context.Context) (profiles, governance []byte, err error)
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

func (s *MySQLStore) LoadEvent(ctx context.Context, orgID, eventID string) (*EventDetail, error) {
	var row EventDetail
	var title, summary, topic, entity, language sql.NullString
	var metadata []byte
	err := s.db.QueryRowContext(ctx, `
SELECT id, orgId, status, title, summary, primaryTopic, primaryEntity, language, startAt, lastAt, metadata
FROM NewsEvent
WHERE orgId = ? AND id = ?
LIMIT 1`, orgID, eventID).Scan(
		&row.ID, &row.OrgID, &row.Status,
		&title, &summary, &topic, &entity, &language,
		&row.StartAt, &row.LastAt, &metadata,
	)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	row.Title = title.String
	row.Summary = summary.String
	row.PrimaryTopic = topic.String
	row.PrimaryEntity = entity.String
	row.Language = language.String
	row.Metadata = metadata
	return &row, nil
}

func (s *MySQLStore) Timeline(ctx context.Context, orgID, eventID string, since time.Time) ([]TimelineEntry, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT id, bucketStart, title, summary, referencedArticleIds
FROM NewsEventTimelineEntry
WHERE orgId = ? AND eventId = ? AND bucketStart >= ?
ORDER BY bucketStart ASC
LIMIT 12`, orgID, eventID, since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]TimelineEntry, 0, 12)
	for rows.Next() {
		var entry TimelineEntry
		var title, summary sql.NullString
		var refs []byte
		if err := rows.Scan(&entry.ID, &entry.BucketStart, &title, &summary, &refs); err != nil {
			return nil, err
		}
		entry.Title = title.String
		entry.Summary = summary.String
		entry.ReferencedArticleIDs = jsonStringList(refs)
		out = append(out, entry)
	}
	return out, rows.Err()
}

func (s *MySQLStore) BriefItems(ctx context.Context, orgID, eventID string, limit int) ([]BriefItem, error) {
	if limit <= 0 {
		return nil, nil
	}
	rows, err := s.db.QueryContext(ctx, `
SELECT nei.createdAt, nei.processedItemId, nei.processedArticleId,
       a.id, a.url, a.sourceLabel, a.crawlAt,
       pa.title, pa.summary, pa.keyPoints, pa.publishedAt, pa.processedAt, pa.source
FROM NewsEventItem nei
JOIN ProcessedArticle pa ON pa.id = nei.processedArticleId AND pa.orgId = ?
JOIN Article a ON a.id = pa.articleId AND a.orgId = ?
WHERE nei.orgId = ? AND nei.eventId = ?
ORDER BY nei.createdAt DESC
LIMIT ?`, orgID, orgID, orgID, eventID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]BriefItem, 0)
	for rows.Next() {
		var item BriefItem
		var processedItem, articleID, rawURL, label, title, summary, source sql.NullString
		var crawlAt, publishedAt sql.NullTime
		var keyPoints []byte
		if err := rows.Scan(
			&item.CreatedAt, &processedItem, &item.ProcessedArticleID,
			&articleID, &rawURL, &label, &crawlAt,
			&title, &summary, &keyPoints, &publishedAt, &item.ProcessedAt, &source,
		); err != nil {
			return nil, err
		}
		item.ProcessedItemID = strings.TrimSpace(processedItem.String)
		item.ArticleID = strings.TrimSpace(articleID.String)
		item.URL = strings.TrimSpace(rawURL.String)
		item.SourceLabel = strings.TrimSpace(label.String)
		item.Title = strings.TrimSpace(title.String)
		item.Summary = summary.String
		item.Source = strings.TrimSpace(source.String)
		item.KeyPoints = jsonStringList(keyPoints)
		if crawlAt.Valid {
			item.CrawlAt = crawlAt.Time
			item.HasCrawlAt = true
		}
		if publishedAt.Valid {
			item.PublishedAt = publishedAt.Time
			item.HasPublishedAt = true
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

func (s *MySQLStore) ReferencedArticles(ctx context.Context, orgID, eventID string, articleIDs []string, limit int) ([]ArticleRow, error) {
	ids := uniqueNonEmpty(articleIDs)
	if len(ids) > 600 {
		ids = ids[:600]
	}
	if len(ids) == 0 || limit <= 0 {
		return []ArticleRow{}, nil
	}
	query := `
SELECT a.id, a.url, a.sourceLabel, pa.title, pa.publishedAt
FROM ProcessedArticle pa
JOIN Article a ON a.id = pa.articleId AND a.orgId = ?
JOIN NewsEventItem nei ON nei.processedArticleId = pa.id AND nei.orgId = ? AND nei.eventId = ?
WHERE pa.orgId = ? AND pa.articleId IN (` + placeholders(len(ids)) + `)
ORDER BY pa.processedAt DESC
LIMIT ?`
	args := make([]any, 0, len(ids)+5)
	args = append(args, orgID, orgID, eventID, orgID)
	for _, id := range ids {
		args = append(args, id)
	}
	args = append(args, limit)
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]ArticleRow, 0)
	seen := map[string]struct{}{}
	for rows.Next() {
		var row ArticleRow
		var label, title sql.NullString
		var published sql.NullTime
		if err := rows.Scan(&row.ID, &row.URL, &label, &title, &published); err != nil {
			return nil, err
		}
		if row.ID == "" {
			continue
		}
		if _, ok := seen[row.ID]; ok {
			continue
		}
		seen[row.ID] = struct{}{}
		row.SourceLabel = strings.TrimSpace(label.String)
		row.Title = strings.TrimSpace(title.String)
		if published.Valid {
			row.PublishedAt = published.Time
			row.HasPublished = true
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

func (s *MySQLStore) TimelineWindowDays(ctx context.Context, orgID string) int {
	raw, err := s.setting(ctx, "news_event_settings:"+orgID)
	if err != nil || len(raw) == 0 {
		return 30
	}
	var doc struct {
		BackfillDays any `json:"backfillDays"`
		LookbackDays any `json:"lookbackDays"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return 30
	}
	backfill := clampInt(jsonInt(doc.BackfillDays, 30), 1, 365)
	lookback := clampInt(jsonInt(doc.LookbackDays, 30), 1, 180)
	if backfill > lookback {
		return backfill
	}
	return lookback
}

func (s *MySQLStore) SaveEventMetadata(ctx context.Context, orgID, eventID string, metadata []byte) error {
	_, err := s.db.ExecContext(ctx,
		"UPDATE NewsEvent SET metadata = ?, updatedAt = ? WHERE id = ? AND orgId = ?",
		metadata, time.Now().UTC().Truncate(time.Millisecond), eventID, orgID,
	)
	return err
}

func (s *MySQLStore) GatewaySettings(ctx context.Context) ([]byte, []byte, error) {
	profiles, err := s.setting(ctx, "llm_gateway_profiles")
	if err != nil {
		return nil, nil, err
	}
	governance, err := s.setting(ctx, "litellm_proxy_governance")
	if err != nil {
		return nil, nil, err
	}
	return profiles, governance, nil
}

func (s *MySQLStore) setting(ctx context.Context, key string) ([]byte, error) {
	var raw []byte
	err := s.db.QueryRowContext(ctx, "SELECT value FROM SystemSetting WHERE `key` = ? LIMIT 1", key).Scan(&raw)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return raw, err
}

func jsonStringList(raw []byte) []string {
	if len(raw) == 0 {
		return nil
	}
	var items []any
	if err := json.Unmarshal(raw, &items); err != nil {
		return nil
	}
	out := make([]string, 0, len(items))
	for _, item := range items {
		text, ok := item.(string)
		if !ok {
			continue
		}
		text = strings.TrimSpace(text)
		if text != "" {
			out = append(out, text)
		}
	}
	return out
}

func uniqueNonEmpty(values []string) []string {
	seen := map[string]struct{}{}
	out := make([]string, 0, len(values))
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

func jsonInt(value any, fallback int) int {
	switch typed := value.(type) {
	case float64:
		if typed != float64(int(typed)) {
			return fallback
		}
		return int(typed)
	case int:
		return typed
	default:
		return fallback
	}
}

func clampInt(value, min, max int) int {
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}

func placeholders(n int) string {
	if n <= 0 {
		return ""
	}
	return strings.Repeat("?,", n-1) + "?"
}
