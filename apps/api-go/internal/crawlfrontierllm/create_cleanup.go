package crawlfrontierllm

import (
	"context"
	"log"
)

// createdRunRows remembers the ids createRunFromProfile wrote, so the B3 cleanup
// can remove exactly those rows when the call fails. The synthetic CrawlTask id
// is the important one: it is the row that a later manual crawl-task retry could
// execute as an ordinary crawl.
type createdRunRows struct {
	taskID        string
	runID         string
	workflowRunID string
}

// discardCreatedRunRows deletes the rows of an abandoned run creation in
// foreign-key order. Cleanup is best effort and deliberately detached from the
// caller's cancellation, because cancellation is one of the failure modes that
// needs it; a leftover row is the pre-fix behaviour, so a cleanup failure is
// logged rather than replacing the original error.
func (s *Service) discardCreatedRunRows(ctx context.Context, rows createdRunRows) {
	if s.db == nil {
		return
	}
	cleanupCtx := context.WithoutCancel(ctx)
	if rows.runID != "" {
		if _, err := s.db.ExecContext(cleanupCtx,
			"DELETE FROM CrawlFrontierNode WHERE runId = ?", rows.runID); err != nil {
			log.Printf("crawlfrontierllm: discard frontier nodes of run %s: %v", rows.runID, err)
		}
		if _, err := s.db.ExecContext(cleanupCtx,
			"DELETE FROM CrawlFrontierRun WHERE id = ?", rows.runID); err != nil {
			log.Printf("crawlfrontierllm: discard frontier run %s: %v", rows.runID, err)
		}
	}
	if rows.workflowRunID != "" {
		if _, err := s.db.ExecContext(cleanupCtx,
			"DELETE FROM CrawlStrategyWorkflowRun WHERE id = ?", rows.workflowRunID); err != nil {
			log.Printf("crawlfrontierllm: discard workflow run %s: %v", rows.workflowRunID, err)
		}
	}
	if rows.taskID != "" {
		if _, err := s.db.ExecContext(cleanupCtx,
			"DELETE FROM CrawlTask WHERE id = ?", rows.taskID); err != nil {
			log.Printf("crawlfrontierllm: discard synthetic crawl task %s: %v", rows.taskID, err)
		}
	}
}
