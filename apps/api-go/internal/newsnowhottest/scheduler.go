package newsnowhottest

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"sort"
	"sync"
	"time"
)

// Background execution. Both schedulers use the same Redis contracts as the
// NestJS classes they replace:
//
//   - the hottest scheduler claims cron:newsnow-hottest-analysis:tick-gate with
//     SET NX EX 585 and a {"claimedAt"} payload, refreshes every active
//     organization under lock:cron:newsnow-hottest-analysis:org:<id> (8 minutes,
//     auto-renewed) with the persisted newsnowHottestAnalysisOrgConcurrency, and
//     builds the global snapshot once per tick;
//   - the source warm scheduler takes lock:cron:newsnow-source-warm (55 seconds,
//     auto-renewed) and fetches the active sources with concurrency six.
const (
	hottestTickGateKey      = "cron:newsnow-hottest-analysis:tick-gate"
	hottestTickGateTTL      = 9*time.Minute + 45*time.Second
	hottestTickInterval     = 10 * time.Minute
	hottestOrgLockKeyPrefix = "cron:newsnow-hottest-analysis:org:"
	hottestOrgLockTTLMillis = 8 * 60 * 1000

	warmLockKey       = "cron:newsnow-source-warm"
	warmLockTTLMillis = 55 * 1000
	warmInterval      = time.Minute
	warmConcurrency   = 6

	activeOrgCacheKey   = "org:active:list:v1"
	activeOrgCacheTTL   = 15 * time.Second
	activeOrgLockKey    = "lock:org:active:list:v1"
	activeOrgLockTTL    = 2 * time.Second
	activeOrgRetryDelay = 50 * time.Millisecond
	activeOrgWaitBudget = 500 * time.Millisecond
)

// OrgReader lists the active organizations.
type OrgReader interface {
	ListActiveOrgIDs(ctx context.Context) ([]string, error)
}

// ConcurrencyReader reads the persisted hottest-analysis organization
// concurrency from the multi-tenant scheduler settings.
type ConcurrencyReader interface {
	ReadNewsnowHottestAnalysisOrgConcurrency(ctx context.Context) (int, error)
}

// ActiveSourceRegistry mirrors NewsnowActiveSourceRegistryService. It is the
// in-process set of source ids watched by the sockets connected to this process;
// the NewsNow WebSocket gateway will populate it when that transport moves to Go.
type ActiveSourceRegistry interface {
	GetAllActiveSourceIDs() []string
}

// SchedulerOptions wires the ten-minute hottest scheduler.
type SchedulerOptions struct {
	Store    Store
	Orgs     OrgReader
	Settings ConcurrencyReader
	Service  *Service
	Logger   *log.Logger
	Now      func() time.Time
	Interval time.Duration
}

// Scheduler owns the ten-minute loop and the tick gate.
type Scheduler struct {
	store    Store
	orgs     OrgReader
	settings ConcurrencyReader
	service  *Service
	logger   *log.Logger
	now      func() time.Time
	interval time.Duration

	startOnce sync.Once
	stopOnce  sync.Once
	stop      chan struct{}
	cancel    context.CancelFunc
	wg        sync.WaitGroup
}

// NewScheduler builds the scheduler; Start launches the loop.
func NewScheduler(options SchedulerOptions) *Scheduler {
	now := options.Now
	if now == nil {
		now = time.Now
	}
	logger := options.Logger
	if logger == nil {
		logger = log.Default()
	}
	interval := options.Interval
	if interval <= 0 {
		interval = hottestTickInterval
	}
	return &Scheduler{
		store:    options.Store,
		orgs:     options.Orgs,
		settings: options.Settings,
		service:  options.Service,
		logger:   logger,
		now:      now,
		interval: interval,
		stop:     make(chan struct{}),
	}
}

// Start launches the loop aligned to the next interval boundary. Missed
// intervals are not replayed.
func (s *Scheduler) Start(parent context.Context) {
	if s == nil {
		return
	}
	s.startOnce.Do(func() {
		ctx, cancel := context.WithCancel(parent)
		s.cancel = cancel
		s.wg.Add(1)
		go func() {
			defer s.wg.Done()
			s.loop(ctx)
		}()
	})
}

// Close stops new ticks and waits for the in-flight tick. A timed-out
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
		if s.cancel != nil {
			s.cancel()
		}
		return nil
	case <-ctx.Done():
		if s.cancel != nil {
			s.cancel()
		}
		return ctx.Err()
	}
}

func (s *Scheduler) loop(ctx context.Context) {
	next := s.now().UTC().Truncate(s.interval).Add(s.interval)
	timer := time.NewTimer(time.Until(next))
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
				if err := s.runTick(ctx); err != nil {
					s.logf("newsnowhottest: scheduler tick failed err=%v", err)
				}
			}()
			now := s.now().UTC()
			next = next.Add(s.interval)
			if !next.After(now) {
				next = now.Truncate(s.interval).Add(s.interval)
			}
			timer.Reset(time.Until(next))
		}
	}
}

// runTick claims one interval, builds the global snapshot once and refreshes
// every active organization.
func (s *Scheduler) runTick(ctx context.Context) error {
	if s == nil || s.store == nil || s.orgs == nil || s.settings == nil || s.service == nil {
		return errors.New("newsnowhottest: scheduler is not fully configured")
	}
	claimed, err := s.claimTick(ctx)
	if err != nil {
		return err
	}
	if !claimed {
		s.logf("newsnowhottest: skipped tick because another instance already claimed this interval")
		return nil
	}
	orgIDs, err := s.listActiveOrgIDs(ctx)
	if err != nil {
		return err
	}
	if len(orgIDs) == 0 {
		return nil
	}
	concurrency, err := s.settings.ReadNewsnowHottestAnalysisOrgConcurrency(ctx)
	if err != nil {
		return err
	}
	s.logf("newsnowhottest: tick started orgCount=%d concurrency=%d", len(orgIDs), concurrency)

	snapshot, err := s.service.EnsureGlobalSnapshot(ctx, "")
	if err != nil {
		return err
	}
	completed, skipped, failed := 0, 0, 0
	mapWithConcurrency(orgIDs, concurrency, func(_ int, orgID string) {
		status := s.refreshOrg(ctx, orgID, snapshot)
		switch status {
		case orgRunCompleted:
			completed++
		case orgRunSkipped:
			skipped++
		default:
			failed++
		}
	})
	s.logf("newsnowhottest: tick completed orgCount=%d completed=%d failed=%d skipped=%d",
		len(orgIDs), completed, failed, skipped)
	return nil
}

type orgRunStatus string

const (
	orgRunCompleted orgRunStatus = "completed"
	orgRunSkipped   orgRunStatus = "skipped"
	orgRunFailed    orgRunStatus = "failed"
)

// refreshOrg takes the organization lease and rebuilds one projection with the
// tick's shared snapshot.
func (s *Scheduler) refreshOrg(ctx context.Context, orgID string, snapshot *GlobalSnapshot) orgRunStatus {
	lease, err := acquireLock(ctx, s.store, hottestOrgLockKeyPrefix+orgID, hottestOrgLockTTLMillis)
	if err != nil {
		s.logf("newsnowhottest: organization lock failed orgId=%s err=%v", orgID, err)
		return orgRunFailed
	}
	if lease == nil {
		s.logf("newsnowhottest: skipped organization refresh because the previous run is still in progress orgId=%s", orgID)
		return orgRunSkipped
	}
	stopRenew := lease.startAutoRenew()
	_, refreshErr := s.service.RefreshProjectionForOrg(ctx, orgID, snapshot)
	stopRenew()
	lease.release()
	if refreshErr != nil {
		s.logf("newsnowhottest: organization refresh failed orgId=%s err=%v", orgID, refreshErr)
		return orgRunFailed
	}
	return orgRunCompleted
}

// claimTick writes the typed tick payload with SET NX EX 585.
func (s *Scheduler) claimTick(ctx context.Context) (bool, error) {
	payload, err := marshalJSON(struct {
		ClaimedAt string `json:"claimedAt"`
	}{ClaimedAt: isoTime(s.now())})
	if err != nil {
		return false, err
	}
	return s.store.SetNX(ctx, hottestTickGateKey, string(payload), hottestTickGateTTL)
}

// listActiveOrgIDs reproduces ActiveOrgRegistryService.listActiveOrgs through the
// shared Redis cache, exactly like the other migrated schedulers.
func (s *Scheduler) listActiveOrgIDs(ctx context.Context) ([]string, error) {
	cached, found, cacheErr := s.readActiveOrgCache(ctx)
	if cacheErr != nil {
		s.logf("newsnowhottest: active org cache read failed; falling back to mysql err=%v", cacheErr)
		return s.orgs.ListActiveOrgIDs(ctx)
	}
	if found {
		return cached, nil
	}
	token, tokenErr := newLockToken()
	if tokenErr != nil {
		return s.orgs.ListActiveOrgIDs(ctx)
	}
	acquired, lockErr := s.store.SetNX(ctx, activeOrgLockKey, token, activeOrgLockTTL)
	if lockErr != nil {
		s.logf("newsnowhottest: active org cache lock failed; falling back to mysql err=%v", lockErr)
		return s.orgs.ListActiveOrgIDs(ctx)
	}
	if acquired {
		defer func() {
			_, _ = s.store.Eval(context.Background(), lockReleaseScript, []string{activeOrgLockKey}, token)
		}()
		if cached, found, err := s.readActiveOrgCache(ctx); err == nil && found {
			return cached, nil
		}
		orgIDs, err := s.orgs.ListActiveOrgIDs(ctx)
		if err != nil {
			return nil, err
		}
		if payload, err := marshalJSON(activeOrgEntries(orgIDs)); err == nil {
			_ = s.store.Set(ctx, activeOrgCacheKey, string(payload), activeOrgCacheTTL)
		}
		return orgIDs, nil
	}
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
	return s.orgs.ListActiveOrgIDs(ctx)
}

type activeOrgEntry struct {
	ID string `json:"id"`
}

func activeOrgEntries(ids []string) []activeOrgEntry {
	entries := make([]activeOrgEntry, 0, len(ids))
	for _, id := range ids {
		entries = append(entries, activeOrgEntry{ID: id})
	}
	return entries
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

// WarmSchedulerOptions wires the one-minute source warm scheduler.
type WarmSchedulerOptions struct {
	Store    Store
	Sources  SourceFetcher
	Registry ActiveSourceRegistry
	Logger   *log.Logger
	Now      func() time.Time
	Interval time.Duration
}

// WarmScheduler owns the one-minute source warm loop.
type WarmScheduler struct {
	store    Store
	sources  SourceFetcher
	registry ActiveSourceRegistry
	logger   *log.Logger
	now      func() time.Time
	interval time.Duration

	startOnce sync.Once
	stopOnce  sync.Once
	stop      chan struct{}
	cancel    context.CancelFunc
	wg        sync.WaitGroup
}

// NewWarmScheduler builds the source warm scheduler.
func NewWarmScheduler(options WarmSchedulerOptions) *WarmScheduler {
	now := options.Now
	if now == nil {
		now = time.Now
	}
	logger := options.Logger
	if logger == nil {
		logger = log.Default()
	}
	interval := options.Interval
	if interval <= 0 {
		interval = warmInterval
	}
	return &WarmScheduler{
		store:    options.Store,
		sources:  options.Sources,
		registry: options.Registry,
		logger:   logger,
		now:      now,
		interval: interval,
		stop:     make(chan struct{}),
	}
}

// Start launches the loop aligned to the next minute boundary.
func (s *WarmScheduler) Start(parent context.Context) {
	if s == nil {
		return
	}
	s.startOnce.Do(func() {
		ctx, cancel := context.WithCancel(parent)
		s.cancel = cancel
		s.wg.Add(1)
		go func() {
			defer s.wg.Done()
			s.loop(ctx)
		}()
	})
}

// Close stops new ticks and waits for the in-flight one.
func (s *WarmScheduler) Close(ctx context.Context) error {
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
		if s.cancel != nil {
			s.cancel()
		}
		return nil
	case <-ctx.Done():
		if s.cancel != nil {
			s.cancel()
		}
		return ctx.Err()
	}
}

func (s *WarmScheduler) loop(ctx context.Context) {
	next := s.now().UTC().Truncate(s.interval).Add(s.interval)
	timer := time.NewTimer(time.Until(next))
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
				if err := s.runTick(ctx); err != nil {
					s.logf("newsnowhottest: source warm tick failed err=%v", err)
				}
			}()
			now := s.now().UTC()
			next = next.Add(s.interval)
			if !next.After(now) {
				next = now.Truncate(s.interval).Add(s.interval)
			}
			timer.Reset(time.Until(next))
		}
	}
}

// runTick takes the warm lease and fetches the active sources with concurrency
// six. A fetch failure is logged and never stops the other sources.
func (s *WarmScheduler) runTick(ctx context.Context) error {
	if s == nil || s.store == nil || s.sources == nil || s.registry == nil {
		return errors.New("newsnowhottest: source warm scheduler is not fully configured")
	}
	lease, err := acquireLock(ctx, s.store, warmLockKey, warmLockTTLMillis)
	if err != nil {
		return err
	}
	if lease == nil {
		s.logf("newsnowhottest: skipped source warm tick because the previous tick is still in progress")
		return nil
	}
	stopRenew := lease.startAutoRenew()
	defer func() {
		stopRenew()
		lease.release()
	}()
	sourceIDs := s.registry.GetAllActiveSourceIDs()
	if len(sourceIDs) == 0 {
		return nil
	}
	mapWithConcurrency(sourceIDs, warmConcurrency, func(_ int, sourceID string) {
		if _, err := s.sources.FetchSource(ctx, sourceID, false); err != nil {
			s.logf("newsnowhottest: active source warm failed sourceId=%s err=%v", sourceID, err)
		}
	})
	return nil
}

func (s *Scheduler) logf(format string, args ...any) {
	if s != nil && s.logger != nil {
		s.logger.Printf(format, args...)
	}
}

func (s *WarmScheduler) logf(format string, args ...any) {
	if s != nil && s.logger != nil {
		s.logger.Printf(format, args...)
	}
}

// InMemoryActiveSourceRegistry is the concurrency-safe in-process session
// registry. It has the same trim/dedupe/drop rules as
// NewsnowActiveSourceRegistryService and is the registry the warm scheduler
// consumes.
type InMemoryActiveSourceRegistry struct {
	mu       sync.Mutex
	sessions map[string]activeSourceSession
}

type activeSourceSession struct {
	orgID     string
	sourceIDs []string
}

// NewActiveSourceRegistry builds an empty registry.
func NewActiveSourceRegistry() *InMemoryActiveSourceRegistry {
	return &InMemoryActiveSourceRegistry{sessions: make(map[string]activeSourceSession)}
}

// SetActiveSources replaces the source list of one socket, mirroring the NestJS
// trim/dedupe/drop rules.
func (r *InMemoryActiveSourceRegistry) SetActiveSources(socketID, orgID string, sourceIDs []string) {
	if r == nil {
		return
	}
	socketID = jsTrim(socketID)
	orgID = jsTrim(orgID)
	unique := make([]string, 0, len(sourceIDs))
	seen := make(map[string]struct{}, len(sourceIDs))
	for _, sourceID := range sourceIDs {
		trimmed := jsTrim(sourceID)
		if trimmed == "" {
			continue
		}
		if _, exists := seen[trimmed]; exists {
			continue
		}
		seen[trimmed] = struct{}{}
		unique = append(unique, trimmed)
	}
	if socketID == "" {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if orgID == "" || len(unique) == 0 {
		delete(r.sessions, socketID)
		return
	}
	r.sessions[socketID] = activeSourceSession{orgID: orgID, sourceIDs: unique}
}

// RemoveSocket forgets one socket.
func (r *InMemoryActiveSourceRegistry) RemoveSocket(socketID string) {
	if r == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.sessions, jsTrim(socketID))
}

// GetAllActiveSourceIDs returns every watched source id in session order.
func (r *InMemoryActiveSourceRegistry) GetAllActiveSourceIDs() []string {
	if r == nil {
		return []string{}
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	order := make([]string, 0, len(r.sessions))
	seen := make(map[string]struct{}, len(r.sessions))
	// Map iteration is not stable; the collected set is what the warm scheduler
	// consumes, and the scheduler fetches with a fixed concurrency, so the order
	// has no effect on the result. Sorting keeps logs deterministic.
	socketIDs := make([]string, 0, len(r.sessions))
	for socketID := range r.sessions {
		socketIDs = append(socketIDs, socketID)
	}
	sort.Strings(socketIDs)
	for _, socketID := range socketIDs {
		for _, sourceID := range r.sessions[socketID].sourceIDs {
			if _, exists := seen[sourceID]; exists {
				continue
			}
			seen[sourceID] = struct{}{}
			order = append(order, sourceID)
		}
	}
	return order
}
