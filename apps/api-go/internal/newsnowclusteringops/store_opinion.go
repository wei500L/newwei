package newsnowclusteringops

import (
	"context"
	"database/sql"
	"time"
)

// loadOpinionSnapshots reads the NewsNow domestic opinion index snapshots of one
// organization inside the requested window, oldest bucket first. It mirrors
// NewsnowDomesticOpinionIndexService.getDomesticOpinionIndex's
// newsnowDomesticOpinionIndexSnapshot.findMany call.
func (s *Service) loadOpinionSnapshots(ctx context.Context, orgID string, since time.Time) ([]opinionSnapshotRow, error) {
	const query = "SELECT bucketStart, indexValue, attentionScore, breadthScore, freshnessScore," +
		" sentimentPressure, candidateCount, keywordSummary" +
		" FROM NewsnowDomesticOpinionIndexSnapshot" +
		" WHERE orgId = ? AND bucketStart >= ?" +
		" ORDER BY bucketStart ASC"

	rows, err := s.db.QueryContext(ctx, query, orgID, since)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	out := make([]opinionSnapshotRow, 0, 48)
	for rows.Next() {
		var row opinionSnapshotRow
		var keywordSummary []byte
		if err := rows.Scan(
			&row.BucketStart,
			&row.IndexValue,
			&row.AttentionScore,
			&row.BreadthScore,
			&row.FreshnessScore,
			&row.SentimentPressure,
			&row.CandidateCount,
			&keywordSummary,
		); err != nil {
			return nil, err
		}
		row.KeywordSummaryJSON = keywordSummary
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// loadOpinionCandidates reads the domestic candidate snapshots of the latest
// bucket. The query is scoped to isDomestic = true, exactly like the Prisma
// where clause of loadTopCandidatesForBucket.
func (s *Service) loadOpinionCandidates(ctx context.Context, orgID string, bucketStart time.Time) ([]opinionCandidateRow, error) {
	const query = "SELECT label, candidateScore, domesticRatio, sourceCount" +
		" FROM NewsnowCandidateSnapshot" +
		" WHERE orgId = ? AND bucketStart = ? AND isDomestic = 1"

	rows, err := s.db.QueryContext(ctx, query, orgID, bucketStart)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	out := make([]opinionCandidateRow, 0, 16)
	for rows.Next() {
		var row opinionCandidateRow
		if err := rows.Scan(&row.Label, &row.CandidateScore, &row.DomesticRatio, &row.SourceCount); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// loadOpinionArticles reads the processed articles that feed the pipeline side
// of the index. It reproduces the Prisma select of loadPipelineTrend, including
// the joined Article.crawlAt / sourceId and the source language, which the
// domestic-classification rule consults.
//
// The NestJS predicate is status = 'completed' (not 'processed') and
// eventAt >= since; MaterializeEventAt is nullable in the schema but the range
// predicate excludes NULL, so a NULL can only appear through a race.
func (s *Service) loadOpinionArticles(ctx context.Context, orgID string, since time.Time) ([]opinionPipelineArticleRow, error) {
	const query = "SELECT pa.id, pa.title, pa.summary, pa.topics, pa.entities, pa.qualityScore," +
		" pa.language, pa.location, pa.publishedAt, pa.eventAt, pa.processedAt, pa.cleanedMarkdownRef," +
		" a.crawlAt, a.sourceId, ns.language" +
		" FROM ProcessedArticle pa" +
		" JOIN Article a ON a.id = pa.articleId" +
		" LEFT JOIN NewsSource ns ON ns.id = a.sourceId" +
		" WHERE pa.status = 'completed' AND pa.orgId = ? AND pa.eventAt >= ?" +
		" ORDER BY pa.eventAt DESC, pa.id DESC"

	rows, err := s.db.QueryContext(ctx, query, orgID, since)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	out := make([]opinionPipelineArticleRow, 0, 128)
	for rows.Next() {
		var (
			row                   opinionPipelineArticleRow
			title                 sql.NullString
			summary               sql.NullString
			topics                []byte
			entities              []byte
			qualityScore          sql.NullFloat64
			language              sql.NullString
			location              sql.NullString
			publishedAt           sql.NullTime
			eventAt               sql.NullTime
			cleanedMarkdownRef    sql.NullString
			sourceID              sql.NullString
			articleSourceLanguage sql.NullString
		)
		if err := rows.Scan(
			&row.ID,
			&title,
			&summary,
			&topics,
			&entities,
			&qualityScore,
			&language,
			&location,
			&publishedAt,
			&eventAt,
			&row.ProcessedAt,
			&cleanedMarkdownRef,
			&row.CrawlAt,
			&sourceID,
			&articleSourceLanguage,
		); err != nil {
			return nil, err
		}
		row.Title = nullStringPointer(title)
		row.Summary = nullStringPointer(summary)
		row.TopicsJSON = topics
		row.EntitiesJSON = entities
		if qualityScore.Valid {
			value := qualityScore.Float64
			row.QualityScore = &value
		}
		row.Language = nullStringPointer(language)
		row.Location = nullStringPointer(location)
		if publishedAt.Valid {
			value := publishedAt.Time
			row.PublishedAt = &value
		}
		if eventAt.Valid {
			row.EventAt = eventAt.Time
		}
		row.CleanedMarkdownRef = nullStringPointer(cleanedMarkdownRef)
		row.ArticleSourceID = nullStringPointer(sourceID)
		row.ArticleSourceLanguage = nullStringPointer(articleSourceLanguage)
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}
