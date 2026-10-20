package crawlmaintenance

import (
	"context"
	"errors"
	"sync"
	"time"
)

var (
	// errRedisUnavailable reports a missing Redis handle.
	errRedisUnavailable = errors.New("crawlmaintenance: redis is not configured")
	// errMySQLUnavailable reports a missing MySQL pool.
	errMySQLUnavailable = errors.New("crawlmaintenance: mysql is not configured")
	// errMongoUnavailable reports a missing Mongo database.
	errMongoUnavailable = errors.New("crawlmaintenance: mongo is not configured")
)

// cronScheduler is the shared wall-clock loop. Each tick recomputes the next
// fire time from the current clock, so a delayed tick is re-aligned instead of
// replaying missed intervals. Close stops new ticks, waits for the in-flight
// tick and then cancels the tick context.
type cronScheduler struct {
	name string
	next func(time.Time) time.Time
	tick func(context.Context) error
	now  func() time.Time
	logf func(format string, args ...any)

	startOnce sync.Once
	stopOnce  sync.Once
	stop      chan struct{}
	hardStop  context.CancelFunc
	wg        sync.WaitGroup
}

func newCronScheduler(name string, next func(time.Time) time.Time, tick func(context.Context) error, now func() time.Time, logf func(string, ...any)) *cronScheduler {
	if now == nil {
		now = time.Now
	}
	if logf == nil {
		logf = func(string, ...any) {}
	}
	return &cronScheduler{name: name, next: next, tick: tick, now: now, logf: logf, stop: make(chan struct{})}
}

// Start launches the loop.
func (s *cronScheduler) Start(parent context.Context) {
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

// Close stops the loop and waits for the in-flight tick. The wait is bounded by
// ctx.
func (s *cronScheduler) Close(ctx context.Context) error {
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
		s.cancel()
		return nil
	case <-ctx.Done():
		s.cancel()
		return ctx.Err()
	}
}

func (s *cronScheduler) cancel() {
	if s.hardStop != nil {
		s.hardStop()
	}
}

func (s *cronScheduler) loop(ctx context.Context) {
	timer := time.NewTimer(time.Until(s.next(s.now())))
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-s.stop:
			return
		case <-timer.C:
			if err := s.tick(ctx); err != nil {
				s.logf("crawlmaintenance: %s tick failed: %v", s.name, err)
			}
			timer.Reset(time.Until(s.next(s.now())))
		}
	}
}

// nextMinute aligns a tick to the next wall-clock minute.
func nextMinute(now time.Time) time.Time {
	return now.Truncate(time.Minute).Add(time.Minute)
}

// nextFiveMinutes aligns a tick to the next wall-clock five-minute boundary
// (:00, :05, :10, ...), matching CronExpression.EVERY_5_MINUTES.
func nextFiveMinutes(now time.Time) time.Time {
	return now.Truncate(5 * time.Minute).Add(5 * time.Minute)
}

// nextLocalHour is CronExpression's daily fire time in the process-local zone
// (@Cron without timeZone). DST changes are handled by rebuilding the date each
// day instead of adding 24h.
func nextLocalHour(now time.Time, hour int) time.Time {
	location := now.Location()
	candidate := time.Date(now.Year(), now.Month(), now.Day(), hour, 0, 0, 0, location)
	if candidate.After(now) {
		return candidate
	}
	return time.Date(now.Year(), now.Month(), now.Day()+1, hour, 0, 0, 0, location)
}
