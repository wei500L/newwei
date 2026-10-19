package kgingestion

import (
	"context"
	"log"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/knowledgegraph"
)

// Service runs one organization: settings gate, cursor, batch loop and the
// per-article pipeline.
type Service struct {
	store    *Store
	settings SettingsProvider
	failures FailureCounter
	quality  *Quality
	graph    *GraphWriter
	linker   *Linker
	logger   *log.Logger
}

// ServiceOptions are the production dependencies of one Service.
type ServiceOptions struct {
	Store    *Store
	Settings SettingsProvider
	Failures FailureCounter
	Quality  *Quality
	Graph    *GraphWriter
	Linker   *Linker
	Logger   *log.Logger
}

// NewService builds the organization runner.
func NewService(options ServiceOptions) *Service {
	return &Service{
		store:    options.Store,
		settings: options.Settings,
		failures: options.Failures,
		quality:  options.Quality,
		graph:    options.Graph,
		linker:   options.Linker,
		logger:   options.Logger,
	}
}

// IngestOrg reproduces ingestOrg: read the settings document, stop when the
// feature or ingestion is disabled, load or create the state row, then process
// one batch. A batch failure is an organization failure; per-article failures
// are handled inside runOrgBatch and never fail the organization.
func (s *Service) IngestOrg(ctx context.Context, orgID string) (BatchSummary, error) {
	if s == nil || s.store == nil || s.settings == nil || s.failures == nil || s.quality == nil || s.graph == nil || s.linker == nil {
		return BatchSummary{}, errServiceUnavailable
	}
	settings := s.settings.Read(ctx, orgID)
	if !settings.Enabled || !settings.IngestionEnabled {
		return BatchSummary{}, nil
	}

	cursor, err := s.store.LoadCursor(ctx, orgID)
	if err != nil {
		return BatchSummary{}, err
	}
	summary, err := runOrgBatch(ctx, orgID, settings, &cursor, s.store, s.failures, s, s.logger)
	if err != nil {
		return summary, err
	}
	if summary.ProcessedArticles+summary.FailedArticles > 0 && s.logger != nil {
		s.logger.Printf("kgingestion: completed orgId=%s processedArticles=%d failedArticles=%d upsertedEdges=%d validatedRelations=%d filteredRelations=%d",
			orgID, summary.ProcessedArticles, summary.FailedArticles, summary.UpsertedEdges,
			summary.ValidatedRelations, summary.FilteredRelations)
	}
	return summary, nil
}

// ProcessArticle runs T3 -> T4 -> T5 for one article. Entity linking is a
// separate try: its failure is logged and does not make the article fail, so
// the cursor still advances and the graph writes are not repeated.
func (s *Service) ProcessArticle(
	ctx context.Context,
	orgID string,
	article ProcessedArticle,
	settings Settings,
) (ArticleWriteStats, error) {
	prepared := s.quality.Prepare(ctx, PrepareInput{
		OrgID:       orgID,
		ArticleID:   article.ArticleID,
		Title:       article.Title,
		Summary:     article.Summary,
		Language:    article.Language,
		KGRelations: article.KGRelations,
		Settings:    settings,
	})

	edges, err := s.graph.IngestProcessedArticle(ctx, orgID, article.ArticleID, article.LLMPromptVersion, prepared.Relations)
	if err != nil {
		return ArticleWriteStats{}, err
	}
	stats := ArticleWriteStats{
		EdgesUpserted:      edges,
		ValidatedRelations: prepared.ValidatedRelations,
		FilteredRelations:  prepared.FilteredRelations,
	}

	if _, err := s.linker.Link(ctx, orgID, article.ArticleID, article.Entities, settings, linkingContextText(article)); err != nil {
		if s.logger != nil {
			s.logger.Printf("kgingestion: entity linking failed orgId=%s articleId=%s err=%v",
				orgID, article.ArticleID, err)
		}
	}
	return stats, nil
}

// linkingContextText is `[title, summary].filter(Boolean).join("\n\n").trim()`.
// The linker applies the 4000 UTF-16 unit cap.
func linkingContextText(article ProcessedArticle) string {
	parts := make([]string, 0, 2)
	if article.Title != nil && *article.Title != "" {
		parts = append(parts, *article.Title)
	}
	if article.Summary != nil && *article.Summary != "" {
		parts = append(parts, *article.Summary)
	}
	if len(parts) == 0 {
		return ""
	}
	return knowledgegraph.TrimSpace(strings.Join(parts, "\n\n"))
}
