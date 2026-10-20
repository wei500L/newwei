package newseventstimeline

import (
	"context"
	"log"
	"math"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/gdeltsnapshot"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/settingscrawl"
	"github.com/wei500L/newwei/apps/api-go/internal/newsbackfilljobs"
)

// tickInterval is CronExpression.EVERY_10_MINUTES: a wall-clock aligned
// "*/10 * * * *" schedule.
const tickInterval = 10 * time.Minute

// SettingsReader reads the normalized news-event settings for one organization.
type SettingsReader interface {
	Read(ctx context.Context, orgID string) (settingscrawl.NewsEventSettingsModel, error)
}

// ActiveOrgReader lists the active organization ids, ordered by id ascending.
type ActiveOrgReader interface {
	ListActiveOrgIDs(ctx context.Context) ([]string, error)
}

// ConcurrencyReader reads the persisted newsEventsTimelineOrgConcurrency.
type ConcurrencyReader interface {
	ReadNewsEventsTimelineOrgConcurrency(ctx context.Context) (int, error)
}

// schedulerOptions are the production dependencies of the ten-minute loop.
type schedulerOptions struct {
	Store       *store
	Settings    SettingsReader
	Orgs        ActiveOrgReader
	Concurrency ConcurrencyReader
	Redis       *redis.Client
	Logger      *log.Logger
	Now         func() time.Time
}

// orgRunStatus is the per-organization outcome, matching
// NewsEventsTimelineSchedulerOrgRunStatus plus the rejected case.
type orgRunStatus string

const (
	orgRunCompleted orgRunStatus = "completed"
	orgRunSkipped   orgRunStatus = "skipped"
	orgRunFailed    orgRunStatus = "failed"
)

// Scheduler owns the ten-minute tick, the tick gate and the organization leases.
//
// Both the gate and the lease are shared with NestJS: the gate key has no
// "lock:" prefix while the lease key does, so a flip between the two processes
// can never run one organization twice at the same time.
type Scheduler struct {
	store       *store
	settings    SettingsReader
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
		settings:    options.Settings,
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

// Start launches the loop. The first tick is aligned to the next wall-clock ten
// minute boundary; intervals that elapsed before startup are not replayed.
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
		timer := time.NewTimer(nextWallClockDelay(s.clock(), tickInterval))
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
			s.logf("newseventstimeline: tick failed err=%v", err)
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

// runOnce is rebuildRecentTimelines: claim the interval, list the active
// organizations, read the organization concurrency and settle the fan-out.
func (s *Scheduler) runOnce(ctx context.Context) error {
	claimed, err := newsbackfilljobs.ClaimSchedulerTick(ctx, s.redis, tickGateKey, rebuildTickGateTTL, s.clock())
	if err != nil {
		return err
	}
	if !claimed {
		s.logf("newseventstimeline: skipped tick because another instance claimed this interval")
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
		value, err := s.concurrency.ReadNewsEventsTimelineOrgConcurrency(ctx)
		if err != nil {
			return err
		}
		concurrency = value
	}
	s.logf("newseventstimeline: tick started orgCount=%d concurrency=%d", len(orgIDs), concurrency)
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
			s.logf("newseventstimeline: rebuild failed orgId=%s", orgIDs[index])
		}
	}
	s.logf("newseventstimeline: tick completed orgCount=%d completed=%d skipped=%d failed=%d",
		len(orgIDs), completed, skipped, failed)
	return nil
}

// runOrgs bounds the fan-out with the persisted concurrency and waits for every
// started organization. The per-organization error is already logged, so one
// failing organization never aborts the rest of the tick.
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
				s.logf("newseventstimeline: rebuild failed orgId=%s err=%v", orgID, err)
				results[index] = orgRunFailed
				return
			}
			results[index] = status
		}(index, orgID)
	}
	wait.Wait()
	return results
}

// rebuildOrgWithLock mirrors rebuildOrgWithLock: the organization lease name and
// TTL match NestJS, and a lease held elsewhere is a skip rather than a failure.
func (s *Scheduler) rebuildOrgWithLock(ctx context.Context, orgID string) (orgRunStatus, error) {
	if s.locks == nil {
		return orgRunFailed, errNoDatabase
	}
	acquired, err := s.locks.WithLock(ctx, orgLockKeyPrefix+orgID, rebuildOrgLockTTL,
		func(runCtx context.Context) error {
			return s.rebuildOrg(runCtx, orgID)
		})
	if err != nil {
		return orgRunFailed, err
	}
	if !acquired {
		s.logf("newseventstimeline: skipped org because the previous run is still in progress orgId=%s", orgID)
		return orgRunSkipped, nil
	}
	return orgRunCompleted, nil
}

// resolveTimelineRuntimeSettings mirrors resolveTimelineRuntimeSettings.
//
// NewsEventsSettingsService.getSettings always returns a complete, already
// clamped document, so the normalizeBoundedNumber fallbacks in the NestJS
// resolver are unreachable on this path; the same clamps are applied here so the
// function stays correct for a partial document.
func resolveTimelineRuntimeSettings(settings settingscrawl.NewsEventSettingsModel) timelineRuntimeSettings {
	rawLow := clampBoundedNumber(settings.TimelineLowConfidenceThreshold, 0, 1, 0.5)
	rawHigh := clampBoundedNumber(settings.TimelineHighConfidenceThreshold, 0, 1, 0.8)
	low := math.Min(rawLow, rawHigh)
	high := math.Max(rawLow, rawHigh)
	return timelineRuntimeSettings{
		ConfidenceFallback:           clampBoundedNumber(settings.MinCategoryConfidenceForGate, 0, 1, low),
		LowConfidenceThreshold:       low,
		HighConfidenceThreshold:      high,
		DriftKLThreshold:             clampBoundedNumber(settings.TimelineDriftKlThreshold, minDriftKLThreshold, maxDriftKLThreshold, 0.35),
		MinBucketItemsForDrift:       clampBoundedInt(settings.TimelineMinBucketItemsForDrift, minMinBucketItemsForDrift, maxMinBucketItemsForDrift, 3),
		CrossCategoryWarningShare:    clampBoundedNumber(settings.TimelineCrossCategoryWarningShare, 0, 1, 0.3),
		MaxCategoryDistributionItems: clampBoundedInt(settings.TimelineMaxCategoryDistributionItems, minMaxCategoryDistributionItems, maxMaxCategoryDistributionItems, 16),
		MaxPhaseSummaries:            clampBoundedInt(settings.TimelineMaxPhaseSummaries, minMaxPhaseSummaries, maxMaxPhaseSummaries, 8),
	}
}

// clampBoundedNumber mirrors normalizeBoundedNumber.
func clampBoundedNumber(value, min, max, fallback float64) float64 {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return fallback
	}
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}

// clampBoundedInt mirrors normalizeBoundedInt.
func clampBoundedInt(value, min, max, fallback int) int {
	rounded := jsRoundInt(clampBoundedNumber(float64(value), float64(min), float64(max), float64(fallback)))
	if rounded < min {
		return min
	}
	if rounded > max {
		return max
	}
	return rounded
}

// nextWallClockDelay returns the duration to the next multiple of interval on the
// wall clock, mirroring @nestjs/schedule's strictly-future cron date.
func nextWallClockDelay(now time.Time, interval time.Duration) time.Duration {
	nanos := now.UnixNano()
	period := interval.Nanoseconds()
	next := (nanos/period + 1) * period
	return time.Duration(next - nanos)
}
