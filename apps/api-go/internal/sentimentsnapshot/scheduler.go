package sentimentsnapshot

import (
	"context"
	"log"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/gdeltsnapshot"
	"github.com/wei500L/newwei/apps/api-go/internal/newsbackfilljobs"
)

// ActiveOrgReader lists the active organization ids, ordered by id ascending.
type ActiveOrgReader interface {
	ListActiveOrgIDs(ctx context.Context) ([]string, error)
}

// ConcurrencyReader reads the persisted sentimentSnapshotOrgConcurrency.
type ConcurrencyReader interface {
	ReadSentimentSnapshotOrgConcurrency(ctx context.Context) (int, error)
}

// schedulerOptions are the production dependencies of the hourly loop.
type schedulerOptions struct {
	Store       *store
	Orgs        ActiveOrgReader
	Concurrency ConcurrencyReader
	Redis       *redis.Client
	Logger      *log.Logger
	Now         func() time.Time
}

// orgRunStatus is the per-organization outcome.
type orgRunStatus string

const (
	orgRunCompleted orgRunStatus = "completed"
	orgRunSkipped   orgRunStatus = "skipped"
	orgRunFailed    orgRunStatus = "failed"
)

// Scheduler owns the hourly tick, the tick gate and the organization leases.
//
// The gate and the lease keys match NestJS byte for byte, so a flip between the
// two processes can never rebuild one organization's day twice at the same time.
type Scheduler struct {
	store       *store
	orgs        ActiveOrgReader
	concurrency ConcurrencyReader
	redis       *redis.Client
	locks       *gdeltsnapshot.SharedLock
	logger      *log.Logger
	now         func() time.Time

	startOnce sync.Once
	stopOnce  sync.Once
	stop      chan struct{}
	wg        sync.WaitGroup
}

// newScheduler builds the scheduler from already-constructed ports.
func newScheduler(options schedulerOptions) *Scheduler {
	now := options.Now
	if now == nil {
		now = time.Now
	}
	return &Scheduler{
		store:       options.Store,
		orgs:        options.Orgs,
		concurrency: options.Concurrency,
		redis:       options.Redis,
		locks:       gdeltsnapshot.NewSharedLock(options.Redis),
		logger:      options.Logger,
		now:         now,
		stop:        make(chan struct{}),
	}
}

func (s *Scheduler) clock() time.Time {
	if s != nil && s.now != nil {
		return s.now()
	}
	return time.Now()
}

func (s *Scheduler) logf(format string, args ...any) {
	if s != nil && s.logger != nil {
		s.logger.Printf(format, args...)
	}
}

// Start launches the loop. The first tick is aligned to the next wall-clock hour
// boundary; intervals that elapsed before startup are not replayed.
func (s *Scheduler) Start(parent context.Context) {
	if s == nil {
		return
	}
	s.startOnce.Do(func() {
		ctx, cancel := context.WithCancel(parent)
		s.wg.Add(1)
		go func() {
			defer s.wg.Done()
			defer cancel()
			s.loop(ctx)
		}()
	})
}

func (s *Scheduler) loop(ctx context.Context) {
	for {
		timer := time.NewTimer(nextWallClockDelay(s.clock(), hourlyInterval))
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-s.stop:
			timer.Stop()
			return
		case <-timer.C:
		}
		if err := s.runOnce(ctx); err != nil {
			s.logf("sentimentsnapshot: tick failed err=%v", err)
		}
	}
}

// Close stops new ticks and waits for the in-flight organizations to drain.
func (s *Scheduler) Close(ctx context.Context) error {
	if s == nil {
		return nil
	}
	s.stopOnce.Do(func() { close(s.stop) })
	done := make(chan struct{})
	go func() {
		s.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// runOnce is rebuildRecentSnapshots.
func (s *Scheduler) runOnce(ctx context.Context) error {
	claimed, err := newsbackfilljobs.ClaimSchedulerTick(ctx, s.redis, snapshotTickGateKey, tickGateTTL, s.clock())
	if err != nil {
		return err
	}
	if !claimed {
		s.logf("sentimentsnapshot: skipped tick because another instance claimed this interval")
		return nil
	}
	if s.orgs == nil {
		return nil
	}
	orgIDs, err := s.orgs.ListActiveOrgIDs(ctx)
	if err != nil {
		return err
	}
	if len(orgIDs) == 0 {
		return nil
	}
	concurrency := 1
	if s.concurrency != nil {
		value, err := s.concurrency.ReadSentimentSnapshotOrgConcurrency(ctx)
		if err != nil {
			return err
		}
		concurrency = value
	}
	s.logf("sentimentsnapshot: tick started orgCount=%d concurrency=%d", len(orgIDs), concurrency)
	results := s.runOrgs(ctx, orgIDs, concurrency)
	completed, skipped, failed := 0, 0, 0
	for index, status := range results {
		switch status {
		case orgRunCompleted:
			completed++
		case orgRunSkipped:
			skipped++
		default:
			failed++
			s.logf("sentimentsnapshot: rebuild failed orgId=%s", orgIDs[index])
		}
	}
	s.logf("sentimentsnapshot: tick completed orgCount=%d completed=%d skipped=%d failed=%d",
		len(orgIDs), completed, skipped, failed)
	return nil
}

// runOrgs bounds the fan-out with the persisted concurrency and waits for every
// started organization. One failing organization never aborts the rest.
func (s *Scheduler) runOrgs(ctx context.Context, orgIDs []string, concurrency int) []orgRunStatus {
	results := make([]orgRunStatus, len(orgIDs))
	if len(orgIDs) == 0 {
		return results
	}
	if concurrency < 1 {
		concurrency = 1
	}
	if concurrency > len(orgIDs) {
		concurrency = len(orgIDs)
	}
	semaphore := make(chan struct{}, concurrency)
	var wait sync.WaitGroup
	for index, orgID := range orgIDs {
		select {
		case <-s.stop:
			results[index] = orgRunSkipped
			continue
		case <-ctx.Done():
			results[index] = orgRunFailed
			continue
		case semaphore <- struct{}{}:
		}
		wait.Add(1)
		go func(index int, orgID string) {
			defer wait.Done()
			defer func() { <-semaphore }()
			status, err := s.rebuildOrgWithLock(ctx, orgID)
			if err != nil {
				s.logf("sentimentsnapshot: rebuild failed orgId=%s err=%v", orgID, err)
				results[index] = orgRunFailed
				return
			}
			results[index] = status
		}(index, orgID)
	}
	wait.Wait()
	return results
}

// rebuildOrgWithLock mirrors rebuildOrgWithLock.
func (s *Scheduler) rebuildOrgWithLock(ctx context.Context, orgID string) (orgRunStatus, error) {
	if s.locks == nil {
		return orgRunFailed, errNoDatabase
	}
	acquired, err := s.locks.WithLock(ctx, snapshotOrgLockFmt+orgID, orgLockTTL,
		func(runCtx context.Context) error {
			return s.rebuildOrg(runCtx, orgID)
		})
	if err != nil {
		return orgRunFailed, err
	}
	if !acquired {
		s.logf("sentimentsnapshot: skipped org because the previous run is still in progress orgId=%s", orgID)
		return orgRunSkipped, nil
	}
	return orgRunCompleted, nil
}

// rebuildOrg is rebuildOrg: today and yesterday as UTC days, each rewritten by
// its own transaction.
//
// The two aggregations run concurrently, exactly like the NestJS Promise.all.
// The two days stay serial (O4 declined): running them concurrently would
// multiply the per-organization aggregation fan-out by two on top of the
// persisted sentimentSnapshotOrgConcurrency, and the hourly cadence has no
// latency pressure that would justify the extra Mongo load.
func (s *Scheduler) rebuildOrg(ctx context.Context, orgID string) error {
	if s.store == nil {
		return errNoDatabase
	}
	todayStart := toUTCDayStart(s.clock())
	for offset := 0; offset < rebuildDays; offset++ {
		bucketStart := todayStart.Add(-time.Duration(offset) * 24 * time.Hour)
		bucketEnd := bucketStart.Add(24 * time.Hour)

		entities, topics, err := s.aggregateBucket(ctx, orgID, bucketStart, bucketEnd)
		if err != nil {
			return err
		}
		if err := s.store.writeBucket(ctx, orgID, bucketStart, entities, topics, s.clock()); err != nil {
			return err
		}
	}
	s.logf("sentimentsnapshot: rebuild completed orgId=%s days=%d", orgID, rebuildDays)
	return nil
}

// aggregateBucket runs both pipelines concurrently and surfaces the first error
// after both have finished.
func (s *Scheduler) aggregateBucket(ctx context.Context, orgID string, start, end time.Time) ([]sentimentAggregateRow, []topicAggregateRow, error) {
	var entities []sentimentAggregateRow
	var topics []topicAggregateRow
	var entityErr error
	var topicErr error
	var wait sync.WaitGroup
	wait.Add(2)
	go func() {
		defer wait.Done()
		entities, entityErr = s.store.aggregateEntitySentiment(ctx, orgID, start, end)
	}()
	go func() {
		defer wait.Done()
		topics, topicErr = s.store.aggregateTopicSentiment(ctx, orgID, start, end)
	}()
	wait.Wait()
	if entityErr != nil {
		return nil, nil, entityErr
	}
	if topicErr != nil {
		return nil, nil, topicErr
	}
	return entities, topics, nil
}

// nextWallClockDelay returns the duration to the next multiple of interval on the
// wall clock, mirroring @nestjs/schedule's strictly-future cron date.
func nextWallClockDelay(now time.Time, interval time.Duration) time.Duration {
	nanos := now.UnixNano()
	period := interval.Nanoseconds()
	next := (nanos/period + 1) * period
	return time.Duration(next - nanos)
}
