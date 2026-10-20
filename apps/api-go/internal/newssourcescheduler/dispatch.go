package newssourcescheduler

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"math"
	"sync/atomic"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/crawlqueue"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlworkflow"
)

// This file holds the shared dispatch body (O6): one function drives both the
// 30-second tick and POST /:id/dispatch. The mode selects the documented
// differences:
//
//	manual  scheduledFor = now, the caller is the crawl actor, the backpressure
//	        marker is cleared synchronously, the source row is written with
//	        isActive = 1 and circuitOpenUntil = NULL, the metric context is
//	        "dispatch_now", and an error propagates to the HTTP layer (the caller
//	        deletes the dedupe key first).
//	cron    scheduledFor = source.nextRunAt ?? now, the actor comes from
//	        resolveCrawlActorId, the backpressure clear is fire-and-forget, only a
//	        deep seed run clears circuitOpenUntil, the enqueue budget and the RSS
//	        adaptive interval apply, the metric context is "schedule", and an
//	        error is logged by the caller while the tick keeps going.
//
// Everything else — the in-flight capacity check, the seed resolution, the two
// dedupe queries, the per-URL transaction, the enqueue and the failure
// compensation — is the same code path.

// dispatchInput carries the mode-specific inputs of one source dispatch.
type dispatchInput struct {
	Mode dispatchMode
	// ActorID is the manual caller. Cron resolves the actor itself.
	ActorID *string
	// RuntimeSettings is preloaded once per tick by the cron path. The manual
	// path loads it lazily and only when a seed block exists.
	RuntimeSettings *seedRuntimeSettings
	// EnableAdaptive turns on the RSS adaptive interval logic (cron only).
	EnableAdaptive bool
	// Budget is the cron-only per-tick enqueue budget.
	Budget *enqueueBudget
	// UseTickOverlay enables the per-tick workflow overlay cache (O7).
	UseTickOverlay bool
}

// rssAdaptiveRun is the per-source RSS adaptive context the tick resolved before
// dispatch.
type rssAdaptiveRun struct {
	State             rssAdaptiveState
	TierBefore        rssAdaptiveTier
	DiscoveryCacheTTL int
}

// rssAdaptiveTierInfo is the resolved tier after the run, for logging.
type rssAdaptiveTierInfo struct {
	Tier            rssAdaptiveTier
	IntervalSeconds int
}

// enqueueBudget is the atomic maxEnqueuePerTick budget shared by the concurrent
// source workers (O1). A nil budget means "unlimited", which is what the manual
// dispatch uses.
type enqueueBudget struct {
	limit int64
	used  int64
}

func newEnqueueBudget(limit int) *enqueueBudget {
	if limit <= 0 {
		return nil
	}
	return &enqueueBudget{limit: int64(limit)}
}

// Reserve atomically claims up to want slots and returns how many were granted.
func (b *enqueueBudget) Reserve(want int) int {
	if b == nil || want <= 0 {
		return 0
	}
	for {
		used := atomic.LoadInt64(&b.used)
		remaining := b.limit - used
		if remaining <= 0 {
			return 0
		}
		granted := int64(want)
		if granted > remaining {
			granted = remaining
		}
		if atomic.CompareAndSwapInt64(&b.used, used, used+granted) {
			return int(granted)
		}
	}
}

// Release returns unused slots so a later source in the same tick can use them.
func (b *enqueueBudget) Release(count int) {
	if b == nil || count <= 0 {
		return
	}
	atomic.AddInt64(&b.used, -int64(count))
}

// dispatchSource is the shared dispatch body.
func (s *Service) dispatchSource(ctx context.Context, source *source, input dispatchInput) (dispatchOutcome, error) {
	now := s.now()
	manual := input.Mode == dispatchModeManual

	scheduledFor := now
	if !manual && source.NextRunAt != nil {
		scheduledFor = *source.NextRunAt
	}

	// Backpressure marker: manual awaits the clear, cron never blocks on it.
	if manual {
		if err := s.cache.Del(ctx, backpressureKey(source.ID)); err != nil {
			s.logWarn("failed to clear backpressure marker", "sourceId", source.ID, "error", err)
		}
		if err := s.SetBackpressureState(ctx, source.ID, nil); err != nil {
			s.logWarn("failed to clear backpressure snapshot state", "sourceId", source.ID, "error", err)
		}
	} else {
		go func() {
			background, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if err := s.cache.Del(background, backpressureKey(source.ID)); err != nil {
				return
			}
			_ = s.SetBackpressureState(background, source.ID, nil)
		}()
	}

	activeCutoff := now.Add(-s.settings.InFlightLookback)

	overlay, err := s.dispatchOverlay(ctx, source, input.UseTickOverlay)
	if err != nil {
		return dispatchOutcome{}, err
	}

	runtimeSettings := defaultSeedRuntimeSettings()
	seedConfig := normalizeSeedConfig(source, runtimeSettings, overlay)
	if input.RuntimeSettings != nil {
		runtimeSettings = *input.RuntimeSettings
		seedConfig = normalizeSeedConfig(source, runtimeSettings, overlay)
	} else if seedConfig != nil {
		runtimeSettings, err = s.loadSeedRuntimeSettings(ctx)
		if err != nil {
			return dispatchOutcome{}, err
		}
		seedConfig = normalizeSeedConfig(source, runtimeSettings, overlay)
	}

	modeName := "single"
	if seedConfig != nil {
		modeName = string(seedConfig.Mode)
	}

	inFlightLimit := 1
	if seedConfig != nil {
		inFlightLimit = seedConfig.MaxNewURLsPerRun
	}
	inFlightJobs, err := s.repo.FindInFlightJobs(ctx, source.ID, activeCutoff, inFlightLimit)
	if err != nil {
		return dispatchOutcome{}, err
	}
	inFlightCount := len(inFlightJobs)
	remainingCapacity := 0
	if seedConfig != nil {
		remainingCapacity = seedConfig.MaxNewURLsPerRun - inFlightCount
	}
	shouldBlock := inFlightCount > 0
	if seedConfig != nil {
		shouldBlock = remainingCapacity <= 0
	}
	if shouldBlock {
		rescheduleAt := now.Add(s.settings.InFlightRescheduleDelay)
		if manual {
			if err := s.repo.UpdateSourceManual(ctx, source.ID, source.OrgID, rescheduleAt); err != nil {
				return dispatchOutcome{}, err
			}
		} else if err := s.repo.RescheduleSourceIfDue(ctx, source.ID, now, rescheduleAt); err != nil {
			s.logWarn("failed to reschedule news source with in-flight pipeline job",
				"sourceId", source.ID, "orgId", source.OrgID, "error", err)
		}
		if !manual {
			s.logInfo("skipped scheduling: in-flight pipeline jobs at capacity",
				"sourceId", source.ID, "orgId", source.OrgID, "inFlightCount", inFlightCount,
				"inFlightLimit", inFlightLimit, "rescheduleAt", rescheduleAt)
		}
		return dispatchOutcome{
			SourceID:        source.ID,
			Mode:            modeName,
			ScheduledFor:    isoMillis(now),
			NextRunAt:       isoMillis(rescheduleAt),
			ScheduledCount:  0,
			SkippedCount:    0,
			EnqueueFailures: 0,
			PipelineJobIDs:  []string{},
			CrawlTaskIDs:    []string{},
			InFlightCount:   intPointer(inFlightCount),
			InFlightLimit:   intPointer(inFlightLimit),
			Reason:          pipelineDispatchReasonInFlight,
		}, nil
	}

	// RSS adaptive: the tier before this run decides the discovery cache TTL,
	// the tier after it decides nextRunAt. Only a source without a cron schedule
	// participates.
	var adaptive *rssAdaptiveRun
	if !manual && input.EnableAdaptive && s.shouldUseRSSAdaptive(source, seedConfig) {
		adaptiveState, adaptiveErr := s.readRSSAdaptiveState(ctx, source.ID)
		if adaptiveErr != nil {
			return dispatchOutcome{}, adaptiveErr
		}
		tierBefore := s.resolveRSSAdaptiveTier(adaptiveState, source.Priority, runtimeSettings)
		adaptive = &rssAdaptiveRun{
			State:             adaptiveState,
			TierBefore:        tierBefore,
			DiscoveryCacheTTL: resolveRSSAdaptiveCacheTTLSeconds(seedConfig.CacheTTLSeconds, tierBefore, runtimeSettings),
		}
	}

	nextRunAt := s.computeNextRunAt(source, scheduledFor, now, nil)
	maxNewURLsThisRun := 1
	if seedConfig != nil {
		maxNewURLsThisRun = remainingCapacity
		if maxNewURLsThisRun < 0 {
			maxNewURLsThisRun = 0
		}
	}
	seedFreshnessWindowDays := runtimeSettings.SeedFreshnessWindowDays

	// jobsToEnqueue is always the canonical type: the single-URL path fills the
	// URL and mode directly, the seed path goes through the fingerprint dedupe.
	var jobsToSchedule []canonicalSeedJob
	if seedConfig != nil {
		discoveryCacheTTLOverride := (*int)(nil)
		if adaptive != nil {
			discoveryCacheTTLOverride = &adaptive.DiscoveryCacheTTL
		}
		resolved, resolveErr := s.resolveSeedCandidates(ctx, source, seedConfig, seedFreshnessWindowDays, overlay, discoveryCacheTTLOverride)
		if resolveErr != nil {
			return dispatchOutcome{}, resolveErr
		}
		jobsToSchedule = canonicalizeSeedJobs(resolved, seedConfig.QueryParamAllowlist)
	} else {
		jobsToSchedule = []canonicalSeedJob{{URL: source.URL, TimestampSource: "none"}}
	}
	if seedConfig != nil && seedConfig.Mode == seedModeDeep {
		s.clearDeepDiscoveryFailureState(ctx, source.ID)
	}

	canonicalJobs := jobsToSchedule

	recentFingerprints := map[string]bool{}
	activeFingerprints := map[string]bool{}
	if seedConfig != nil {
		recentFingerprints, err = s.findRecentArticleFingerprints(ctx, source.OrgID, canonicalJobs, seedConfig.DedupeWindowHours)
		if err != nil {
			return dispatchOutcome{}, err
		}
		activeFingerprints, err = s.findActivePipelineFingerprints(ctx, source.ID, canonicalJobs, activeCutoff)
		if err != nil {
			return dispatchOutcome{}, err
		}
	}

	newJobs := jobsToSchedule
	if seedConfig != nil {
		filtered := make([]canonicalSeedJob, 0, len(canonicalJobs))
		for _, job := range canonicalJobs {
			if recentFingerprints[job.URLFingerprint] {
				continue
			}
			if activeFingerprints[job.URLFingerprint] {
				continue
			}
			filtered = append(filtered, job)
		}
		if len(filtered) > maxNewURLsThisRun {
			filtered = filtered[:maxNewURLsThisRun]
		}
		newJobs = filtered
	}
	totalCandidates := len(jobsToSchedule)
	skippedCount := totalCandidates - len(newJobs)
	if skippedCount < 0 {
		skippedCount = 0
	}

	// RSS adaptive interval: the tier after this run decides nextRunAt, and the
	// adaptive state is persisted before the source row is written.
	var adaptiveTierInfo rssAdaptiveTierInfo
	if adaptive != nil {
		if seedConfig != nil {
			nextState := s.buildNextRSSAdaptiveState(adaptive.State, len(newJobs) > 0)
			if err := s.writeRSSAdaptiveState(ctx, source.ID, nextState); err != nil {
				return dispatchOutcome{}, err
			}
			tier := s.resolveRSSAdaptiveTier(nextState, source.Priority, runtimeSettings)
			interval := resolveRSSAdaptiveIntervalSeconds(source.FrequencySeconds, tier, runtimeSettings)
			adaptiveTierInfo = rssAdaptiveTierInfo{Tier: tier, IntervalSeconds: interval}
			nextRunAt = s.computeNextRunAt(source, scheduledFor, now, &interval)
		}
	}

	if manual {
		if err := s.repo.UpdateSourceManualRun(ctx, source.ID, source.OrgID, scheduledFor, nextRunAt); err != nil {
			return dispatchOutcome{}, err
		}
	} else {
		clearCircuit := seedConfig != nil && seedConfig.Mode == seedModeDeep
		if err := s.updateLastRunAndNextRun(ctx, source, scheduledFor, nextRunAt, clearCircuit); err != nil {
			return dispatchOutcome{}, err
		}
	}

	if len(newJobs) == 0 {
		if !manual {
			s.logInfo("news source run scheduled no new URLs",
				"sourceId", source.ID, "orgId", source.OrgID, "seedMode", seedModeName(seedConfig),
				"seedFreshnessWindowDays", seedFreshnessWindowDays,
				"rssAdaptiveTier", adaptiveTierInfo.Tier, "scheduledFor", scheduledFor, "nextRunAt", nextRunAt)
		}
		return dispatchOutcome{
			SourceID:        source.ID,
			Mode:            modeName,
			ScheduledFor:    isoMillis(scheduledFor),
			NextRunAt:       isoMillis(nextRunAt),
			ScheduledCount:  0,
			SkippedCount:    skippedCount,
			EnqueueFailures: 0,
			PipelineJobIDs:  []string{},
			CrawlTaskIDs:    []string{},
			InFlightCount:   intPointer(inFlightCount),
			InFlightLimit:   intPointer(inFlightLimit),
			Reason:          pipelineDispatchReasonNoNewURLs,
		}, nil
	}

	jobsToEnqueue := newJobs
	reserved := 0
	if input.Budget != nil {
		reserved = input.Budget.Reserve(len(newJobs))
		if reserved == 0 {
			if !manual {
				s.logInfo("skipped scheduling due to global enqueue limit",
					"sourceId", source.ID, "orgId", source.OrgID, "maxEnqueuePerTick", s.settings.MaxEnqueuePerTick)
			}
			return dispatchOutcome{
				SourceID:        source.ID,
				Mode:            modeName,
				ScheduledFor:    isoMillis(scheduledFor),
				NextRunAt:       isoMillis(nextRunAt),
				ScheduledCount:  0,
				SkippedCount:    skippedCount,
				EnqueueFailures: 0,
				PipelineJobIDs:  []string{},
				CrawlTaskIDs:    []string{},
				InFlightCount:   intPointer(inFlightCount),
				InFlightLimit:   intPointer(inFlightLimit),
				Reason:          pipelineDispatchReasonOK,
			}, nil
		}
		jobsToEnqueue = newJobs[:reserved]
		if reserved < len(newJobs) {
			s.logInfo("limited news source scheduling due to global enqueue cap",
				"sourceId", source.ID, "orgId", source.OrgID, "limited", reserved,
				"original", len(newJobs), "maxEnqueuePerTick", s.settings.MaxEnqueuePerTick)
		}
	}

	actorID := ""
	if input.ActorID != nil {
		actorID = *input.ActorID
	} else {
		resolved, resolveErr := s.resolveCrawlActorID(ctx, source.OrgID)
		if resolveErr != nil {
			return dispatchOutcome{}, resolveErr
		}
		if resolved == nil {
			s.logWarn("news source scheduler cannot resolve crawl task actor; skipping scheduling",
				"sourceId", source.ID, "orgId", source.OrgID)
			if reserved > 0 {
				input.Budget.Release(reserved)
			}
			return dispatchOutcome{
				SourceID:        source.ID,
				Mode:            modeName,
				ScheduledFor:    isoMillis(scheduledFor),
				NextRunAt:       isoMillis(nextRunAt),
				ScheduledCount:  0,
				SkippedCount:    skippedCount,
				EnqueueFailures: 0,
				PipelineJobIDs:  []string{},
				CrawlTaskIDs:    []string{},
				InFlightCount:   intPointer(inFlightCount),
				InFlightLimit:   intPointer(inFlightLimit),
				Reason:          pipelineDispatchReasonOK,
			}, nil
		}
		actorID = *resolved
	}

	bullPriority := s.toBullmqPriority(source.Priority)
	crawlPriorityClass := toCrawlPriorityClass(source.Priority)
	seedParentURL := ""
	if seedConfig != nil {
		seedParentURL = source.URL
		if seedConfig.Mode == seedModeRSS && seedConfig.FeedURL != nil {
			seedParentURL = *seedConfig.FeedURL
		}
	}

	pipelineJobIDs := []string{}
	crawlTaskIDs := []string{}
	enqueueFailures := 0
	skippedInFlight := 0
	rssSkippedNoBody := 0
	enqueued := 0
	snapshotNeeded := false

	for _, job := range jobsToEnqueue {
		seedInput := buildSeedPayloadInput(seedConfig, seedParentURL, job)
		payload := s.buildPayload(source, job.URL, seedInput)
		publishedAt := toISOTimestamp(job.PublishedAtTs)
		crawledAt := toISOTimestamp(job.CrawledAtTs)
		effectiveAt := toISOTimestamp(job.EffectiveTs)

		if seedConfig != nil && seedConfig.Mode == seedModeRSS {
			result, rssErr := s.enqueueRSSSeedPipelineJob(ctx, rssSeedInput{
				Source:        source,
				Job:           job,
				ScheduledFor:  scheduledFor,
				Payload:       payload,
				SeedConfig:    seedConfig,
				SeedParentURL: seedParentURL,
				BullPriority:  int64(bullPriority),
				PipelineJobID: mustNewID(),
				ItemMetaID:    mustNewID(),
				RawItemID:     newMongoObjectIDHex(),
				PublishedAt:   publishedAt,
				CrawledAt:     crawledAt,
				EffectiveAt:   effectiveAt,
			})
			if rssErr != nil {
				return dispatchOutcome{}, rssErr
			}
			if result.SkippedNoBody {
				rssSkippedNoBody++
				continue
			}
			if result.PipelineJobID != "" {
				pipelineJobIDs = append(pipelineJobIDs, result.PipelineJobID)
			}
			if result.EnqueueFailed {
				enqueueFailures++
			} else {
				enqueued++
			}
			continue
		}

		jobMetadata := pipelineJobMetadata{
			SourceName:    source.Name,
			SourceType:    source.SiteType,
			SeedMode:      seedModeName(seedConfig),
			PublishedAt:   publishedAt,
			CrawledAt:     crawledAt,
			EffectiveAt:   effectiveAt,
			TriggeredByID: manualTriggeredBy(input.Mode, actorID),
			CrawlTaskID:   mustNewID(),
		}
		if seedConfig != nil {
			jobMetadata.SeedParentURL = &seedParentURL
			jobMetadata.RelevanceScore = job.RelevanceScore
			jobMetadata.TimestampSource = job.TimestampSource
			if job.URLFingerprint != "" {
				fingerprint := job.URLFingerprint
				jobMetadata.URLFingerprint = &fingerprint
			}
		}

		crawlTaskID := jobMetadata.CrawlTaskID
		itemPayloadConfig := buildItemPayloadConfig(source, seedConfig, seedParentURL, seedInput)
		itemPayload := buildItemPayload(payload, itemPayloadConfig)
		taskConfig := crawlTaskConfig{
			Payload:            payload.CrawlOptions,
			ItemPayload:        itemPayload,
			PipelineJobID:      "",
			PipelinePriority:   bullPriority,
			CrawlPriorityClass: crawlPriorityClass,
			SourcePriority:     source.Priority,
		}
		if seedConfig != nil {
			window := seedConfig.DedupeWindowHours
			taskConfig.DedupeWindowHours = &window
			taskConfig.QueryParamAllowlist = seedConfig.QueryParamAllowlist
		}
		// O2: the PipelineJob depth metadata and the CrawlTask config are written
		// in one transaction each, with both ids pre-generated, so no follow-up
		// UPDATE is needed.
		taskConfig.PipelineJobID = mustNewID()
		pipelineJobID := taskConfig.PipelineJobID

		persisted, persistErr := s.repo.PersistDispatch(ctx, dispatchPersist{
			Source:         source,
			URL:            job.URL,
			URLFingerprint: optionalFingerprint(job.URLFingerprint),
			ScheduledFor:   scheduledFor,
			DisplayName:    displayName(source),
			Keywords:       payload.Keywords,
			TaskConfig:     taskConfig.marshalTaskConfig(),
			JobMetadata:    mustJSON(jobMetadata),
			PipelineJobID:  pipelineJobID,
			CrawlTaskID:    crawlTaskID,
			CreatedByID:    actorID,
			Now:            s.now().UTC().Truncate(time.Millisecond),
		})
		if persistErr != nil {
			return dispatchOutcome{}, persistErr
		}
		if persisted.Skipped {
			skippedInFlight++
			rescheduleAt := s.now().Add(s.settings.InFlightRescheduleDelay)
			if err := s.repo.RescheduleSourceIfDue(ctx, source.ID, s.now(), rescheduleAt); err != nil {
				s.logWarn("failed to reschedule news source with in-flight crawl task",
					"sourceId", source.ID, "orgId", source.OrgID, "error", err)
			}
			continue
		}
		pipelineJobIDs = append(pipelineJobIDs, persisted.PipelineJobID)
		crawlTaskIDs = append(crawlTaskIDs, persisted.CrawlTaskID)

		enqueueResult, enqueueErr := s.queue.EnqueueTask(ctx, persisted.CrawlTaskID, source.OrgID, crawlqueueEnqueueOptions(
			crawlPriorityClass, source.Priority, source.ID, actorID))
		if enqueueErr != nil {
			enqueueFailures++
			snapshotNeeded = true
			s.logError("failed to enqueue news source crawl task",
				"pipelineJobId", persisted.PipelineJobID, "orgId", source.OrgID,
				"sourceId", source.ID, "crawlTaskId", persisted.CrawlTaskID, "error", enqueueErr)
			message := enqueueErr.Error()
			nowMillisTime := s.now().UTC().Truncate(time.Millisecond)
			if err := s.repo.MarkPipelineJobFailed(ctx, persisted.PipelineJobID, message, nowMillisTime); err != nil {
				s.logWarn("failed to mark pipeline job failed", "pipelineJobId", persisted.PipelineJobID, "error", err)
			}
			if err := s.repo.MarkCrawlTaskFailed(ctx, persisted.CrawlTaskID, message, nowMillisTime); err != nil {
				s.logWarn("failed to mark crawl task failed", "crawlTaskId", persisted.CrawlTaskID, "error", err)
			}
			continue
		}
		if enqueueResult.Deduplicated {
			skippedInFlight++
			nowMillisTime := s.now().UTC().Truncate(time.Millisecond)
			if err := s.repo.MarkPipelineJobFailed(ctx, persisted.PipelineJobID,
				"Superseded: an in-flight crawl job for the same task is already queued", nowMillisTime); err != nil {
				s.logWarn("failed to mark superseded pipeline job failed", "pipelineJobId", persisted.PipelineJobID, "error", err)
			}
			continue
		}
		if err := s.repo.MarkCrawlTaskQueued(ctx, persisted.CrawlTaskID, s.now().UTC().Truncate(time.Millisecond)); err != nil {
			s.logWarn("failed to mark crawl task queued", "crawlTaskId", persisted.CrawlTaskID, "error", err)
		}
		snapshotNeeded = true
		enqueued++
	}

	if reserved > enqueued {
		input.Budget.Release(reserved - enqueued)
	}

	// O3: one snapshot refresh per source instead of one per URL.
	if snapshotNeeded {
		if err := s.SyncQueueCounts(ctx, source.OrgID, source.ID); err != nil {
			s.logWarn("failed to sync queue counts", "sourceId", source.ID, "orgId", source.OrgID, "error", err)
		}
		if _, err := s.RefreshSnapshotForSource(ctx, source.OrgID, source.ID); err != nil {
			s.logWarn("failed to refresh ops snapshot", "sourceId", source.ID, "orgId", source.OrgID, "error", err)
		}
	}

	scheduledCount := len(jobsToEnqueue) - rssSkippedNoBody - enqueueFailures - skippedInFlight
	if scheduledCount < 0 {
		scheduledCount = 0
	}
	totalSkippedCount := skippedCount + rssSkippedNoBody + skippedInFlight
	if rssSkippedNoBody > 0 {
		metricsContext := metricsContextSchedule
		if manual {
			metricsContext = metricsContextDispatchNow
		}
		s.recordRSSNoBodySkipMetric(ctx, source.OrgID, source.ID, sourceNameOrNil(source), rssSkippedNoBody, metricsContext)
		if !manual {
			s.logInfo("skipped RSS candidates without prefetched body markdown",
				"sourceId", source.ID, "orgId", source.OrgID, "mode", modeName, "rssSkippedNoBodyCount", rssSkippedNoBody)
		}
	}
	if skippedInFlight > 0 && !manual {
		s.logInfo("skipped news source crawl enqueue because a job is already in flight",
			"sourceId", source.ID, "orgId", source.OrgID, "skippedInFlightCount", skippedInFlight)
	}

	outcome := dispatchOutcome{
		SourceID:        source.ID,
		Mode:            modeName,
		ScheduledFor:    isoMillis(scheduledFor),
		NextRunAt:       isoMillis(nextRunAt),
		ScheduledCount:  scheduledCount,
		SkippedCount:    totalSkippedCount,
		EnqueueFailures: enqueueFailures,
		PipelineJobIDs:  pipelineJobIDs,
		CrawlTaskIDs:    crawlTaskIDs,
		InFlightCount:   intPointer(inFlightCount),
		InFlightLimit:   intPointer(inFlightLimit),
		Reason:          pipelineDispatchReasonOK,
		enqueued:        enqueued,
	}
	if rssSkippedNoBody > 0 {
		value := rssSkippedNoBody
		outcome.RSSSkippedNoBodyCount = &value
	}
	if !manual {
		s.logInfo("news source run dispatched",
			"sourceId", source.ID, "orgId", source.OrgID, "mode", modeName,
			"scheduledCount", scheduledCount, "skippedCount", totalSkippedCount,
			"enqueueFailures", enqueueFailures, "enqueued", enqueued,
			"rssAdaptiveTier", adaptiveTierInfo.Tier, "nextRunAt", nextRunAt)
	}
	return outcome, nil
}

// dispatchOverlay compiles (or reads from the per-tick cache) the workflow
// overlay.
func (s *Service) dispatchOverlay(ctx context.Context, source *source, useTickCache bool) (*workflowOverlay, error) {
	var compiled *crawlworkflow.CompiledNewsSourceOverlay
	var err error
	if useTickCache {
		compiled, err = s.compileOverlayCached(ctx, source)
	} else {
		if s.workflows == nil || (source.WorkflowID == nil && source.WorkflowVersionID == nil) {
			return nil, nil
		}
		workflowID := ""
		if source.WorkflowID != nil {
			workflowID = *source.WorkflowID
		}
		versionID := ""
		if source.WorkflowVersionID != nil {
			versionID = *source.WorkflowVersionID
		}
		compiled, err = s.workflows.CompileNewsSourceOverlay(ctx, source.OrgID, workflowID, versionID)
	}
	if err != nil || compiled == nil {
		return nil, err
	}
	return &workflowOverlay{
		CrawlOptions: compiled.CrawlOptions,
		Seed:         compiled.Seed,
		Keywords:     compiled.Keywords,
	}, nil
}

// updateLastRunAndNextRun writes the NewsSource run bookkeeping.
func (s *Service) updateLastRunAndNextRun(ctx context.Context, source *source, scheduledFor, nextRunAt time.Time, clearCircuit bool) error {
	return s.repo.UpdateSourceRun(ctx, source.ID, scheduledFor, nextRunAt, clearCircuit)
}

// rssSeedInput is the enqueueRssSeedPipelineJob input.
type rssSeedInput struct {
	Source        *source
	Job           canonicalSeedJob
	ScheduledFor  time.Time
	Payload       crawlPayload
	SeedConfig    *seedConfig
	SeedParentURL string
	BullPriority  int64
	PipelineJobID string
	ItemMetaID    string
	RawItemID     string
	PublishedAt   *string
	CrawledAt     *string
	EffectiveAt   *string
}

// rssSeedResult is the enqueueRssSeedPipelineJob result.
type rssSeedResult struct {
	SkippedNoBody bool
	EnqueueFailed bool
	PipelineJobID string
}

// enqueueRSSSeedPipelineJob is enqueueRssSeedPipelineJob.
func (s *Service) enqueueRSSSeedPipelineJob(ctx context.Context, input rssSeedInput) (rssSeedResult, error) {
	article := input.Job.PrefetchedArticle
	if article == nil || trimJS(article.Markdown) == "" {
		return rssSeedResult{SkippedNoBody: true}, nil
	}
	normalizedArticle := *article
	normalizedArticle.Markdown = trimJS(article.Markdown)
	normalized, ok := buildRSSPrefetchedPayload(input.Payload, &normalizedArticle)
	if !ok {
		s.logError("RSS prefetched payload failed NormalizedNewsPayloadSchema; skipping outbox write",
			"orgId", input.Source.OrgID, "sourceId", input.Source.ID, "url", input.Job.URL)
		return rssSeedResult{EnqueueFailed: true}, nil
	}

	markdownSource := ""
	if metadata, ok := decodeObject(normalizedArticle.Metadata); ok {
		if value, ok := metadata.stringField("markdownSource"); ok {
			switch lowerTrim(value) {
			case "content", "description", "stub":
				markdownSource = lowerTrim(value)
			}
		}
	}

	itemNameBase := input.Job.URL
	if input.Payload.SourceName != nil && trimJS(*input.Payload.SourceName) != "" {
		itemNameBase = trimJS(*input.Payload.SourceName) + ": " + input.Job.URL
	}
	jobMetadata := rssPipelineJobMetadata{
		SourceName:               input.Source.Name,
		SourceType:               input.Source.SiteType,
		SeedMode:                 string(input.SeedConfig.Mode),
		SeedParentURL:            input.SeedParentURL,
		RelevanceScore:           input.Job.RelevanceScore,
		PublishedAt:              input.PublishedAt,
		CrawledAt:                input.CrawledAt,
		EffectiveAt:              input.EffectiveAt,
		TimestampSource:          input.Job.TimestampSource,
		URLFingerprint:           optionalFingerprint(input.Job.URLFingerprint),
		IngestPath:               "rss_prefetched",
		PrefetchedMarkdownSource: optionalString(markdownSource),
		ItemMetaID:               input.ItemMetaID,
		RawItemID:                input.RawItemID,
	}

	outboxID, err := s.repo.PersistRSSSeed(ctx, rssSeedPersist{
		Source:         input.Source,
		URL:            input.Job.URL,
		URLFingerprint: optionalFingerprint(input.Job.URLFingerprint),
		Priority:       input.Source.Priority,
		ScheduledFor:   input.ScheduledFor,
		JobMetadata:    mustJSON(jobMetadata),
		ItemMetaID:     input.ItemMetaID,
		ItemName:       toItemMetaName(itemNameBase),
		ExternalID:     "newsSourceRss:" + input.PipelineJobID,
		RawItemID:      input.RawItemID,
		PipelineJobID:  input.PipelineJobID,
		Payload:        normalized,
		BullPriority:   input.BullPriority,
		Now:            s.now().UTC().Truncate(time.Millisecond),
	})
	if err != nil {
		return rssSeedResult{}, err
	}
	if s.items == nil {
		return rssSeedResult{EnqueueFailed: true, PipelineJobID: input.PipelineJobID}, nil
	}
	delivered := s.items.DeliverOutboxNow(ctx, outboxID)
	if !delivered {
		s.logWarn("RSS prefetched raw-item outbox delivery deferred to retry",
			"orgId", input.Source.OrgID, "sourceId", input.Source.ID,
			"pipelineJobId", input.PipelineJobID, "outboxId", outboxID)
	}
	return rssSeedResult{
		EnqueueFailed: !delivered,
		PipelineJobID: input.PipelineJobID,
	}, nil
}

// pipelineJobMetadata is the non-RSS PipelineJob.metadata object.
type pipelineJobMetadata struct {
	SourceName      string   `json:"sourceName"`
	SourceType      string   `json:"sourceType"`
	SeedMode        string   `json:"seedMode"`
	SeedParentURL   *string  `json:"seedParentUrl,omitempty"`
	RelevanceScore  *float64 `json:"relevanceScore,omitempty"`
	PublishedAt     *string  `json:"publishedAt,omitempty"`
	CrawledAt       *string  `json:"crawledAt,omitempty"`
	EffectiveAt     *string  `json:"effectiveAt,omitempty"`
	TimestampSource string   `json:"timestampSource,omitempty"`
	URLFingerprint  *string  `json:"urlFingerprint,omitempty"`
	TriggeredByID   *string  `json:"triggeredById,omitempty"`
	CrawlTaskID     string   `json:"crawlTaskId"`
}

// rssPipelineJobMetadata is the RSS seed PipelineJob.metadata object.
type rssPipelineJobMetadata struct {
	SourceName               string   `json:"sourceName"`
	SourceType               string   `json:"sourceType"`
	SeedMode                 string   `json:"seedMode"`
	SeedParentURL            string   `json:"seedParentUrl"`
	RelevanceScore           *float64 `json:"relevanceScore,omitempty"`
	PublishedAt              *string  `json:"publishedAt,omitempty"`
	CrawledAt                *string  `json:"crawledAt,omitempty"`
	EffectiveAt              *string  `json:"effectiveAt,omitempty"`
	TimestampSource          string   `json:"timestampSource"`
	URLFingerprint           *string  `json:"urlFingerprint,omitempty"`
	IngestPath               string   `json:"ingestPath"`
	PrefetchedMarkdownSource *string  `json:"prefetchedMarkdownSource,omitempty"`
	ItemMetaID               string   `json:"itemMetaId"`
	RawItemID                string   `json:"rawItemId"`
}

// buildSeedPayloadInput projects the seed config onto the buildPayload seed.
func buildSeedPayloadInput(seed *seedConfig, parentURL string, job canonicalSeedJob) *seedPayloadInput {
	if seed == nil {
		return nil
	}
	return &seedPayloadInput{
		Mode:                seed.Mode,
		ParentURL:           parentURL,
		RelevanceScore:      job.RelevanceScore,
		PublishedAt:         toISOTimestamp(job.PublishedAtTs),
		CrawledAt:           toISOTimestamp(job.CrawledAtTs),
		EffectiveAt:         toISOTimestamp(job.EffectiveTs),
		TimestampSource:     job.TimestampSource,
		DedupeWindowHours:   seed.DedupeWindowHours,
		QueryParamAllowlist: seed.QueryParamAllowlist,
	}
}

// canonicalizeSeedJobs is canonicalizeSeedJobs: the fingerprint map keeps the
// first URL seen, replaces the entry when the new one has a newer effective
// timestamp or a higher score, and otherwise merges the prefetched article.
func canonicalizeSeedJobs(jobs []scoredSeedCandidate, queryParamAllowlist []string) []canonicalSeedJob {
	order := make([]string, 0, len(jobs))
	byFingerprint := make(map[string]canonicalSeedJob, len(jobs))
	for _, job := range jobs {
		rawURL := trimJS(job.URL)
		if rawURL == "" {
			continue
		}
		canonicalURL, fingerprint, ok := buildCanonicalURLFingerprint(rawURL, queryParamAllowlist)
		if !ok {
			continue
		}
		existing, seen := byFingerprint[fingerprint]
		if !seen {
			order = append(order, fingerprint)
			byFingerprint[fingerprint] = canonicalSeedJob{
				URL:               canonicalURL,
				URLFingerprint:    fingerprint,
				RelevanceScore:    job.RelevanceScore,
				PublishedAtTs:     resolveTimestamp(job.PublishedAtTs),
				CrawledAtTs:       resolveTimestamp(job.CrawledAtTs),
				EffectiveTs:       resolveTimestamp(job.EffectiveTs),
				TimestampSource:   job.TimestampSource,
				PrefetchedArticle: job.PrefetchedArticle,
			}
			continue
		}
		existingEffective := int64(-1)
		if existing.EffectiveTs != nil {
			existingEffective = *existing.EffectiveTs
		}
		nextEffective := int64(-1)
		if job.EffectiveTs != nil {
			nextEffective = *job.EffectiveTs
		}
		existingScore := negativeInfinity()
		if existing.RelevanceScore != nil {
			existingScore = *existing.RelevanceScore
		}
		nextScore := negativeInfinity()
		if job.RelevanceScore != nil {
			nextScore = *job.RelevanceScore
		}
		shouldReplace := nextEffective > existingEffective ||
			(nextEffective == existingEffective && nextScore > existingScore)
		if shouldReplace {
			byFingerprint[fingerprint] = canonicalSeedJob{
				URL:               canonicalURL,
				URLFingerprint:    fingerprint,
				RelevanceScore:    job.RelevanceScore,
				PublishedAtTs:     resolveTimestamp(job.PublishedAtTs),
				CrawledAtTs:       resolveTimestamp(job.CrawledAtTs),
				EffectiveTs:       resolveTimestamp(job.EffectiveTs),
				TimestampSource:   job.TimestampSource,
				PrefetchedArticle: job.PrefetchedArticle,
			}
			continue
		}
		merged := existing
		merged.PrefetchedArticle = mergePrefetchedArticle(existing.PrefetchedArticle, job.PrefetchedArticle)
		byFingerprint[fingerprint] = merged
	}
	out := make([]canonicalSeedJob, 0, len(order))
	for _, fingerprint := range order {
		out = append(out, byFingerprint[fingerprint])
	}
	return out
}

// negativeInfinity is Number.NEGATIVE_INFINITY for the score comparisons.
func negativeInfinity() float64 {
	return math.Inf(-1)
}

// toISOTimestamp is toIsoTimestamp.
func toISOTimestamp(value *int64) *string {
	resolved := resolveTimestamp(value)
	if resolved == nil {
		return nil
	}
	formatted := isoMillis(time.UnixMilli(*resolved))
	return &formatted
}

// optionalFingerprint returns a pointer for a non-empty fingerprint.
func optionalFingerprint(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

// optionalString returns a pointer for a non-empty value.
func optionalString(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

// intPointer returns a pointer to the value.
func intPointer(value int) *int {
	return &value
}

// sourceNameOrNil exposes the optional source name for the metrics helper.
func sourceNameOrNil(source *source) *string {
	if source.Name == "" {
		return nil
	}
	return &source.Name
}

// seedModeName renders the seed mode or "single".
func seedModeName(seed *seedConfig) string {
	if seed == nil {
		return "single"
	}
	return string(seed.Mode)
}

// manualTriggeredBy returns the manual caller id and nil for the cron path,
// which is the NestJS metadata difference between the two entry points.
func manualTriggeredBy(mode dispatchMode, actorID string) *string {
	if mode != dispatchModeManual || actorID == "" {
		return nil
	}
	return &actorID
}

// mustNewID returns a cuid-shaped id or panics on entropy failure.
func mustNewID() string {
	id, err := newID()
	if err != nil {
		panic(fmt.Sprintf("newssourcescheduler: id generation failed: %v", err))
	}
	return id
}

// newMongoObjectIDHex is `new Types.ObjectId().toHexString()`.
func newMongoObjectIDHex() string {
	var buffer [12]byte
	if _, err := rand.Read(buffer[:]); err != nil {
		panic(fmt.Sprintf("newssourcescheduler: raw item id generation failed: %v", err))
	}
	return hex.EncodeToString(buffer[:])
}

// crawlqueueEnqueueOptions builds the crawlqueue options.
func crawlqueueEnqueueOptions(priorityClass string, sourcePriority int, sourceID, actorID string) crawlqueue.EnqueueOptions {
	return crawlqueue.EnqueueOptions{
		PriorityClass:  crawlqueue.PriorityClass(priorityClass),
		SourcePriority: &sourcePriority,
		SourceID:       &sourceID,
		TriggeredByID:  optionalString(actorID),
	}
}
