package processeditemoutbox

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"log"
	"sync"
	"time"
)

const (
	// lockKey is the physical Redis key. CacheService.withLock prefixes "lock:".
	lockKey = "lock:cron:processed-item-outbox"
	// lockTTL is the 290-second lease.
	lockTTL = 290 * time.Second
	// tickPeriod matches the NestJS @Cron(EVERY_5_MINUTES).
	tickPeriod = 5 * time.Minute
)

// LockStore is the narrow Redis lease port. It matches the methods exposed by
// userdigest.NewRedisDeliveryStore, which the gateway passes in production.
type LockStore interface {
	SetIfAbsent(ctx context.Context, key, value string, ttl time.Duration) (bool, error)
	RenewLock(ctx context.Context, key, token string, ttl time.Duration) error
	ReleaseLock(ctx context.Context, key, token string) error
}

// Scheduler owns the five-minute wall-clock tick and the cross-process scan
// lease. Delivery concurrency and the per-tick budget live in Service.
type Scheduler struct {
	service *Service
	locks   LockStore
	now     func() time.Time

	startOnce sync.Once
	stopOnce  sync.Once
	stop      chan struct{}
	hardStop  context.CancelFunc
	wg        sync.WaitGroup
}

// NewScheduler builds the Go execution owner. A nil service or lock store
// returns a scheduler that does nothing; go-mode wiring treats that as a
// startup error.
func NewScheduler(service *Service, locks LockStore, now func() time.Time) *Scheduler {
	if now == nil {
		now = time.Now
	}
	return &Scheduler{service: service, locks: locks, now: now, stop: make(chan struct{})}
}

// Start launches the five-minute loop without a catch-up tick.
func (s *Scheduler) Start(parent context.Context) {
	if s == nil || s.service == nil || s.locks == nil {
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

// Close stops new ticks, lets the in-flight tick finish, then cancels the
// loop. Rows left processing are recovered by the five-minute stale window.
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
		if s.hardStop != nil {
			s.hardStop()
		}
		return ctx.Err()
	}
}

func (s *Scheduler) loop(ctx context.Context) {
	next := s.now().UTC().Truncate(tickPeriod).Add(tickPeriod)
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
			next = next.Add(tickPeriod)
			if !next.After(now) {
				next = now.Truncate(tickPeriod).Add(tickPeriod)
			}
			timer.Reset(time.Until(next))
		}
	}
}

func (s *Scheduler) runTick(ctx context.Context) {
	if s == nil || s.service == nil || s.locks == nil {
		return
	}
	token, err := newLeaseToken()
	if err != nil {
		log.Printf("processeditemoutbox: generate cron lease token failed: %v", err)
		return
	}
	acquired, err := s.locks.SetIfAbsent(ctx, lockKey, token, lockTTL)
	if err != nil {
		log.Printf("processeditemoutbox: acquire cron lease failed: %v", err)
		return
	}
	if !acquired {
		log.Printf("processeditemoutbox: tick skipped because another instance holds the cron lease")
		return
	}
	stopRenew := s.startLeaseRenew(token)
	defer func() {
		stopRenew()
		releaseCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := s.locks.ReleaseLock(releaseCtx, lockKey, token); err != nil {
			log.Printf("processeditemoutbox: release cron lease failed: %v", err)
		}
	}()
	s.service.RunTick(ctx, 0)
}

func (s *Scheduler) startLeaseRenew(token string) func() {
	interval := lockTTL / 3
	ticker := time.NewTicker(interval)
	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				renewCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				if err := s.locks.RenewLock(renewCtx, lockKey, token, lockTTL); err != nil {
					log.Printf("processeditemoutbox: renew cron lease failed: %v", err)
				}
				cancel()
			}
		}
	}()
	var once sync.Once
	return func() {
		once.Do(func() {
			close(stop)
			<-done
		})
	}
}

func newLeaseToken() (string, error) {
	var buffer [16]byte
	if _, err := rand.Read(buffer[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(buffer[:]), nil
}
