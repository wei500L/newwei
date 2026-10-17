package crawlfrontierruns

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"strings"
	"time"
)

// errNodeMissing is returned for both an absent node and a cross-tenant node.
var errNodeMissing = newStatus(404, "Crawl frontier node not found")

// GetNode mirrors getNode: node first, orgId comparison afterwards, then the
// run/profile subset, the org-scoped crawl result, the article and its
// processed row, and the three derived summaries.
func (s *Service) GetNode(ctx context.Context, orgID, id string) (nodeDetail, error) {
	node, err := s.loadNodeRecord(ctx, id)
	if err != nil {
		return nodeDetail{}, err
	}
	if node.OrgID != orgID {
		return nodeDetail{}, errNodeMissing
	}
	run, profile, err := s.loadNodeRun(ctx, node.RunID)
	if err != nil {
		return nodeDetail{}, err
	}

	var crawlResult *crawlResultScan
	if node.CrawlResultID != nil && strings.TrimSpace(*node.CrawlResultID) != "" {
		result, err := s.loadCrawlResult(ctx, *node.CrawlResultID)
		if err != nil {
			return nodeDetail{}, err
		}
		// Cross-tenant crawl results are rendered as null, matching the
		// explicit orgId comparison in NestJS.
		if result != nil && result.OrgID == orgID {
			crawlResult = result
		}
	}

	var article *articleScan
	if crawlResult != nil {
		found, err := s.loadArticle(ctx, orgID, crawlResult.Document.ContentHash)
		if err != nil {
			return nodeDetail{}, err
		}
		article = found
	}

	var processed *processedArticleDocument
	if article != nil {
		row, err := s.loadProcessedArticle(ctx, article.Document.ID)
		if err != nil {
			return nodeDetail{}, err
		}
		processed = row
	}

	var articleMetadata RawJSON
	if article != nil {
		articleMetadata = article.Metadata
	}
	repairSummary := buildNodeRepairSummary(articleMetadata)
	extractionSummary := buildNodeExtractionSummary(article != nil, processed)

	detail := nodeDetail{
		nodeRecord:        node,
		Run:               run,
		ProcessedArticle:  processed,
		RepairSummary:     repairSummary,
		ExtractionSummary: extractionSummary,
	}
	if crawlResult != nil {
		detail.CrawlResult = &crawlResult.Document
	}
	if article != nil {
		detail.Article = &article.Document
	}
	var profileID *string
	if profile != nil {
		profileID = &profile.ID
	}
	nodeID := node.ID
	includeRepair := false
	if article != nil && article.LLMRepair != nil {
		includeRepair = true
	}
	detail.LLMLogFilters = buildLlmLogFilters(node.RunID, &nodeID, profileID, includeRepair)
	return detail, nil
}

// loadNodeRecord loads one CrawlFrontierNode row by primary key.
func (s *Service) loadNodeRecord(ctx context.Context, id string) (nodeRecord, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT "+nodeColumns+" FROM CrawlFrontierNode WHERE id = ?", id)
	if err != nil {
		return nodeRecord{}, err
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return nodeRecord{}, err
		}
		return nodeRecord{}, errNodeMissing
	}
	return scanNodeRecord(rows)
}

// loadNodeRun loads the run subset and its profile subset embedded in
// GET /nodes/:id.
func (s *Service) loadNodeRun(ctx context.Context, runID string) (nodeRunRef, *nodeRunProfile, error) {
	rows, err := s.db.QueryContext(ctx,
		"SELECT id, seedUrl, status, executionMode, profileId FROM CrawlFrontierRun WHERE id = ?", runID)
	if err != nil {
		return nodeRunRef{}, nil, err
	}
	var id, seedURL, status, executionMode string
	var profileID sql.NullString
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			_ = rows.Close()
			return nodeRunRef{}, nil, err
		}
		_ = rows.Close()
		return nodeRunRef{}, nil, newStatus(500, "Internal server error")
	}
	err = rows.Scan(&id, &seedURL, &status, &executionMode, &profileID)
	_ = rows.Close()
	if err != nil {
		return nodeRunRef{}, nil, err
	}
	run := nodeRunRef{
		ID:            id,
		SeedURL:       seedURL,
		Status:        RunStatus(status),
		ExecutionMode: ExecutionMode(executionMode),
	}
	if !profileID.Valid {
		return run, nil, nil
	}
	profileRows, err := s.db.QueryContext(ctx,
		"SELECT id, name, matchHost, executionMode, isActive FROM CrawlSiteProfile WHERE id = ?", profileID.String)
	if err != nil {
		return nodeRunRef{}, nil, err
	}
	defer profileRows.Close()
	if !profileRows.Next() {
		if err := profileRows.Err(); err != nil {
			return nodeRunRef{}, nil, err
		}
		return run, nil, nil
	}
	var profile nodeRunProfile
	var active int
	if err := profileRows.Scan(&profile.ID, &profile.Name, &profile.MatchHost, &profile.ExecutionMode, &active); err != nil {
		return nodeRunRef{}, nil, err
	}
	profile.IsActive = active != 0
	run.Profile = &profile
	return run, &profile, nil
}

// crawlResultScan is the org-tagged crawl result projection.
type crawlResultScan struct {
	OrgID    string
	Document crawlResultDocument
}

// loadCrawlResult loads the crawl result subset used by GET /nodes/:id. A
// missing row is not an error: NestJS renders null.
func (s *Service) loadCrawlResult(ctx context.Context, id string) (*crawlResultScan, error) {
	rows, err := s.db.QueryContext(ctx,
		"SELECT id, orgId, sourceUrl, fetchedAt, markdownRef, contentHash, metadata FROM CrawlResult WHERE id = ?", id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return nil, err
		}
		return nil, nil
	}
	var result crawlResultScan
	var fetchedAt time.Time
	var metadata []byte
	if err := rows.Scan(&result.Document.ID, &result.OrgID, &result.Document.SourceURL,
		&fetchedAt, &result.Document.MarkdownRef, &result.Document.ContentHash, &metadata); err != nil {
		return nil, err
	}
	result.Document.FetchedAt = nestFromTime(fetchedAt)
	result.Document.Metadata = objectJSONOrNull(metadata)
	return &result, nil
}

// articleScan is the article projection plus its parsed metadata view.
type articleScan struct {
	Document  articleDocument
	Metadata  RawJSON
	LLMRepair RawJSON
}

// loadArticle loads the article matching the unique (orgId, contentHash) key.
func (s *Service) loadArticle(ctx context.Context, orgID, contentHash string) (*articleScan, error) {
	rows, err := s.db.QueryContext(ctx,
		"SELECT id, url, titleGuess, sourceLabel, language, crawlAt, metadata FROM Article WHERE orgId = ? AND contentHash = ? LIMIT 1",
		orgID, contentHash)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return nil, err
		}
		return nil, nil
	}
	var article articleScan
	var titleGuess, sourceLabel, language sql.NullString
	var crawlAt time.Time
	var metadata []byte
	if err := rows.Scan(&article.Document.ID, &article.Document.URL, &titleGuess, &sourceLabel,
		&language, &crawlAt, &metadata); err != nil {
		return nil, err
	}
	article.Document.TitleGuess = nullStringPtr(titleGuess)
	article.Document.SourceLabel = nullStringPtr(sourceLabel)
	article.Document.Language = nullStringPtr(language)
	article.Document.CrawlAt = nestFromTime(crawlAt)
	article.Document.Metadata = objectJSONOrNull(metadata)
	article.Metadata = article.Document.Metadata
	if article.Metadata.IsObject() {
		view := articleMetadataView{}
		if json.Unmarshal(article.Metadata, &view) == nil && view.LLMRepair.IsObject() {
			article.LLMRepair = view.LLMRepair
			article.Document.LLMRepair = view.LLMRepair
		}
	}
	return &article, nil
}

// loadProcessedArticle loads the ProcessedArticle row of an article.
func (s *Service) loadProcessedArticle(ctx context.Context, articleID string) (*processedArticleDocument, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT id, status, title, subtitle, author, source, publishedAt, category, qualityScore,
       llmModel, llmPromptVersion, language, location, processedAt, removedNoiseTypes,
       topics, keyPoints, entities, kgRelations
FROM ProcessedArticle WHERE articleId = ? LIMIT 1`, articleID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return nil, err
		}
		return nil, nil
	}
	var document processedArticleDocument
	var title, subtitle, author, source, category, llmModel, llmPromptVersion, language, location sql.NullString
	var publishedAt sql.NullTime
	var qualityScore sql.NullFloat64
	var processedAt time.Time
	var removedNoiseTypes, topics, keyPoints, entities, kgRelations []byte
	err = rows.Scan(
		&document.ID, &document.Status, &title, &subtitle, &author, &source, &publishedAt,
		&category, &qualityScore, &llmModel, &llmPromptVersion, &language, &location,
		&processedAt, &removedNoiseTypes, &topics, &keyPoints, &entities, &kgRelations,
	)
	if err != nil {
		return nil, err
	}
	document.Title = nullStringPtr(title)
	document.Subtitle = nullStringPtr(subtitle)
	document.Author = nullStringPtr(author)
	document.Source = nullStringPtr(source)
	document.PublishedAt = nestFromNullTime(publishedAt)
	document.Category = nullStringPtr(category)
	document.QualityScore = nullFloatPtr(qualityScore)
	document.LLMModel = nullStringPtr(llmModel)
	document.LLMPromptVersion = nullStringPtr(llmPromptVersion)
	document.Language = nullStringPtr(language)
	document.Location = nullStringPtr(location)
	document.ProcessedAt = nestFromTime(processedAt)
	document.RemovedNoiseTypes = rawOrNil(bytes.TrimSpace(removedNoiseTypes))
	document.Topics = rawOrNil(bytes.TrimSpace(topics))
	document.KeyPoints = rawOrNil(bytes.TrimSpace(keyPoints))
	document.Entities = rawOrNil(bytes.TrimSpace(entities))
	document.KGRelations = rawOrNil(bytes.TrimSpace(kgRelations))
	return &document, nil
}
