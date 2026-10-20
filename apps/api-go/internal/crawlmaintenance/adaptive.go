package crawlmaintenance

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sort"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/settingscrawl"
)

// Adaptive concurrency constants copied from CrawlAdaptiveConcurrencyService.
const (
	adaptiveLockTTLMs        = 45_000
	adaptiveMetricSampleSize = 200
)

// crawlSettingsPort is the narrow read/write settings surface the adaptive cron
// needs.
type crawlSettingsPort interface {
	Read(ctx context.Context) (settingscrawl.CrawlClientNormalized, error)
	UpdateMaxConcurrencyInternal(ctx context.Context, maxConcurrency int) (int, error)
}

// adaptiveQueue is the crawl queue control surface (global meta + C2 broadcast).
type adaptiveQueue interface {
	SetGlobalConcurrency(ctx context.Context, value int) error
	PublishWorkerConcurrency(ctx context.Context, maxConcurrency int) error
}

// adaptiveMetricsState is AdaptiveConcurrencyMetrics. Field order is part of the
// cached contract; nullable fields always emit null.
type adaptiveMetricsState struct {
	TaskCount          int      `json:"taskCount"`
	FailedCount        int      `json:"failedCount"`
	ErrorRate          float64  `json:"errorRate"`
	P95LatencyMs       *float64 `json:"p95LatencyMs"`
	MemoryHeadroom     *float64 `json:"memoryHeadroom"`
	MemorySampleCount  int      `json:"memorySampleCount"`
	LatencySampleCount int      `json:"latencySampleCount"`
	SamplingMode       string   `json:"samplingMode"`
}

// adaptiveStateDocument is AdaptiveConcurrencyState. Field order matches the
// NestJS object literal, and no numeric field is omitted.
type adaptiveStateDocument struct {
	Enabled               bool                 `json:"enabled"`
	LastDecision          string               `json:"lastDecision"`
	LastAdjustedAt        *string              `json:"lastAdjustedAt"`
	Reason                *string              `json:"reason"`
	CurrentMaxConcurrency int                  `json:"currentMaxConcurrency"`
	UpdatedAt             string               `json:"updatedAt"`
	Metrics               adaptiveMetricsState `json:"metrics"`
}

// emptyAdaptiveMetrics is createEmptyAdaptiveMetrics.
func emptyAdaptiveMetrics() adaptiveMetricsState {
	return adaptiveMetricsState{SamplingMode: "recent_sample"}
}

// AdaptiveDeps are the production dependencies of the per-minute adjustment.
type AdaptiveDeps struct {
	DB       *sql.DB
	Redis    *redis.Client
	Settings crawlSettingsPort
	Activity activityCounter
	Queue    adaptiveQueue
	Now      func() time.Time
	Logf     func(format string, args ...any)
}

// AdaptiveScheduler owns the per-minute adaptive concurrency adjustment.
type AdaptiveScheduler struct {
	db       *sql.DB
	redis    *redis.Client
	settings crawlSettingsPort
	activity activityCounter
	queue    adaptiveQueue
	logf     func(string, ...any)
	loop     *cronScheduler
}

// NewAdaptiveScheduler builds the scheduler.
func NewAdaptiveScheduler(deps AdaptiveDeps) *AdaptiveScheduler {
	logf := deps.Logf
	if logf == nil {
		logf = func(string, ...any) {}
	}
	scheduler := &AdaptiveScheduler{
		db:       deps.DB,
		redis:    deps.Redis,
		settings: deps.Settings,
		activity: deps.Activity,
		queue:    deps.Queue,
		logf:     logf,
	}
	scheduler.loop = newCronScheduler("crawl-adaptive-concurrency", nextMinute, scheduler.runTick, deps.Now, logf)
	return scheduler
}

// Start launches the per-minute loop.
func (s *AdaptiveScheduler) Start(parent context.Context) { s.loop.Start(parent) }

// Close stops the loop and waits for the in-flight tick.
func (s *AdaptiveScheduler) Close(ctx context.Context) error { return s.loop.Close(ctx) }

// runTick is adjustCron: the shared cron lease decides execution ownership.
func (s *AdaptiveScheduler) runTick(ctx context.Context) error {
	if s == nil || s.db == nil || s.redis == nil || s.settings == nil || s.activity == nil || s.queue == nil {
		return fmt.Errorf("crawlmaintenance: adaptive concurrency is not fully configured")
	}
	now := s.loop.now()
	_, err := withRedisLock(ctx, s.redis, adaptiveLockKey,
		time.Duration(adaptiveLockTTLMs)*time.Millisecond,
		func(runCtx context.Context) error { return s.adjustConcurrency(runCtx, now) })
	return err
}

// adjustConcurrency is adjustConcurrency: every branch persists the state
// document, and the decision text is byte-identical to the NestJS reasons.
func (s *AdaptiveScheduler) adjustConcurrency(ctx context.Context, now time.Time) error {
	settings, err := s.settings.Read(ctx)
	if err != nil {
		return err
	}
	if !settings.Settings.AdaptiveConcurrencyEnabled {
		return s.persistState(ctx, adaptiveStateDocument{
			Enabled:               false,
			LastDecision:          "disabled",
			LastAdjustedAt:        nil,
			Reason:                stringPointer("adaptive concurrency is disabled"),
			CurrentMaxConcurrency: settings.MaxConcurrency,
			UpdatedAt:             formatISO(now),
			Metrics:               emptyAdaptiveMetrics(),
		})
	}

	active, err := s.hasRecentCrawlActivity(ctx, now, settings.Settings.AdaptiveWindowMinutes)
	if err != nil {
		return err
	}
	if !active {
		return s.persistState(ctx, adaptiveStateDocument{
			Enabled:               true,
			LastDecision:          "idle",
			LastAdjustedAt:        nil,
			Reason:                stringPointer("no recent crawl activity"),
			CurrentMaxConcurrency: settings.MaxConcurrency,
			UpdatedAt:             formatISO(now),
			Metrics:               emptyAdaptiveMetrics(),
		})
	}

	metrics, err := s.computeMetrics(ctx, now, settings.Settings.AdaptiveWindowMinutes)
	if err != nil {
		return err
	}
	reasons := buildAdaptiveReasons(metrics, settings)

	if len(reasons) == 0 {
		return s.persistState(ctx, adaptiveStateDocument{
			Enabled:               true,
			LastDecision:          "stable",
			LastAdjustedAt:        nil,
			Reason:                nil,
			CurrentMaxConcurrency: settings.MaxConcurrency,
			UpdatedAt:             formatISO(now),
			Metrics:               metrics,
		})
	}
	joinedReason := joinReasons(reasons)
	if settings.MaxConcurrency <= 1 {
		return s.persistState(ctx, adaptiveStateDocument{
			Enabled:               true,
			LastDecision:          "at_floor",
			LastAdjustedAt:        nil,
			Reason:                &joinedReason,
			CurrentMaxConcurrency: settings.MaxConcurrency,
			UpdatedAt:             formatISO(now),
			Metrics:               metrics,
		})
	}

	previous, err := s.readPreviousState(ctx)
	if err != nil {
		return err
	}
	if previous != nil && previous.LastAdjustedAt != nil {
		if previousAt, ok := parseISO(*previous.LastAdjustedAt); ok {
			elapsed := now.Sub(previousAt)
			if elapsed < time.Duration(settings.Settings.AdaptiveCooldownMinutes)*time.Minute {
				return s.persistState(ctx, adaptiveStateDocument{
					Enabled:               true,
					LastDecision:          "cooldown",
					LastAdjustedAt:        previous.LastAdjustedAt,
					Reason:                &joinedReason,
					CurrentMaxConcurrency: settings.MaxConcurrency,
					UpdatedAt:             formatISO(now),
					Metrics:               metrics,
				})
			}
		}
	}

	nextConcurrency := settings.MaxConcurrency - 1
	if nextConcurrency < 1 {
		nextConcurrency = 1
	}
	if _, err := s.settings.UpdateMaxConcurrencyInternal(ctx, nextConcurrency); err != nil {
		s.logf("crawlmaintenance: failed to apply adaptive crawl concurrency decrease: %v", err)
		return s.persistErrorState(ctx, now, settings.MaxConcurrency, joinedReason, metrics)
	}
	if err := s.queue.SetGlobalConcurrency(ctx, nextConcurrency); err != nil {
		s.logf("crawlmaintenance: failed to apply adaptive crawl concurrency decrease: %v", err)
		return s.persistErrorState(ctx, now, settings.MaxConcurrency, joinedReason, metrics)
	}
	// B4: NestJS only updated its own worker. The broadcast makes every
	// instance apply the new local concurrency. A publish failure is logged and
	// does not change the already persisted decision.
	if err := s.queue.PublishWorkerConcurrency(ctx, nextConcurrency); err != nil {
		s.logf("crawlmaintenance: failed to publish crawl worker concurrency broadcast: %v", err)
	}
	if err := s.persistState(ctx, adaptiveStateDocument{
		Enabled:               true,
		LastDecision:          "decrease",
		LastAdjustedAt:        stringPointer(formatISO(now)),
		Reason:                &joinedReason,
		CurrentMaxConcurrency: nextConcurrency,
		UpdatedAt:             formatISO(now),
		Metrics:               metrics,
	}); err != nil {
		return err
	}
	s.logf("crawlmaintenance: adaptive crawl concurrency decreased from=%d to=%d reasons=%s",
		settings.MaxConcurrency, nextConcurrency, joinedReason)
	return nil
}

// buildAdaptiveReasons is the reason list construction: p95 latency, error
// rate and memory headroom in that order, with the JS number formatting the
// NestJS template literals use.
func buildAdaptiveReasons(metrics adaptiveMetricsState, settings settingscrawl.CrawlClientNormalized) []string {
	reasons := make([]string, 0, 3)
	latencyThreshold := float64(settings.Settings.RequestTimeoutNormalMs) * settings.Settings.AdaptiveLatencyThresholdRatio
	if metrics.P95LatencyMs != nil && *metrics.P95LatencyMs > latencyThreshold {
		reasons = append(reasons, fmt.Sprintf("p95 latency %s > %sms",
			jsNumberString(*metrics.P95LatencyMs), jsNumberString(jsRound(latencyThreshold))))
	}
	if metrics.ErrorRate > settings.Settings.AdaptiveErrorRateThreshold {
		reasons = append(reasons, fmt.Sprintf("error rate %s%% > %s%%",
			jsToFixed(metrics.ErrorRate*100, 1),
			jsToFixed(settings.Settings.AdaptiveErrorRateThreshold*100, 0)))
	}
	if metrics.MemoryHeadroom != nil && *metrics.MemoryHeadroom < settings.Settings.AdaptiveMemoryHeadroomThreshold {
		reasons = append(reasons, fmt.Sprintf("memory headroom %s%% < %s%%",
			jsToFixed(*metrics.MemoryHeadroom*100, 1),
			jsToFixed(settings.Settings.AdaptiveMemoryHeadroomThreshold*100, 0)))
	}
	return reasons
}

// persistErrorState writes the error decision. The failure itself is only
// logged, matching the NestJS catch block.
func (s *AdaptiveScheduler) persistErrorState(ctx context.Context, now time.Time, current int, reason string, metrics adaptiveMetricsState) error {
	return s.persistState(ctx, adaptiveStateDocument{
		Enabled:               true,
		LastDecision:          "error",
		LastAdjustedAt:        nil,
		Reason:                &reason,
		CurrentMaxConcurrency: current,
		UpdatedAt:             formatISO(now),
		Metrics:               metrics,
	})
}

// adaptiveMetricRow is one sampled terminal task.
type adaptiveMetricRow struct {
	LastRunAt          time.Time
	UpdatedAt          time.Time
	LastServerMemoryMb sql.NullFloat64
	LastPeakMemoryMb   sql.NullFloat64
}

// computeMetrics is computeMetrics: terminal tasks updated inside the window
// with a lastRunAt, two counts and the newest 200 rows for latency and memory.
func (s *AdaptiveScheduler) computeMetrics(ctx context.Context, now time.Time, windowMinutes int) (adaptiveMetricsState, error) {
	from := now.Add(-time.Duration(windowMinutes) * time.Minute).UTC().Truncate(time.Millisecond)
	baseWhere := "`updatedAt` >= ? AND `lastRunAt` IS NOT NULL"
	terminal := " AND `status` IN ('completed', 'failed')"

	var taskCount int
	if err := s.db.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM `CrawlTask` WHERE "+baseWhere+terminal, from).Scan(&taskCount); err != nil {
		return adaptiveMetricsState{}, err
	}
	var failedCount int
	if err := s.db.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM `CrawlTask` WHERE "+baseWhere+terminal+" AND `status` = 'failed'", from).Scan(&failedCount); err != nil {
		return adaptiveMetricsState{}, err
	}
	rows, err := s.db.QueryContext(ctx,
		"SELECT `lastRunAt`, `updatedAt`, `lastServerMemoryMb`, `lastPeakMemoryMb` FROM `CrawlTask`"+
			" WHERE "+baseWhere+terminal+
			" ORDER BY `updatedAt` DESC, `id` DESC LIMIT ?", from, adaptiveMetricSampleSize)
	if err != nil {
		return adaptiveMetricsState{}, err
	}
	defer rows.Close()

	latencies := make([]float64, 0, adaptiveMetricSampleSize)
	headrooms := make([]float64, 0, adaptiveMetricSampleSize)
	for rows.Next() {
		var row adaptiveMetricRow
		if err := rows.Scan(&row.LastRunAt, &row.UpdatedAt, &row.LastServerMemoryMb, &row.LastPeakMemoryMb); err != nil {
			return adaptiveMetricsState{}, err
		}
		latency := row.UpdatedAt.Sub(row.LastRunAt).Milliseconds()
		if latency < 0 {
			latency = 0
		}
		latencies = append(latencies, float64(latency))
		if row.LastServerMemoryMb.Valid && row.LastServerMemoryMb.Float64 > 0 &&
			row.LastPeakMemoryMb.Valid && row.LastPeakMemoryMb.Float64 >= 0 {
			usageRatio := math.Max(0, math.Min(1, row.LastPeakMemoryMb.Float64/row.LastServerMemoryMb.Float64))
			headrooms = append(headrooms, 1-usageRatio)
		}
	}
	if err := rows.Err(); err != nil {
		return adaptiveMetricsState{}, err
	}

	return buildAdaptiveMetrics(taskCount, failedCount, latencies, headrooms), nil
}

// buildAdaptiveMetrics assembles the metrics document from the two counts and
// the sampled latency/headroom values (the newest-first row order is preserved
// by the caller).
func buildAdaptiveMetrics(taskCount, failedCount int, latencies, headrooms []float64) adaptiveMetricsState {
	metrics := adaptiveMetricsState{
		TaskCount:          taskCount,
		FailedCount:        failedCount,
		P95LatencyMs:       computePercentile(latencies, 0.95),
		MemorySampleCount:  len(headrooms),
		LatencySampleCount: len(latencies),
		SamplingMode:       "recent_sample",
	}
	if taskCount > 0 {
		metrics.ErrorRate = float64(failedCount) / float64(taskCount)
	}
	if len(headrooms) > 0 {
		sum := 0.0
		for _, value := range headrooms {
			sum += value
		}
		average := sum / float64(len(headrooms))
		metrics.MemoryHeadroom = &average
	}
	return metrics
}

// computePercentile is computePercentile: ascending sort, then
// ceil(n * percentile) - 1 clamped into range.
func computePercentile(values []float64, percentile float64) *float64 {
	if len(values) == 0 {
		return nil
	}
	sorted := append([]float64(nil), values...)
	sort.Float64s(sorted)
	index := len(sorted) - 1
	if computed := int(math.Ceil(float64(len(sorted))*percentile)) - 1; computed < index {
		index = computed
	}
	if index < 0 {
		index = 0
	}
	result := sorted[index]
	return &result
}

// hasRecentCrawlActivity is hasRecentCrawlActivity: a positive counter or a
// recent enqueue/terminal timestamp inside the window.
func (s *AdaptiveScheduler) hasRecentCrawlActivity(ctx context.Context, now time.Time, windowMinutes int) (bool, error) {
	state, err := s.activity.GetState(ctx)
	if err != nil {
		return false, err
	}
	activeTaskCount := 0
	if state.ActiveTaskCount != nil {
		activeTaskCount = *state.ActiveTaskCount
	} else {
		activeTaskCount, err = s.activity.EnsureActiveTaskCount(ctx, s.db)
		if err != nil {
			return false, err
		}
	}
	if activeTaskCount > 0 {
		return true, nil
	}
	cutoff := now.Add(-time.Duration(windowMinutes) * time.Minute).UnixMilli()
	if state.LastEnqueuedAt != nil {
		if parsed, ok := parseISO(*state.LastEnqueuedAt); ok && parsed.UnixMilli() >= cutoff {
			return true, nil
		}
	}
	if state.LastTerminalAt != nil {
		if parsed, ok := parseISO(*state.LastTerminalAt); ok && parsed.UnixMilli() >= cutoff {
			return true, nil
		}
	}
	return false, nil
}

// readPreviousState reads the cached adaptive state. A missing key is nil; an
// unreadable document is an error, like CacheService.get's JSON.parse failure.
func (s *AdaptiveScheduler) readPreviousState(ctx context.Context) (*adaptiveStateDocument, error) {
	raw, err := s.redis.Get(ctx, adaptiveStateCacheKey).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var state adaptiveStateDocument
	if err := json.Unmarshal(raw, &state); err != nil {
		return nil, err
	}
	return &state, nil
}

// persistState is CacheService.set: JSON.stringify then SET EX 604800.
func (s *AdaptiveScheduler) persistState(ctx context.Context, state adaptiveStateDocument) error {
	payload, err := marshalJSONNoHTMLEscape(state)
	if err != nil {
		return err
	}
	return s.redis.Set(ctx, adaptiveStateCacheKey, payload, adaptiveStateTTL*time.Second).Err()
}

// joinReasons is reasons.join("; ").
func joinReasons(reasons []string) string {
	joined := ""
	for index, reason := range reasons {
		if index > 0 {
			joined += "; "
		}
		joined += reason
	}
	return joined
}

func stringPointer(value string) *string { return &value }
