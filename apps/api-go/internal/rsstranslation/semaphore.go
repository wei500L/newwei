package rsstranslation

import (
	"context"
	"sync"
)

// semaphore is the Go port of the NestJS AsyncSemaphore: a per-service shared
// concurrency limit that can be re-set from the stored settings on each
// request. It is an in-process limit only; no distributed lock is involved,
// exactly like the JavaScript semaphore it replaces.
//
// Release and setLimit broadcast on a channel that is replaced under the
// mutex, so a waiter never misses a wakeup: it reads the current channel before
// unlocking and re-checks the counter after waking.
type semaphore struct {
	mu     sync.Mutex
	limit  int
	active int
	notify chan struct{}
}

func newSemaphore(limit int) *semaphore {
	if limit < 1 {
		limit = 1
	}
	return &semaphore{limit: limit, notify: make(chan struct{})}
}

// setLimit applies a new limit and wakes every waiter to re-check. NestJS
// truncates and floors the limit at 1.
func (s *semaphore) setLimit(limit int) {
	if limit < 1 {
		limit = 1
	}
	s.mu.Lock()
	s.limit = limit
	s.broadcastLocked()
	s.mu.Unlock()
}

// withPermit runs fn while holding one permit. The wait is cancellable through
// ctx; a cancelled waiter never consumes a permit.
func (s *semaphore) withPermit(ctx context.Context, fn func()) error {
	if err := s.acquire(ctx); err != nil {
		return err
	}
	defer s.release()
	fn()
	return nil
}

func (s *semaphore) acquire(ctx context.Context) error {
	for {
		s.mu.Lock()
		if s.active < s.limit {
			s.active++
			s.mu.Unlock()
			return nil
		}
		notify := s.notify
		s.mu.Unlock()
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-notify:
		}
	}
}

func (s *semaphore) release() {
	s.mu.Lock()
	if s.active > 0 {
		s.active--
	}
	s.broadcastLocked()
	s.mu.Unlock()
}

func (s *semaphore) broadcastLocked() {
	close(s.notify)
	s.notify = make(chan struct{})
}
