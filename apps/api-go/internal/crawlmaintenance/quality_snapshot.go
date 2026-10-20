package crawlmaintenance

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// Crawl quality snapshot timings copied from
// CrawlQualityTaskSnapshotService.
const (
	qualityTickGateTTL = 4*time.Minute + 45*time.Second
	qualityOrgLockTTL  = 4 * time.Minute
	qualityLookback    = 15 * time.Minute
)

// qualityLogStages is the TaskLog stage filter used by
// discoverRecentlyChangedTaskIds.
var qualityLogStages = []string{"expansion", "preflight", "dedupe"}

// SnapshotRefresher is the exported crawl-quality snapshot refresh.
type SnapshotRefresher interface {
	RefreshSnapshotsForTaskIDs(ctx context.Context, orgID string, taskIDs []string) error
}

// qualityConcurrencyReader reads crawlQualityTaskSnapshotOrgConcurrency.
type qualityConcurrencyReader interface {
	Read(ctx context.Context) (int, error)
}

// QualitySnapshotDeps are the production dependencies of the five-minute tick.
type QualitySnapshotDeps struct {
	DB          *sql.DB
	Redis       *redis.Client
	Mongo       *mongo.Database
	Snapshots   SnapshotRefresher
	Concurrency qualityConcurrencyReader
	Now         func() time.Time
	Logf        func(format string, args ...any)
}

// QualitySnapshotScheduler owns the five-minute tick gate and the per-org leases.
type QualitySnapshotScheduler struct {
	db          *sql.DB
	redis       *redis.Client
	taskLogs    *mongo.Collection
	snapshots   SnapshotRefresher
	concurrency qualityConcurrencyReader
	logf        func(string, ...any)
	loop        *cronScheduler
}

// NewQualitySnapshotScheduler builds the scheduler.
func NewQualitySnapshotScheduler(deps QualitySnapshotDeps) *QualitySnapshotScheduler {
	logf := deps.Logf
	if logf == nil {
		logf = func(string, ...any) {}
	}
	scheduler := &QualitySnapshotScheduler{
		db:          deps.DB,
		redis:       deps.Redis,
		snapshots:   deps.Snapshots,
		concurrency: deps.Concurrency,
		logf:        logf,
	}
	if deps.Mongo != nil {
		scheduler.taskLogs = deps.Mongo.Collection(taskLogsCollection)
	}
	scheduler.loop = newCronScheduler("crawl-quality-task-snapshot", nextFiveMinutes, scheduler.runTick, deps.Now, logf)
	return scheduler
}

// Start launches the five-minute loop.
func (s *QualitySnapshotScheduler) Start(parent context.Context) { s.loop.Start(parent) }

// Close stops the loop and waits for the in-flight tick.
func (s *QualitySnapshotScheduler) Close(ctx context.Context) error { return s.loop.Close(ctx) }

// runTick is refreshRecentSnapshots: the tick gate first (shared with NestJS,
// no "lock:" prefix), then the active organizations with the configured
// concurrency, then one lease per organization.
func (s *QualitySnapshotScheduler) runTick(ctx context.Context) error {
	if s == nil || s.db == nil || s.redis == nil || s.snapshots == nil || s.concurrency == nil {
		return fmt.Errorf("crawlmaintenance: crawl quality snapshot is not fully configured")
	}
	claimed, err := claimSchedulerTick(ctx, s.redis, qualityTickGateKey, qualityTickGateTTL, s.loop.now())
	if err != nil {
		return err
	}
	if !claimed {
		s.logf("crawlmaintenance: skipped crawl quality task snapshot refresh tick because another instance already claimed this interval")
		return nil
	}

	orgIDs, err := listActiveOrgIDs(ctx, s.db, s.redis)
	if err != nil {
		return err
	}
	if len(orgIDs) == 0 {
		return nil
	}
	concurrency, err := s.concurrency.Read(ctx)
	if err != nil {
		return err
	}

	results := settleWithConcurrency(ctx, orgIDs, concurrency, s.refreshOrg)
	failed := 0
	skipped := 0
	for _, result := range results {
		if result.err != nil {
			failed++
			s.logf("crawlmaintenance: crawl quality task snapshot refresh failed orgId=%s: %v", result.item, result.err)
			continue
		}
		if result.skipped {
			skipped++
		}
	}
	s.logf("crawlmaintenance: crawl quality task snapshot refresh tick completed orgCount=%d concurrency=%d failed=%d skipped=%d",
		len(orgIDs), concurrency, failed, skipped)
	return nil
}

// orgResult is one settled organization.
type orgResult struct {
	item    string
	skipped bool
	err     error
}

// settleWithConcurrency is settleWithConcurrency: safeConcurrency is clamped to
// [1, len(items)] and floored; workers pull the next index until exhausted.
func settleWithConcurrency(ctx context.Context, items []string, concurrency int, worker func(context.Context, string) (bool, error)) []orgResult {
	if len(items) == 0 {
		return nil
	}
	safe := concurrency
	if safe < 1 {
		safe = 1
	}
	if safe > len(items) {
		safe = len(items)
	}
	results := make([]orgResult, len(items))
	var next int
	var mu sync.Mutex
	var wait sync.WaitGroup
	wait.Add(safe)
	for workerIndex := 0; workerIndex < safe; workerIndex++ {
		go func() {
			defer wait.Done()
			for {
				mu.Lock()
				index := next
				next++
				mu.Unlock()
				if index >= len(items) {
					return
				}
				skipped, err := worker(ctx, items[index])
				results[index] = orgResult{item: items[index], skipped: skipped, err: err}
			}
		}()
	}
	wait.Wait()
	return results
}

// refreshOrg is refreshRecentSnapshotsForOrgWithLock.
func (s *QualitySnapshotScheduler) refreshOrg(ctx context.Context, orgID string) (bool, error) {
	acquired, err := withRedisLock(ctx, s.redis, qualityOrgLockPrefix+orgID, qualityOrgLockTTL,
		func(runCtx context.Context) error {
			since := s.loop.now().Add(-qualityLookback)
			taskIDs, err := s.discoverRecentlyChangedTaskIDs(runCtx, orgID, since)
			if err != nil {
				return err
			}
			if len(taskIDs) == 0 {
				return nil
			}
			return s.snapshots.RefreshSnapshotsForTaskIDs(runCtx, orgID, taskIDs)
		})
	if err != nil {
		return false, err
	}
	if !acquired {
		s.logf("crawlmaintenance: skipped crawl quality task snapshot refresh because previous org run is still in progress orgId=%s", orgID)
	}
	return !acquired, nil
}

// discoverRecentlyChangedTaskIDs is discoverRecentlyChangedTaskIds. The two
// CrawlTask queries are merged into one UNION ALL (O3) so each branch keeps its
// own index, and the three remaining sources run concurrently like the NestJS
// Promise.all.
func (s *QualitySnapshotScheduler) discoverRecentlyChangedTaskIDs(ctx context.Context, orgID string, since time.Time) ([]string, error) {
	since = since.UTC().Truncate(time.Millisecond)
	var (
		wait         sync.WaitGroup
		tasks        []string
		logJobIDs    []string
		resultTaskID []string
		taskErr      error
		logErr       error
		resultErr    error
	)
	wait.Add(3)
	go func() {
		defer wait.Done()
		tasks, taskErr = s.discoverChangedTasks(ctx, orgID, since)
	}()
	go func() {
		defer wait.Done()
		logJobIDs, logErr = s.discoverChangedLogs(ctx, orgID, since)
	}()
	go func() {
		defer wait.Done()
		resultTaskID, resultErr = s.discoverChangedResults(ctx, orgID, since)
	}()
	wait.Wait()
	if taskErr != nil {
		return nil, taskErr
	}
	if logErr != nil {
		return nil, logErr
	}
	if resultErr != nil {
		return nil, resultErr
	}

	seen := make(map[string]struct{}, len(tasks)+len(logJobIDs)+len(resultTaskID))
	merged := make([]string, 0, len(tasks)+len(logJobIDs)+len(resultTaskID))
	appendIDs := func(ids []string) {
		for _, id := range ids {
			if _, ok := seen[id]; ok {
				continue
			}
			seen[id] = struct{}{}
			merged = append(merged, id)
		}
	}
	appendIDs(tasks)
	appendIDs(logJobIDs)
	appendIDs(resultTaskID)
	return merged, nil
}

// discoverChangedTasks runs the merged query: created inside the window, then
// updated inside the window but created before it. `grp` keeps that order.
func (s *QualitySnapshotScheduler) discoverChangedTasks(ctx context.Context, orgID string, since time.Time) ([]string, error) {
	if s.db == nil {
		return nil, errMySQLUnavailable
	}
	rows, err := s.db.QueryContext(ctx,
		"SELECT `id` FROM ("+
			" SELECT `id`, 0 AS `grp` FROM `CrawlTask` WHERE `orgId` = ? AND `createdAt` >= ?"+
			" UNION ALL"+
			" SELECT `id`, 1 AS `grp` FROM `CrawlTask` WHERE `orgId` = ? AND `createdAt` < ? AND `updatedAt` >= ?"+
			") AS `recent_changed` ORDER BY `grp` ASC, `id` ASC",
		orgID, since, orgID, since, since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := make([]string, 0)
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

// discoverChangedLogs is the TaskLog query: crawl4ai expansion/preflight/dedupe
// logs created inside the window, trimmed and blank-filtered.
func (s *QualitySnapshotScheduler) discoverChangedLogs(ctx context.Context, orgID string, since time.Time) ([]string, error) {
	if s.taskLogs == nil {
		return nil, errMongoUnavailable
	}
	stageList := make(bson.A, 0, len(qualityLogStages))
	for _, stage := range qualityLogStages {
		stageList = append(stageList, stage)
	}
	cursor, err := s.taskLogs.Find(ctx, bson.D{
		{Key: "orgId", Value: orgID},
		{Key: "queue", Value: crawlQueueName},
		{Key: "stage", Value: bson.D{{Key: "$in", Value: stageList}}},
		{Key: "createdAt", Value: bson.D{{Key: "$gte", Value: since}}},
	}, options.Find().SetProjection(bson.D{{Key: "jobId", Value: 1}}))
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)

	ids := make([]string, 0)
	for cursor.Next(ctx) {
		var document struct {
			JobID bson.RawValue `bson:"jobId"`
		}
		if err := cursor.Decode(&document); err != nil {
			return nil, err
		}
		jobID, ok := document.JobID.StringValueOK()
		if !ok {
			continue
		}
		if trimmed := strings.TrimSpace(jobID); trimmed != "" {
			ids = append(ids, trimmed)
		}
	}
	if err := cursor.Err(); err != nil {
		return nil, err
	}
	return ids, nil
}

// discoverChangedResults is the CrawlResult query: taskIds fetched inside the
// window, trimmed and blank-filtered.
func (s *QualitySnapshotScheduler) discoverChangedResults(ctx context.Context, orgID string, since time.Time) ([]string, error) {
	if s.db == nil {
		return nil, errMySQLUnavailable
	}
	rows, err := s.db.QueryContext(ctx,
		"SELECT `taskId` FROM `CrawlResult` WHERE `orgId` = ? AND `fetchedAt` >= ?",
		orgID, since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := make([]string, 0)
	for rows.Next() {
		var taskID string
		if err := rows.Scan(&taskID); err != nil {
			return nil, err
		}
		if trimmed := strings.TrimSpace(taskID); trimmed != "" {
			ids = append(ids, trimmed)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return ids, nil
}
