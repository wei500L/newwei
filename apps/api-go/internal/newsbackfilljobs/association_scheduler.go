package newsbackfilljobs

import (
	"context"
	"database/sql"
	"errors"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/newsindicator"
	"github.com/wei500L/newwei/apps/api-go/internal/runtimesettings"
	"github.com/wei500L/newwei/apps/api-go/internal/userdigest"
)

const (
	// associationTickGateKey mirrors claimSchedulerTick's key. It is a raw key:
	// setIfAbsent does not add the lock: prefix.
	associationTickGateKey = "cron:news-indicator-association:tick-gate"
	// associationTickGateTTL mirrors
	// NEWS_INDICATOR_ASSOCIATION_TICK_GATE_TTL_MS (5h55m).
	associationTickGateTTL = 5*time.Hour + 55*time.Minute
	// associationOrgLockKeyPrefix is the physical CacheService.withLock key of
	// one organization: `lock:` + "cron:news-indicator-association:org:<id>".
	associationOrgLockKeyPrefix = "lock:cron:news-indicator-association:org:"
	// associationOrgLockTTL mirrors
	// NEWS_INDICATOR_ASSOCIATION_ORG_LOCK_TTL_MS (30 minutes).
	associationOrgLockTTL = 30 * time.Minute
)

// AssociationScheduler owns the six-hourly news-indicator association refresh
// while API_GO_NEWS_INDICATOR_ASSOCIATION_CRON_MODE=go. NestJS's
// NewsIndicatorAssociationIngestionService returns before claiming the tick
// gate when the same variable is go, so exactly one runtime refreshes an
// interval.
type AssociationScheduler struct {
	redis        *redis.Client
	associations *newsindicator.Service
	settings     *runtimesettings.Service
	orgs         userdigest.DeliveryRepository
	logger       func(format string, args ...any)
	stop         chan struct{}
	done         chan struct{}
	cancel       context.CancelFunc
	once         sync.Once
}

// NewAssociationScheduler builds the scheduler. The active-organization query
// reuses the ActiveOrgRegistryService equivalent of the digest repository; the
// settings reader reuses the multi-tenant scheduler normalizer.
func NewAssociationScheduler(
	db *sql.DB,
	redisClient *redis.Client,
	associations *newsindicator.Service,
	settings *runtimesettings.Service,
	logger func(format string, args ...any),
) *AssociationScheduler {
	if logger == nil {
		logger = func(string, ...any) {}
	}
	return &AssociationScheduler{
		redis:        redisClient,
		associations: associations,
		settings:     settings,
		orgs:         userdigest.NewMySQLDeliveryRepository(db),
		logger:       logger,
		stop:         make(chan struct{}),
		done:         make(chan struct{}),
	}
}

// Start launches the wall-clock loop at minute 0 of hours 0, 6, 12 and 18
// local time, mirroring the NestJS cron "0 */6 * * *".
func (s *AssociationScheduler) Start(parent context.Context) {
	if s == nil || s.associations == nil || s.settings == nil {
		return
	}
	ctx, cancel := context.WithCancel(parent)
	s.cancel = cancel
	go func() {
		defer close(s.done)
		for {
			next := nextSixHourTick(time.Now())
			timer := time.NewTimer(time.Until(next))
			select {
			case <-s.stop:
				timer.Stop()
				return
			case <-ctx.Done():
				timer.Stop()
				return
			case <-timer.C:
			}
			s.runTick(ctx)
		}
	}()
}

// Close stops starting new ticks, waits for the in-flight tick until ctx
// expires, then cancels it.
func (s *AssociationScheduler) Close(ctx context.Context) error {
	if s == nil {
		return nil
	}
	var closeErr error
	s.once.Do(func() {
		close(s.stop)
		if ctx == nil {
			ctx = context.Background()
		}
		select {
		case <-s.done:
		case <-ctx.Done():
			closeErr = errors.New("newsbackfilljobs: association scheduler did not stop before the deadline")
		}
		if s.cancel != nil {
			s.cancel()
		}
	})
	return closeErr
}

// runTick claims the interval gate, then refreshes every active organization
// under its own lease.
func (s *AssociationScheduler) runTick(ctx context.Context) {
	claimed, err := claimSchedulerTick(ctx, s.redis, associationTickGateKey, associationTickGateTTL, time.Now())
	if err != nil {
		s.logger("newsbackfilljobs: association tick gate failed: %v", err)
		return
	}
	if !claimed {
		s.logger("newsbackfilljobs: skipped association refresh because another instance already claimed this interval")
		return
	}
	orgIDs, err := s.orgs.ListActiveOrgIDs(ctx)
	if err != nil {
		s.logger("newsbackfilljobs: association active org read failed: %v", err)
		return
	}
	if len(orgIDs) == 0 {
		return
	}
	concurrency, err := s.settings.ReadNewsIndicatorAssociationOrgConcurrency(ctx)
	if err != nil {
		s.logger("newsbackfilljobs: association concurrency read failed: %v", err)
		return
	}
	if concurrency < 1 {
		concurrency = 1
	}
	if concurrency > len(orgIDs) {
		concurrency = len(orgIDs)
	}
	s.logger("newsbackfilljobs: association refresh tick started orgCount=%d concurrency=%d", len(orgIDs), concurrency)

	var mu sync.Mutex
	failedOrgs := 0
	skippedOrgs := 0
	sem := make(chan struct{}, concurrency)
	var wg sync.WaitGroup
	for _, orgID := range orgIDs {
		select {
		case <-ctx.Done():
			return
		case sem <- struct{}{}:
		}
		wg.Add(1)
		go func(orgID string) {
			defer wg.Done()
			defer func() { <-sem }()
			outcome := s.refreshOrgWithLock(ctx, orgID)
			mu.Lock()
			switch outcome {
			case associationOrgFailed:
				failedOrgs++
			case associationOrgSkipped:
				skippedOrgs++
			}
			mu.Unlock()
		}(orgID)
	}
	wg.Wait()
	s.logger("newsbackfilljobs: association refresh tick completed orgCount=%d concurrency=%d failedOrgs=%d skippedOrgs=%d",
		len(orgIDs), concurrency, failedOrgs, skippedOrgs)
}

type associationOrgOutcome string

const (
	associationOrgCompleted associationOrgOutcome = "completed"
	associationOrgSkipped   associationOrgOutcome = "skipped"
	associationOrgFailed    associationOrgOutcome = "failed"
)

// refreshOrgWithLock mirrors refreshOrgWithLock: the per-organization lease
// makes the six-hour refresh serial with any manual refresh of the same
// organization, and a lease held elsewhere counts as skipped.
func (s *AssociationScheduler) refreshOrgWithLock(ctx context.Context, orgID string) associationOrgOutcome {
	lock, err := acquireRedisLock(ctx, s.redis, associationOrgLockKeyPrefix+orgID, associationOrgLockTTL)
	if err != nil {
		s.logger("newsbackfilljobs: association org lock failed orgId=%s: %v", orgID, err)
		return associationOrgFailed
	}
	if lock == nil {
		s.logger("newsbackfilljobs: skipped association refresh because the previous org run is still in progress orgId=%s", orgID)
		return associationOrgSkipped
	}
	defer lock.Release()

	if !s.associations.AssociationIngestionEnabled(ctx, orgID) {
		// NestJS returns "completed" here; the organization is not counted as
		// skipped because no other run held its lease.
		return associationOrgCompleted
	}
	if _, err := s.associations.RefreshOrg(ctx, orgID); err != nil {
		s.logger("newsbackfilljobs: association refresh failed orgId=%s: %v", orgID, err)
		return associationOrgFailed
	}
	return associationOrgCompleted
}

// nextSixHourTick returns the next wall clock minute 0 of hours 0, 6, 12 and
// 18 in now's location.
func nextSixHourTick(now time.Time) time.Time {
	location := now.Location()
	year, month, day := now.Date()
	nextHour := (now.Hour()/6)*6 + 6
	if nextHour >= 24 {
		return time.Date(year, month, day+1, 0, 0, 0, 0, location)
	}
	return time.Date(year, month, day, nextHour, 0, 0, 0, location)
}
