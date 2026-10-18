package userdigest

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"sync"
	"time"
)

const (
	// deliveryTickGateKey is the raw Redis tick gate. It matches the NestJS
	// claimSchedulerTick key and is never deleted while held.
	deliveryTickGateKey = "cron:user-digest-delivery:tick-gate"
	// deliveryTickGateTTL is 55 seconds, matching
	// USER_DIGEST_DELIVERY_TICK_GATE_TTL_MS.
	deliveryTickGateTTL = 55 * time.Second

	// deliveryOrgLockKeyPrefix is the physical organization lock key. NestJS
	// calls CacheService.withLock("cron:user-digest-delivery:org:<id>"), which
	// adds the "lock:" prefix.
	deliveryOrgLockKeyPrefix = "lock:cron:user-digest-delivery:org:"
	// deliveryOrgLockTTL matches USER_DIGEST_ORG_LOCK_TTL_MS.
	deliveryOrgLockTTL = 55 * time.Second

	// deliveryActiveOrgCacheKey and deliveryActiveOrgCacheTTL mirror
	// ActiveOrgRegistryService.
	deliveryActiveOrgCacheKey = "org:active:list:v1"
	deliveryActiveOrgCacheTTL = 15 * time.Second
	// deliveryActiveOrgLockKey is the physical lock CacheService.wrap creates
	// for the active-org fill.
	deliveryActiveOrgLockKey = "lock:org:active:list:v1"
	// deliveryActiveOrgLockTTL is the 2 second fill lock.
	deliveryActiveOrgLockTTL = 2 * time.Second

	// deliveryNotificationChannel is the digest-only Redis pub/sub channel the
	// NestJS subscriber consumes.
	deliveryNotificationChannel = "user-digest:notifications:v1"

	// deliveryScanBatchSize bounds one page of due schedules. The executor keeps
	// scanning with the read-time cursor until the organization is exhausted,
	// so this is a batch size and never a per-tick delivery cap.
	deliveryScanBatchSize = 100
)

// tickGatePayload is the typed tick-gate value. Only claimedAt is stored.
type tickGatePayload struct {
	ClaimedAt string `json:"claimedAt"`
}

// activeOrgEntry is one entry of the active-org cache. The JSON key matches the
// NestJS ActiveOrgEntry shape.
type activeOrgEntry struct {
	ID string `json:"id"`
}

// DeliverySchedulerDeps are the narrow ports the delivery scheduler needs.
type DeliverySchedulerDeps struct {
	Repository DeliveryRepository
	Store      DeliveryStore
	Digest     DigestGenerator
	Mail       MailPort
	Notifier   DeliveryNotifier
	Settings   OrgConcurrencyReader
	// ConsoleBaseURL is the trimmed NEXTAUTH_URL used for the Today link. An
	// empty value falls back to http://localhost:3000.
	ConsoleBaseURL string
	// Now is an optional clock used by tests and DST-sensitive scheduling.
	Now func() time.Time
}

// DeliveryScheduler owns the per-minute tick loop, the organization leases and
// the due schedule scan. Start launches one goroutine; Close stops new ticks,
// drains in-flight organizations and releases leases before the caller closes
// Redis/MySQL.
type DeliveryScheduler struct {
	deps DeliverySchedulerDeps

	startOnce sync.Once
	stopOnce  sync.Once
	closeOnce sync.Once
	stop      chan struct{}
	hardStop  context.CancelFunc
	wg        sync.WaitGroup
}

// NewDeliveryScheduler builds the scheduler from named ports.
func NewDeliveryScheduler(deps DeliverySchedulerDeps) *DeliveryScheduler {
	return &DeliveryScheduler{deps: deps, stop: make(chan struct{})}
}

// Start launches the per-minute loop. It does not run a catch-up tick for
// minutes that elapsed before startup.
func (s *DeliveryScheduler) Start(parent context.Context) {
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

// Close signals the loop to stop starting new ticks and new organization runs,
// waits for in-flight work to finish, then cancels the remaining context. The
// wait is bounded by ctx; a timeout keeps the process from hanging forever.
func (s *DeliveryScheduler) Close(ctx context.Context) error {
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
		s.closeOnce.Do(func() {
			if s.hardStop != nil {
				s.hardStop()
			}
		})
		return nil
	case <-ctx.Done():
		s.closeOnce.Do(func() {
			if s.hardStop != nil {
				s.hardStop()
			}
		})
		return ctx.Err()
	}
}

// loop aligns the first tick to the next minute boundary and repeats every
// minute. A delayed tick is re-aligned to the next future minute instead of
// replaying missed minutes.
func (s *DeliveryScheduler) loop(ctx context.Context) {
	next := s.clock().UTC().Truncate(time.Minute).Add(time.Minute)
	timer := time.NewTimer(time.Until(next))
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-s.stop:
			return
		case <-timer.C:
			if err := s.runTick(ctx); err != nil {
				log.Printf("userdigest: delivery tick failed: %v", err)
			}
			now := s.clock().UTC()
			next = next.Add(time.Minute)
			if !next.After(now) {
				next = now.Truncate(time.Minute).Add(time.Minute)
			}
			timer.Reset(time.Until(next))
		}
	}
}

// runTick claims the interval and runs the active organizations with the
// persisted runtime concurrency. A failed claim silently skips; a Redis failure
// fails the tick instead of continuing without the gate.
func (s *DeliveryScheduler) runTick(ctx context.Context) error {
	if s == nil || s.deps.Repository == nil || s.deps.Store == nil || s.deps.Settings == nil {
		return fmt.Errorf("userdigest: delivery scheduler is not fully configured")
	}
	claimed, err := s.claimTick(ctx)
	if err != nil {
		return err
	}
	if !claimed {
		log.Printf("userdigest: delivery tick skipped because another instance claimed the interval")
		return nil
	}
	orgIDs, err := s.listActiveOrgIDs(ctx)
	if err != nil {
		return err
	}
	if len(orgIDs) == 0 {
		return nil
	}
	concurrency, err := s.deps.Settings.ReadDigestDeliveryOrgConcurrency(ctx)
	if err != nil {
		return err
	}
	if concurrency < 1 || concurrency > 16 {
		return fmt.Errorf("userdigest: digest delivery org concurrency %d is outside 1..16", concurrency)
	}
	log.Printf("userdigest: delivery tick started orgCount=%d concurrency=%d", len(orgIDs), concurrency)

	results := s.runOrgs(ctx, orgIDs, concurrency)
	completed, skipped, failed := 0, 0, 0
	dueTotal, sentTotal, emptyTotal, failedTotal := 0, 0, 0, 0
	for _, result := range results {
		switch result.outcome {
		case orgRunCompleted:
			completed++
		case orgRunSkipped:
			skipped++
		case orgRunFailed:
			failed++
		}
		if result.outcome == orgRunFailed {
			log.Printf("userdigest: delivery org failed orgId=%s err=%v", result.orgID, result.err)
		}
		dueTotal += result.summary.DueCount
		sentTotal += result.summary.SentCount
		emptyTotal += result.summary.EmptyCount
		failedTotal += result.summary.FailedCount
	}
	log.Printf("userdigest: delivery tick completed orgCount=%d completed=%d skipped=%d failed=%d due=%d sent=%d empty=%d failedDue=%d",
		len(orgIDs), completed, skipped, failed, dueTotal, sentTotal, emptyTotal, failedTotal)
	return nil
}

// claimTick writes the typed tick payload with SET NX EX 55. It never deletes
// the key while the interval is held.
func (s *DeliveryScheduler) claimTick(ctx context.Context) (bool, error) {
	payload, err := marshalJSON(tickGatePayload{ClaimedAt: isoTime(s.clock())})
	if err != nil {
		return false, err
	}
	claimed, err := s.deps.Store.SetIfAbsent(ctx, deliveryTickGateKey, string(payload), deliveryTickGateTTL)
	if err != nil {
		return false, fmt.Errorf("userdigest: claim delivery tick gate: %w", err)
	}
	return claimed, nil
}

// listActiveOrgIDs reads the named active-org cache and falls back to MySQL.
// The fill uses the documented NestJS lock key and TTL so a mixed-version tick
// does not stampede the database.
func (s *DeliveryScheduler) listActiveOrgIDs(ctx context.Context) ([]string, error) {
	cached, found, cacheErr := s.readActiveOrgCache(ctx)
	if cacheErr != nil {
		log.Printf("userdigest: active org cache read failed, falling back to mysql: %v", cacheErr)
		return s.deps.Repository.ListActiveOrgIDs(ctx)
	}
	if found {
		return cached, nil
	}

	token, tokenErr := newDeliveryToken()
	if tokenErr != nil {
		return s.deps.Repository.ListActiveOrgIDs(ctx)
	}
	acquired, lockErr := s.deps.Store.SetIfAbsent(ctx, deliveryActiveOrgLockKey, token, deliveryActiveOrgLockTTL)
	if lockErr != nil {
		log.Printf("userdigest: active org cache lock failed, falling back to mysql: %v", lockErr)
		return s.deps.Repository.ListActiveOrgIDs(ctx)
	}
	if acquired {
		defer func() {
			_ = s.deps.Store.ReleaseLock(context.Background(), deliveryActiveOrgLockKey, token)
		}()
		if cached, found, err := s.readActiveOrgCache(ctx); err == nil && found {
			return cached, nil
		}
		orgIDs, err := s.deps.Repository.ListActiveOrgIDs(ctx)
		if err != nil {
			return nil, err
		}
		if payload, err := marshalJSON(activeOrgEntries(orgIDs)); err == nil {
			_ = s.deps.Store.Set(ctx, deliveryActiveOrgCacheKey, string(payload), deliveryActiveOrgCacheTTL)
		}
		return orgIDs, nil
	}

	// Another instance is filling the cache. Wait up to the NestJS wrap budget
	// before falling back to a direct database read.
	deadline := time.Now().Add(500 * time.Millisecond)
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		default:
		}
		time.Sleep(50 * time.Millisecond)
		if cached, found, err := s.readActiveOrgCache(ctx); err == nil && found {
			return cached, nil
		}
	}
	return s.deps.Repository.ListActiveOrgIDs(ctx)
}

// readActiveOrgCache decodes the named JSON array. A malformed entry is treated
// as a cache error so the caller falls back to the database.
func (s *DeliveryScheduler) readActiveOrgCache(ctx context.Context) ([]string, bool, error) {
	raw, found, err := s.deps.Store.Get(ctx, deliveryActiveOrgCacheKey)
	if err != nil || !found {
		return nil, false, err
	}
	var entries []activeOrgEntry
	if err := json.Unmarshal([]byte(raw), &entries); err != nil {
		return nil, false, err
	}
	ids := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.ID != "" {
			ids = append(ids, entry.ID)
		}
	}
	return ids, true, nil
}

// activeOrgEntries converts a typed ID list into the named cache shape.
func activeOrgEntries(ids []string) []activeOrgEntry {
	entries := make([]activeOrgEntry, 0, len(ids))
	for _, id := range ids {
		entries = append(entries, activeOrgEntry{ID: id})
	}
	return entries
}

// orgRunOutcome is the per-organization result the scheduler logs.
type orgRunOutcome string

const (
	orgRunCompleted orgRunOutcome = "completed"
	orgRunSkipped   orgRunOutcome = "skipped"
	orgRunFailed    orgRunOutcome = "failed"
)

// orgRunResult is one settled organization run.
type orgRunResult struct {
	orgID   string
	outcome orgRunOutcome
	summary DigestDeliveryOrgRunSummary
	err     error
}

// runOrgs limits the organization fan-out with the persisted concurrency and
// waits for every started organization before returning. A stop signal prevents
// new organization runs from starting while in-flight ones drain.
func (s *DeliveryScheduler) runOrgs(ctx context.Context, orgIDs []string, concurrency int) []orgRunResult {
	results := make([]orgRunResult, len(orgIDs))
	sem := make(chan struct{}, concurrency)
	var wg sync.WaitGroup
	for index, orgID := range orgIDs {
		select {
		case <-s.stop:
			results[index] = orgRunResult{orgID: orgID, outcome: orgRunSkipped}
			continue
		case <-ctx.Done():
			results[index] = orgRunResult{orgID: orgID, outcome: orgRunFailed, err: ctx.Err()}
			continue
		case sem <- struct{}{}:
		}
		select {
		case <-s.stop:
			<-sem
			results[index] = orgRunResult{orgID: orgID, outcome: orgRunSkipped}
			continue
		default:
		}
		wg.Add(1)
		go func(index int, orgID string) {
			defer wg.Done()
			defer func() { <-sem }()
			summary, outcome, err := s.runOrgWithLock(ctx, orgID)
			results[index] = orgRunResult{orgID: orgID, outcome: outcome, summary: summary, err: err}
		}(index, orgID)
	}
	wg.Wait()
	return results
}

// runOrgWithLock acquires the per-organization lease, keeps it renewed while the
// organization is processed, and releases it with the owner token. A lease held
// by another instance returns skipped.
func (s *DeliveryScheduler) runOrgWithLock(ctx context.Context, orgID string) (DigestDeliveryOrgRunSummary, orgRunOutcome, error) {
	token, err := newDeliveryToken()
	if err != nil {
		return DigestDeliveryOrgRunSummary{}, orgRunFailed, err
	}
	lockKey := deliveryOrgLockKeyPrefix + orgID
	acquired, err := s.deps.Store.SetIfAbsent(ctx, lockKey, token, deliveryOrgLockTTL)
	if err != nil {
		return DigestDeliveryOrgRunSummary{}, orgRunFailed, err
	}
	if !acquired {
		log.Printf("userdigest: delivery org skipped because previous run still in progress orgId=%s", orgID)
		return DigestDeliveryOrgRunSummary{}, orgRunSkipped, nil
	}
	stopRenew := s.startOrgLockRenew(lockKey, token)
	defer stopRenew()
	defer func() {
		// Release with a short background context: the caller may already have
		// cancelled the run context during shutdown, but the lease must still be
		// removed while the token matches.
		releaseCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = s.deps.Store.ReleaseLock(releaseCtx, lockKey, token)
	}()

	summary, err := s.runDueDeliveriesForOrg(ctx, orgID, s.clock())
	if err != nil {
		return summary, orgRunFailed, err
	}
	log.Printf("userdigest: delivery org completed orgId=%s due=%d sent=%d empty=%d failed=%d",
		orgID, summary.DueCount, summary.SentCount, summary.EmptyCount, summary.FailedCount)
	return summary, orgRunCompleted, nil
}

// startOrgLockRenew renews the lease about every TTL/3 until the returned stop
// function runs. The renewal keeps running while an in-flight organization
// drains, so shutdown does not let the lease expire under a running delivery.
func (s *DeliveryScheduler) startOrgLockRenew(key, token string) func() {
	interval := deliveryOrgLockTTL / 3
	if interval <= 0 {
		interval = time.Second
	}
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
				_ = s.deps.Store.RenewLock(renewCtx, key, token, deliveryOrgLockTTL)
				cancel()
			}
		}
	}()
	return func() { once.Do(func() { close(stop) }) }
}

// newDeliveryToken returns a random 16-byte hex owner token for a lease.
func newDeliveryToken() (string, error) {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf[:]), nil
}

// clock returns the scheduler clock. A nil Now uses the wall clock.
func (s *DeliveryScheduler) clock() time.Time {
	if s != nil && s.deps.Now != nil {
		return s.deps.Now()
	}
	return time.Now()
}
