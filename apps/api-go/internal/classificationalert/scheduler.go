package classificationalert

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/metrics"
)

// MetricSchedulerName is the "scheduler" label written to the existing
// scheduler_runs_total family. NestJS records
// recordSchedulerRun("classification_quality_alerts", "success"|"failure").
const MetricSchedulerName = "classification_quality_alerts"

// Constants mirrored from classification-quality-alert-scheduler.service.ts.
const (
	// summaryWindow is the window the cron always requests:
	// getSummary({orgId, window:"1h"}).
	summaryWindow = "1h"
	// tickInterval is the @Interval argument
	// (CLASSIFICATION_ALERT_SCHEDULER_INTERVAL_MS = 5 minutes). @Interval waits
	// one full interval before the first call, so Start does not evaluate
	// immediately.
	tickInterval = 5 * time.Minute
	// tickGateKey is claimSchedulerTick's raw Redis key; it deliberately has no
	// "lock:" prefix.
	tickGateKey = "cron:classification-quality-alert:tick-gate"
	// tickGateTTL is CLASSIFICATION_ALERT_TICK_GATE_TTL_MS (4m45s = 285s).
	tickGateTTL = 4*time.Minute + 45*time.Second
	// orgLockTTL is CLASSIFICATION_ALERT_LOCK_TTL_MS (4 minutes).
	orgLockTTL = 4 * time.Minute
)

// OrgOutcome is the terminal state of one scheduled organization evaluation.
type OrgOutcome string

const (
	// OrgOutcomeCompleted means the summary evaluation returned without error.
	OrgOutcomeCompleted OrgOutcome = "completed"
	// OrgOutcomeFailed means the summary evaluation, the organization lease or
	// the fan-out worker failed.
	OrgOutcomeFailed OrgOutcome = "failed"
	// OrgOutcomeSkipped means another owner holds the organization lease.
	OrgOutcomeSkipped OrgOutcome = "skipped"
)

// OrgResult is one settled organization evaluation.
type OrgResult struct {
	// OrgID is the evaluated organization.
	OrgID string
	// Outcome is the terminal state.
	Outcome OrgOutcome
	// Err is the summary or lease error; nil for completed and skipped runs.
	Err error
	// rejected marks a fan-out rejection (lease error, panic or canceled
	// context). NestJS counts rejected items as failed and warns for each one,
	// while a "failed" getSummary value was already warned inside evaluateOrg,
	// so the tick loop only logs this flag.
	rejected bool
}

// TickResult is the outcome of one evaluate() invocation. The tick-level error
// is returned separately; every organization failure is reported here so the
// tick itself keeps running.
type TickResult struct {
	// Claimed is false when another instance owns this five-minute interval.
	Claimed bool
	// OrgCount is the number of active organizations read for the tick.
	OrgCount int
	// Concurrency is the persisted value read before the fan-out clamps it to
	// [1, OrgCount] like settleWithConcurrency.
	Concurrency int
	// CompletedOrgs, FailedOrgs and SkippedOrgs mirror the tick summary log.
	CompletedOrgs int
	FailedOrgs    int
	SkippedOrgs   int
	// OrgResults is ordered like the active organization list.
	OrgResults []OrgResult
}

// SummaryEvaluator evaluates one organization's classification quality summary
// and its side effects. It is implemented by
// (*classificationrssops.Service).EvaluateClassificationQualityAlerts, the
// getSummary({orgId, window:"1h"}) equivalent.
type SummaryEvaluator interface {
	EvaluateClassificationQualityAlerts(ctx context.Context, orgID, window string) error
}

// ActiveOrgLister reads the active organizations ordered by id ascending. The
// default implementation is ActiveOrgRegistryService.listActiveOrgs: the shared
// Redis cache first and MySQL on any cache failure.
type ActiveOrgLister interface {
	ListActiveOrgIDs(ctx context.Context) ([]string, error)
}

// OrgConcurrencyReader reads classificationQualityAlertOrgConcurrency from the
// multi_tenant_scheduler_runtime_settings SystemSetting. The default
// implementation validates the whole stored record and caches the result for 30
// seconds like MultiTenantSchedulerSettingsService.getRuntimeSettings.
type OrgConcurrencyReader interface {
	ReadClassificationQualityAlertOrgConcurrency(ctx context.Context) (int, error)
}

// TickGate claims one cluster-wide scheduler interval. The default
// implementation is rediscache.ClaimTick.
type TickGate interface {
	ClaimTick(ctx context.Context, key string, ttl time.Duration, now time.Time) (bool, error)
}

// OrgLocker runs one organization evaluation under a shared lease. The default
// implementation is rediscache.WithLock, which adds the "lock:" prefix and keeps
// the lease renewed while the runner works.
type OrgLocker interface {
	WithLock(ctx context.Context, key string, ttl time.Duration, runner func(context.Context) error) (bool, error)
}

// Options wires the scheduler. DB and Redis back the default production
// implementations of ActiveOrgs, Concurrency, TickGate and OrgLocker; any of
// those can be replaced directly, which is how the evaluation flow is unit
// tested without infrastructure.
type Options struct {
	// DB is the MySQL pool used by the default active-organization reader and
	// the default runtime-settings reader.
	DB *sql.DB
	// Redis is the shared Redis client used by the default tick gate,
	// organization lock and active-organization cache.
	Redis *redis.Client
	// Summary evaluates one organization and is required.
	Summary SummaryEvaluator
	// ActiveOrgs overrides the default ActiveOrgRegistryService equivalent.
	ActiveOrgs ActiveOrgLister
	// Concurrency overrides the default SystemSetting reader.
	Concurrency OrgConcurrencyReader
	// TickGate overrides the default claimSchedulerTick implementation.
	TickGate TickGate
	// OrgLocker overrides the default CacheService.withLock implementation.
	OrgLocker OrgLocker
	// Now is an optional clock for the tick-gate payload and the runtime
	// settings cache. Production uses time.Now.
	Now func() time.Time
}

// Scheduler owns the five-minute tick, the tick gate and the per-organization
// leases. Start launches one goroutine; Close stops new ticks and drains the
// in-flight evaluation before the caller closes Redis and MySQL.
type Scheduler struct {
	options Options
	// interval is the production five-minute tick period; only tests override
	// it to keep the lifecycle test fast.
	interval time.Duration

	startOnce sync.Once
	stopOnce  sync.Once
	stop      chan struct{}
	cancel    context.CancelFunc
	wg        sync.WaitGroup
}

// NewScheduler builds the scheduler and fills in the production dependencies for
// every optional Options field. It fails only when Summary is missing, because
// that is the one dependency this package cannot construct.
func NewScheduler(options Options) (*Scheduler, error) {
	if options.Summary == nil {
		return nil, errors.New("classificationalert: summary evaluator is required")
	}
	if options.Now == nil {
		options.Now = time.Now
	}
	if options.TickGate == nil {
		options.TickGate = redisTickGate{client: options.Redis}
	}
	if options.OrgLocker == nil {
		options.OrgLocker = redisOrgLocker{client: options.Redis}
	}
	if options.ActiveOrgs == nil {
		options.ActiveOrgs = &activeOrgRegistry{db: options.DB, redis: options.Redis}
	}
	if options.Concurrency == nil {
		options.Concurrency = newSystemSettingConcurrencyReader(options.DB, options.Now)
	}
	return &Scheduler{
		options:  options,
		interval: tickInterval,
		stop:     make(chan struct{}),
	}, nil
}

// Start launches the five-minute loop. Like @Interval the first tick happens one
// full interval after Start, never immediately.
func (s *Scheduler) Start(parent context.Context) {
	if s == nil {
		return
	}
	s.startOnce.Do(func() {
		if parent == nil {
			parent = context.Background()
		}
		ctx, cancel := context.WithCancel(parent)
		s.cancel = cancel
		s.wg.Add(1)
		go func() {
			defer s.wg.Done()
			s.loop(ctx)
		}()
	})
}

// Close stops new ticks and waits for the in-flight evaluation, bounded by ctx.
// It is idempotent and safe to call without Start.
func (s *Scheduler) Close(ctx context.Context) error {
	if s == nil {
		return nil
	}
	if ctx == nil {
		ctx = context.Background()
	}
	s.stopOnce.Do(func() { close(s.stop) })
	done := make(chan struct{})
	go func() {
		s.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
		s.cancelRun()
		return nil
	case <-ctx.Done():
		s.cancelRun()
		return ctx.Err()
	}
}

// cancelRun releases the loop context once.
func (s *Scheduler) cancelRun() {
	if s.cancel != nil {
		s.cancel()
	}
}

// loop fires one evaluation per interval until Close or the parent context
// stops it. A failed tick is logged and the next interval is still attempted.
func (s *Scheduler) loop(ctx context.Context) {
	interval := s.interval
	if interval <= 0 {
		interval = tickInterval
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-s.stop:
			return
		case <-ticker.C:
			if _, err := s.EvaluateOnce(ctx); err != nil {
				log.Printf("classificationalert: scheduler tick failed: %v", err)
			}
		}
	}
}

// EvaluateOnce runs exactly one scheduler evaluation. It is the exported
// equivalent of the NestJS @Interval callback, and it is also what Start calls
// on every tick; integration tests use it to evaluate without waiting for the
// five-minute timer.
func (s *Scheduler) EvaluateOnce(ctx context.Context) (TickResult, error) {
	if s == nil || s.options.Summary == nil {
		return TickResult{}, errors.New("classificationalert: scheduler is not configured")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	return s.runTick(ctx)
}

// runTick mirrors evaluate(): claim the tick, read the active organizations and
// the persisted concurrency, then settle every organization under its lease.
func (s *Scheduler) runTick(ctx context.Context) (TickResult, error) {
	now := s.options.Now()
	claimed, err := s.options.TickGate.ClaimTick(ctx, tickGateKey, tickGateTTL, now)
	if err != nil {
		return TickResult{}, fmt.Errorf("classificationalert: claim tick gate: %w", err)
	}
	if !claimed {
		log.Print("classificationalert: skipped tick because another instance already claimed this interval")
		return TickResult{Claimed: false}, nil
	}

	orgIDs, err := s.options.ActiveOrgs.ListActiveOrgIDs(ctx)
	if err != nil {
		return TickResult{Claimed: true}, fmt.Errorf("classificationalert: list active organizations: %w", err)
	}
	// NestJS returns before reading the runtime settings when there is no active
	// organization, so an invalid persisted concurrency does not fail an idle
	// tick.
	if len(orgIDs) == 0 {
		return TickResult{Claimed: true}, nil
	}

	concurrency, err := s.options.Concurrency.ReadClassificationQualityAlertOrgConcurrency(ctx)
	if err != nil {
		return TickResult{Claimed: true}, fmt.Errorf("classificationalert: read classificationQualityAlertOrgConcurrency: %w", err)
	}
	log.Printf("classificationalert: tick started orgCount=%d concurrency=%d", len(orgIDs), concurrency)

	results := s.runOrgs(ctx, orgIDs, concurrency)
	completed, failed, skipped := 0, 0, 0
	for _, result := range results {
		switch result.Outcome {
		case OrgOutcomeCompleted:
			completed++
		case OrgOutcomeSkipped:
			skipped++
		case OrgOutcomeFailed:
			failed++
			if result.rejected {
				log.Printf("classificationalert: tick failed for org orgId=%s err=%v", result.OrgID, result.Err)
			}
		}
	}
	log.Printf("classificationalert: tick completed orgCount=%d concurrency=%d failedOrgs=%d skippedOrgs=%d",
		len(orgIDs), concurrency, failed, skipped)
	return TickResult{
		Claimed:       true,
		OrgCount:      len(orgIDs),
		Concurrency:   concurrency,
		CompletedOrgs: completed,
		FailedOrgs:    failed,
		SkippedOrgs:   skipped,
		OrgResults:    results,
	}, nil
}

// EvaluateOrg mirrors evaluateOrg: take the organization lease and run the
// summary evaluation inside it. A lease held by another owner yields
// OrgOutcomeSkipped; any error, including a panic in the evaluator (the Go
// equivalent of a synchronous throw the NestJS try/catch would catch), fails
// only this organization.
func (s *Scheduler) EvaluateOrg(ctx context.Context, orgID string) (result OrgResult) {
	defer func() {
		if recovered := recover(); recovered != nil {
			result = OrgResult{
				OrgID:    orgID,
				Outcome:  OrgOutcomeFailed,
				Err:      fmt.Errorf("classificationalert: panic while evaluating org: %v", recovered),
				rejected: true,
			}
		}
	}()
	if s == nil || s.options.Summary == nil {
		return OrgResult{
			OrgID:    orgID,
			Outcome:  OrgOutcomeFailed,
			Err:      errors.New("classificationalert: scheduler is not configured"),
			rejected: true,
		}
	}
	if ctx == nil {
		ctx = context.Background()
	}
	outcome := OrgOutcomeSkipped
	var runnerErr error
	acquired, err := s.options.OrgLocker.WithLock(ctx, orgLockKey(orgID), orgLockTTL, func(lockCtx context.Context) error {
		if summaryErr := s.options.Summary.EvaluateClassificationQualityAlerts(lockCtx, orgID, summaryWindow); summaryErr != nil {
			metrics.RecordSchedulerRun(MetricSchedulerName, metrics.SchedulerStatusFailure)
			log.Printf("classificationalert: scheduled classification quality alert evaluation failed orgId=%s: %v", orgID, summaryErr)
			outcome = OrgOutcomeFailed
			runnerErr = summaryErr
			// The error is settled here exactly like the try/catch inside the
			// NestJS withLock callback, so WithLock must still release cleanly.
			return nil
		}
		metrics.RecordSchedulerRun(MetricSchedulerName, metrics.SchedulerStatusSuccess)
		outcome = OrgOutcomeCompleted
		return nil
	})
	if err != nil {
		return OrgResult{OrgID: orgID, Outcome: OrgOutcomeFailed, Err: err, rejected: true}
	}
	if !acquired {
		log.Printf("classificationalert: skipped org because previous run is still in progress orgId=%s", orgID)
		return OrgResult{OrgID: orgID, Outcome: OrgOutcomeSkipped}
	}
	return OrgResult{OrgID: orgID, Outcome: outcome, Err: runnerErr}
}

// runOrgs mirrors settleWithConcurrency: at most clamp(concurrency, len(orgIDs))
// workers run at once, every organization is attempted, and results are written
// back at the input index so the order is preserved.
func (s *Scheduler) runOrgs(ctx context.Context, orgIDs []string, concurrency int) []OrgResult {
	results := make([]OrgResult, len(orgIDs))
	if len(orgIDs) == 0 {
		return results
	}
	sem := make(chan struct{}, clampConcurrency(concurrency, len(orgIDs)))
	var wg sync.WaitGroup
	for index, orgID := range orgIDs {
		sem <- struct{}{}
		wg.Add(1)
		go func(index int, orgID string) {
			defer wg.Done()
			defer func() { <-sem }()
			results[index] = s.EvaluateOrg(ctx, orgID)
		}(index, orgID)
	}
	wg.Wait()
	return results
}

// clampConcurrency mirrors
// Math.max(1, Math.min(items.length, Math.floor(concurrency))).
func clampConcurrency(concurrency, itemCount int) int {
	value := concurrency
	if value > itemCount {
		value = itemCount
	}
	if value < 1 {
		value = 1
	}
	return value
}

// orgLockKey is the logical CacheService.withLock key. rediscache.WithLock
// prefixes "lock:", so the physical Redis key is
// "lock:quality:classification:alert-scheduler:<orgId>:1h" exactly like NestJS.
func orgLockKey(orgID string) string {
	return "quality:classification:alert-scheduler:" + orgID + ":1h"
}
