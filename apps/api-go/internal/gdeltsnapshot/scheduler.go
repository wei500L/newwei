package gdeltsnapshot

import (
	"context"
	"log"
	"sync"
	"time"
)

// Scheduler owns the wall-clock 15-minute rebuild when
// API_GO_GDELT_SNAPSHOT_MODE=go. It mirrors the NestJS @Cron("0 */15 * * * *")
// callback: the tick always runs the service's scheduled refresh, and the shared
// Redis lease decides whether this process actually rebuilds.
type Scheduler struct {
	service *Service

	startOnce sync.Once
	stopOnce  sync.Once
	stop      chan struct{}
	hardStop  context.CancelFunc
	wg        sync.WaitGroup
}

// NewScheduler builds a scheduler for one service.
func NewScheduler(service *Service) *Scheduler {
	return &Scheduler{service: service, stop: make(chan struct{})}
}

// Start launches the tick loop. It does not run a catch-up tick for boundaries
// that elapsed before startup.
func (s *Scheduler) Start(parent context.Context) {
	if s == nil {
		return
	}
	s.startOnce.Do(func() {
		ctx, cancel := context.WithCancel(parent)
		s.hardStop = cancel
		s.wg.Add(1)
		go func() {
			defer s.wg.Done()
			s.loop(ctx)
		}()
	})
}

// Close stops new ticks, waits for the in-flight rebuild, then cancels the
// remaining context. The wait is bounded by ctx; a timeout aborts the rebuild
// and leaves the shared lease to expire, which is why the caller must not close
// Redis before Close returns.
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
		if s.hardStop != nil {
			s.hardStop()
		}
		return nil
	case <-ctx.Done():
		// Abort the in-flight rebuild instead of waiting forever. The lease is
		// released best-effort by the lock helper and otherwise expires.
		if s.hardStop != nil {
			s.hardStop()
		}
		return ctx.Err()
	}
}

// loop aligns the first tick to the next quarter-hour boundary and repeats from
// there. Every tick runs in its own goroutine so a slow rebuild cannot shift the
// wall-clock cadence; the shared lease then makes the late tick a no-op instead
// of a second rebuild. A delayed tick re-aligns to a future boundary instead of
// replaying missed boundaries.
func (s *Scheduler) loop(ctx context.Context) {
	next := nextScheduledAt(s.now())
	timer := time.NewTimer(next.Sub(s.now()))
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-s.stop:
			return
		case <-timer.C:
			s.wg.Add(1)
			go func() {
				defer s.wg.Done()
				if err := s.service.refreshScheduled(ctx); err != nil {
					log.Printf("gdeltsnapshot: scheduled refresh failed: %v", err)
				}
			}()
			now := s.now()
			next = next.Add(refreshIntervalMinutes * time.Minute)
			if !next.After(now) {
				next = nextScheduledAt(now)
			}
			timer.Reset(next.Sub(s.now()))
		}
	}
}

// now reads the service clock, falling back to the wall clock.
func (s *Scheduler) now() time.Time {
	if s.service != nil && s.service.now != nil {
		return s.service.now()
	}
	return time.Now()
}
