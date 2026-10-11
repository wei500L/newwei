package userdigest

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/personalnews"
)

const (
	relatedCandidateMin         = 200
	relatedCandidateMax         = 1000
	relatedCandidatesPerEvent   = 100
	processedItemResolveFactor  = 3
	processedItemResolveMax     = 3000
	processedItemEventBatchSize = 500
)

type digestEvent struct {
	ID                string
	Title             *string
	Summary           *string
	PrimaryTopic      *string
	PrimaryEntity     *string
	StartAt           time.Time
	LastAt            time.Time
	ItemCount         int
	RepresentativeURL *string
}

// loadEvents 取窗口内 status=active 的组织事件。lastAt 只有下界
// （>= windowStart），没有 lastAt < windowEnd。主题/实体直接匹配，
// 来源/关键词/地理走关联内容。命中不足 maxEvents 时用最新事件补齐。
func (s *Service) loadEvents(ctx context.Context, orgID string, preference Preference, subs personalnews.DigestSubscriptionValues, since time.Time) ([]digestEvent, error) {
	if err := s.requireDB(); err != nil {
		return nil, err
	}
	hasTopic := len(subs.FocusTopics) > 0
	hasEntity := len(subs.FocusEntities) > 0
	hasRelated := len(subs.FocusSources) > 0 || len(subs.FocusKeywords) > 0 || len(subs.FocusGeos) > 0
	if !hasTopic && !hasEntity && !hasRelated {
		return s.queryEvents(ctx, orgID, since, false, nil, nil, preference.MaxEvents)
	}

	matched := make([]string, 0)
	seen := map[string]struct{}{}
	add := func(id string) {
		if id == "" {
			return
		}
		if _, ok := seen[id]; ok {
			return
		}
		seen[id] = struct{}{}
		matched = append(matched, id)
	}
	if hasTopic || hasEntity {
		ids, err := s.topicEntityEventIDs(ctx, orgID, since, subs, preference.MaxEvents*8)
		if err != nil {
			return nil, err
		}
		for _, id := range ids {
			add(id)
		}
	}
	if hasRelated {
		ids, err := s.relatedEventIDs(ctx, orgID, since, subs, relatedCandidateLimit(preference.MaxEvents))
		if err != nil {
			return nil, err
		}
		for _, id := range ids {
			add(id)
		}
	}

	var primary []digestEvent
	if len(matched) > 0 {
		rows, err := s.queryEvents(ctx, orgID, since, true, matched, nil, preference.MaxEvents)
		if err != nil {
			return nil, err
		}
		primary = rows
	}
	if len(primary) >= preference.MaxEvents {
		return primary, nil
	}
	already := make([]string, len(primary))
	for i := range primary {
		already[i] = primary[i].ID
	}
	fallback, err := s.queryEvents(ctx, orgID, since, false, nil, already, preference.MaxEvents-len(primary))
	if err != nil {
		return nil, err
	}
	if primary == nil {
		primary = []digestEvent{}
	}
	return append(primary, fallback...), nil
}

func (s *Service) queryEvents(ctx context.Context, orgID string, since time.Time, useInclude bool, includeIDs, excludeIDs []string, limit int) ([]digestEvent, error) {
	if useInclude && len(includeIDs) == 0 {
		return []digestEvent{}, nil
	}
	if limit < 0 {
		limit = 0
	}
	var b strings.Builder
	b.WriteString(`SELECT ne.id, ne.title, ne.summary, ne.primaryTopic, ne.primaryEntity, ne.startAt, ne.lastAt,
(SELECT COUNT(*) FROM NewsEventItem nei WHERE nei.eventId = ne.id),
a.url
FROM NewsEvent ne
LEFT JOIN ProcessedArticle pa ON pa.id = ne.representativeProcessedArticleId
LEFT JOIN Article a ON a.id = pa.articleId
WHERE ne.orgId = ? AND ne.status = 'active' AND ne.lastAt >= ?`)
	args := []any{orgID, since.UTC()}
	if useInclude {
		b.WriteString(" AND ne.id IN (")
		b.WriteString(placeholders(len(includeIDs)))
		b.WriteString(")")
		for _, id := range includeIDs {
			args = append(args, id)
		}
	}
	if len(excludeIDs) > 0 {
		b.WriteString(" AND ne.id NOT IN (")
		b.WriteString(placeholders(len(excludeIDs)))
		b.WriteString(")")
		for _, id := range excludeIDs {
			args = append(args, id)
		}
	}
	b.WriteString(" ORDER BY ne.lastAt DESC, ne.startAt DESC LIMIT ?")
	args = append(args, limit)
	return s.scanEvents(ctx, b.String(), args)
}

func (s *Service) topicEntityEventIDs(ctx context.Context, orgID string, since time.Time, subs personalnews.DigestSubscriptionValues, limit int) ([]string, error) {
	var b strings.Builder
	b.WriteString("SELECT id FROM NewsEvent WHERE orgId = ? AND status = 'active' AND lastAt >= ? AND ")
	args := []any{orgID, since.UTC()}
	switch {
	case len(subs.FocusTopics) > 0 && len(subs.FocusEntities) > 0:
		b.WriteString("(primaryTopic IN (")
		b.WriteString(placeholders(len(subs.FocusTopics)))
		b.WriteString(") OR primaryEntity IN (")
		b.WriteString(placeholders(len(subs.FocusEntities)))
		b.WriteString("))")
		for _, topic := range subs.FocusTopics {
			args = append(args, topic)
		}
		for _, entity := range subs.FocusEntities {
			args = append(args, entity)
		}
	case len(subs.FocusTopics) > 0:
		b.WriteString("primaryTopic IN (")
		b.WriteString(placeholders(len(subs.FocusTopics)))
		b.WriteString(")")
		for _, topic := range subs.FocusTopics {
			args = append(args, topic)
		}
	default:
		b.WriteString("primaryEntity IN (")
		b.WriteString(placeholders(len(subs.FocusEntities)))
		b.WriteString(")")
		for _, entity := range subs.FocusEntities {
			args = append(args, entity)
		}
	}
	// Nest 这个 id 查询没有 orderBy，只 take。
	b.WriteString(" LIMIT ?")
	args = append(args, limit)
	return s.scanIDs(ctx, b.String(), args)
}

func (s *Service) relatedEventIDs(ctx context.Context, orgID string, since time.Time, subs personalnews.DigestSubscriptionValues, candidateLimit int) ([]string, error) {
	seen := map[string]struct{}{}
	var ids []string
	add := func(id string) {
		if id == "" {
			return
		}
		if _, ok := seen[id]; ok {
			return
		}
		seen[id] = struct{}{}
		ids = append(ids, id)
	}
	if len(subs.FocusSources) > 0 {
		sourceIDs := make([]string, 0, len(subs.FocusSources))
		for _, source := range subs.FocusSources {
			sourceIDs = append(sourceIDs, source.SourceID)
		}
		query := `SELECT DISTINCT nei.eventId
FROM NewsEventItem nei
INNER JOIN NewsEvent ne ON ne.id = nei.eventId
INNER JOIN ProcessedArticle pa ON pa.id = nei.processedArticleId
INNER JOIN Article a ON a.id = pa.articleId
WHERE nei.orgId = ? AND ne.orgId = ? AND ne.status = 'active' AND ne.lastAt >= ?
AND a.sourceId IN (` + placeholders(len(sourceIDs)) + `)`
		args := []any{orgID, orgID, since.UTC()}
		for _, id := range sourceIDs {
			args = append(args, id)
		}
		rows, err := s.scanIDs(ctx, query, args)
		if err != nil {
			return nil, err
		}
		for _, id := range rows {
			add(id)
		}
	}
	if len(subs.FocusKeywords) == 0 && len(subs.FocusGeos) == 0 {
		return ids, nil
	}
	processedIDs, err := s.matchedProcessedItemIDs(ctx, orgID, since, subs, candidateLimit)
	if err != nil {
		return nil, err
	}
	for _, batch := range chunkStrings(processedIDs, processedItemEventBatchSize) {
		query := `SELECT DISTINCT nei.eventId
FROM NewsEventItem nei
INNER JOIN NewsEvent ne ON ne.id = nei.eventId
WHERE nei.orgId = ? AND nei.processedItemId IN (` + placeholders(len(batch)) + `)
AND ne.orgId = ? AND ne.status = 'active' AND ne.lastAt >= ?`
		args := []any{orgID}
		for _, id := range batch {
			args = append(args, id)
		}
		args = append(args, orgID, since.UTC())
		rows, err := s.scanIDs(ctx, query, args)
		if err != nil {
			return nil, err
		}
		for _, id := range rows {
			add(id)
		}
	}
	return ids, nil
}

func (s *Service) scanEvents(ctx context.Context, query string, args []any) ([]digestEvent, error) {
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("%w: news events: %v", errMySQL, err)
	}
	defer rows.Close()
	out := make([]digestEvent, 0)
	for rows.Next() {
		var event digestEvent
		var title, summary, topic, entity, articleURL sql.NullString
		var itemCount int64
		if err := rows.Scan(&event.ID, &title, &summary, &topic, &entity, &event.StartAt, &event.LastAt, &itemCount, &articleURL); err != nil {
			return nil, fmt.Errorf("%w: scan news event: %v", errMySQL, err)
		}
		event.ItemCount = int(itemCount)
		event.Title = nullStringPtr(title)
		event.Summary = nullStringPtr(summary)
		event.PrimaryTopic = nullStringPtr(topic)
		event.PrimaryEntity = nullStringPtr(entity)
		event.RepresentativeURL = nullStringPtr(articleURL)
		out = append(out, event)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("%w: news events: %v", errMySQL, err)
	}
	return out, nil
}

func (s *Service) scanIDs(ctx context.Context, query string, args []any) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("%w: news event ids: %v", errMySQL, err)
	}
	defer rows.Close()
	out := make([]string, 0)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("%w: scan news event id: %v", errMySQL, err)
		}
		out = append(out, id)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("%w: news event ids: %v", errMySQL, err)
	}
	return out, nil
}

func nullStringPtr(value sql.NullString) *string {
	if !value.Valid {
		return nil
	}
	text := value.String
	return &text
}

func relatedCandidateLimit(maxEvents int) int {
	numeric := maxEvents
	if numeric < 0 {
		numeric = 0
	}
	limit := numeric * relatedCandidatesPerEvent
	if limit < relatedCandidateMin {
		limit = relatedCandidateMin
	}
	if limit > relatedCandidateMax {
		limit = relatedCandidateMax
	}
	return limit
}
