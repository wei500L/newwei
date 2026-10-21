package crawlworker

// SharedGlobalConcurrencyLimiter, ported from crawl.processor.ts.
//
// One limiter is shared by the hot, normal and legacy queue workers, so the
// process never runs more than N crawl attempts at once even though each queue
// worker pulls up to N jobs. Priority is strict: a hot waiter is served before a
// normal waiter, and a normal acquisition is refused while any hot waiter is
// queued even when a slot is free, so a burst of hot tasks cannot be starved by
// a long normal backlog. The capacity can be changed at runtime (C2 broadcast)
// and a capacity increase drains the waiters immediately, hot first.

import (
	"context"
	"sync"

	"github.com/wei500L/newwei/apps/api-go/internal/crawlqueue"
)

// limiterSlot is the release function one acquired slot returns.
type limiterSlot func()

// limiterWaiter is one queued acquisition. result is buffered so the drain and
// the close path never block while holding the mutex.
type limiterWaiter struct {
	class   crawlqueue.PriorityClass
	result  chan limiterResult
	settled bool
}

// limiterResult is the drain/close answer to a waiter.
type limiterResult struct {
	release limiterSlot
	err     error
}

// concurrencyLimiter is SharedGlobalConcurrencyLimiter.
type concurrencyLimiter struct {
	mu       sync.Mutex
	capacity int
	active   int
	closed   bool
	hot      []*limiterWaiter
	normal   []*limiterWaiter
}

// newConcurrencyLimiter builds the limiter with an initial capacity of at least
// one, like the NestJS field initializer Math.max(1, Math.round(capacity)).
func newConcurrencyLimiter(capacity int) *concurrencyLimiter {
	return &concurrencyLimiter{capacity: maxInt(1, jsRound(float64(capacity)))}
}

// setCapacity is setCapacity: sanitize, store and drain the waiters.
func (l *concurrencyLimiter) setCapacity(next int) {
	if l == nil {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	l.capacity = maxInt(1, jsRound(float64(next)))
	l.drainLocked()
}

// acquire is acquire: take a slot immediately when the class may use it, or
// queue the waiter until a slot is released, the capacity grows, or the limiter
// is closed. The context is the attempt context: a canceled context withdraws an
// unsettled waiter so worker shutdown does not leave it queued, and a slot that
// was granted in the same instant is released again.
func (l *concurrencyLimiter) acquire(ctx context.Context, class crawlqueue.PriorityClass) (limiterSlot, error) {
	if l == nil {
		return func() {}, nil
	}
	l.mu.Lock()
	if l.closed {
		l.mu.Unlock()
		return nil, errLimiterClosed
	}
	if slot := l.tryAcquireLocked(class); slot != nil {
		l.mu.Unlock()
		return slot, nil
	}
	waiter := &limiterWaiter{
		class:  crawlqueue.NormalizePriorityClass(class),
		result: make(chan limiterResult, 1),
	}
	if waiter.class == crawlqueue.PriorityClassHot {
		l.hot = append(l.hot, waiter)
	} else {
		l.normal = append(l.normal, waiter)
	}
	l.mu.Unlock()

	select {
	case result := <-waiter.result:
		if result.err != nil {
			return nil, result.err
		}
		return result.release, nil
	case <-ctx.Done():
		return l.withdraw(waiter, ctx)
	}
}

// withdraw removes an unsettled waiter. When the drain already granted the slot
// the slot is returned to the pool and the context error wins, because the
// attempt is not going to run.
func (l *concurrencyLimiter) withdraw(waiter *limiterWaiter, ctx context.Context) (limiterSlot, error) {
	l.mu.Lock()
	if waiter.settled {
		l.mu.Unlock()
		select {
		case result := <-waiter.result:
			if result.release != nil {
				result.release()
			}
		default:
		}
		return nil, ctx.Err()
	}
	l.removeWaiterLocked(waiter)
	l.mu.Unlock()
	return nil, ctx.Err()
}

// close is close: refuse new acquisitions and reject every pending waiter with
// the shutting-down error.
func (l *concurrencyLimiter) close() {
	if l == nil {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	l.closed = true
	waiters := make([]*limiterWaiter, 0, len(l.hot)+len(l.normal))
	waiters = append(waiters, l.hot...)
	waiters = append(waiters, l.normal...)
	l.hot = nil
	l.normal = nil
	for _, waiter := range waiters {
		if waiter.settled {
			continue
		}
		waiter.settled = true
		waiter.result <- limiterResult{err: errLimiterShuttingDown}
	}
}

// tryAcquireLocked is tryAcquire: the capacity check, the hot-waiter
// reservation for the normal class, and the slot accounting.
func (l *concurrencyLimiter) tryAcquireLocked(class crawlqueue.PriorityClass) limiterSlot {
	if l.active >= l.capacity {
		return nil
	}
	if crawlqueue.NormalizePriorityClass(class) == crawlqueue.PriorityClassNormal && len(l.hot) > 0 {
		return nil
	}
	l.active++
	return l.newReleaserLocked()
}

// newReleaserLocked builds the idempotent slot release. The caller holds the
// mutex; the release function takes it when invoked.
func (l *concurrencyLimiter) newReleaserLocked() limiterSlot {
	released := false
	return func() {
		l.mu.Lock()
		defer l.mu.Unlock()
		if released {
			return
		}
		released = true
		if l.active > 0 {
			l.active--
		}
		l.drainLocked()
	}
}

// drainLocked is drain: serve waiters, hot first, while slots remain.
func (l *concurrencyLimiter) drainLocked() {
	for l.active < l.capacity {
		waiter := l.shiftWaiterLocked()
		if waiter == nil {
			return
		}
		l.active++
		waiter.settled = true
		waiter.result <- limiterResult{release: l.newReleaserLocked()}
	}
}

// shiftWaiterLocked pops the next waiter: the oldest hot waiter, otherwise the
// oldest normal waiter.
func (l *concurrencyLimiter) shiftWaiterLocked() *limiterWaiter {
	for len(l.hot) > 0 {
		waiter := l.hot[0]
		l.hot = l.hot[1:]
		if waiter.settled {
			continue
		}
		return waiter
	}
	for len(l.normal) > 0 {
		waiter := l.normal[0]
		l.normal = l.normal[1:]
		if waiter.settled {
			continue
		}
		return waiter
	}
	return nil
}

// removeWaiterLocked drops one waiter from its queue.
func (l *concurrencyLimiter) removeWaiterLocked(target *limiterWaiter) {
	queue := &l.normal
	if target.class == crawlqueue.PriorityClassHot {
		queue = &l.hot
	}
	for index, waiter := range *queue {
		if waiter == target {
			*queue = append((*queue)[:index:index], (*queue)[index+1:]...)
			return
		}
	}
}

// stats reports the current capacity and active slots. It exists for tests and
// diagnostics; the limiter itself never reads it.
func (l *concurrencyLimiter) stats() (capacity, active int) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.capacity, l.active
}
