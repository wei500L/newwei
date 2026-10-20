package crawlmaintenance

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/rand"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

// Cleanup outbox constants copied from CrawlCleanupOutboxService.
const (
	cleanupOutboxType          = "cleanup_crawl_results"
	cleanupOutboxBatchSize     = 100
	cleanupOutboxStaleLockMs   = 5 * 60_000
	cleanupOutboxBaseDelayMs   = 30_000
	cleanupOutboxMaxAttempts   = 10
	cleanupOutboxLockTTLMs     = 55_000
	cleanupCrawlResultContents = "crawlresultcontents"
)

// cleanupOutboxEntry is one selected MongoOutbox row.
type cleanupOutboxEntry struct {
	ID        string
	OrgID     string
	Payload   []byte
	Status    string
	Attempts  sql.NullInt64
	CreatedAt time.Time
}

func (e cleanupOutboxEntry) attemptsValue() int {
	if !e.Attempts.Valid {
		return 0
	}
	return int(e.Attempts.Int64)
}

// cleanupPayload is the validated cleanup_crawl_results payload.
type cleanupPayload struct {
	TaskID string
	// OrgID keeps the raw payload value when it is a non-empty string.
	OrgID *string
}

// CleanupOutboxDeps are the production dependencies of the per-minute replay.
type CleanupOutboxDeps struct {
	DB    *sql.DB
	Redis *redis.Client
	Mongo *mongo.Database
	Now   func() time.Time
	Rand  func() float64
	Logf  func(format string, args ...any)
}

// CleanupOutboxScheduler owns the per-minute cleanup_crawl_results replay.
type CleanupOutboxScheduler struct {
	db           *sql.DB
	redis        *redis.Client
	crawlResults *mongo.Collection
	taskLogs     *mongo.Collection
	logf         func(string, ...any)
	loop         *cronScheduler
	rand         func() float64
}

// NewCleanupOutboxScheduler builds the replay scheduler.
func NewCleanupOutboxScheduler(deps CleanupOutboxDeps) *CleanupOutboxScheduler {
	logf := deps.Logf
	if logf == nil {
		logf = func(string, ...any) {}
	}
	random := deps.Rand
	if random == nil {
		random = rand.Float64
	}
	scheduler := &CleanupOutboxScheduler{
		db:    deps.DB,
		redis: deps.Redis,
		logf:  logf,
		rand:  random,
	}
	if deps.Mongo != nil {
		scheduler.crawlResults = deps.Mongo.Collection(cleanupCrawlResultContents)
		scheduler.taskLogs = deps.Mongo.Collection(taskLogsCollection)
	}
	scheduler.loop = newCronScheduler("crawl-cleanup-outbox", nextMinute, scheduler.runTick, deps.Now, logf)
	return scheduler
}

// Start launches the per-minute loop.
func (s *CleanupOutboxScheduler) Start(parent context.Context) { s.loop.Start(parent) }

// Close stops the loop and waits for the in-flight tick.
func (s *CleanupOutboxScheduler) Close(ctx context.Context) error { return s.loop.Close(ctx) }

// runTick is retryPendingCleanupOutbox. The whole batch runs under the shared
// cron lease; a batch-level failure is logged as a warning and ends the tick.
func (s *CleanupOutboxScheduler) runTick(ctx context.Context) error {
	if s == nil || s.db == nil || s.redis == nil {
		return fmt.Errorf("crawlmaintenance: cleanup outbox is not fully configured")
	}
	_, err := withRedisLock(ctx, s.redis, cleanupOutboxLockKey,
		time.Duration(cleanupOutboxLockTTLMs)*time.Millisecond,
		func(runCtx context.Context) error {
			if err := s.replayBatch(runCtx); err != nil {
				s.logf("crawlmaintenance: failed to process crawl cleanup outbox batch: %v", err)
			}
			return nil
		})
	return err
}

// replayBatch selects the three status groups, merges them and delivers the
// entries in createdAt order.
func (s *CleanupOutboxScheduler) replayBatch(ctx context.Context) error {
	now := s.loop.now()
	staleLockCutoff := now.Add(-time.Duration(cleanupOutboxStaleLockMs) * time.Millisecond)
	entries, err := s.fetchRetryEntries(ctx, now, staleLockCutoff)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		payload, ok := parseCleanupPayload(entry.Payload)
		if !ok || (payload.OrgID != nil && *payload.OrgID != entry.OrgID) {
			s.markOutboxDead(ctx, entry.ID, entry.attemptsValue()+1, errors.New("Invalid outbox payload"))
			continue
		}
		if err := s.deliverOutboxPayload(ctx, entry, payload.TaskID); err != nil {
			return err
		}
	}
	return nil
}

// fetchRetryEntries runs the three status queries and applies the shared merge
// (de-duplicate by id, sort by createdAt then id, take the batch size).
func (s *CleanupOutboxScheduler) fetchRetryEntries(ctx context.Context, now, staleLockCutoff time.Time) ([]cleanupOutboxEntry, error) {
	pending, err := s.findEntriesForRetry(ctx, "pending", "`availableAt` <= ?", now)
	if err != nil {
		return nil, err
	}
	failed, err := s.findEntriesForRetry(ctx, "failed", "`availableAt` <= ?", now)
	if err != nil {
		return nil, err
	}
	staleProcessing, err := s.findEntriesForRetry(ctx, "processing", "`lockedAt` < ?", staleLockCutoff)
	if err != nil {
		return nil, err
	}

	return mergeRetryEntries([][]cleanupOutboxEntry{pending, failed, staleProcessing}, cleanupOutboxBatchSize), nil
}

// mergeRetryEntries is mergeRetryEntries: keep the first occurrence per id,
// sort by createdAt then id, and truncate to take.
func mergeRetryEntries(groups [][]cleanupOutboxEntry, take int) []cleanupOutboxEntry {
	total := 0
	for _, group := range groups {
		total += len(group)
	}
	merged := make([]cleanupOutboxEntry, 0, total)
	seen := make(map[string]struct{}, total)
	for _, group := range groups {
		for _, entry := range group {
			if _, ok := seen[entry.ID]; ok {
				continue
			}
			seen[entry.ID] = struct{}{}
			merged = append(merged, entry)
		}
	}
	sort.SliceStable(merged, func(i, j int) bool {
		if !merged[i].CreatedAt.Equal(merged[j].CreatedAt) {
			return merged[i].CreatedAt.Before(merged[j].CreatedAt)
		}
		return localeCompare(merged[i].ID, merged[j].ID) < 0
	})
	if take >= 0 && len(merged) > take {
		merged = merged[:take]
	}
	return merged
}

func (s *CleanupOutboxScheduler) findEntriesForRetry(ctx context.Context, status, eligibility string, cutoff time.Time) ([]cleanupOutboxEntry, error) {
	if s.db == nil {
		return nil, errMySQLUnavailable
	}
	rows, err := s.db.QueryContext(ctx,
		"SELECT `id`, `orgId`, `payload`, `status`, `attempts`, `createdAt` FROM `MongoOutbox`"+
			" WHERE `type` = ? AND `status` = ? AND "+eligibility+
			" ORDER BY `createdAt` ASC, `id` ASC LIMIT ?",
		cleanupOutboxType, status, cutoff.UTC().Truncate(time.Millisecond), cleanupOutboxBatchSize)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	entries := make([]cleanupOutboxEntry, 0, cleanupOutboxBatchSize)
	for rows.Next() {
		var entry cleanupOutboxEntry
		if err := rows.Scan(&entry.ID, &entry.OrgID, &entry.Payload, &entry.Status, &entry.Attempts, &entry.CreatedAt); err != nil {
			return nil, err
		}
		entries = append(entries, entry)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return entries, nil
}

// parseCleanupPayload is parseOutboxPayload: only an object with the exact type
// and a non-blank string taskId is valid; a non-blank string orgId is kept as is
// for the cross-tenant check.
func parseCleanupPayload(raw []byte) (cleanupPayload, bool) {
	var document struct {
		Type   json.RawMessage `json:"type"`
		TaskID json.RawMessage `json:"taskId"`
		OrgID  json.RawMessage `json:"orgId"`
	}
	if err := json.Unmarshal(raw, &document); err != nil {
		return cleanupPayload{}, false
	}
	var payloadType string
	if err := json.Unmarshal(document.Type, &payloadType); err != nil || payloadType != cleanupOutboxType {
		return cleanupPayload{}, false
	}
	var taskID string
	if err := json.Unmarshal(document.TaskID, &taskID); err != nil || strings.TrimSpace(taskID) == "" {
		return cleanupPayload{}, false
	}
	payload := cleanupPayload{TaskID: taskID}
	if len(document.OrgID) > 0 {
		var orgID string
		if err := json.Unmarshal(document.OrgID, &orgID); err == nil && strings.TrimSpace(orgID) != "" {
			payload.OrgID = &orgID
		}
	}
	return payload, true
}

// deliverOutboxPayload claims the row, deletes the Mongo content, then removes
// the outbox row. Any failure after the claim schedules the documented backoff.
func (s *CleanupOutboxScheduler) deliverOutboxPayload(ctx context.Context, entry cleanupOutboxEntry, taskID string) error {
	attempts, claimed, err := s.claimOutboxEntry(ctx, entry)
	if err != nil {
		return err
	}
	if !claimed {
		return nil
	}
	if err := s.deleteTaskResults(ctx, taskID, entry.OrgID); err != nil {
		s.logf("crawlmaintenance: crawl cleanup outbox delivery failed outboxId=%s taskId=%s orgId=%s: %v", entry.ID, taskID, entry.OrgID, err)
		s.markOutboxFailure(ctx, entry.ID, attempts, err)
		return nil
	}
	if _, err := s.db.ExecContext(ctx,
		"DELETE FROM `MongoOutbox` WHERE `id` = ?", entry.ID); err != nil {
		s.logf("crawlmaintenance: crawl cleanup outbox row delete failed outboxId=%s taskId=%s orgId=%s: %v", entry.ID, taskID, entry.OrgID, err)
		s.markOutboxFailure(ctx, entry.ID, attempts, err)
	}
	return nil
}

// claimOutboxEntry is claimOutboxEntry: the eligibility predicate keeps the
// scan-time status, the update flips the row to processing and increments the
// attempt counter in one transaction, and the read-back supplies the attempt
// value used by the backoff.
func (s *CleanupOutboxScheduler) claimOutboxEntry(ctx context.Context, entry cleanupOutboxEntry) (int, bool, error) {
	now := s.loop.now().UTC().Truncate(time.Millisecond)
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, false, err
	}
	defer func() { _ = tx.Rollback() }()

	eligibility := "`availableAt` <= ?"
	cutoff := now
	if entry.Status == "processing" {
		eligibility = "`lockedAt` < ?"
		cutoff = now.Add(-time.Duration(cleanupOutboxStaleLockMs) * time.Millisecond)
	}
	result, err := tx.ExecContext(ctx,
		"UPDATE `MongoOutbox` SET `status` = 'processing', `lockedAt` = ?, `attempts` = `attempts` + 1,"+
			" `lastError` = NULL, `updatedAt` = ?"+
			" WHERE `id` = ? AND `type` = ? AND `status` = ? AND "+eligibility,
		now, now, entry.ID, cleanupOutboxType, entry.Status, cutoff)
	if err != nil {
		return 0, false, err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return 0, false, err
	}
	if affected == 0 {
		return 0, false, tx.Commit()
	}
	var attempts sql.NullInt64
	if err := tx.QueryRowContext(ctx,
		"SELECT `attempts` FROM `MongoOutbox` WHERE `id` = ?", entry.ID).Scan(&attempts); err != nil {
		return 0, false, err
	}
	if err := tx.Commit(); err != nil {
		return 0, false, err
	}
	if !attempts.Valid {
		return 1, true, nil
	}
	return int(attempts.Int64), true, nil
}

// markOutboxFailure is markOutboxFailure: status failed, capped exponential
// backoff with jitter, lockedAt NULL and attempts = max(attempts, 1). It never
// moves the row to dead; rows at or above the attempt cap only log a warning so
// the Mongo content is never orphaned.
func (s *CleanupOutboxScheduler) markOutboxFailure(ctx context.Context, outboxID string, attempts int, cause error) {
	if attempts >= cleanupOutboxMaxAttempts {
		s.logf("crawlmaintenance: crawl cleanup outbox delivery still failing after max attempts; continuing to retry to avoid orphaning Mongo content outboxId=%s attempts=%d", outboxID, attempts)
	}
	nextDelay := s.computeBackoffDelay(cleanupOutboxBaseDelayMs, attempts, 5)
	availableAt := s.loop.now().UTC().Truncate(time.Millisecond).Add(time.Duration(nextDelay) * time.Millisecond)
	message := cause.Error()
	if _, err := s.db.ExecContext(ctx,
		"UPDATE `MongoOutbox` SET `status` = 'failed', `lastError` = ?, `availableAt` = ?,"+
			" `lockedAt` = NULL, `attempts` = ?, `updatedAt` = ? WHERE `id` = ?",
		message, availableAt, maxInt(attempts, 1), s.loop.now().UTC().Truncate(time.Millisecond), outboxID); err != nil {
		s.logf("crawlmaintenance: failed to update crawl cleanup outbox status after delivery error outboxId=%s message=%s: %v", outboxID, message, err)
	}
}

// markOutboxDead is markOutboxDead: invalid payloads are the only dead-letter
// path.
func (s *CleanupOutboxScheduler) markOutboxDead(ctx context.Context, outboxID string, attempts int, cause error) {
	message := cause.Error()
	now := s.loop.now().UTC().Truncate(time.Millisecond)
	if _, err := s.db.ExecContext(ctx,
		"UPDATE `MongoOutbox` SET `status` = 'dead', `lastError` = ?, `availableAt` = ?,"+
			" `lockedAt` = NULL, `attempts` = ?, `updatedAt` = ? WHERE `id` = ?",
		message, now, maxInt(attempts, 1), now, outboxID); err != nil {
		s.logf("crawlmaintenance: failed to mark crawl cleanup outbox dead outboxId=%s message=%s: %v", outboxID, message, err)
		return
	}
	s.logf("crawlmaintenance: marked crawl cleanup outbox dead outboxId=%s attempts=%d message=%s", outboxID, maxInt(attempts, 1), message)
}

// computeBackoffDelay is computeBackoffDelay: base * 2^max(min(attempt, cap)-1,
// 0) * (0.5 + random), rounded like Math.round.
func (s *CleanupOutboxScheduler) computeBackoffDelay(baseDelayMs, attempt, maxAttempts int) int {
	capped := attempt
	if capped > maxAttempts {
		capped = maxAttempts
	}
	exponent := capped - 1
	if exponent < 0 {
		exponent = 0
	}
	delay := float64(baseDelayMs) * math.Pow(2, float64(exponent)) * (0.5 + s.rand())
	return int(jsRound(delay))
}

// deleteTaskResults is CrawlResultService.deleteTaskResults: delete the Mongo
// crawlresultcontents documents for the task and the TaskLog documents of the
// organization whose jobId starts with the task id. The two deletes run
// concurrently like the NestJS Promise.all; the prefix is intentionally not
// regex-escaped because the NestJS query is not either.
func (s *CleanupOutboxScheduler) deleteTaskResults(ctx context.Context, taskID, orgID string) error {
	if s.crawlResults == nil || s.taskLogs == nil {
		return errMongoUnavailable
	}
	var wait sync.WaitGroup
	errs := make([]error, 2)
	wait.Add(2)
	go func() {
		defer wait.Done()
		_, err := s.crawlResults.DeleteMany(ctx, bson.D{{Key: "taskId", Value: taskID}})
		errs[0] = err
	}()
	go func() {
		defer wait.Done()
		_, err := s.taskLogs.DeleteMany(ctx, bson.D{
			{Key: "orgId", Value: orgID},
			{Key: "jobId", Value: bson.Regex{Pattern: "^" + taskID}},
		})
		errs[1] = err
	}()
	wait.Wait()
	return errors.Join(errs...)
}

func maxInt(left, right int) int {
	if left > right {
		return left
	}
	return right
}
