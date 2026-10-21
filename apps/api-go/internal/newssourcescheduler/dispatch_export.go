package newssourcescheduler

import (
	"context"
	"errors"
)

// ErrSchedulerNotConfigured is reported when RunScheduleOnce is called on a
// service that was never built. Production wiring always builds the scheduler
// before the refresh route can dispatch, so this only guards a programming
// error instead of silently reporting a dispatch that never happened.
var ErrSchedulerNotConfigured = errors.New("newssourcescheduler: scheduler is not configured")

// RunScheduleOnce takes the shared cron:news-source-scheduler lease and runs one
// scheduleDueSources pass. It is the immediate-dispatch entry point the migrated
// POST /api/situation-monitor/refresh needs.
//
// ran reports whether this call owned the lease and executed the pass. false
// means another scheduler (NestJS or a second api-go instance) is already
// ticking, which lets the caller report the "scheduler is already busy" branch
// instead of claiming a dispatch that never happened. The lease key is the same
// physical "lock:cron:news-source-scheduler" key the wall-clock tick and NestJS
// use, so all three exclude each other.
//
// The gate is NEWS_SOURCE_SCHEDULER_ENABLED (Settings.Enabled) only, exactly like
// NestJS's scheduleCron: SCHEDULE_ENABLED merely decides whether the @Cron
// registration exists, so a manual entry point still dispatches while the
// wall-clock loop is off. When the scheduler switch itself is off no pass runs but
// the call still reports true, because the legacy refresh reports
// schedulerTriggered=true with zero tasks in that state and this entry point keeps
// that observable result unchanged.
func (s *Service) RunScheduleOnce(ctx context.Context) (bool, error) {
	if s == nil {
		return false, ErrSchedulerNotConfigured
	}
	if !s.settings.Enabled {
		return true, nil
	}
	return s.withLock(ctx, schedulerLockKey, s.settings.LockTTL, func(lockCtx context.Context) error {
		s.scheduleDueSources(lockCtx, s.now())
		return nil
	})
}

// RunScheduleOnce delegates to the service behind the wall-clock loop, so a
// caller outside this package can dispatch through the scheduler handle it
// already holds (the situation monitor refresh route does). A nil scheduler or a
// nil service reports ErrSchedulerNotConfigured instead of a claimed dispatch.
func (s *Scheduler) RunScheduleOnce(ctx context.Context) (bool, error) {
	if s == nil || s.service == nil {
		return false, ErrSchedulerNotConfigured
	}
	return s.service.RunScheduleOnce(ctx)
}
