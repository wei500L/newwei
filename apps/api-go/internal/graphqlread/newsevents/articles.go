package newsevents

import (
	"database/sql"
	"net/http"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
)

func (s *service) newsEventReferencedArticles(ctx contract.Context) (any, error) {
	if s == nil || s.db == nil {
		return nil, &contract.Failure{Status: http.StatusInternalServerError, Message: "Internal server error"}
	}
	eventID, _ := contract.StringArg(ctx.Args, "eventId")
	seen := map[string]struct{}{}
	ids := make([]string, 0)
	for _, raw := range stringListArg(ctx.Args, "articleIds") {
		trimmed := strings.TrimSpace(raw)
		if trimmed == "" {
			continue
		}
		if _, ok := seen[trimmed]; ok {
			continue
		}
		seen[trimmed] = struct{}{}
		ids = append(ids, trimmed)
		if len(ids) >= 600 {
			break
		}
	}
	if len(ids) == 0 {
		return []NewsEventReferencedArticleModel{}, nil
	}
	limit := optionalInt(ctx.Args, "limit", 300, 1, 2000)
	query := `
SELECT a.id, a.url, a.sourceLabel, pa.title, a.crawlAt, pa.publishedAt, pa.processedAt, pa.id
FROM ProcessedArticle pa
JOIN Article a ON a.id = pa.articleId
WHERE pa.articleId IN (` + placeholders(len(ids)) + `)
  AND EXISTS (
    SELECT 1 FROM NewsEventItem nei
    WHERE nei.processedArticleId = pa.id AND nei.orgId = ? AND nei.eventId = ?
  )
ORDER BY pa.processedAt DESC
LIMIT ?`
	args := make([]any, 0, len(ids)+3)
	for _, id := range ids {
		args = append(args, id)
	}
	args = append(args, ctx.Identity.OrgID, eventID, limit)
	rows, err := s.db.QueryContext(s.call(ctx), query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	kept := map[string]struct{}{}
	out := make([]NewsEventReferencedArticleModel, 0)
	for rows.Next() {
		var model NewsEventReferencedArticleModel
		var label, title sql.NullString
		var published sql.NullTime
		if err := rows.Scan(&model.ID, &model.URL, &label, &title, &model.CrawlAt, &published, &model.ProcessedAt, &model.ProcessedArticleID); err != nil {
			return nil, err
		}
		if model.ID == "" {
			continue
		}
		if _, ok := kept[model.ID]; ok {
			continue
		}
		kept[model.ID] = struct{}{}
		model.SourceLabel = nullString(label)
		model.Title = nullString(title)
		if published.Valid {
			value := published.Time
			model.PublishedAt = &value
		}
		out = append(out, model)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}
