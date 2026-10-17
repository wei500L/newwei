package crawlreadtelemetry

import (
	"context"
	"database/sql"
)

// This file holds the thin exported wrappers the GraphQL read package reuses so
// the crawl read logic lives exactly once. The REST endpoints keep using the
// unexported functions below; nothing in the REST path changes.

// CrawlTaskViewSelectSQL is the standard CrawlTask column projection shared by
// the REST endpoints and the GraphQL reader. Its column order is exactly the
// order scanCrawlTaskRow expects, so a query built from it can be handed to
// ScanCrawlTaskViews. Append the WHERE, ORDER BY and LIMIT clauses.
const CrawlTaskViewSelectSQL = `SELECT t.id, t.targetUrl, t.displayName, t.status, t.keywords, t.concurrency,
       t.timeRangeFrom, t.timeRangeTo, t.lastRunAt, t.lastSuccessAt, t.lastResultAt,
       t.lastCursor, t.lastError, t.runCount, t.createdAt, t.updatedAt, t.config,
       t.lastServerMemoryMb, t.lastPeakMemoryMb, t.lastMemoryEfficiency,
       (SELECT COUNT(*) FROM CrawlResult r WHERE r.taskId = t.id) AS resultCount
FROM CrawlTask t`

// ScanCrawlTaskViews consumes the rows of a query built on CrawlTaskViewSelectSQL
// and returns the toView projection of every row, reusing the same scanner and
// projection as the REST list endpoint. It iterates but does not close rows, so
// the caller keeps the usual `defer rows.Close()`.
func ScanCrawlTaskViews(rows *sql.Rows) ([]CrawlTaskView, error) {
	views := make([]CrawlTaskView, 0)
	for rows.Next() {
		row, err := scanCrawlTaskRow(rows)
		if err != nil {
			return nil, err
		}
		views = append(views, crawlTaskViewFromRow(row))
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return views, nil
}

// CrawlTaskDetailForGraphQL returns the GraphQL-facing task detail (task view,
// results with Mongo content/asset enrichment, item status metadata, memory
// stats and latest run summary) for one org-scoped task. It reuses the same
// SQL and enrichment path as the REST GET /api/crawl-tasks/:id handler.
//
// resultSearch follows the GraphQL argument: an empty string is treated as an
// absent filter, matching the NestJS truthiness check. resultLimit is passed
// through unchanged, because the GraphQL caller applies clampResultLimit.
func (s *Service) CrawlTaskDetailForGraphQL(
	ctx context.Context,
	orgID, userID, taskID string,
	resultLimit int,
	resultSearch string,
) (CrawlTaskDetailResponse, error) {
	filters := crawlTaskDetailFilters{ResultLimit: resultLimit}
	if resultSearch != "" {
		search := resultSearch
		filters.ResultSearch = &search
	}
	return s.getCrawlTask(ctx, orgID, userID, taskID, filters)
}
