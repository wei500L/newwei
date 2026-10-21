package crawlworker

// B1 CrawlTask side effects.
//
// NestJS ran these from the per-queue QueueEvents readers ('completed',
// 'failed', 'stalled'). Those readers are not migrated, so the Go worker applies
// the same writes exactly once, right after the BullMQ transition that produced
// the event. The QueueEvents stream itself keeps working for the NestJS admin
// consumers; it is a broadcast (XREAD), never a competing consumer.
//
// Every statement is tenant scoped (id + orgId) and status guarded, matching the
// Prisma updateMany filters:
//   - failed: status IN ('queued','running') -> 'failed';
//   - stalled: status = 'running' -> 'queued'.
// updatedAt is written explicitly because Prisma's @updatedAt has no MySQL
// default.

import (
	"context"
	"database/sql"
	"fmt"
	"time"
)

// taskStore is the CrawlTask terminal-status writer. The production
// implementation is sqlTaskStore; unit tests substitute a fake to assert the
// status/lastError/tenant arguments and the VARCHAR(191) fallback.
type taskStore interface {
	// MarkFailed is the 'failed' side effect for one job.
	MarkFailed(ctx context.Context, taskID, orgID, lastError string) error
	// MarkStalled is the 'stalled' side effect for one recovered job.
	MarkStalled(ctx context.Context, taskID, orgID, lastError string) error
}

// sqlTaskStore writes CrawlTask rows on the shared MySQL handle.
type sqlTaskStore struct {
	db  *sql.DB
	now func() time.Time
}

// newSQLTaskStore builds the MySQL-backed task store.
func newSQLTaskStore(db *sql.DB, now func() time.Time) *sqlTaskStore {
	return &sqlTaskStore{db: db, now: now}
}

// MarkFailed implements taskStore. The row is only updated while it is queued or
// running, so a task that already reached a terminal state is not rewritten.
func (s *sqlTaskStore) MarkFailed(ctx context.Context, taskID, orgID, lastError string) error {
	if s == nil || s.db == nil {
		return fmt.Errorf("crawlworker: mysql is not configured")
	}
	_, err := s.db.ExecContext(ctx,
		"UPDATE `CrawlTask` SET `status` = 'failed', `lastError` = ?, `updatedAt` = ?"+
			" WHERE `id` = ? AND `orgId` = ? AND `status` IN ('queued', 'running')",
		lastError, s.updatedAt(), taskID, orgID)
	return err
}

// MarkStalled implements taskStore: a recovered stalled job returns to queued so
// the next attempt (or the stale-task janitor) can pick the row up again.
func (s *sqlTaskStore) MarkStalled(ctx context.Context, taskID, orgID, lastError string) error {
	if s == nil || s.db == nil {
		return fmt.Errorf("crawlworker: mysql is not configured")
	}
	_, err := s.db.ExecContext(ctx,
		"UPDATE `CrawlTask` SET `status` = 'queued', `lastError` = ?, `updatedAt` = ?"+
			" WHERE `id` = ? AND `orgId` = ? AND `status` = 'running'",
		lastError, s.updatedAt(), taskID, orgID)
	return err
}

// updatedAt is the DATETIME(3) value Prisma would write.
func (s *sqlTaskStore) updatedAt() time.Time {
	clock := time.Now
	if s != nil && s.now != nil {
		clock = s.now
	}
	return clock().UTC().Truncate(time.Millisecond)
}
