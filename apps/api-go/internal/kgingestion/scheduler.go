package kgingestion

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"sync"
	"time"
)

// Scheduler and lock contracts, copied from
// knowledge-graph.ingestion.service.ts and CacheService:
//
//   - The tick gate is SET NX EX 285 with {"claimedAt": <ISO>} on the same key
//     NestJS uses, so only one process (NestJS or Go) claims an interval.
//   - The organization lock is CacheService.withLock("cron:knowledge-graph-
//     ingestion:org:<id>", 60_000), whose physical key is prefixed with "lock:"
//     and whose value is a random token. It is renewed every TTL/3 and released
//     only while the token still matches.
const (
	tickGateKey      = "cron:knowledge-graph-ingestion:tick-gate"
	tickGateTTL      = 285 * time.Second
	orgLockKeyPrefix = "lock:cron:knowledge-graph-ingestion:org:"
	orgLockTTL       = 60 * time.Second
	tickInterval     = 5 * time.Minute

	activeOrgCacheKey   = "org:active:list:v1"
	activeOrgCacheTTL   = 15 * time.Second
	activeOrgLockKey    = "lock:org:active:list:v1"
	activeOrgLockTTL    = 2 * time.Second
	activeOrgRetryDelay = 50 * time.Millisecond
	activeOrgWaitBudget = 500 * time.Millisecond
)

// tickGatePayload is the typed tick-gate value. Only claimedAt is stored.
type tickGatePayload struct {
	ClaimedAt string `json:"claimedAt"`
}

// activeOrgEntry is one entry of the active-organization cache. The JSON key
// matches the NestJS ActiveOrgEntry shape.
type activeOrgEntry struct {
	ID string `json:"id"`
}

// ActiveOrgRepository reads the active organizations from MySQL.
type ActiveOrgRepository interface {
	ListActiveOrgIDs(ctx context.Context) ([]string, error)
}

// ConcurrencyReader reads the persisted knowledge-graph organization
// concurrency from the multi-tenant scheduler settings.
type ConcurrencyReader interface {
	ReadKnowledgeGraphIngestionOrgConcurrency(ctx context.Context) (int, error)
}

// OrgProcessor processes one organization.
type OrgProcessor interface {
	IngestOrg(ctx context.Context, orgID string) (BatchSummary, error)
}

// SchedulerOptions are the production dependencies of the five-minute loop.
type SchedulerOptions struct {
	Repository ActiveOrgRepository
	Store      RedisStore
	Settings   ConcurrencyReader
	Processor  OrgProcessor
	Logger     *log.Logger
	Now        func() time.Time
}

// Scheduler owns the five-minute tick, the tick gate and the organization
// leases.
type Scheduler struct {
	repository ActiveOrgRepository
	store      RedisStore
	settings   ConcurrencyReader
	processor  OrgProcessor
	logger     *log.Logger
	now        func() time.Time

	startOnce sync.Once
	stopOnce  sync.Once
	stop      chan struct{}
	wg        sync.WaitGroup
}

// NewScheduler builds the scheduler. Start must be called to launch the loop.
func NewScheduler(options SchedulerOptions) *Scheduler {
	now := options.Now
	if now == nil {
		now = time.Now
	}
	return &Scheduler{
		repository: options.Repository,
		store:      options.Store,
		settings:   options.Settings,
		processor:  options.Processor,
		logger:     options.Logger,
		now:        now,
		stop:       make(chan struct{}),
	}
}

func (s *Scheduler) clock() time.Time {
	if s != nil && s.now != nil {
		return s.now()
	}
	return time.Now()
}

func (s *Scheduler) logf(format string, args ...any) {
	if s != nil && s.logger != nil {
		s.logger.Printf(format, args...)
	}
}

// Start launches the loop. The first tick is aligned to the next wall-clock
// five-minute boundary; missed intervals are not replayed.
func (s *Scheduler) Start(parent context.Context) {
	if s == nil {
		return
	}
	s.startOnce.Do(func() {
		ctx, cancel := context.WithCancel(parent)
		s.wg.Add(1)
		go func() {
			defer s.wg.Done()
			defer cancel()
			s.loop(ctx)
		}()
	})
}

// Close stops new ticks, waits for the in-flight organizations to drain and
// returns the context error when the caller's budget expires. A timed-out
// organization lock is left to expire naturally.
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
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (s *Scheduler) loop(ctx context.Context) {
	next := s.clock().UTC().Truncate(tickInterval).Add(tickInterval)
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
				s.logf("kgingestion: scheduler tick failed err=%v", err)
			}
			now := s.clock().UTC()
			next = next.Add(tickInterval)
			if !next.After(now) {
				next = now.Truncate(tickInterval).Add(tickInterval)
			}
			timer.Reset(time.Until(next))
		}
	}
}

// runTick claims the global interval, then fans the active organizations out
// with the persisted concurrency. One organization failure never stops the
// others.
func (s *Scheduler) runTick(ctx context.Context) error {
	if s == nil || s.repository == nil || s.store == nil || s.settings == nil || s.processor == nil {
		return errors.New("kgingestion: scheduler is not fully configured")
	}
	claimed, err := s.claimTick(ctx)
	if err != nil {
		return err
	}
	if !claimed {
		s.logf("kgingestion: skipped tick because another instance already claimed this interval")
		return nil
	}

	orgIDs, err := s.listActiveOrgIDs(ctx)
	if err != nil {
		return err
	}
	if len(orgIDs) == 0 {
		return nil
	}
	concurrency, err := s.settings.ReadKnowledgeGraphIngestionOrgConcurrency(ctx)
	if err != nil {
		return err
	}
	s.logf("kgingestion: tick started orgCount=%d concurrency=%d", len(orgIDs), concurrency)

	results := s.runOrgs(ctx, orgIDs, concurrency)
	completed, skipped, failed := 0, 0, 0
	for _, result := range results {
		switch result.outcome {
		case orgRunCompleted:
			completed++
		case orgRunSkipped:
			skipped++
		case orgRunFailed:
			failed++
			s.logf("kgingestion: org failed orgId=%s err=%v", result.orgID, result.err)
		}
	}
	s.logf("kgingestion: tick completed orgCount=%d completed=%d failed=%d skipped=%d",
		len(orgIDs), completed, failed, skipped)
	return nil
}

// claimTick writes the typed tick payload with SET NX EX 285. A Redis failure
// fails the tick instead of running without the gate.
func (s *Scheduler) claimTick(ctx context.Context) (bool, error) {
	payload, err := json.Marshal(tickGatePayload{ClaimedAt: formatISO8601Millis(s.clock())})
	if err != nil {
		return false, err
	}
	claimed, err := s.store.SetIfAbsent(ctx, tickGateKey, string(payload), tickGateTTL)
	if err != nil {
		return false, fmt.Errorf("kgingestion: claim tick gate: %w", err)
	}
	return claimed, nil
}

// listActiveOrgIDs reproduces ActiveOrgRegistryService.listActiveOrgs: the
// named Redis cache first, a short fill lock on a miss, and a MySQL fallback on
// any cache or lock failure.
func (s *Scheduler) listActiveOrgIDs(ctx context.Context) ([]string, error) {
	cached, found, cacheErr := s.readActiveOrgCache(ctx)
	if cacheErr != nil {
		s.logf("kgingestion: active org cache read failed; falling back to mysql err=%v", cacheErr)
		return s.repository.ListActiveOrgIDs(ctx)
	}
	if found {
		return cached, nil
	}

	token, tokenErr := newLockToken()
	if tokenErr != nil {
		return s.repository.ListActiveOrgIDs(ctx)
	}
	acquired, lockErr := s.store.SetIfAbsent(ctx, activeOrgLockKey, token, activeOrgLockTTL)
	if lockErr != nil {
		s.logf("kgingestion: active org cache lock failed; falling back to mysql err=%v", lockErr)
		return s.repository.ListActiveOrgIDs(ctx)
	}
	if acquired {
		defer func() {
			_ = s.store.ReleaseLock(context.Background(), activeOrgLockKey, token)
		}()
		if cached, found, err := s.readActiveOrgCache(ctx); err == nil && found {
			return cached, nil
		}
		orgIDs, err := s.repository.ListActiveOrgIDs(ctx)
		if err != nil {
			return nil, err
		}
		if payload, err := json.Marshal(activeOrgEntries(orgIDs)); err == nil {
			_ = s.store.Set(ctx, activeOrgCacheKey, string(payload), activeOrgCacheTTL)
		}
		return orgIDs, nil
	}

	// Another instance is filling the cache. Wait for the NestJS wrap budget
	// before falling back to a direct database read.
	deadline := time.Now().Add(activeOrgWaitBudget)
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		default:
		}
		time.Sleep(activeOrgRetryDelay)
		if cached, found, err := s.readActiveOrgCache(ctx); err == nil && found {
			return cached, nil
		}
	}
	return s.repository.ListActiveOrgIDs(ctx)
}

func (s *Scheduler) readActiveOrgCache(ctx context.Context) ([]string, bool, error) {
	raw, found, err := s.store.Get(ctx, activeOrgCacheKey)
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

func activeOrgEntries(ids []string) []activeOrgEntry {
	entries := make([]activeOrgEntry, 0, len(ids))
	for _, id := range ids {
		entries = append(entries, activeOrgEntry{ID: id})
	}
	return entries
}

type orgRunOutcome string

const (
	orgRunCompleted orgRunOutcome = "completed"
	orgRunSkipped   orgRunOutcome = "skipped"
	orgRunFailed    orgRunOutcome = "failed"
)

type orgRunResult struct {
	orgID   string
	outcome orgRunOutcome
	err     error
}

// runOrgs bounds the fan-out with the persisted concurrency and waits for every
// started organization. A stop signal prevents new organizations from starting
// while in-flight ones drain.
func (s *Scheduler) runOrgs(ctx context.Context, orgIDs []string, concurrency int) []orgRunResult {
	results := make([]orgRunResult, len(orgIDs))
	if len(orgIDs) == 0 {
		return results
	}
	if concurrency < 1 {
		concurrency = 1
	}
	if concurrency > len(orgIDs) {
		concurrency = len(orgIDs)
	}
	sem := make(chan struct{}, concurrency)
	var wait sync.WaitGroup
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
		wait.Add(1)
		go func(index int, orgID string) {
			defer wait.Done()
			defer func() { <-sem }()
			results[index] = s.runOrgWithLock(ctx, orgID)
		}(index, orgID)
	}
	wait.Wait()
	return results
}

// runOrgWithLock acquires the organization lease, renews it while the
// organization is processed and releases it with the owner token.
func (s *Scheduler) runOrgWithLock(ctx context.Context, orgID string) orgRunResult {
	token, err := newLockToken()
	if err != nil {
		return orgRunResult{orgID: orgID, outcome: orgRunFailed, err: err}
	}
	lockKey := orgLockKeyPrefix + orgID
	acquired, err := s.store.SetIfAbsent(ctx, lockKey, token, orgLockTTL)
	if err != nil {
		return orgRunResult{orgID: orgID, outcome: orgRunFailed, err: err}
	}
	if !acquired {
		s.logf("kgingestion: skipped org because previous run is still in progress orgId=%s", orgID)
		return orgRunResult{orgID: orgID, outcome: orgRunSkipped}
	}

	stopRenew := s.startOrgLockRenew(lockKey, token)
	defer stopRenew()
	defer func() {
		// Release with a short background context: the run context may already
		// be cancelled during shutdown, but the token still matches.
		releaseCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = s.store.ReleaseLock(releaseCtx, lockKey, token)
	}()

	if _, err := s.processor.IngestOrg(ctx, orgID); err != nil {
		return orgRunResult{orgID: orgID, outcome: orgRunFailed, err: err}
	}
	return orgRunResult{orgID: orgID, outcome: orgRunCompleted}
}

// startOrgLockRenew renews the lease about every TTL/3 until the returned stop
// function runs. Renewal keeps running while an in-flight organization drains,
// so shutdown does not let the lease expire under a running write.
func (s *Scheduler) startOrgLockRenew(key, token string) func() {
	interval := orgLockTTL / 3
	if interval < 500*time.Millisecond {
		interval = 500 * time.Millisecond
	}
	done := make(chan struct{})
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ticker.C:
				renewCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				_ = s.store.RenewLock(renewCtx, key, token, orgLockTTL)
				cancel()
			}
		}
	}()
	var once sync.Once
	return func() {
		once.Do(func() { close(done) })
	}
}

// newLockToken returns a random UUID v4, the same shape CacheService uses.
func newLockToken() (string, error) {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	buf[6] = (buf[6] & 0x0f) | 0x40
	buf[8] = (buf[8] & 0x3f) | 0x80
	encoded := hex.EncodeToString(buf[:])
	return encoded[0:8] + "-" + encoded[8:12] + "-" + encoded[12:16] + "-" + encoded[16:20] + "-" + encoded[20:32], nil
}
