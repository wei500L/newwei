package knowledgegraph

import (
	"database/sql"
	"fmt"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
)

// articleEntityLinks is the articleEntityLinks root resolver.
func (s *service) articleEntityLinks(ctx contract.Context) (any, error) {
	if !s.healthy() {
		return nil, fmt.Errorf("knowledge graph database is not configured")
	}
	articleID, ok := contract.StringArg(ctx.Args, "articleId")
	if !ok {
		return nil, fmt.Errorf("articleId is required")
	}
	limit := 50
	if value, present := contract.IntArg(ctx.Args, "limit"); present {
		limit = value
	}
	limit = clampLimit(limit, 1, 200)

	current := s.getSettings(ctx.Ctx, ctx.Identity.OrgID)
	if !current.Enabled {
		return []ArticleEntityLinkModel{}, nil
	}

	rows, err := s.db.QueryContext(s.call(ctx.Ctx),
		"SELECT l.`articleId`, l.`mention`, l.`confidence`, l.`createdAt`, "+
			"e.`id`, e.`type`, e.`canonicalName`, e.`properties` "+
			"FROM `ArticleEntityLink` l INNER JOIN `KnowledgeEntity` e ON e.`id` = l.`entityId` "+
			"WHERE l.`orgId` = ? AND l.`articleId` = ? ORDER BY l.`createdAt` DESC LIMIT ?",
		ctx.Identity.OrgID, articleID, limit,
	)
	if err != nil {
		return nil, fmt.Errorf("query article entity links: %w", err)
	}
	defer rows.Close()

	out := make([]ArticleEntityLinkModel, 0)
	for rows.Next() {
		var item ArticleEntityLinkModel
		var mention sql.NullString
		var confidence sql.NullFloat64
		var properties []byte
		if err := rows.Scan(&item.ArticleID, &mention, &confidence, &item.CreatedAt,
			&item.Entity.ID, &item.Entity.Type, &item.Entity.Name, &properties); err != nil {
			return nil, fmt.Errorf("scan article entity link: %w", err)
		}
		item.Mention = nullString(mention)
		item.Confidence = nullFloat(confidence)
		item.Entity.Properties = decodeJSON(properties)
		out = append(out, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// knowledgeGraphEdgeEvidence is the knowledgeGraphEdgeEvidence root resolver.
func (s *service) knowledgeGraphEdgeEvidence(ctx contract.Context) (any, error) {
	if !s.healthy() {
		return nil, fmt.Errorf("knowledge graph database is not configured")
	}
	edgeID, ok := contract.StringArg(ctx.Args, "edgeId")
	if !ok {
		return nil, fmt.Errorf("edgeId is required")
	}
	limit := 20
	if value, present := contract.IntArg(ctx.Args, "limit"); present {
		limit = value
	}
	limit = clampLimit(limit, 1, 50)

	current := s.getSettings(ctx.Ctx, ctx.Identity.OrgID)
	if !current.Enabled {
		return []KnowledgeGraphEdgeEvidenceItemModel{}, nil
	}

	rows, err := s.db.QueryContext(s.call(ctx.Ctx),
		"SELECT ev.`id`, ev.`confidence`, ev.`extractorVersion`, ev.`createdAt`, ev.`evidence`, "+
			"a.`id`, a.`url`, a.`titleGuess`, a.`language`, a.`crawlAt`, "+
			"p.`title`, p.`summary`, p.`language` "+
			"FROM `KnowledgeEdgeEvidence` ev "+
			"INNER JOIN `Article` a ON a.`id` = ev.`articleId` "+
			"LEFT JOIN `ProcessedArticle` p ON p.`articleId` = a.`id` "+
			"WHERE ev.`orgId` = ? AND ev.`edgeId` = ? "+
			"ORDER BY a.`crawlAt` DESC, ev.`createdAt` DESC LIMIT ?",
		ctx.Identity.OrgID, edgeID, limit,
	)
	if err != nil {
		return nil, fmt.Errorf("query edge evidence: %w", err)
	}
	defer rows.Close()

	out := make([]KnowledgeGraphEdgeEvidenceItemModel, 0)
	for rows.Next() {
		var item KnowledgeGraphEdgeEvidenceItemModel
		var confidence sql.NullFloat64
		var extractorVersion sql.NullString
		var evidence []byte
		var titleGuess sql.NullString
		var articleLanguage sql.NullString
		var processedTitle sql.NullString
		var processedSummary sql.NullString
		var processedLanguage sql.NullString
		if err := rows.Scan(&item.ID, &confidence, &extractorVersion, &item.CreatedAt, &evidence,
			&item.Article.ID, &item.Article.URL, &titleGuess, &articleLanguage, &item.Article.CrawlAt,
			&processedTitle, &processedSummary, &processedLanguage); err != nil {
			return nil, fmt.Errorf("scan edge evidence: %w", err)
		}
		item.Confidence = nullFloat(confidence)
		item.ExtractorVersion = nullString(extractorVersion)
		item.Evidence = decodeJSONObject(evidence)
		if processedTitle.Valid {
			item.Article.Title = nullString(processedTitle)
		} else {
			item.Article.Title = nullString(titleGuess)
		}
		item.Article.Summary = nullString(processedSummary)
		if processedLanguage.Valid {
			item.Article.Language = nullString(processedLanguage)
		} else {
			item.Article.Language = nullString(articleLanguage)
		}
		out = append(out, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

func clampLimit(value, minimum, maximum int) int {
	if value < minimum {
		return minimum
	}
	if value > maximum {
		return maximum
	}
	return value
}
