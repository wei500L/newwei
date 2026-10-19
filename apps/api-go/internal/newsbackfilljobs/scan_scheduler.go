package newsbackfilljobs

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	// scanLockKey is the physical CacheService.withLock key of the five-minute
	// scan: `lock:` + "cron:news-event-clustering-recovery".
	scanLockKey = "lock:cron:news-event-clustering-recovery"
	// scanLockTTL mirrors CLUSTERING_RECOVERY_SCHEDULER_LOCK_TTL_MS (4 minutes).
	scanLockTTL = 4 * time.Minute
	// scanInterval mirrors @Cron(CronExpression.EVERY_5_MINUTES).
	scanInterval = 5 * time.Minute
)

// ScanScheduler owns the five-minute pending LLM backfill scan while
// API_GO_NEWS_CLUSTERING_RECOVERY_WORKER_MODE=go. NestJS's
// NewsEventClusteringRecoverySchedulerService returns before its lock when the
// same variable is go, so exactly one runtime scans.
type ScanScheduler struct {
	service *Service
	redis   *redis.Client
	stop    chan struct{}
	done    chan struct{}
	cancel  context.CancelFunc
	once    sync.Once
}

// NewScanScheduler builds the scheduler. A nil Redis client makes every tick a
// no-op because the lock cannot be acquired.
func NewScanScheduler(service *Service, redisClient *redis.Client) *ScanScheduler {
	return &ScanScheduler{service: service, redis: redisClient, stop: make(chan struct{}), done: make(chan struct{})}
}

// Start launches the wall-clock loop. It does not run a catch-up tick for
// boundaries that elapsed before startup.
func (s *ScanScheduler) Start(parent context.Context) {
	if s == nil || s.service == nil {
		return
	}
	ctx, cancel := context.WithCancel(parent)
	s.cancel = cancel
	go func() {
		defer close(s.done)
		for {
			next := nextFiveMinuteTick(time.Now())
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
func (s *ScanScheduler) Close(ctx context.Context) error {
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
			closeErr = errors.New("newsbackfilljobs: scan scheduler did not stop before the deadline")
		}
		if s.cancel != nil {
			s.cancel()
		}
	})
	return closeErr
}

// runTick acquires the scan lock and runs the R1 recovery plus the pending
// scan. A lock held by another instance skips the tick, exactly like the
// NestJS withLock null result.
func (s *ScanScheduler) runTick(ctx context.Context) {
	lock, err := acquireRedisLock(ctx, s.redis, scanLockKey, scanLockTTL)
	if err != nil {
		s.service.logger("newsbackfilljobs: scan lock acquire failed: %v", err)
		return
	}
	if lock == nil {
		s.service.logger("newsbackfilljobs: skipped clustering recovery scan because the previous tick is still running")
		return
	}
	defer lock.Release()

	result, err := s.service.Scan(ctx)
	if err != nil {
		s.service.logger("newsbackfilljobs: clustering recovery scan failed: %v", err)
		return
	}
	if result.Queued > 0 || result.Failed > 0 || result.Skipped > 0 || result.Recovered > 0 || result.SkippedNotReady {
		s.service.logger("newsbackfilljobs: clustering recovery scan scanned=%d queued=%d skipped=%d failed=%d recovered=%d skippedNotReady=%t",
			result.Scanned, result.Queued, result.Skipped, result.Failed, result.Recovered, result.SkippedNotReady)
	}
}

// nextFiveMinuteTick returns the next wall-clock five-minute boundary. The
// minute-of-hour is identical in every time zone, so Truncate is exact here.
func nextFiveMinuteTick(now time.Time) time.Time {
	return now.Truncate(scanInterval).Add(scanInterval)
}
