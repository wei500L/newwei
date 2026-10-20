package itemsingest

import (
	"context"
	"log"
	"sync"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/userdigest"
)

const (
	// rawItemOutboxLockKey matches CacheService.withLock("cron:raw-item-outbox"),
	// which prefixes "lock:".
	rawItemOutboxLockKey = "lock:cron:raw-item-outbox"
	// rawItemOutboxLockTTL matches RAW_ITEM_OUTBOX_LOCK_TTL_MS.
	rawItemOutboxLockTTL = 55 * time.Second
)

// OutboxScheduler owns the per-minute raw_item replay and its physical Redis
// lease. It runs no other outbox type.
type OutboxScheduler struct {
	service *Service
	store   userdigest.DeliveryStore
	now     func() time.Time

	startOnce sync.Once
	stopOnce  sync.Once
	stop      chan struct{}
	hardStop  context.CancelFunc
	wg        sync.WaitGroup
}

// NewOutboxScheduler builds the replay owner. A nil service or store returns a
// scheduler that does nothing; wiring treats that as a startup error.
func NewOutboxScheduler(service *Service, store userdigest.DeliveryStore, now func() time.Time) *OutboxScheduler {
	if now == nil {
		now = time.Now
	}
	return &OutboxScheduler{service: service, store: store, now: now, stop: make(chan struct{})}
}

// Start launches the minute loop without a catch-up tick.
func (s *OutboxScheduler) Start(parent context.Context) {
	if s == nil || s.service == nil || s.store == nil {
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

// Close stops new ticks, drains the in-flight tick, then cancels the loop.
func (s *OutboxScheduler) Close(ctx context.Context) error {
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
		if s.hardStop != nil {
			s.hardStop()
		}
		return ctx.Err()
	}
}

func (s *OutboxScheduler) loop(ctx context.Context) {
	next := s.now().UTC().Truncate(time.Minute).Add(time.Minute)
	timer := time.NewTimer(time.Until(next))
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-s.stop:
			return
		case <-timer.C:
			s.runTick(ctx)
			now := s.now().UTC()
			next = next.Add(time.Minute)
			if !next.After(now) {
				next = now.Truncate(time.Minute).Add(time.Minute)
			}
			timer.Reset(time.Until(next))
		}
	}
}

func (s *OutboxScheduler) runTick(ctx context.Context) {
	token := newUUIDv4()
	acquired, err := s.store.SetIfAbsent(ctx, rawItemOutboxLockKey, token, rawItemOutboxLockTTL)
	if err != nil {
		log.Printf("itemsingest: raw-item outbox lease failed: %v", err)
		return
	}
	if !acquired {
		return
	}
	stopRenew := s.startLeaseRenew(token)
	defer func() {
		stopRenew()
		releaseCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = s.store.ReleaseLock(releaseCtx, rawItemOutboxLockKey, token)
	}()
	s.service.retryPendingOutbox(ctx)
}

// startLeaseRenew renews the lease about every TTL/3 while the tick drains.
func (s *OutboxScheduler) startLeaseRenew(token string) func() {
	interval := rawItemOutboxLockTTL / 3
	ticker := time.NewTicker(interval)
	stop := make(chan struct{})
	var once sync.Once
	go func() {
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				renewCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				if err := s.store.RenewLock(renewCtx, rawItemOutboxLockKey, token, rawItemOutboxLockTTL); err != nil {
					log.Printf("itemsingest: raw-item outbox lease renew failed: %v", err)
				}
				cancel()
			}
		}
	}()
	return func() { once.Do(func() { close(stop) }) }
}
