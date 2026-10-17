package crawlfrontierruns

import (
	"context"
	"database/sql"
	"encoding/json"
	"strings"
	"time"
)

// canceledEventDetails is the details payload of the frontier_run_canceled
// workflow event.
type canceledEventDetails struct {
	FrontierRunID string `json:"frontierRunId"`
}

// lockedRun is one row locked by the cancellation transaction.
type lockedRun struct {
	ID            string
	WorkflowRunID sql.NullString
}

// CancelRun mirrors the fixed cancelRun: the run exists and belongs to the
// caller's organization (otherwise 404), then cancelRunRecords runs, and the
// request returns the full run detail regardless of whether a state transition
// happened. Cancelling a terminal run is an idempotent no-op.
func (s *Service) CancelRun(ctx context.Context, orgID, id string) (runDetail, error) {
	fields, err := s.loadRunFields(ctx, id)
	if err != nil {
		return runDetail{}, err
	}
	if fields.OrgID != orgID {
		return runDetail{}, errRunMissing
	}
	if _, err := s.cancelRunRecords(ctx, orgID, []string{id}); err != nil {
		return runDetail{}, err
	}
	return s.GetRun(ctx, orgID, id)
}

// CancelRuns mirrors the fixed cancelRuns: trim, drop empty entries,
// deduplicate while preserving first-occurrence order, then run the same
// protocol. canceledIds only contains ids that actually changed state, in
// ascending id order.
func (s *Service) CancelRuns(ctx context.Context, orgID string, ids []string) (bulkCancelResult, error) {
	uniqueIDs := normalizeCancelIDs(ids)
	if len(uniqueIDs) == 0 {
		return bulkCancelResult{}, &inputError{Message: "ids must contain at least one run id"}
	}
	canceled, err := s.cancelRunRecords(ctx, orgID, uniqueIDs)
	if err != nil {
		return bulkCancelResult{}, err
	}
	if canceled == nil {
		canceled = []string{}
	}
	return bulkCancelResult{CanceledIDs: canceled, CanceledCount: len(canceled)}, nil
}

// normalizeCancelIDs trims, drops empty entries and deduplicates while keeping
// first-occurrence order. It is the pure part of the bulk-cancel request
// handling.
func normalizeCancelIDs(ids []string) []string {
	uniqueIDs := make([]string, 0, len(ids))
	for _, id := range ids {
		trimmed := strings.TrimSpace(id)
		if trimmed == "" || containsString(uniqueIDs, trimmed) {
			continue
		}
		uniqueIDs = append(uniqueIDs, trimmed)
	}
	return uniqueIDs
}

// runStatusIsCancelable is the reference predicate behind the SQL status
// filter: failed runs are still cancelable, completed and canceled runs are
// terminal and must never be rewritten.
func runStatusIsCancelable(status RunStatus) bool {
	return status != RunStatusCompleted && status != RunStatusCanceled
}

// cancelRunRecords implements the fixed cancellation protocol:
//
//  1. Open a transaction whose first statement is a locking read ordered by id
//     ascending. Terminal runs are excluded, so completed/canceled rows are
//     never rewritten. The ascending order makes two overlapping bulk
//     cancellations acquire row locks in the same order and avoids deadlocks.
//  2. Update the locked runs and their pending/queued/running nodes.
//  3. Commit.
//  4. Append one frontier_run_canceled event per locked run that has a workflow
//     run and mark that workflow run canceled, in ascending id order.
//
// The returned ids are the rows locked by step 1 (the ids that actually
// transitioned).
func (s *Service) cancelRunRecords(ctx context.Context, orgID string, ids []string) ([]string, error) {
	payload, err := json.Marshal(ids)
	if err != nil {
		return nil, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()

	rows, err := tx.QueryContext(ctx, `
SELECT id, workflowRunId
FROM CrawlFrontierRun
WHERE orgId = ? AND JSON_CONTAINS(?, JSON_QUOTE(id)) AND status NOT IN ('completed', 'canceled')
ORDER BY id ASC
FOR UPDATE`, orgID, string(payload))
	if err != nil {
		return nil, err
	}
	locked := make([]lockedRun, 0)
	for rows.Next() {
		var run lockedRun
		if err := rows.Scan(&run.ID, &run.WorkflowRunID); err != nil {
			_ = rows.Close()
			return nil, err
		}
		locked = append(locked, run)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return nil, err
	}
	_ = rows.Close()

	if len(locked) == 0 {
		// Nothing to transition: commit the empty transaction and return an
		// empty list so the handler can render canceledCount = 0.
		if err := tx.Commit(); err != nil {
			return nil, err
		}
		return []string{}, nil
	}

	lockedIDs := make([]string, 0, len(locked))
	for _, run := range locked {
		lockedIDs = append(lockedIDs, run.ID)
	}
	lockedPayload, err := json.Marshal(lockedIDs)
	if err != nil {
		return nil, err
	}
	finishedAt := time.Now().UTC().Truncate(time.Millisecond)

	// The WHERE clauses repeat orgId so a tenant-scoped lock can never update a
	// row outside the caller's organization.
	if _, err := tx.ExecContext(ctx, `
UPDATE CrawlFrontierRun
SET status = 'canceled', finishedAt = ?, updatedAt = ?
WHERE orgId = ? AND JSON_CONTAINS(?, JSON_QUOTE(id))`,
		finishedAt, finishedAt, orgID, string(lockedPayload)); err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx, `
UPDATE CrawlFrontierNode
SET status = 'canceled', updatedAt = ?
WHERE orgId = ? AND JSON_CONTAINS(?, JSON_QUOTE(runId))
  AND status IN ('pending', 'queued', 'running')`,
		finishedAt, orgID, string(lockedPayload)); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}

	// Events are appended after the commit, exactly like the NestJS fix, so a
	// slow event write cannot hold the run row locks.
	for _, run := range locked {
		if !run.WorkflowRunID.Valid || run.WorkflowRunID.String == "" {
			continue
		}
		if err := s.appendCancelEvent(ctx, run.ID, run.WorkflowRunID.String, finishedAt); err != nil {
			return nil, err
		}
	}
	return lockedIDs, nil
}

// appendCancelEvent appends the frontier_run_canceled event (sequence =
// count + 1, mirroring recorder.appendEvent) and marks the workflow run
// canceled with a cleared error.
func (s *Service) appendCancelEvent(ctx context.Context, frontierRunID, workflowRunID string, finishedAt time.Time) error {
	var count int
	if err := s.db.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM CrawlStrategyWorkflowRunEvent WHERE runId = ?", workflowRunID).Scan(&count); err != nil {
		return err
	}
	eventID, err := newRowID()
	if err != nil {
		return err
	}
	details, err := json.Marshal(canceledEventDetails{FrontierRunID: frontierRunID})
	if err != nil {
		return err
	}
	if _, err := s.db.ExecContext(ctx, `
INSERT INTO CrawlStrategyWorkflowRunEvent
  (id, runId, sequence, level, eventType, nodeId, nodeType, message, triggerReason,
   beforeCount, afterCount, rescuedCount, details, createdAt)
VALUES (?, ?, ?, 'warn', 'frontier_run_canceled', NULL, 'legacy.frontier_run',
        'Frontier run was canceled', NULL, NULL, NULL, NULL, ?, ?)`,
		eventID, workflowRunID, count+1, []byte(details), finishedAt); err != nil {
		return err
	}
	if _, err := s.db.ExecContext(ctx, `
UPDATE CrawlStrategyWorkflowRun
SET status = 'canceled', error = NULL, finishedAt = ?, updatedAt = NOW(3)
WHERE id = ?`, finishedAt, workflowRunID); err != nil {
		return err
	}
	return nil
}
