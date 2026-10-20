package bullmqcleanup

import (
	"context"
	"log"
	"sync"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/cronlock"
)

const (
	// lockName is the logical lease name. cronlock prefixes "lock:", so the
	// physical key is lock:cron:bullmq-retained-cleanup.
	lockName = "cron:bullmq-retained-cleanup"
	// lockTTL is shorter than CleanInterval (55m < 60m) so a crashed holder's
	// lease always expires before the next tick.
	lockTTL = 55 * time.Minute
	// runTimeout bounds one cycle so a hung Redis command cannot hold the
	// scheduler goroutine forever.
	runTimeout = 30 * time.Minute
)

// Scheduler runs the immediate cycle followed by one cycle per hour, taking the
// distributed lease first. It replaces the per-process setInterval in
// BullmqQueueCleanupService (issue B1).
type Scheduler struct {
	cleaner  *Cleaner
	lock     *cronlock.Lock
	interval time.Duration

	mu     sync.Mutex
	cancel context.CancelFunc
	wg     sync.WaitGroup
}

// NewScheduler builds the scheduler. interval defaults to CleanInterval.
func NewScheduler(cleaner *Cleaner, lock *cronlock.Lock) *Scheduler {
	return &Scheduler{cleaner: cleaner, lock: lock, interval: CleanInterval}
}

// Start launches one goroutine that runs the cycle immediately and then every
// interval. It is idempotent.
func (s *Scheduler) Start(ctx context.Context) {
	if s == nil {
		return
	}
	s.mu.Lock()
	if s.cancel != nil {
		s.mu.Unlock()
		return
	}
	runCtx, cancel := context.WithCancel(ctx)
	s.cancel = cancel
	s.wg.Add(1)
	s.mu.Unlock()

	go func() {
		defer s.wg.Done()
		s.run(runCtx)
		ticker := time.NewTicker(s.interval)
		defer ticker.Stop()
		for {
			select {
			case <-runCtx.Done():
				return
			case <-ticker.C:
				s.run(runCtx)
			}
		}
	}()
}

// Close stops new ticks and waits for the in-flight cycle (or its cancellation)
// before the shared Redis client is closed.
func (s *Scheduler) Close(ctx context.Context) error {
	if s == nil {
		return nil
	}
	s.mu.Lock()
	cancel := s.cancel
	s.cancel = nil
	s.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	done := make(chan struct{})
	go func() {
		s.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-ctx.Done():
	}
	return nil
}

// RunOnce executes one leased cycle. It returns acquired=false when another
// instance owns the lease; runner is then not executed. The integration tests
// call it directly to prove that two instances produce one cleanup.
func (s *Scheduler) RunOnce(ctx context.Context) (bool, error) {
	if s == nil || s.cleaner == nil || s.lock == nil {
		return false, nil
	}
	runCtx, cancel := context.WithTimeout(ctx, runTimeout)
	defer cancel()
	return s.lock.WithLock(runCtx, lockName, lockTTL, func(ctx context.Context) error {
		return s.cleaner.CleanAll(ctx)
	})
}

// run executes one cycle and logs failures. A lease held elsewhere is not an
// error: that instance is performing the cycle.
func (s *Scheduler) run(ctx context.Context) {
	_, err := s.RunOnce(ctx)
	if err != nil && ctx.Err() == nil {
		log.Printf("bullmqcleanup: retained-job cleanup cycle: %v", err)
	}
}
