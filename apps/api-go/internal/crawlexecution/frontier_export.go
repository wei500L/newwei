package crawlexecution

// frontier_export.go exports the CrawlResult/CrawlResultContent write path the
// Frontier node chain (internal/crawlfrontiernode) needs.
//
// The Frontier node chain persists its crawl results through the same
// CrawlResultService.persistResults the task runner uses, but with three
// differences the NestJS call site has:
//
//   - the task is loaded by primary key only (processQueuedNode does
//     crawlTask.findUnique({where:{id}}) and validates orgId itself), so
//     LoadFrontierCrawlTask must not filter by orgId;
//   - ingestToItems is undefined, so no CrawlResult -> items ingest runs;
//   - the memory argument is undefined, so the returned CrawlExecutionSummary
//     carries no memory block.
//
// Nothing here changes the existing RunTask behaviour: the new entry points
// only call the existing privates.

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/crawl4ai"
	"github.com/wei500L/newwei/apps/api-go/internal/crawloptions"
)

// FrontierCrawlTask is the CrawlTask row the Frontier node chain reads. Field
// names mirror the Prisma model so the chain can reason about them directly.
type FrontierCrawlTask struct {
	ID                   string
	OrgID                string
	NewsSourceID         *string
	CreatedByID          string
	TargetURL            string
	DisplayName          *string
	Status               string
	Config               json.RawMessage
	Keywords             json.RawMessage
	LastResultAt         *time.Time
	LastCursor           *string
	LastServerMemoryMB   *float64
	LastPeakMemoryMB     *float64
	LastMemoryEfficiency *float64
}

func (t *FrontierCrawlTask) row() *taskRow {
	if t == nil {
		return nil
	}
	return &taskRow{
		ID:                   t.ID,
		OrgID:                t.OrgID,
		NewsSourceID:         t.NewsSourceID,
		CreatedByID:          t.CreatedByID,
		TargetURL:            t.TargetURL,
		DisplayName:          t.DisplayName,
		Status:               t.Status,
		Config:               t.Config,
		Keywords:             t.Keywords,
		LastResultAt:         t.LastResultAt,
		LastCursor:           t.LastCursor,
		LastServerMemoryMB:   t.LastServerMemoryMB,
		LastPeakMemoryMB:     t.LastPeakMemoryMB,
		LastMemoryEfficiency: t.LastMemoryEfficiency,
	}
}

// LoadFrontierCrawlTask is crawlTask.findUnique({where:{id}}): no orgId filter,
// because the caller compares task.orgId with the job orgId itself.
func (s *Service) LoadFrontierCrawlTask(ctx context.Context, taskID string) (*FrontierCrawlTask, error) {
	if s.db == nil {
		return nil, errNotConfigured("crawlexecution: mysql is not configured")
	}
	row := s.db.QueryRowContext(ctx,
		"SELECT `id`, `orgId`, `newsSourceId`, `createdById`, `targetUrl`, `displayName`, `status`, `config`, `keywords`, "+
			"`lastResultAt`, `lastCursor`, `lastServerMemoryMB`, `lastPeakMemoryMb`, `lastMemoryEfficiency` "+
			"FROM `CrawlTask` WHERE `id` = ? LIMIT 1",
		taskID)
	var record FrontierCrawlTask
	var newsSourceID, displayName, config, keywords sql.NullString
	var lastResultAt, lastCursor sql.NullString
	var serverMemory, peakMemory, memoryEfficiency sql.NullFloat64
	err := row.Scan(
		&record.ID, &record.OrgID, &newsSourceID, &record.CreatedByID, &record.TargetURL,
		&displayName, &record.Status, &config, &keywords,
		&lastResultAt, &lastCursor, &serverMemory, &peakMemory, &memoryEfficiency,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("crawlexecution: load crawl task: %w", err)
	}
	if newsSourceID.Valid {
		value := newsSourceID.String
		record.NewsSourceID = &value
	}
	if displayName.Valid {
		value := displayName.String
		record.DisplayName = &value
	}
	if config.Valid {
		record.Config = json.RawMessage(config.String)
	}
	if keywords.Valid {
		record.Keywords = json.RawMessage(keywords.String)
	}
	if lastResultAt.Valid {
		if parsed, parseErr := parseMySQLDateTime(lastResultAt.String); parseErr == nil {
			record.LastResultAt = &parsed
		}
	}
	if lastCursor.Valid {
		value := lastCursor.String
		record.LastCursor = &value
	}
	if serverMemory.Valid {
		value := serverMemory.Float64
		record.LastServerMemoryMB = &value
	}
	if peakMemory.Valid {
		value := peakMemory.Float64
		record.LastPeakMemoryMB = &value
	}
	if memoryEfficiency.Valid {
		value := memoryEfficiency.Float64
		record.LastMemoryEfficiency = &value
	}
	return &record, nil
}

// PersistFrontierResults is
// CrawlResultService.persistResults(task, enrichedResults, crawlOptions, runId)
// as called by persistFrontierResponse: no memory argument and no
// ingestToItems argument.
//
// The returned Summary is exactly what the NestJS call returns, including the
// equivalent of `memory: undefined` (callers omit the memory block).
func (s *Service) PersistFrontierResults(
	ctx context.Context,
	task *FrontierCrawlTask,
	items []crawl4ai.PipelineArticle,
	options crawloptions.Options,
	runID string,
	orgID string,
) (Summary, error) {
	row := task.row()
	if row == nil {
		return Summary{}, errNotConfigured("crawlexecution: crawl task is required")
	}
	summary, _, err := s.persistResults(ctx, row, items, options, crawl4ai.PipelineResponse{RunID: runID}, false, orgID)
	if err != nil {
		return Summary{}, err
	}
	return summary, nil
}
