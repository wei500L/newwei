package realtimesignals

import (
	"context"
	"log"
	"sync"
	"time"
)

// minuteInterval is CronExpression.EVERY_MINUTE.
const minuteInterval = time.Minute

// Scheduler owns the wall-clock minute tick when
// API_GO_REALTIME_SIGNALS_MODE=go. Every tick runs in its own goroutine and the
// shared Redis tick gate decides whether this process collects, so a slow round
// cannot shift the cadence and cannot overlap the next one.
type Scheduler struct {
	service *Service
	logger  *log.Logger

	startOnce sync.Once
	stopOnce  sync.Once
	stop      chan struct{}
	hardStop  context.CancelFunc
	loopDone  chan struct{}
	wg        sync.WaitGroup
}

// NewScheduler builds a scheduler for one service.
func NewScheduler(service *Service) *Scheduler {
	logger := log.Default()
	if service != nil && service.logger != nil {
		logger = service.logger
	}
	return &Scheduler{service: service, logger: logger, stop: make(chan struct{}), loopDone: make(chan struct{})}
}

// Start launches the tick loop. It does not replay the minute boundary that
// elapsed before startup.
func (s *Scheduler) Start(parent context.Context) {
	if s == nil || s.service == nil {
		return
	}
	s.startOnce.Do(func() {
		ctx, cancel := context.WithCancel(parent)
		s.hardStop = cancel
		s.wg.Add(1)
		go func() {
			defer s.wg.Done()
			defer close(s.loopDone)
			s.loop(ctx)
		}()
	})
}

// Close stops new ticks and waits for the in-flight round. The wait is bounded by
// ctx; a timeout cancels the round and leaves the shared leases to expire.
func (s *Scheduler) Close(ctx context.Context) error {
	if s == nil {
		return nil
	}
	s.stopOnce.Do(func() { close(s.stop) })
	// Wait for the loop to stop producing ticks before waiting for the in-flight
	// round. Adding to a WaitGroup after Wait has observed a zero counter is a
	// misuse, so the two phases cannot share one wait.
	select {
	case <-s.loopDone:
	case <-ctx.Done():
		if s.hardStop != nil {
			s.hardStop()
		}
		return ctx.Err()
	}
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
		if s.hardStop != nil {
			s.hardStop()
		}
		return ctx.Err()
	}
}

// loop aligns to the next minute boundary and repeats from there. A delayed tick
// re-aligns to a future boundary instead of replaying missed minutes, matching a
// cron that fires on the wall clock.
func (s *Scheduler) loop(ctx context.Context) {
	next := nextMinuteBoundary(s.now())
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
				if err := s.service.RefreshScheduled(ctx); err != nil {
					s.logger.Printf("realtimesignals: scheduled refresh failed: %v", err)
				}
			}()
			now := s.now()
			next = next.Add(minuteInterval)
			if !next.After(now) {
				next = nextMinuteBoundary(now)
			}
			timer.Reset(next.Sub(s.now()))
		}
	}
}

func (s *Scheduler) now() time.Time {
	if s != nil && s.service != nil && s.service.now != nil {
		return s.service.now()
	}
	return time.Now()
}

// nextMinuteBoundary truncates to the minute and adds one, so a tick at exactly
// :00.000 waits a full minute instead of firing immediately twice.
func nextMinuteBoundary(value time.Time) time.Time {
	return value.Truncate(minuteInterval).Add(minuteInterval)
}
