package crawlmaintenance

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/wei500L/newwei/apps/api-go/internal/crawlqueue"
	"github.com/wei500L/newwei/apps/api-go/internal/crawltaskwrite"
)

// JanitorConfig mirrors CRAWL_TASK_JANITOR_* and the two stale timeouts. The
// timeouts stay in milliseconds so the lastError text uses the exact integer
// the environment supplied.
type JanitorConfig struct {
	Enabled          bool
	RunningTimeoutMs int
	QueuedTimeoutMs  int
	BatchSize        int
	QueueScanLimit   int
	LockTTLMs        int
}

// activityCounter is crawlqueue.Activity, narrowed for the janitor.
type activityCounter interface {
	GetState(ctx context.Context) (crawlqueue.ActivityState, error)
	EnsureActiveTaskCount(ctx context.Context, db *sql.DB) (int, error)
	MarkTasksTerminal(ctx context.Context, count int) error
}

// pendingQueueScanner is the crawlqueue pending scan (wait, paused, delayed,
// prioritized, active).
type pendingQueueScanner interface {
	PendingJobCount(ctx context.Context) (int64, error)
	ListPendingTaskIDs(ctx context.Context, scanLimit int) (crawlqueue.TaskIDSet, error)
}

// staleTaskRow is StaleTaskRow.
type staleTaskRow struct {
	ID        string
	OrgID     string
	LastRunAt *time.Time
	UpdatedAt time.Time
}

// effectiveTime is (lastRunAt ?? updatedAt).
func (r staleTaskRow) effectiveTime() time.Time {
	if r.LastRunAt != nil {
		return *r.LastRunAt
	}
	return r.UpdatedAt
}

// JanitorDeps are the production dependencies of the per-minute janitor.
type JanitorDeps struct {
	DB       *sql.DB
	Redis    *redis.Client
	Mongo    *mongo.Database
	Activity activityCounter
	Queue    pendingQueueScanner
	Config   JanitorConfig
	Now      func() time.Time
	Logf     func(format string, args ...any)
}

// JanitorScheduler owns the per-minute stale-task cleanup.
type JanitorScheduler struct {
	db       *sql.DB
	redis    *redis.Client
	activity activityCounter
	queue    pendingQueueScanner
	taskLogs *mongo.Collection
	config   JanitorConfig
	logf     func(string, ...any)
	loop     *cronScheduler
}

// NewJanitorScheduler builds the janitor. The Mongo database may be nil in unit
// tests that exercise the SQL paths; the TaskLog write then warns instead of
// failing the tick.
func NewJanitorScheduler(deps JanitorDeps) *JanitorScheduler {
	logf := deps.Logf
	if logf == nil {
		logf = func(string, ...any) {}
	}
	scheduler := &JanitorScheduler{
		db:       deps.DB,
		redis:    deps.Redis,
		activity: deps.Activity,
		queue:    deps.Queue,
		config:   deps.Config,
		logf:     logf,
	}
	if deps.Mongo != nil {
		scheduler.taskLogs = deps.Mongo.Collection(taskLogsCollection)
	}
	scheduler.loop = newCronScheduler("crawl-task-janitor", nextMinute, scheduler.runTick, deps.Now, logf)
	return scheduler
}

// Start launches the per-minute loop.
func (s *JanitorScheduler) Start(parent context.Context) { s.loop.Start(parent) }

// Close stops the loop and waits for the in-flight tick.
func (s *JanitorScheduler) Close(ctx context.Context) error { return s.loop.Close(ctx) }

// runTick is cleanupCron. The active-count gate is kept, with the B2 exception:
// when the counter is zero the tick still checks for a stale pending task
// because pending rows are never counted and would otherwise never be
// reclaimed on an idle deployment.
func (s *JanitorScheduler) runTick(ctx context.Context) error {
	if s == nil || !s.config.Enabled {
		return nil
	}
	if s.db == nil || s.redis == nil || s.activity == nil || s.queue == nil {
		return fmt.Errorf("crawlmaintenance: janitor is not fully configured")
	}
	activeTaskCount, err := s.activity.EnsureActiveTaskCount(ctx, s.db)
	if err != nil {
		return err
	}
	now := s.loop.now()
	if activeTaskCount == 0 {
		stuck, err := s.hasStalePendingTask(ctx, now.Add(-time.Duration(s.config.QueuedTimeoutMs)*time.Millisecond))
		if err != nil {
			return err
		}
		if !stuck {
			return nil
		}
	}
	_, err = withRedisLock(ctx, s.redis, janitorLockKey,
		time.Duration(s.config.LockTTLMs)*time.Millisecond,
		func(runCtx context.Context) error { return s.cleanupStaleTasks(runCtx, now) })
	return err
}

// hasStalePendingTask is the B2 idle check. It walks
// CrawlTask_status_updatedAt_id_idx (status, updatedAt) with LIMIT 1.
func (s *JanitorScheduler) hasStalePendingTask(ctx context.Context, cutoff time.Time) (bool, error) {
	var one int
	err := s.db.QueryRowContext(ctx,
		"SELECT 1 FROM `CrawlTask` WHERE `status` = 'pending' AND `updatedAt` < ? LIMIT 1",
		cutoff.UTC().Truncate(time.Millisecond)).Scan(&one)
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// cleanupStaleTasks is cleanupStaleTasks. Candidates are found per kind, the
// queued and pending candidates share one queue scan (O1), and each kind is
// failed in its own short transaction (B3).
func (s *JanitorScheduler) cleanupStaleTasks(ctx context.Context, now time.Time) error {
	runningCutoff := now.Add(-time.Duration(s.config.RunningTimeoutMs) * time.Millisecond)
	queuedCutoff := now.Add(-time.Duration(s.config.QueuedTimeoutMs) * time.Millisecond)

	running, err := s.findStaleRunningTasks(ctx, runningCutoff, s.config.BatchSize)
	if err != nil {
		return err
	}
	queued, err := s.findStaleTasks(ctx, "queued", queuedCutoff, s.config.BatchSize)
	if err != nil {
		return err
	}
	pending, err := s.findStaleTasks(ctx, "pending", queuedCutoff, s.config.BatchSize)
	if err != nil {
		return err
	}

	queuedWithoutJobs, pendingWithoutJobs := s.filterQueuedTasksWithoutPendingJobs(ctx, queued, pending)

	if len(running) == 0 && len(queuedWithoutJobs) == 0 && len(pendingWithoutJobs) == 0 {
		return nil
	}
	if len(running) > 0 {
		if err := s.failTasks(ctx, "running", running, staleTaskMessage("running", s.config)); err != nil {
			return err
		}
	}
	if len(queuedWithoutJobs) > 0 {
		if err := s.failTasks(ctx, "queued", queuedWithoutJobs, staleTaskMessage("queued", s.config)); err != nil {
			return err
		}
	}
	if len(pendingWithoutJobs) > 0 {
		if err := s.failTasks(ctx, "pending", pendingWithoutJobs, staleTaskMessage("pending", s.config)); err != nil {
			return err
		}
	}
	return nil
}

// findStaleRunningTasks merges the two NestJS running queries: an old
// lastRunAt, and a NULL lastRunAt with an old updatedAt. Each query takes at
// most take rows; the merge keeps the first occurrence per id, sorts by
// (lastRunAt ?? updatedAt) then id, and truncates to take.
func (s *JanitorScheduler) findStaleRunningTasks(ctx context.Context, cutoff time.Time, take int) ([]staleTaskRow, error) {
	started, err := s.queryStaleTasks(ctx,
		"SELECT `id`, `orgId`, `lastRunAt`, `updatedAt` FROM `CrawlTask`"+
			" WHERE `status` = 'running' AND `lastRunAt` < ?"+
			" ORDER BY `lastRunAt` ASC, `id` ASC LIMIT ?",
		cutoff.UTC().Truncate(time.Millisecond), take)
	if err != nil {
		return nil, err
	}
	withoutHeartbeat, err := s.queryStaleTasks(ctx,
		"SELECT `id`, `orgId`, `lastRunAt`, `updatedAt` FROM `CrawlTask`"+
			" WHERE `status` = 'running' AND `lastRunAt` IS NULL AND `updatedAt` < ?"+
			" ORDER BY `updatedAt` ASC, `id` ASC LIMIT ?",
		cutoff.UTC().Truncate(time.Millisecond), take)
	if err != nil {
		return nil, err
	}

	return mergeStaleTaskRows([][]staleTaskRow{started, withoutHeartbeat}, take), nil
}

// mergeStaleTaskRows is mergeStaleTaskRows: keep the first occurrence per id,
// sort by (lastRunAt ?? updatedAt) then id and truncate to take.
func mergeStaleTaskRows(groups [][]staleTaskRow, take int) []staleTaskRow {
	merged := make([]staleTaskRow, 0, len(groups)*len(groups[0]))
	seen := make(map[string]struct{})
	for _, group := range groups {
		for _, task := range group {
			if _, ok := seen[task.ID]; ok {
				continue
			}
			seen[task.ID] = struct{}{}
			merged = append(merged, task)
		}
	}
	sortByTimeThenID(merged, staleTaskRow.effectiveTime, func(task staleTaskRow) string { return task.ID })
	if take >= 0 && len(merged) > take {
		merged = merged[:take]
	}
	return merged
}

// staleTaskMessage is the exact lastError text per kind.
func staleTaskMessage(kind string, config JanitorConfig) string {
	switch kind {
	case "running":
		return fmt.Sprintf("stale crawl task timed out (running > %dms)", config.RunningTimeoutMs)
	case "queued":
		return fmt.Sprintf("stale crawl task timed out (queued > %dms)", config.QueuedTimeoutMs)
	default:
		return fmt.Sprintf("stale crawl task stuck pending with no queue job (never enqueued > %dms)", config.QueuedTimeoutMs)
	}
}

// findStaleTasks is findStaleQueuedTasks / findStalePendingTasks.
func (s *JanitorScheduler) findStaleTasks(ctx context.Context, status string, cutoff time.Time, take int) ([]staleTaskRow, error) {
	return s.queryStaleTasks(ctx,
		"SELECT `id`, `orgId`, `lastRunAt`, `updatedAt` FROM `CrawlTask`"+
			" WHERE `status` = ? AND `updatedAt` < ?"+
			" ORDER BY `updatedAt` ASC, `id` ASC LIMIT ?",
		status, cutoff.UTC().Truncate(time.Millisecond), take)
}

func (s *JanitorScheduler) queryStaleTasks(ctx context.Context, query string, args ...any) ([]staleTaskRow, error) {
	if s.db == nil {
		return nil, errMySQLUnavailable
	}
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	tasks := make([]staleTaskRow, 0)
	for rows.Next() {
		var task staleTaskRow
		var lastRunAt sql.NullTime
		if err := rows.Scan(&task.ID, &task.OrgID, &lastRunAt, &task.UpdatedAt); err != nil {
			return nil, err
		}
		if lastRunAt.Valid {
			value := lastRunAt.Time
			task.LastRunAt = &value
		}
		tasks = append(tasks, task)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return tasks, nil
}

// filterQueuedTasksWithoutPendingJobs is filterQueuedTasksWithoutPendingJobs
// for both kinds at once (O1): the backlog is counted and the queue scanned
// once, and the same task-id set filters queued and pending candidates. A scan
// error or an over-limit backlog clears both lists, exactly like the NestJS
// catch-and-return-empty behaviour.
func (s *JanitorScheduler) filterQueuedTasksWithoutPendingJobs(ctx context.Context, queued, pending []staleTaskRow) ([]staleTaskRow, []staleTaskRow) {
	if len(queued) == 0 && len(pending) == 0 {
		return nil, nil
	}
	pendingCount, err := s.queue.PendingJobCount(ctx)
	if err != nil {
		s.logf("crawlmaintenance: failed to scan queue for queued-task cleanup: %v", err)
		return nil, nil
	}
	if pendingCount > int64(s.config.QueueScanLimit) {
		s.logf("crawlmaintenance: skipping queued-task cleanup because crawl queue is too large to scan safely pendingCount=%d scanLimit=%d queuedCandidates=%d pendingCandidates=%d",
			pendingCount, s.config.QueueScanLimit, len(queued), len(pending))
		return nil, nil
	}
	effectiveScanLimit := s.config.QueueScanLimit
	if pendingCount < int64(effectiveScanLimit) {
		effectiveScanLimit = int(pendingCount)
	}
	if effectiveScanLimit < 0 {
		effectiveScanLimit = 0
	}
	taskIDs := make(crawlqueue.TaskIDSet)
	if effectiveScanLimit > 0 {
		taskIDs, err = s.queue.ListPendingTaskIDs(ctx, effectiveScanLimit)
		if err != nil {
			s.logf("crawlmaintenance: failed to list pending queue task ids: %v", err)
			return nil, nil
		}
	}
	keep := func(tasks []staleTaskRow) []staleTaskRow {
		filtered := make([]staleTaskRow, 0, len(tasks))
		for _, task := range tasks {
			if !taskIDs.Has(task.ID) {
				filtered = append(filtered, task)
			}
		}
		return filtered
	}
	return keep(queued), keep(pending)
}

// failTasks is failTasks with B3: the candidate ids are locked and re-checked
// against the status inside one transaction, only the rows that are actually
// failed are counted, and the audit row, TaskLog and activity decrement use that
// exact set.
func (s *JanitorScheduler) failTasks(ctx context.Context, kind string, tasks []staleTaskRow, message string) error {
	if len(tasks) == 0 {
		return nil
	}
	taskIDs := make([]string, 0, len(tasks))
	for _, task := range tasks {
		taskIDs = append(taskIDs, task.ID)
	}
	selected, err := s.selectAndFailTasks(ctx, kind, taskIDs, message)
	if err != nil {
		return err
	}
	if len(selected) == 0 {
		return nil
	}
	// Restore the candidate order so the audit metadata taskIds order matches
	// the janitor scan order.
	byID := make(map[string]staleTaskRow, len(selected))
	for _, task := range selected {
		byID[task.ID] = task
	}
	ordered := make([]staleTaskRow, 0, len(selected))
	for _, task := range tasks {
		if row, ok := byID[task.ID]; ok {
			ordered = append(ordered, row)
			delete(byID, task.ID)
		}
	}
	if err := s.activity.MarkTasksTerminal(ctx, len(ordered)); err != nil {
		return err
	}
	s.writeAuditLogs(ctx, ordered, kind, message)
	s.writeTaskLogs(ctx, ordered, kind, message)
	s.logf("crawlmaintenance: marked stale crawl tasks as failed kind=%s count=%d", kind, len(ordered))
	return nil
}

// selectAndFailTasks runs the FOR UPDATE selection and the status-guarded
// update in one transaction.
func (s *JanitorScheduler) selectAndFailTasks(ctx context.Context, kind string, taskIDs []string, message string) ([]staleTaskRow, error) {
	if s.db == nil {
		return nil, errMySQLUnavailable
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()

	placeholders := strings.Join(repeatPlaceholder(len(taskIDs)), ",")
	args := make([]any, 0, len(taskIDs)+1)
	for _, id := range taskIDs {
		args = append(args, id)
	}
	args = append(args, kind)
	rows, err := tx.QueryContext(ctx,
		"SELECT `id`, `orgId`, `lastRunAt`, `updatedAt` FROM `CrawlTask`"+
			" WHERE `id` IN ("+placeholders+") AND `status` = ? FOR UPDATE", args...)
	if err != nil {
		return nil, err
	}
	selected := make([]staleTaskRow, 0, len(taskIDs))
	for rows.Next() {
		var task staleTaskRow
		var lastRunAt sql.NullTime
		if err := rows.Scan(&task.ID, &task.OrgID, &lastRunAt, &task.UpdatedAt); err != nil {
			rows.Close()
			return nil, err
		}
		if lastRunAt.Valid {
			value := lastRunAt.Time
			task.LastRunAt = &value
		}
		selected = append(selected, task)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	if len(selected) == 0 {
		return nil, tx.Commit()
	}

	updateArgs := make([]any, 0, len(selected)+3)
	updateArgs = append(updateArgs, "failed", message, s.loop.now().UTC().Truncate(time.Millisecond))
	updatePlaceholders := make([]string, 0, len(selected))
	for _, task := range selected {
		updateArgs = append(updateArgs, task.ID)
		updatePlaceholders = append(updatePlaceholders, "?")
	}
	updateArgs = append(updateArgs, kind)
	if _, err := tx.ExecContext(ctx,
		"UPDATE `CrawlTask` SET `status` = ?, `lastError` = ?, `updatedAt` = ?"+
			" WHERE `id` IN ("+strings.Join(updatePlaceholders, ",")+") AND `status` = ?", updateArgs...); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return selected, nil
}

// repeatPlaceholder returns count "?" tokens.
func repeatPlaceholder(count int) []string {
	values := make([]string, count)
	for index := range values {
		values[index] = "?"
	}
	return values
}

// janitorAuditMetadata is the AuditLog.metadata document. Field order is part
// of the contract: {kind, message, taskIds}.
type janitorAuditMetadata struct {
	Kind    string   `json:"kind"`
	Message string   `json:"message"`
	TaskIDs []string `json:"taskIds"`
}

// writeAuditLogs groups the failed tasks by organization and writes one
// best-effort audit row per organization. A failure only warns.
func (s *JanitorScheduler) writeAuditLogs(ctx context.Context, tasks []staleTaskRow, kind, message string) {
	order := make([]string, 0)
	byOrg := make(map[string][]string)
	for _, task := range tasks {
		if _, ok := byOrg[task.OrgID]; !ok {
			order = append(order, task.OrgID)
		}
		byOrg[task.OrgID] = append(byOrg[task.OrgID], task.ID)
	}
	for _, orgID := range order {
		metadata, err := json.Marshal(janitorAuditMetadata{Kind: kind, Message: message, TaskIDs: byOrg[orgID]})
		if err != nil {
			s.logf("crawlmaintenance: failed to encode crawl stale-task audit metadata orgId=%s: %v", orgID, err)
			continue
		}
		if err := crawltaskwrite.WriteAuditLogBestEffort(ctx, s.db, crawltaskwrite.MaintenanceAuditEntry{
			OrgID:    orgID,
			Resource: "crawlTask",
			Action:   "auto_fail_stale",
			Metadata: metadata,
		}); err != nil {
			s.logf("crawlmaintenance: failed to write crawl stale-task audit log orgId=%s: %v", orgID, err)
		}
	}
}

// taskLogCleanupData is the TaskLog.data document. Field order is part of the
// contract: {kind, lastRunAt, updatedAt}.
type taskLogCleanupData struct {
	Kind      string  `bson:"kind"`
	LastRunAt *string `bson:"lastRunAt"`
	UpdatedAt string  `bson:"updatedAt"`
}

// taskLogDocument is the TaskLog document the janitor writes. Mongoose adds the
// timestamps, so they are written explicitly.
type taskLogDocument struct {
	Queue     string             `bson:"queue"`
	JobID     string             `bson:"jobId"`
	OrgID     string             `bson:"orgId"`
	Stage     string             `bson:"stage"`
	Status    string             `bson:"status"`
	Message   string             `bson:"message"`
	Data      taskLogCleanupData `bson:"data"`
	CreatedAt time.Time          `bson:"createdAt"`
	UpdatedAt time.Time          `bson:"updatedAt"`
}

// writeTaskLogs writes one cleanup TaskLog per failed task. A failure only
// warns.
func (s *JanitorScheduler) writeTaskLogs(ctx context.Context, tasks []staleTaskRow, kind, message string) {
	if s.taskLogs == nil {
		s.logf("crawlmaintenance: skip crawl stale-task logs because mongo is not configured")
		return
	}
	for _, task := range tasks {
		var lastRunAt *string
		if task.LastRunAt != nil {
			value := formatISO(*task.LastRunAt)
			lastRunAt = &value
		}
		now := s.loop.now().UTC().Truncate(time.Millisecond)
		document := taskLogDocument{
			Queue:   crawlQueueName,
			JobID:   task.ID,
			OrgID:   task.OrgID,
			Stage:   "cleanup",
			Status:  "failed",
			Message: message,
			Data: taskLogCleanupData{
				Kind:      kind,
				LastRunAt: lastRunAt,
				UpdatedAt: formatISO(task.UpdatedAt),
			},
			CreatedAt: now,
			UpdatedAt: now,
		}
		if _, err := s.taskLogs.InsertOne(ctx, document); err != nil {
			s.logf("crawlmaintenance: failed to write stale crawl task log taskId=%s: %v", task.ID, err)
		}
	}
}

const (
	taskLogsCollection = "tasklogs"
	crawlQueueName     = "crawl4ai"
)
