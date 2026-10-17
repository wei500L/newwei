package classificationrssops

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"sort"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// rssDiagnosticsQuery is the typed input of the three RSS diagnostics reads. The
// numbers are optional floats because the controller parses Number(raw) and the
// service clamps them.
type rssDiagnosticsQuery struct {
	OrgID         string
	WindowDays    *float64
	LookbackHours *float64
}

// rssBackfillRequest is the typed input of POST backfill-source-id.
type rssBackfillRequest struct {
	OrgID  string
	DryRun *bool
	Limit  *float64
}

// newsSourceSchedulerEnabled mirrors EnvService.newsSourceSchedulerConfig.enabled
// (NEWS_SOURCE_SCHEDULER_ENABLED with envBoolean semantics, default true). It is
// read here instead of being added to config.Config so the classification/RSS ops
// switch chapter does not widen the shared configuration.
func newsSourceSchedulerEnabled() bool {
	switch strings.TrimSpace(strings.ToLower(os.Getenv("NEWS_SOURCE_SCHEDULER_ENABLED"))) {
	case "", "true", "1", "yes", "y", "on":
		return true
	case "false", "0", "no", "n", "off":
		return false
	default:
		// An unrecognized value would make the NestJS process fail to boot; the
		// Go reader keeps the documented default instead of inventing a failure.
		return true
	}
}

// RSSDiagnosticsOverview mirrors getOverview: the payload is served from the
// MySQL ObservabilitySnapshot row (scope rss_diagnostics, variantKey
// windowDays:<d>:lookbackHours:<h>) behind the shared Redis lock, with a 60s TTL.
func (s *Service) RSSDiagnosticsOverview(ctx context.Context, query rssDiagnosticsQuery) (json.RawMessage, error) {
	windowDays := resolveWindowDays(query.WindowDays)
	lookbackHours := resolveLookbackHours(query.LookbackHours)
	variantKey := fmt.Sprintf("windowDays:%d:lookbackHours:%d", windowDays, lookbackHours)
	return s.store.getOrCreate(ctx, query.OrgID, rssDiagnosticsSnapshotScope, variantKey,
		rssSnapshotTTLSeconds, func() (json.RawMessage, error) {
			overview, err := s.buildRSSDiagnosticsOverview(ctx, query.OrgID, windowDays, lookbackHours)
			if err != nil {
				return nil, err
			}
			return json.Marshal(overview)
		})
}

// resolveWindowDays mirrors clampInt(options.windowDays, 1, 30, 7).
func resolveWindowDays(value *float64) int {
	if value == nil {
		return rssDefaultWindowDays
	}
	return clampIntRange(*value, 1, rssMaxWindowDays)
}

// resolveLookbackHours mirrors clampInt(options.lookbackHours, 1, 720, 24).
func resolveLookbackHours(value *float64) int {
	if value == nil {
		return rssDefaultLookbackHours
	}
	return clampIntRange(*value, 1, rssMaxLookbackHours)
}

// RSSDiagnosticsChain mirrors getChainSummary: it loads the same (possibly cached)
// overview and returns its chain object.
func (s *Service) RSSDiagnosticsChain(ctx context.Context, query rssDiagnosticsQuery) (json.RawMessage, error) {
	payload, err := s.RSSDiagnosticsOverview(ctx, query)
	if err != nil {
		return nil, err
	}
	var overview rssDiagnosticsOverview
	if err := json.Unmarshal(payload, &overview); err != nil {
		return nil, err
	}
	return json.Marshal(overview.Chain)
}

// RSSDiagnosticsSources mirrors listSourceDetails: it loads the same overview and
// returns its sources array.
func (s *Service) RSSDiagnosticsSources(ctx context.Context, query rssDiagnosticsQuery) (json.RawMessage, error) {
	payload, err := s.RSSDiagnosticsOverview(ctx, query)
	if err != nil {
		return nil, err
	}
	var overview rssDiagnosticsOverview
	if err := json.Unmarshal(payload, &overview); err != nil {
		return nil, err
	}
	if overview.Sources == nil {
		overview.Sources = []rssDiagnosticsSourceRow{}
	}
	return json.Marshal(overview.Sources)
}

// buildRSSDiagnosticsOverview mirrors the private buildOverview helper.
func (s *Service) buildRSSDiagnosticsOverview(ctx context.Context, orgID string, windowDays, lookbackHours int) (rssDiagnosticsOverview, error) {
	now := time.Now().UTC()
	sinceWindow := now.Add(-time.Duration(windowDays) * 24 * time.Hour)
	sinceLookback := now.Add(-time.Duration(lookbackHours) * time.Hour)
	schedulerEnabled := newsSourceSchedulerEnabled()

	sources, err := s.loadRSSSources(ctx, orgID)
	if err != nil {
		return rssDiagnosticsOverview{}, err
	}
	sourceIDs := make([]string, 0, len(sources))
	for _, source := range sources {
		sourceIDs = append(sourceIDs, source.ID)
	}

	processedStats, err := s.processedStatsBySource(ctx, orgID, sourceIDs, sinceWindow)
	if err != nil {
		return rssDiagnosticsOverview{}, err
	}
	articleStats, err := s.articleStatsBySource(ctx, orgID, sourceIDs, sinceWindow)
	if err != nil {
		return rssDiagnosticsOverview{}, err
	}
	processedCompletedTotal, processedMissingSourceID, err := s.processedCoverage(ctx, orgID, sinceLookback)
	if err != nil {
		return rssDiagnosticsOverview{}, err
	}
	articleTotal, articleMissingSourceID, err := s.articleCoverage(ctx, orgID, sinceLookback)
	if err != nil {
		return rssDiagnosticsOverview{}, err
	}
	pipelineRows, err := s.pipelineStatusCounts(ctx, orgID, sourceIDs, sinceLookback)
	if err != nil {
		return rssDiagnosticsOverview{}, err
	}
	latestJobs, err := s.latestPipelineJobs(ctx, orgID, sourceIDs)
	if err != nil {
		return rssDiagnosticsOverview{}, err
	}
	crawlTaskRows, err := s.crawlTaskStatusCounts(ctx, orgID, sinceLookback)
	if err != nil {
		return rssDiagnosticsOverview{}, err
	}
	latestCrawlTask, err := s.latestCrawlTaskUpdatedAt(ctx, orgID)
	if err != nil {
		return rssDiagnosticsOverview{}, err
	}
	crawlResultTotal, crawlResultMissingMarkdown, err := s.crawlResultCounts(ctx, orgID, sinceLookback)
	if err != nil {
		return rssDiagnosticsOverview{}, err
	}
	latestCrawlResult, err := s.latestCrawlResultFetchedAt(ctx, orgID)
	if err != nil {
		return rssDiagnosticsOverview{}, err
	}

	jobsBySource := map[string]rssSourcePipelineStats{}
	statusTotals := map[string]int{}
	for _, row := range pipelineRows {
		statusTotals[row.Status] += row.Count
		if row.SourceID == "" {
			continue
		}
		current := jobsBySource[row.SourceID]
		switch row.Status {
		case "queued", "pending":
			current.Queued += row.Count
		case "running", "delayed":
			current.Running += row.Count
		case "completed":
			current.Completed += row.Count
		case "failed":
			current.Failed += row.Count
		}
		jobsBySource[row.SourceID] = current
	}

	latestJobBySource := map[string]rssLatestPipelineJob{}
	for _, row := range latestJobs {
		if row.SourceID == "" {
			continue
		}
		if _, ok := latestJobBySource[row.SourceID]; ok {
			continue
		}
		latestJobBySource[row.SourceID] = row
	}

	visibility := computeRSSVisibility(sources, processedStats, articleStats)
	pipelineCounts := pipelineCountsFromStatusTotals(statusTotals)
	crawlTaskCounts := crawlTaskCountsFromRows(crawlTaskRows)
	processedMissingRate := ratio4(float64(processedMissingSourceID), float64(processedCompletedTotal), 0)
	articleMissingRate := ratio4(float64(articleMissingSourceID), float64(articleTotal), 0)

	recommendations := make([]string, 0, 5)
	if !schedulerEnabled {
		recommendations = append(recommendations, "news_source_scheduler_disabled")
	}
	if len(sources) == 0 {
		recommendations = append(recommendations, "no_rss_sources_configured")
	}
	if visibility.VisibleByArticleFallback > 0 {
		recommendations = append(recommendations, "run_source_id_backfill_for_processed_items")
	}
	if processedMissingRate >= 0.1 {
		recommendations = append(recommendations, "high_processed_item_missing_source_id_rate")
	}
	if crawlResultMissingMarkdown > 0 {
		recommendations = append(recommendations, "crawl_results_missing_markdown_ref_detected")
	}

	rows := make([]rssDiagnosticsSourceRow, 0, len(sources))
	for _, source := range sources {
		processed := processedStats[source.ID]
		article := articleStats[source.ID]
		jobs := jobsBySource[source.ID]
		latestJob, hasLatestJob := latestJobBySource[source.ID]

		sourceVisibility := RssSourceVisibilityNone
		switch {
		case processed.ItemCount > 0:
			sourceVisibility = RssSourceVisibilityProcessed
		case article.ItemCount > 0:
			sourceVisibility = RssSourceVisibilityArticleFallback
		}

		issues := make([]string, 0, 4)
		if !source.SeedEnabled {
			issues = append(issues, "seed_disabled")
		}
		if source.FeedURL == nil {
			issues = append(issues, "feed_url_missing")
		}
		if sourceVisibility == RssSourceVisibilityNone {
			issues = append(issues, "no_recent_items")
		} else if sourceVisibility == RssSourceVisibilityArticleFallback {
			issues = append(issues, "processed_source_link_missing")
		}
		if source.ConsecutiveFailures > 0 {
			issues = append(issues, "source_has_failures")
		}

		row := rssDiagnosticsSourceRow{
			SourceID:             source.ID,
			Name:                 source.Name,
			IsActive:             source.IsActive,
			Language:             source.Language,
			SiteURL:              source.SiteURL,
			FeedURL:              source.FeedURL,
			SeedEnabled:          source.SeedEnabled,
			ItemCountByProcessed: processed.ItemCount,
			LatestByProcessed:    isoPointer(processed.LatestItemAt),
			ItemCountByArticle:   article.ItemCount,
			LatestByArticle:      isoPointer(article.LatestItemAt),
			Visibility:           sourceVisibility,
			Jobs24h:              jobs,
			LastFailureAt:        isoPointer(source.LastFailureAt),
			ConsecutiveFailures:  source.ConsecutiveFailures,
			CircuitOpenUntil:     isoPointer(source.CircuitOpenUntil),
			Issues:               issues,
		}
		if hasLatestJob {
			status := latestJob.Status
			row.LastJobStatus = &status
			createdAt := formatJSTime(latestJob.CreatedAt)
			row.LastJobCreatedAt = &createdAt
		}
		rows = append(rows, row)
	}
	sort.SliceStable(rows, func(left, right int) bool {
		if rows[left].ItemCountByProcessed != rows[right].ItemCountByProcessed {
			return rows[left].ItemCountByProcessed > rows[right].ItemCountByProcessed
		}
		if rows[left].ItemCountByArticle != rows[right].ItemCountByArticle {
			return rows[left].ItemCountByArticle > rows[right].ItemCountByArticle
		}
		return rows[left].Name < rows[right].Name
	})

	generatedAt := formatJSTime(now)
	var latestJobCreatedAt *string
	if len(latestJobs) > 0 {
		value := formatJSTime(latestJobs[0].CreatedAt)
		latestJobCreatedAt = &value
	}
	chain := rssDiagnosticsChain{
		GeneratedAt:      generatedAt,
		WindowDays:       windowDays,
		LookbackHours:    lookbackHours,
		SchedulerEnabled: schedulerEnabled,
		Sources: rssSourceCounts{
			RSSTotal:       len(sources),
			RSSActive:      countSources(sources, func(source rssSourceRow) bool { return source.IsActive }),
			SeedEnabled:    countSources(sources, func(source rssSourceRow) bool { return source.SeedEnabled }),
			MissingFeedURL: countSources(sources, func(source rssSourceRow) bool { return source.FeedURL == nil }),
		},
		Visibility: visibility,
		ProcessedCoverage: rssProcessedCoverage{
			CompletedTotal:  processedCompletedTotal,
			MissingSourceID: processedMissingSourceID,
			MissingRate:     processedMissingRate,
		},
		ArticleCoverage: rssArticleCoverage{
			Total:           articleTotal,
			MissingSourceID: articleMissingSourceID,
			MissingRate:     articleMissingRate,
		},
		PipelineJobs: rssPipelineJobCounts{
			Total:           pipelineCounts.Total,
			Queued:          pipelineCounts.Queued,
			Running:         pipelineCounts.Running,
			Completed:       pipelineCounts.Completed,
			Failed:          pipelineCounts.Failed,
			LatestCreatedAt: latestJobCreatedAt,
		},
		CrawlTasks: rssCrawlTaskCounts{
			Total:           crawlTaskCounts.Total,
			Queued:          crawlTaskCounts.Queued,
			Running:         crawlTaskCounts.Running,
			Completed:       crawlTaskCounts.Completed,
			Failed:          crawlTaskCounts.Failed,
			LatestUpdatedAt: isoPointer(latestCrawlTask),
		},
		CrawlResults: rssCrawlResultCounts{
			Total:              crawlResultTotal,
			MissingMarkdownRef: crawlResultMissingMarkdown,
			LatestFetchedAt:    isoPointer(latestCrawlResult),
		},
		Recommendations: recommendations,
	}

	return rssDiagnosticsOverview{
		GeneratedAt: generatedAt,
		Chain:       chain,
		Sources:     rows,
	}, nil
}

// countSources counts rows matching a predicate.
func countSources(sources []rssSourceRow, predicate func(rssSourceRow) bool) int {
	count := 0
	for _, source := range sources {
		if predicate(source) {
			count++
		}
	}
	return count
}

// computeRSSVisibility mirrors the private computeVisibility helper.
func computeRSSVisibility(
	sources []rssSourceRow,
	processedStats, articleStats map[string]rssSourceWindowStats,
) rssVisibility {
	visibleByProcessed := 0
	visibleByArticleFallback := 0
	hiddenSources := 0
	for _, source := range sources {
		processedCount := processedStats[source.ID].ItemCount
		articleCount := articleStats[source.ID].ItemCount
		switch {
		case processedCount > 0:
			visibleByProcessed++
		case articleCount > 0:
			visibleByArticleFallback++
		default:
			hiddenSources++
		}
	}
	return rssVisibility{
		VisibleByProcessed:       visibleByProcessed,
		VisibleByArticleFallback: visibleByArticleFallback,
		HiddenSources:            hiddenSources,
	}
}

// rssPipelineCounts is the four-bucket pipeline job mix.
type rssPipelineCounts struct {
	Total     int
	Queued    int
	Running   int
	Completed int
	Failed    int
}

// pipelineCountsFromStatusTotals mirrors pipelineCountsFromRows.
func pipelineCountsFromStatusTotals(totals map[string]int) rssPipelineCounts {
	queued := totals["queued"] + totals["pending"]
	running := totals["running"] + totals["delayed"]
	completed := totals["completed"]
	failed := totals["failed"]
	return rssPipelineCounts{
		Total:     queued + running + completed + failed,
		Queued:    queued,
		Running:   running,
		Completed: completed,
		Failed:    failed,
	}
}

// crawlTaskCountsFromRows mirrors crawlTaskCountsFromRows.
func crawlTaskCountsFromRows(rows []rssCrawlTaskStatusCount) rssCrawlTaskCounts {
	counts := map[string]int{}
	for _, row := range rows {
		counts[row.Status] += row.Count
	}
	queued := counts["queued"]
	running := counts["running"]
	completed := counts["completed"]
	failed := counts["failed"]
	return rssCrawlTaskCounts{
		Total:     queued + running + completed + failed,
		Queued:    queued,
		Running:   running,
		Completed: completed,
		Failed:    failed,
	}
}

// loadRSSSources mirrors the private loadRssSources helper: every NewsSource row
// of the organization whose config.seed.mode is "rss".
func (s *Service) loadRSSSources(ctx context.Context, orgID string) ([]rssSourceRow, error) {
	if err := s.requireDB(); err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, `
SELECT id, name, isActive, url, language, config, lastFailureAt, consecutiveFailures, circuitOpenUntil
FROM NewsSource
WHERE orgId = ?
ORDER BY priority DESC, updatedAt DESC, createdAt DESC`, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]rssSourceRow, 0, 16)
	for rows.Next() {
		var (
			id                  string
			name                string
			isActive            int
			siteURL             string
			language            sql.NullString
			config              []byte
			lastFailureAt       sql.NullTime
			consecutiveFailures int
			circuitOpenUntil    sql.NullTime
		)
		if err := rows.Scan(&id, &name, &isActive, &siteURL, &language, &config,
			&lastFailureAt, &consecutiveFailures, &circuitOpenUntil); err != nil {
			return nil, err
		}
		seed, ok := parseRSSSeed(config)
		if !ok || seed.Mode != "rss" {
			continue
		}
		trimmedSiteURL := strings.TrimSpace(siteURL)
		var feedURL *string
		if seed.FeedURL != nil && strings.TrimSpace(*seed.FeedURL) != "" {
			value := strings.TrimSpace(*seed.FeedURL)
			feedURL = &value
		} else if trimmedSiteURL != "" {
			value := trimmedSiteURL
			feedURL = &value
		}
		row := rssSourceRow{
			ID:                  id,
			Name:                name,
			IsActive:            isActive != 0,
			SiteURL:             trimmedSiteURL,
			SeedEnabled:         seed.Enabled,
			FeedURL:             feedURL,
			ConsecutiveFailures: maxInt(consecutiveFailures, 0),
		}
		if language.Valid && strings.TrimSpace(language.String) != "" {
			value := language.String
			row.Language = &value
		}
		if lastFailureAt.Valid {
			value := lastFailureAt.Time.UTC()
			row.LastFailureAt = &value
		}
		if circuitOpenUntil.Valid {
			value := circuitOpenUntil.Time.UTC()
			row.CircuitOpenUntil = &value
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

// rssSeed is the parsed NewsSource.config.seed sub-object.
type rssSeed struct {
	Enabled bool
	Mode    string
	FeedURL *string
}

// parseRSSSeed mirrors the private extractSeed helper.
func parseRSSSeed(raw []byte) (rssSeed, bool) {
	if len(raw) == 0 {
		return rssSeed{}, false
	}
	var config rssNewsSourceConfigDocument
	if err := json.Unmarshal(raw, &config); err != nil || config.Seed == nil {
		return rssSeed{}, false
	}
	mode := "sitemap"
	if config.Seed.Mode != nil {
		switch strings.ToLower(strings.TrimSpace(*config.Seed.Mode)) {
		case "rss", "list", "deep":
			mode = strings.ToLower(strings.TrimSpace(*config.Seed.Mode))
		}
	}
	seed := rssSeed{
		Enabled: config.Seed.Enabled != nil && *config.Seed.Enabled,
		Mode:    mode,
	}
	if config.Seed.FeedURL != nil && strings.TrimSpace(*config.Seed.FeedURL) != "" {
		value := strings.TrimSpace(*config.Seed.FeedURL)
		seed.FeedURL = &value
	}
	return seed, true
}

// processedStatsBySource mirrors getProcessedStatsBySource (Mongo aggregation).
func (s *Service) processedStatsBySource(ctx context.Context, orgID string, sourceIDs []string, since time.Time) (map[string]rssSourceWindowStats, error) {
	out := map[string]rssSourceWindowStats{}
	if len(sourceIDs) == 0 {
		return out, nil
	}
	collection, err := s.collection(processedItemsCollection)
	if err != nil {
		return nil, err
	}
	cursor, err := collection.Aggregate(ctx, []bson.D{
		{{Key: "$match", Value: bson.D{
			{Key: "orgId", Value: orgID},
			{Key: "status", Value: pipelineStatusCompleted},
			{Key: "sourceId", Value: bson.D{{Key: "$in", Value: sourceIDs}}},
			{Key: "createdAt", Value: bson.D{{Key: "$gte", Value: since}}},
		}}},
		{{Key: "$group", Value: bson.D{
			{Key: "_id", Value: "$sourceId"},
			{Key: "itemCountWindow", Value: bson.D{{Key: "$sum", Value: 1}}},
			{Key: "latestItemAt", Value: bson.D{{Key: "$max", Value: "$createdAt"}}},
		}}},
	})
	if err != nil {
		return nil, err
	}
	var rows []processedItemCountRow
	if err := cursor.All(ctx, &rows); err != nil {
		return nil, err
	}
	for _, row := range rows {
		sourceID := rawString(row.SourceID)
		if sourceID == nil {
			continue
		}
		count := 0
		if parsed := rawNumber(row.ItemCount); parsed != nil {
			count = maxInt(int(*parsed), 0)
		}
		out[*sourceID] = rssSourceWindowStats{ItemCount: count, LatestItemAt: rawTime(row.LatestItemAt)}
	}
	return out, nil
}

// articleStatsBySource mirrors getArticleStatsBySource (MySQL groupBy).
func (s *Service) articleStatsBySource(ctx context.Context, orgID string, sourceIDs []string, since time.Time) (map[string]rssSourceWindowStats, error) {
	out := map[string]rssSourceWindowStats{}
	if len(sourceIDs) == 0 {
		return out, nil
	}
	payload, err := json.Marshal(sourceIDs)
	if err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, `
SELECT sourceId, COUNT(*) AS itemCount, MAX(crawlAt) AS latestItemAt
FROM Article
WHERE orgId = ? AND crawlAt >= ? AND sourceId IS NOT NULL AND JSON_CONTAINS(?, JSON_QUOTE(sourceId))
GROUP BY sourceId`, orgID, since, string(payload))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var sourceID sql.NullString
		var count int
		var latest sql.NullTime
		if err := rows.Scan(&sourceID, &count, &latest); err != nil {
			return nil, err
		}
		if !sourceID.Valid || strings.TrimSpace(sourceID.String) == "" {
			continue
		}
		entry := rssSourceWindowStats{ItemCount: maxInt(count, 0)}
		if latest.Valid {
			value := latest.Time.UTC()
			entry.LatestItemAt = &value
		}
		out[strings.TrimSpace(sourceID.String)] = entry
	}
	return out, rows.Err()
}

// processedCoverage mirrors the two ProcessedItemModel.countDocuments calls of
// the lookback window: completed total and completed without a sourceId.
func (s *Service) processedCoverage(ctx context.Context, orgID string, since time.Time) (int, int, error) {
	collection, err := s.collection(processedItemsCollection)
	if err != nil {
		return 0, 0, err
	}
	base := bson.D{
		{Key: "orgId", Value: orgID},
		{Key: "status", Value: pipelineStatusCompleted},
		{Key: "createdAt", Value: bson.D{{Key: "$gte", Value: since}}},
	}
	total, err := collection.CountDocuments(ctx, base)
	if err != nil {
		return 0, 0, err
	}
	missing, err := collection.CountDocuments(ctx, append(base, bson.E{
		Key: "$or",
		Value: []bson.D{
			{{Key: "sourceId", Value: nil}},
			{{Key: "sourceId", Value: ""}},
			{{Key: "sourceId", Value: bson.D{{Key: "$exists", Value: false}}}},
		},
	}))
	if err != nil {
		return 0, 0, err
	}
	return int(total), int(missing), nil
}

// articleCoverage mirrors the two article.count calls of the lookback window.
func (s *Service) articleCoverage(ctx context.Context, orgID string, since time.Time) (int, int, error) {
	var total int
	if err := s.db.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM Article WHERE orgId = ? AND crawlAt >= ?", orgID, since).Scan(&total); err != nil {
		return 0, 0, err
	}
	var missing int
	if err := s.db.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM Article WHERE orgId = ? AND crawlAt >= ? AND sourceId IS NULL", orgID, since).Scan(&missing); err != nil {
		return 0, 0, err
	}
	return total, missing, nil
}

// pipelineStatusCounts mirrors the pipelineJob.groupBy call for the RSS sources.
func (s *Service) pipelineStatusCounts(ctx context.Context, orgID string, sourceIDs []string, since time.Time) ([]rssPipelineStatusCount, error) {
	if len(sourceIDs) == 0 {
		return []rssPipelineStatusCount{}, nil
	}
	payload, err := json.Marshal(sourceIDs)
	if err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, `
SELECT sourceId, status, COUNT(*) AS itemCount
FROM PipelineJob
WHERE orgId = ? AND createdAt >= ? AND sourceId IS NOT NULL AND JSON_CONTAINS(?, JSON_QUOTE(sourceId))
GROUP BY sourceId, status`, orgID, since, string(payload))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]rssPipelineStatusCount, 0, 32)
	for rows.Next() {
		var sourceID, status string
		var count int
		if err := rows.Scan(&sourceID, &status, &count); err != nil {
			return nil, err
		}
		out = append(out, rssPipelineStatusCount{
			SourceID: strings.TrimSpace(sourceID),
			Status:   status,
			Count:    maxInt(count, 0),
		})
	}
	return out, rows.Err()
}

// latestPipelineJobs mirrors the pipelineJob.findMany call: the newest rows per
// source, ordered by createdAt desc and bounded like the NestJS take.
func (s *Service) latestPipelineJobs(ctx context.Context, orgID string, sourceIDs []string) ([]rssLatestPipelineJob, error) {
	if len(sourceIDs) == 0 {
		return []rssLatestPipelineJob{}, nil
	}
	payload, err := json.Marshal(sourceIDs)
	if err != nil {
		return nil, err
	}
	limit := maxInt(200, len(sourceIDs)*3)
	rows, err := s.db.QueryContext(ctx, `
SELECT sourceId, status, createdAt
FROM PipelineJob
WHERE orgId = ? AND sourceId IS NOT NULL AND JSON_CONTAINS(?, JSON_QUOTE(sourceId))
ORDER BY createdAt DESC
LIMIT ?`, orgID, string(payload), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]rssLatestPipelineJob, 0, len(sourceIDs))
	for rows.Next() {
		var sourceID, status string
		var createdAt sql.NullTime
		if err := rows.Scan(&sourceID, &status, &createdAt); err != nil {
			return nil, err
		}
		if !createdAt.Valid {
			continue
		}
		out = append(out, rssLatestPipelineJob{
			SourceID:  strings.TrimSpace(sourceID),
			Status:    status,
			CreatedAt: createdAt.Time.UTC(),
		})
	}
	return out, rows.Err()
}

// crawlTaskStatusCounts mirrors the crawlTask.groupBy call.
func (s *Service) crawlTaskStatusCounts(ctx context.Context, orgID string, since time.Time) ([]rssCrawlTaskStatusCount, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT status, COUNT(*) AS itemCount
FROM CrawlTask
WHERE orgId = ? AND displayName LIKE ? AND updatedAt >= ?
GROUP BY status`, orgID, rssSchedulerDisplayName+"%", since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]rssCrawlTaskStatusCount, 0, 8)
	for rows.Next() {
		var status string
		var count int
		if err := rows.Scan(&status, &count); err != nil {
			return nil, err
		}
		out = append(out, rssCrawlTaskStatusCount{Status: status, Count: maxInt(count, 0)})
	}
	return out, rows.Err()
}

// latestCrawlTaskUpdatedAt mirrors the crawlTask.findFirst call.
func (s *Service) latestCrawlTaskUpdatedAt(ctx context.Context, orgID string) (*time.Time, error) {
	var updatedAt sql.NullTime
	err := s.db.QueryRowContext(ctx, `
SELECT updatedAt FROM CrawlTask
WHERE orgId = ? AND displayName LIKE ?
ORDER BY updatedAt DESC
LIMIT 1`, orgID, rssSchedulerDisplayName+"%").Scan(&updatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if !updatedAt.Valid {
		return nil, nil
	}
	value := updatedAt.Time.UTC()
	return &value, nil
}

// crawlResultCounts mirrors the two crawlResult.count calls.
func (s *Service) crawlResultCounts(ctx context.Context, orgID string, since time.Time) (int, int, error) {
	var total int
	if err := s.db.QueryRowContext(ctx, `
SELECT COUNT(*)
FROM CrawlResult cr
JOIN CrawlTask ct ON ct.id = cr.taskId
WHERE ct.orgId = ? AND ct.displayName LIKE ? AND cr.fetchedAt >= ?`,
		orgID, rssSchedulerDisplayName+"%", since).Scan(&total); err != nil {
		return 0, 0, err
	}
	var missing int
	if err := s.db.QueryRowContext(ctx, `
SELECT COUNT(*)
FROM CrawlResult cr
JOIN CrawlTask ct ON ct.id = cr.taskId
WHERE ct.orgId = ? AND ct.displayName LIKE ? AND cr.fetchedAt >= ? AND cr.markdownRef = ''`,
		orgID, rssSchedulerDisplayName+"%", since).Scan(&missing); err != nil {
		return 0, 0, err
	}
	return total, missing, nil
}

// latestCrawlResultFetchedAt mirrors the crawlResult.findFirst call.
func (s *Service) latestCrawlResultFetchedAt(ctx context.Context, orgID string) (*time.Time, error) {
	var fetchedAt sql.NullTime
	err := s.db.QueryRowContext(ctx, `
SELECT cr.fetchedAt
FROM CrawlResult cr
JOIN CrawlTask ct ON ct.id = cr.taskId
WHERE ct.orgId = ? AND ct.displayName LIKE ?
ORDER BY cr.fetchedAt DESC
LIMIT 1`, orgID, rssSchedulerDisplayName+"%").Scan(&fetchedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if !fetchedAt.Valid {
		return nil, nil
	}
	value := fetchedAt.Time.UTC()
	return &value, nil
}

// BackfillSourceID mirrors backfillProcessedItemSourceId. dryRun defaults to
// true, limit is clamped to 1..5000 and only an explicit dryRun=false writes.
func (s *Service) BackfillSourceID(ctx context.Context, request rssBackfillRequest) (rssSourceIDBackfillResponse, error) {
	dryRun := true
	if request.DryRun != nil {
		dryRun = *request.DryRun
	}
	limit := rssDefaultBackfillLimit
	if request.Limit != nil {
		limit = clampIntRange(*request.Limit, 1, rssMaxBackfillLimit)
	}

	processed, err := s.collection(processedItemsCollection)
	if err != nil {
		return rssSourceIDBackfillResponse{}, err
	}
	cursor, err := processed.Find(ctx, bson.D{
		{Key: "orgId", Value: request.OrgID},
		{Key: "status", Value: pipelineStatusCompleted},
		{Key: "$or", Value: []bson.D{
			{{Key: "sourceId", Value: nil}},
			{{Key: "sourceId", Value: ""}},
			{{Key: "sourceId", Value: bson.D{{Key: "$exists", Value: false}}}},
		}},
	}, options.Find().
		SetProjection(bson.D{
			{Key: "_id", Value: 1},
			{Key: "rawItemId", Value: 1},
			{Key: "itemMetaId", Value: 1},
			{Key: "pipelineJobId", Value: 1},
		}).
		SetSort(bson.D{{Key: "createdAt", Value: -1}}).
		SetLimit(int64(limit)))
	if err != nil {
		return rssSourceIDBackfillResponse{}, err
	}
	var rows []processedItemDocument
	if err := cursor.All(ctx, &rows); err != nil {
		return rssSourceIDBackfillResponse{}, err
	}

	candidates := make([]rssBackfillCandidate, 0, len(rows))
	for _, row := range rows {
		processedItemID := rawIDString(row.ID)
		rawItemID := rawIDString(row.RawItemID)
		itemMetaID := rawString(row.ItemMetaID)
		if processedItemID == "" || rawItemID == "" || itemMetaID == nil {
			continue
		}
		if !validObjectID(processedItemID) || !validObjectID(rawItemID) {
			continue
		}
		candidates = append(candidates, rssBackfillCandidate{
			ProcessedItemID: processedItemID,
			RawItemID:       rawItemID,
			ItemMetaID:      *itemMetaID,
			PipelineJobID:   rawString(row.PipelineJobID),
		})
	}
	if len(candidates) == 0 {
		return rssSourceIDBackfillResponse{
			DryRun:            dryRun,
			Limit:             limit,
			Scanned:           0,
			Matched:           0,
			Updated:           0,
			Unresolved:        0,
			UnresolvedSamples: []rssBackfillUnresolvedSample{},
		}, nil
	}

	rawObjectIDs := make([]bson.ObjectID, 0, len(candidates))
	seenRawIDs := make(map[string]bool, len(candidates))
	for _, candidate := range candidates {
		if seenRawIDs[candidate.RawItemID] {
			continue
		}
		seenRawIDs[candidate.RawItemID] = true
		objectID, err := bson.ObjectIDFromHex(candidate.RawItemID)
		if err != nil {
			continue
		}
		rawObjectIDs = append(rawObjectIDs, objectID)
	}
	rawItems, err := s.collection(rawItemsCollection)
	if err != nil {
		return rssSourceIDBackfillResponse{}, err
	}
	rawCursor, err := rawItems.Find(ctx,
		bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: rawObjectIDs}}}},
		options.Find().SetProjection(bson.D{{Key: "payload", Value: 1}}))
	if err != nil {
		return rssSourceIDBackfillResponse{}, err
	}
	var rawDocuments []rawItemDocument
	if err := rawCursor.All(ctx, &rawDocuments); err != nil {
		return rssSourceIDBackfillResponse{}, err
	}
	type rawMetadata struct {
		sourceID      *string
		pipelineJobID *string
		crawlResultID *string
	}
	rawByID := make(map[string]rawMetadata, len(rawDocuments))
	for _, document := range rawDocuments {
		id := rawIDString(document.ID)
		if id == "" {
			continue
		}
		rawByID[id] = rawMetadata{
			sourceID:      rawString(document.Payload.Metadata.SourceID),
			pipelineJobID: rawString(document.Payload.Metadata.PipelineJobID),
			crawlResultID: rawString(document.Payload.Metadata.CrawlResultID),
		}
	}

	itemMetaIDs := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		itemMetaIDs = append(itemMetaIDs, candidate.ItemMetaID)
	}
	fallbackCrawlResultByItemMeta, err := s.crawlResultIDsFromItemMeta(ctx, request.OrgID, itemMetaIDs)
	if err != nil {
		return rssSourceIDBackfillResponse{}, err
	}

	// Multi-hop assignment: pipeline job -> raw metadata sourceId -> raw
	// metadata pipelineJobId -> raw metadata crawlResultId -> ItemMeta.externalId
	// crawl-result prefix. Each hop stays independent so the resolution order in
	// the loop below can pick the first value that resolves.
	for index := range candidates {
		candidate := &candidates[index]
		if raw, ok := rawByID[candidate.RawItemID]; ok {
			candidate.RawSourceID = raw.sourceID
			candidate.RawPipelineJobID = raw.pipelineJobID
			if raw.crawlResultID != nil {
				candidate.CrawlResultID = raw.crawlResultID
			} else if fallback, ok := fallbackCrawlResultByItemMeta[candidate.ItemMetaID]; ok {
				candidate.FallbackCrawlResultID = fallback
			}
		} else if fallback, ok := fallbackCrawlResultByItemMeta[candidate.ItemMetaID]; ok {
			candidate.FallbackCrawlResultID = fallback
		}
	}

	pipelineJobIDs := make([]string, 0, len(candidates)*2)
	for _, candidate := range candidates {
		if candidate.PipelineJobID != nil {
			pipelineJobIDs = append(pipelineJobIDs, *candidate.PipelineJobID)
		}
		if candidate.RawPipelineJobID != nil {
			pipelineJobIDs = append(pipelineJobIDs, *candidate.RawPipelineJobID)
		}
	}
	sourceIDByPipelineJobID, err := s.sourceIDsByPipelineJob(ctx, request.OrgID, pipelineJobIDs)
	if err != nil {
		return rssSourceIDBackfillResponse{}, err
	}

	crawlResultIDs := make([]string, 0, len(candidates)*2)
	for _, candidate := range candidates {
		if candidate.CrawlResultID != nil {
			crawlResultIDs = append(crawlResultIDs, *candidate.CrawlResultID)
		}
		if candidate.FallbackCrawlResultID != nil {
			crawlResultIDs = append(crawlResultIDs, *candidate.FallbackCrawlResultID)
		}
	}
	sourceIDByCrawlResultID, err := s.sourceIDsByCrawlResult(ctx, request.OrgID, crawlResultIDs)
	if err != nil {
		return rssSourceIDBackfillResponse{}, err
	}

	candidateSourceIDs := make([]string, 0, len(candidates)*4)
	for _, candidate := range candidates {
		candidateSourceIDs = append(candidateSourceIDs,
			lookupSourceCandidates(candidate, sourceIDByPipelineJobID, sourceIDByCrawlResultID)...)
	}
	validSourceIDs, err := s.validNewsSourceIDs(ctx, request.OrgID, candidateSourceIDs)
	if err != nil {
		return rssSourceIDBackfillResponse{}, err
	}

	unresolvedSamples := make([]rssBackfillUnresolvedSample, 0, unresolvedBackfillSamples)
	models := make([]mongo.WriteModel, 0, len(candidates))
	for _, candidate := range candidates {
		resolved := resolveBackfillSourceID(candidate, sourceIDByPipelineJobID, sourceIDByCrawlResultID)
		if resolved == nil {
			if len(unresolvedSamples) < unresolvedBackfillSamples {
				unresolvedSamples = append(unresolvedSamples, rssBackfillUnresolvedSample{
					ProcessedItemID: candidate.ProcessedItemID,
					ItemMetaID:      candidate.ItemMetaID,
					Reason:          "source_not_resolved",
				})
			}
			continue
		}
		if !validSourceIDs[*resolved] {
			if len(unresolvedSamples) < unresolvedBackfillSamples {
				unresolvedSamples = append(unresolvedSamples, rssBackfillUnresolvedSample{
					ProcessedItemID: candidate.ProcessedItemID,
					ItemMetaID:      candidate.ItemMetaID,
					Reason:          "resolved_source_not_in_org",
				})
			}
			continue
		}

		objectID, err := bson.ObjectIDFromHex(candidate.ProcessedItemID)
		if err != nil {
			continue
		}
		set := bson.D{
			{Key: "sourceId", Value: *resolved},
			{Key: "updatedAt", Value: nowMillis()},
		}
		if pipelineJobID := firstNonEmpty(trimmedPointer(candidate.PipelineJobID), trimmedPointer(candidate.RawPipelineJobID)); pipelineJobID != nil {
			set = append(set, bson.E{Key: "pipelineJobId", Value: *pipelineJobID})
		}
		models = append(models, mongo.NewUpdateOneModel().
			SetFilter(bson.D{
				{Key: "_id", Value: objectID},
				{Key: "orgId", Value: request.OrgID},
				{Key: "$or", Value: []bson.D{
					{{Key: "sourceId", Value: nil}},
					{{Key: "sourceId", Value: ""}},
					{{Key: "sourceId", Value: bson.D{{Key: "$exists", Value: false}}}},
				}},
			}).
			SetUpdate(bson.D{{Key: "$set", Value: set}}))
	}

	updated := 0
	if !dryRun && len(models) > 0 {
		result, err := processed.BulkWrite(ctx, models)
		if err != nil {
			log.Printf("classification rss ops: failed to backfill sourceId org=%s: %v", request.OrgID, err)
			return rssSourceIDBackfillResponse{}, err
		}
		updated = int(result.ModifiedCount)
		if _, err := s.store.invalidateSnapshots(ctx, request.OrgID, rssDiagnosticsSnapshotScope); err != nil {
			log.Printf("classification rss ops: failed to invalidate rss snapshots org=%s: %v", request.OrgID, err)
		}
	}

	matched := len(models)
	if dryRun {
		updated = 0
	}
	return rssSourceIDBackfillResponse{
		DryRun:            dryRun,
		Limit:             limit,
		Scanned:           len(candidates),
		Matched:           matched,
		Updated:           updated,
		Unresolved:        maxInt(0, len(candidates)-matched),
		UnresolvedSamples: unresolvedSamples,
	}, nil
}

// resolveBackfillSourceID implements the multi-hop resolution order of the
// NestJS service: PipelineJob.sourceId -> RawItem.payload.metadata.sourceId ->
// RawItem.payload.metadata.pipelineJobId -> RawItem.payload.metadata.crawlResultId
// -> ItemMeta.externalId (crawlResult:/crawl: prefix) resolved through the owning
// CrawlTask.config. The first hop that yields a non-blank value wins.
func resolveBackfillSourceID(
	candidate rssBackfillCandidate,
	sourceIDByPipelineJobID map[string]string,
	sourceIDByCrawlResultID map[string]string,
) *string {
	return firstNonEmpty(
		trimmedPointer(lookupString(sourceIDByPipelineJobID, candidate.PipelineJobID)),
		trimmedPointer(candidate.RawSourceID),
		trimmedPointer(lookupString(sourceIDByPipelineJobID, candidate.RawPipelineJobID)),
		trimmedPointer(lookupString(sourceIDByCrawlResultID, candidate.CrawlResultID)),
		trimmedPointer(lookupString(sourceIDByCrawlResultID, candidate.FallbackCrawlResultID)),
	)
}

// lookupSourceCandidates collects every hop value of one candidate.
func lookupSourceCandidates(
	candidate rssBackfillCandidate,
	sourceIDByPipelineJobID map[string]string,
	sourceIDByCrawlResultID map[string]string,
) []string {
	out := make([]string, 0, 5)
	if candidate.RawSourceID != nil {
		out = append(out, *candidate.RawSourceID)
	}
	if value := lookupString(sourceIDByPipelineJobID, candidate.PipelineJobID); value != nil {
		out = append(out, *value)
	}
	if value := lookupString(sourceIDByPipelineJobID, candidate.RawPipelineJobID); value != nil {
		out = append(out, *value)
	}
	if value := lookupString(sourceIDByCrawlResultID, candidate.CrawlResultID); value != nil {
		out = append(out, *value)
	}
	if value := lookupString(sourceIDByCrawlResultID, candidate.FallbackCrawlResultID); value != nil {
		out = append(out, *value)
	}
	return out
}

// crawlResultIDsFromItemMeta mirrors the ItemMeta externalId hop: the stored
// externalId may start with "crawlResult:" or "crawl:".
func (s *Service) crawlResultIDsFromItemMeta(ctx context.Context, orgID string, itemMetaIDs []string) (map[string]*string, error) {
	out := map[string]*string{}
	normalized := normalizeIDList(itemMetaIDs, 5000)
	if len(normalized) == 0 {
		return out, nil
	}
	payload, err := json.Marshal(normalized)
	if err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx,
		"SELECT id, externalId FROM ItemMeta WHERE orgId = ? AND JSON_CONTAINS(?, JSON_QUOTE(id))",
		orgID, string(payload))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var externalID sql.NullString
		if err := rows.Scan(&id, &externalID); err != nil {
			return nil, err
		}
		if !externalID.Valid {
			continue
		}
		if crawlResultID := crawlResultIDFromExternalID(externalID.String); crawlResultID != nil {
			out[id] = crawlResultID
		}
	}
	return out, rows.Err()
}

// crawlResultIDFromExternalID mirrors the private extractCrawlResultIdFromExternalId.
func crawlResultIDFromExternalID(externalID string) *string {
	raw := strings.TrimSpace(externalID)
	if raw == "" {
		return nil
	}
	for _, prefix := range []string{"crawlResult:", "crawl:"} {
		if strings.HasPrefix(raw, prefix) {
			candidate := strings.TrimSpace(raw[len(prefix):])
			if candidate != "" {
				return &candidate
			}
		}
	}
	return nil
}

// sourceIDsByPipelineJob mirrors the pipelineJob.findMany hop.
func (s *Service) sourceIDsByPipelineJob(ctx context.Context, orgID string, pipelineJobIDs []string) (map[string]string, error) {
	out := map[string]string{}
	normalized := normalizeIDList(pipelineJobIDs, 5000)
	if len(normalized) == 0 {
		return out, nil
	}
	payload, err := json.Marshal(normalized)
	if err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx,
		"SELECT id, sourceId FROM PipelineJob WHERE orgId = ? AND JSON_CONTAINS(?, JSON_QUOTE(id))",
		orgID, string(payload))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var sourceID sql.NullString
		if err := rows.Scan(&id, &sourceID); err != nil {
			return nil, err
		}
		if !sourceID.Valid || strings.TrimSpace(sourceID.String) == "" {
			continue
		}
		out[id] = strings.TrimSpace(sourceID.String)
	}
	return out, rows.Err()
}

// sourceIDsByCrawlResult mirrors the crawlResult.findMany hop, parsing the
// owning CrawlTask.config for the sourceId.
func (s *Service) sourceIDsByCrawlResult(ctx context.Context, orgID string, crawlResultIDs []string) (map[string]string, error) {
	out := map[string]string{}
	normalized := normalizeIDList(crawlResultIDs, 5000)
	if len(normalized) == 0 {
		return out, nil
	}
	payload, err := json.Marshal(normalized)
	if err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, `
SELECT cr.id, ct.config
FROM CrawlResult cr
JOIN CrawlTask ct ON ct.id = cr.taskId
WHERE ct.orgId = ? AND JSON_CONTAINS(?, JSON_QUOTE(cr.id))`,
		orgID, string(payload))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var config []byte
		if err := rows.Scan(&id, &config); err != nil {
			return nil, err
		}
		if sourceID := sourceIDFromTaskConfig(config); sourceID != nil {
			out[id] = *sourceID
		}
	}
	return out, rows.Err()
}

// sourceIDFromTaskConfig mirrors the private extractSourceIdFromTaskConfig.
func sourceIDFromTaskConfig(raw []byte) *string {
	if len(raw) == 0 {
		return nil
	}
	var config crawlTaskConfigDocument
	if err := json.Unmarshal(raw, &config); err != nil {
		return nil
	}
	if config.SourceID != nil && strings.TrimSpace(*config.SourceID) != "" {
		value := strings.TrimSpace(*config.SourceID)
		return &value
	}
	if config.ItemPayload != nil && config.ItemPayload.Metadata != nil &&
		config.ItemPayload.Metadata.SourceID != nil && strings.TrimSpace(*config.ItemPayload.Metadata.SourceID) != "" {
		value := strings.TrimSpace(*config.ItemPayload.Metadata.SourceID)
		return &value
	}
	return nil
}

// validNewsSourceIDs mirrors the newsSource.findMany validation set.
func (s *Service) validNewsSourceIDs(ctx context.Context, orgID string, sourceIDs []string) (map[string]bool, error) {
	out := map[string]bool{}
	normalized := normalizeIDList(sourceIDs, 5000)
	if len(normalized) == 0 {
		return out, nil
	}
	payload, err := json.Marshal(normalized)
	if err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx,
		"SELECT id FROM NewsSource WHERE orgId = ? AND JSON_CONTAINS(?, JSON_QUOTE(id))",
		orgID, string(payload))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out[id] = true
	}
	return out, rows.Err()
}

// lookupString resolves an optional key in a string map.
func lookupString(values map[string]string, key *string) *string {
	if key == nil {
		return nil
	}
	value, ok := values[*key]
	if !ok {
		return nil
	}
	return &value
}

// trimmedPointer returns nil for a missing or blank value.
func trimmedPointer(value *string) *string {
	if value == nil {
		return nil
	}
	trimmed := strings.TrimSpace(*value)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

// firstNonEmpty returns the first non-nil, non-blank candidate.
func firstNonEmpty(values ...*string) *string {
	for _, value := range values {
		if trimmed := trimmedPointer(value); trimmed != nil {
			return trimmed
		}
	}
	return nil
}
