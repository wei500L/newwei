package newssourcescheduler

import (
	"context"
	"sync"
	"sync/atomic"
	"time"
)

// This file ports scheduleCron/scheduleDueSources: the 30-second tick, the
// crawl-queue backpressure phase (O4), the due-source selection and the O1
// bounded source concurrency with an atomic maxEnqueuePerTick budget.

// tickInterval is the @Cron("*/30 * * * * *") cadence.
const tickInterval = 30 * time.Second

// Scheduler owns the wall-clock loop. It performs no work at all unless both
// SCHEDULE_ENABLED and NEWS_SOURCE_SCHEDULER_ENABLED allow ticks.
type Scheduler struct {
	service *Service

	startOnce sync.Once
	stopOnce  sync.Once
	stop      chan struct{}
	hardStop  context.CancelFunc
	wg        sync.WaitGroup
}

// NewScheduler builds the tick owner.
func NewScheduler(service *Service) *Scheduler {
	return &Scheduler{service: service, stop: make(chan struct{})}
}

// Start launches the loop aligned to the next 30-second boundary. The one-time
// legacy RSS seed cache TTL migration runs first, in the same goroutine: NestJS
// performs it from onModuleInit, i.e. before the first tick and independently of
// the tick switches, so the Go owner has to do the same to keep the migration
// alive once NestJS is gone. It is deliberately not awaited by Start, so a slow
// scan never delays readiness, and Close cancels it.
func (s *Scheduler) Start(parent context.Context) {
	if s == nil || s.service == nil {
		return
	}
	s.startOnce.Do(func() {
		ctx, cancel := context.WithCancel(parent)
		s.hardStop = cancel
		s.wg.Add(1)
		go func() {
			defer s.wg.Done()
			s.runLegacyRSSSeedCacheTTLMigration(ctx)
			s.loop(ctx)
		}()
	})
}

// runLegacyRSSSeedCacheTTLMigration runs the migration under a context that the
// stop channel cancels, so a stopped scheduler does not keep scanning.
func (s *Scheduler) runLegacyRSSSeedCacheTTLMigration(ctx context.Context) {
	migrationCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	go func() {
		select {
		case <-s.stop:
			cancel()
		case <-migrationCtx.Done():
		}
	}()
	s.service.migrateLegacyRSSSeedCacheTTL(migrationCtx)
}

// Close stops new ticks and waits for the in-flight tick.
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
	next := nextTickBoundary(s.service.now())
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
			now := s.service.now()
			next = nextTickBoundary(now)
			if !next.After(now) {
				next = now.Add(tickInterval)
			}
			timer.Reset(time.Until(next))
		}
	}
}

// nextTickBoundary is the next multiple of 30 seconds.
func nextTickBoundary(now time.Time) time.Time {
	truncated := now.Truncate(tickInterval)
	next := truncated.Add(tickInterval)
	if !next.After(now) {
		next = next.Add(tickInterval)
	}
	return next
}

// runTick takes the scheduler lease and runs one schedule pass.
func (s *Scheduler) runTick(ctx context.Context) {
	service := s.service
	if !service.scheduleTicksEnabled() {
		return
	}
	// The lease is "cron:news-source-scheduler" with the CacheService "lock:"
	// prefix, so NestJS and Go exclude each other even while a switch flip
	// leaves both loops alive.
	_, err := service.withLock(ctx, schedulerLockKey, service.settings.LockTTL, func(ctx context.Context) error {
		service.scheduleDueSources(ctx, service.now())
		return nil
	})
	if err != nil {
		if asStatus(err) != nil {
			return
		}
		service.logError("news source scheduler cron tick failed", "error", err,
			"lockTtlMs", service.settings.LockTTL.Milliseconds(),
			"batchSize", service.settings.BatchSize)
	}
}

// scheduleDueSources is scheduleDueSources.
func (s *Service) scheduleDueSources(ctx context.Context, now time.Time) {
	if handled := s.applyBackpressure(ctx, now); handled {
		return
	}

	s.resetOverlayCache()

	runtimeSettings, err := s.loadSeedRuntimeSettings(ctx)
	if err != nil {
		s.logError("failed to resolve news source scheduler settings", "error", err)
		return
	}

	sources, err := s.repo.FindDueSources(ctx, now, s.settings.BatchSize)
	if err != nil {
		s.logError("failed to select due news sources", "error", err)
		return
	}
	if len(sources) == 0 {
		return
	}

	budget := newEnqueueBudget(s.settings.MaxEnqueuePerTick)
	concurrency := s.settings.SourceConcurrency
	if concurrency < 1 {
		concurrency = 1
	}
	semaphore := make(chan struct{}, concurrency)
	var waitGroup sync.WaitGroup

	for _, candidate := range sources {
		if budget != nil && budget.Exhausted() {
			s.logInfo("reached max enqueue per tick; stopping news source scheduling for this run",
				"maxEnqueuePerTick", s.settings.MaxEnqueuePerTick)
			break
		}
		waitGroup.Add(1)
		semaphore <- struct{}{}
		go func(source *source) {
			defer waitGroup.Done()
			defer func() { <-semaphore }()
			if budget != nil && budget.Exhausted() {
				return
			}
			s.dispatchCronSource(ctx, source, now, runtimeSettings, budget)
		}(candidate)
	}
	waitGroup.Wait()
}

// dispatchCronSource is the cron wrapper of the shared dispatch body: acquire
// the shared 25-second dedupe window, dispatch, isolate the failure.
func (s *Service) dispatchCronSource(ctx context.Context, source *source, now time.Time, runtimeSettings seedRuntimeSettings, budget *enqueueBudget) {
	dedupe := computeSharedDispatchDedupeKey(source.ID, now)
	acquired, err := s.cacheSetIfAbsentJSON(ctx, dedupe.Key, dedupeUntilValue{Until: dedupe.Until}, s.secondsDuration(dedupe.TTLSeconds))
	if err != nil {
		s.logWarn("failed to acquire news source dispatch window", "sourceId", source.ID, "error", err)
		return
	}
	if !acquired {
		return
	}

	_, dispatchErr := s.dispatchSource(ctx, source, dispatchInput{
		Mode:            dispatchModeCron,
		RuntimeSettings: &runtimeSettings,
		Budget:          budget,
		EnableAdaptive:  true,
		UseTickOverlay:  true,
	})
	if dispatchErr != nil {
		if isDeepDiscoveryFailureError(dispatchErr) {
			s.markDeepDiscoveryFailureState(ctx, source, dispatchErr, s.now())
		}
		s.logError("failed to schedule news source pipeline job",
			"sourceId", source.ID, "orgId", source.OrgID, "error", dispatchErr)
	}
}

// dispatchWindow is the shared dedupe window value written to Redis.
type dedupeUntilValue struct {
	Until string `json:"until"`
}

// dispatchWindowKey is computeSharedDispatchDedupeKey.
type dispatchWindow struct {
	Key        string
	Until      string
	TTLSeconds int
}

// computeSharedDispatchDedupeKey is computeSharedDispatchDedupeKey.
func computeSharedDispatchDedupeKey(sourceID string, now time.Time) dispatchWindow {
	nowMillis := now.UnixMilli()
	bucketStartMs := (nowMillis / schedulerDispatchDedupeWindowMs) * schedulerDispatchDedupeWindowMs
	bucketStart := time.UnixMilli(bucketStartMs).UTC()
	bucketEnd := time.UnixMilli(bucketStartMs + schedulerDispatchDedupeWindowMs).UTC()
	ttlSeconds := int(ceilDiv(bucketEnd.UnixMilli()-nowMillis, 1000)) + 2
	if ttlSeconds < 1 {
		ttlSeconds = 1
	}
	return dispatchWindow{
		Key:        "news-source:dispatch:" + sourceID + ":" + isoMillis(bucketStart),
		Until:      isoMillis(bucketEnd),
		TTLSeconds: ttlSeconds,
	}
}

// ceilDiv is Math.ceil(a / b) for positive integers.
func ceilDiv(value, divisor int64) int64 {
	if value <= 0 {
		return 0
	}
	return (value + divisor - 1) / divisor
}

// secondsDuration converts a seconds count to a duration.
func (s *Service) secondsDuration(seconds int) time.Duration {
	return time.Duration(seconds) * time.Second
}

// applyBackpressure is the backpressure phase. It returns true when the tick
// stopped before dispatching (either because sources were delayed or because the
// queue was over the threshold but nothing was due).
//
// O4: the legacy marker, the runtime snapshot and the 24h counter are written in
// one pipeline (plus a second pipeline for the first-hit expiry), instead of
// three round trips per source. Values, keys and TTLs are unchanged.
func (s *Service) applyBackpressure(ctx context.Context, now time.Time) bool {
	threshold := s.settings.BackpressureMaxPendingJobs
	if threshold <= 0 {
		return false
	}
	pendingJobs, err := s.pendingJobCount(ctx)
	if err != nil {
		s.logWarn("failed to evaluate crawl queue backlog for news source backpressure",
			"threshold", threshold, "error", err)
		return false
	}
	if pendingJobs <= int64(threshold) {
		return false
	}

	sourcesToDelay, err := s.repo.FindDueSources(ctx, now, s.settings.BatchSize)
	if err != nil {
		s.logWarn("failed to select news sources for backpressure", "threshold", threshold, "error", err)
		return false
	}
	if len(sourcesToDelay) == 0 {
		return true
	}

	rescheduleAt := now.Add(s.settings.BackpressureDelay)
	if _, err := s.repo.DelaySources(ctx, sourceIDsOf(sourcesToDelay), now, rescheduleAt); err != nil {
		s.logWarn("failed to delay news sources under backpressure", "threshold", threshold, "error", err)
		return false
	}

	ttlSeconds := int(ceilDiv(s.settings.BackpressureDelay.Milliseconds(), 1000))
	if ttlSeconds < 1 {
		ttlSeconds = 1
	}
	until := isoMillis(rescheduleAt)
	pending := int(pendingJobs)

	// Runtime snapshots: one MGET, then one pipeline for every marker and every
	// snapshot value.
	keys := make([]string, 0, len(sourcesToDelay))
	for _, source := range sourcesToDelay {
		keys = append(keys, listRuntimeKey(source.ID))
	}
	rawStates, present, readErr := s.cache.GetMany(ctx, keys)
	if readErr != nil {
		s.logWarn("failed to read news source runtime states", "error", readErr)
	}

	entries := make([]cacheEntry, 0, 2*len(sourcesToDelay))
	for index, source := range sourcesToDelay {
		marker := backpressureMarkerValue{Until: until, PendingJobs: pending, Threshold: threshold}
		markerJSON, marshalErr := jsonMarshal(marker)
		if marshalErr != nil {
			continue
		}
		entries = append(entries, cacheEntry{
			Key:   backpressureKey(source.ID),
			Value: markerJSON,
			TTL:   time.Duration(ttlSeconds) * time.Second,
		})

		state := emptyListRuntimeState()
		if present != nil && index < len(present) && present[index] {
			state = normalizeListRuntimeState(jsonRaw(rawStates[index]), now)
		}
		state.BackpressureUntil = &until
		pendingValue := pending
		state.BackpressurePendingJobs = &pendingValue
		thresholdValue := threshold
		state.BackpressureThreshold = &thresholdValue
		state.BackpressureHitTimes = pruneHitTimestamps(append(state.BackpressureHitTimes, isoMillis(now)), now)
		stateJSON, marshalErr := jsonMarshal(state)
		if marshalErr != nil {
			continue
		}
		entries = append(entries, cacheEntry{
			Key:   listRuntimeKey(source.ID),
			Value: stateJSON,
			TTL:   time.Duration(runtimeStateTTLSeconds) * time.Second,
		})
	}
	if len(entries) > 0 {
		if err := s.cache.SetMany(ctx, entries); err != nil {
			s.logWarn("failed to write news source backpressure state", "error", err)
		}
	}

	countKeys := make([]string, 0, len(sourcesToDelay))
	for _, source := range sourcesToDelay {
		countKeys = append(countKeys, backpressureCountKey(source.ID))
	}
	counts, err := s.cache.IncrMany(ctx, countKeys)
	if err != nil {
		s.logWarn("failed to increment news source backpressure counters", "error", err)
	} else {
		firstHit := make([]string, 0, len(counts))
		for index, count := range counts {
			if count == 1 {
				firstHit = append(firstHit, countKeys[index])
			}
		}
		if len(firstHit) > 0 {
			if err := s.cache.ExpireMany(ctx, firstHit, time.Duration(24*60*60)*time.Second); err != nil {
				s.logWarn("failed to expire news source backpressure counters", "error", err)
			}
		}
	}

	// One notification per organization behind the 30-minute gate.
	delayedByOrg := map[string]int{}
	order := []string{}
	for _, source := range sourcesToDelay {
		if _, seen := delayedByOrg[source.OrgID]; !seen {
			order = append(order, source.OrgID)
		}
		delayedByOrg[source.OrgID]++
	}
	for _, orgID := range order {
		notifyValue := backpressureNotifyValue{Until: until, PendingJobs: pending, Threshold: threshold}
		acquired, setErr := s.cacheSetIfAbsentJSON(ctx, backpressureNotifyKey(orgID), notifyValue,
			time.Duration(30*60)*time.Second)
		if setErr != nil {
			s.logWarn("failed to gate news source backpressure notification", "orgId", orgID, "error", setErr)
			continue
		}
		if !acquired {
			continue
		}
		s.notifyBackpressure(ctx, orgID, pending, threshold, delayedByOrg[orgID], until)
	}

	s.logWarn("backpressure: delayed news source scheduling due to crawl queue backlog",
		"pendingJobs", pending, "threshold", threshold,
		"delayedCount", len(sourcesToDelay), "rescheduleAt", rescheduleAt)
	return true
}

// backpressureMarkerValue is the legacy news-source:backpressure:{id} value.
type backpressureMarkerValue struct {
	Until       string `json:"until"`
	PendingJobs int    `json:"pendingJobs"`
	Threshold   int    `json:"threshold"`
}

// backpressureNotifyValue is the news-source:backpressure-notify:{orgId} value.
type backpressureNotifyValue struct {
	Until       string `json:"until"`
	PendingJobs int    `json:"pendingJobs"`
	Threshold   int    `json:"threshold"`
}

// pendingJobCount is CrawlQueueService.getPendingJobCount: the waiting + delayed
// + active jobs of the three crawl queues.
func (s *Service) pendingJobCount(ctx context.Context) (int64, error) {
	if s.queue == nil {
		return 0, nil
	}
	hot, normal, err := s.queue.CountsByQueue(ctx)
	if err != nil {
		return 0, err
	}
	legacy, err := s.queue.LegacyCounts(ctx)
	if err != nil {
		return 0, err
	}
	return hot.Pending() + normal.Pending() + legacy.Pending(), nil
}

// sourceIDsOf projects the source ids.
func sourceIDsOf(sources []*source) []string {
	out := make([]string, 0, len(sources))
	for _, source := range sources {
		out = append(out, source.ID)
	}
	return out
}

// Exhausted reports whether the per-tick budget has been fully used.
func (b *enqueueBudget) Exhausted() bool {
	if b == nil {
		return false
	}
	return atomic.LoadInt64(&b.used) >= b.limit
}
