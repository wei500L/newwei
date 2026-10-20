package crawlmaintenance

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

// Audit retention constants copied from AuditLogRetentionService.
const (
	// auditRetentionLockTTL is the B5 lease length. It is renewed while the
	// purge runs, so a long purge keeps the lease and a second instance skips.
	auditRetentionLockTTL = 30 * time.Minute
	// auditRetentionBatchSize is DELETE_BATCH_SIZE.
	auditRetentionBatchSize = 1000
)

// auditRetentionReader reads the normalized retention days.
type auditRetentionReader interface {
	Read(ctx context.Context) (int, error)
}

// AuditRetentionDeps are the production dependencies of the daily purge.
type AuditRetentionDeps struct {
	DB        *sql.DB
	Redis     *redis.Client
	Retention auditRetentionReader
	Now       func() time.Time
	Logf      func(format string, args ...any)
}

// AuditRetentionScheduler owns the daily 01:00 local-time purge.
type AuditRetentionScheduler struct {
	db        *sql.DB
	redis     *redis.Client
	retention auditRetentionReader
	logf      func(string, ...any)
	loop      *cronScheduler
}

// NewAuditRetentionScheduler builds the scheduler.
func NewAuditRetentionScheduler(deps AuditRetentionDeps) *AuditRetentionScheduler {
	logf := deps.Logf
	if logf == nil {
		logf = func(string, ...any) {}
	}
	scheduler := &AuditRetentionScheduler{
		db:        deps.DB,
		redis:     deps.Redis,
		retention: deps.Retention,
		logf:      logf,
	}
	scheduler.loop = newCronScheduler("audit-log-retention",
		func(now time.Time) time.Time { return nextLocalHour(now, 1) },
		scheduler.runTick, deps.Now, logf)
	return scheduler
}

// Start launches the daily loop.
func (s *AuditRetentionScheduler) Start(parent context.Context) { s.loop.Start(parent) }

// Close stops the loop and waits for the in-flight tick.
func (s *AuditRetentionScheduler) Close(ctx context.Context) error { return s.loop.Close(ctx) }

// runTick is handleCron wrapped in the B5 lease. NestJS has no lock, so a
// mixed-version window could run both sides once; the DELETE is idempotent and
// both only remove createdAt < cutoff rows.
func (s *AuditRetentionScheduler) runTick(ctx context.Context) error {
	if s == nil || s.db == nil || s.redis == nil || s.retention == nil {
		return fmt.Errorf("crawlmaintenance: audit log retention is not fully configured")
	}
	acquired, err := withRedisLock(ctx, s.redis, auditRetentionLockKey, auditRetentionLockTTL,
		func(runCtx context.Context) error { return s.purgeExpiredAuditLogs(runCtx) })
	if err != nil {
		return err
	}
	if !acquired {
		s.logf("crawlmaintenance: skipped audit log retention purge because another instance holds the cron lease")
	}
	return nil
}

// purgeExpiredAuditLogs is purgeExpiredAuditLogs with the O2 primary-key
// cursor: each batch continues after the previous last id instead of rescanning
// the table from the beginning.
func (s *AuditRetentionScheduler) purgeExpiredAuditLogs(ctx context.Context) error {
	retentionDays, err := s.retention.Read(ctx)
	if err != nil {
		return err
	}
	if retentionDays < 1 {
		retentionDays = 1
	}
	now := s.loop.now()
	// The NestJS cutoff is now - days * 24 * 60 * 60 * 1000 milliseconds.
	cutoff := now.Add(-time.Duration(retentionDays) * 24 * time.Hour)

	totalDeleted := 0
	cursor := ""
	for {
		ids, err := s.selectExpiredIDs(ctx, cursor, cutoff)
		if err != nil {
			return err
		}
		if len(ids) == 0 {
			break
		}
		deleted, err := s.deleteIDs(ctx, ids)
		if err != nil {
			return err
		}
		totalDeleted += deleted
		if len(ids) < auditRetentionBatchSize {
			break
		}
		cursor = ids[len(ids)-1]
	}
	if totalDeleted > 0 {
		s.logf("crawlmaintenance: deleted audit logs older than %d days count=%d", retentionDays, totalDeleted)
	}
	return nil
}

// selectExpiredIDs reads one primary-key batch. The id cursor keeps the scan
// monotonic, so the whole table is walked once per execution.
func (s *AuditRetentionScheduler) selectExpiredIDs(ctx context.Context, cursor string, cutoff time.Time) ([]string, error) {
	if s.db == nil {
		return nil, errMySQLUnavailable
	}
	rows, err := s.db.QueryContext(ctx,
		"SELECT `id` FROM `AuditLog` WHERE `id` > ? AND `createdAt` < ?"+
			" ORDER BY `id` ASC LIMIT ?",
		cursor, cutoff.UTC().Truncate(time.Millisecond), auditRetentionBatchSize)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := make([]string, 0, auditRetentionBatchSize)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return ids, nil
}

// deleteIDs deletes one batch and returns the affected row count.
func (s *AuditRetentionScheduler) deleteIDs(ctx context.Context, ids []string) (int, error) {
	if len(ids) == 0 {
		return 0, nil
	}
	placeholders := make([]string, len(ids))
	args := make([]any, 0, len(ids))
	for index, id := range ids {
		placeholders[index] = "?"
		args = append(args, id)
	}
	result, err := s.db.ExecContext(ctx,
		"DELETE FROM `AuditLog` WHERE `id` IN ("+strings.Join(placeholders, ",")+")", args...)
	if err != nil {
		return 0, err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return 0, err
	}
	return int(affected), nil
}
