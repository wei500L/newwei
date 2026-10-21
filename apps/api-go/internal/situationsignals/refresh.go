package situationsignals

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
)

// This file ports SituationMonitorRefreshService.refresh (POST
// /api/situation-monitor/refresh). The observations below keep the NestJS source
// of truth in apps/api/src/modules/situation-monitor/situation-monitor-refresh.service.ts
// (baseline 170a95d8) readable next to the port.
//
// The flow is the NestJS order:
//
//  1. clear the two cache prefixes and load the organization's active news
//     sources, all three concurrently (O2);
//  2. gate the crawl part on crawl.write and on the active-source count;
//  3. reorder the active sources, dispatch one scheduler pass (B1) and count the
//     CrawlTask/PipelineJob rows the pass created;
//  4. refresh Telegram and OREF concurrently (O1), warnings appended Telegram
//     first, OREF second;
//  5. write the refresh-run record with a 900 second TTL, read it back through
//     the shared getRefreshRun to compute terminal, and answer.

// refreshPath is the single route this file's handler owns.
const refreshPath = "/api/situation-monitor/refresh"

// crawlWritePermission gates the crawl part of a refresh.
const crawlWritePermission = "crawl.write"

// Cache prefixes the refresh clears. Both are copied verbatim from the NestJS
// service, including their cross-tenant reach:
//
// Q2: insightsCachePrefix also matches situation-monitor:insights:v2:core:*,
// situation-monitor:insights:v2:external:{orgId} and
// situation-monitor:insights:learning-rev:v1:{orgId} for EVERY organization, so
// one organization's refresh clears the insight caches and learning revisions of
// all of them. The behavior is kept unchanged on purpose; the observation is
// recorded in the PR description instead of changing the product semantics.
//
// Q3: the real external snapshot keys are situation-monitor:external-snapshot:*,
// which do not start with this prefix ("external" is followed by a hyphen, not a
// colon), so externalCleared is always 0 exactly like NestJS.
const (
	insightsCachePrefix = "situation-monitor:insights:"
	externalCachePrefix = "situation-monitor:external:"
)

// Warning codes, sources and messages, copied verbatim from the NestJS service.
const (
	refreshWarningInsightsCache    = "situation_monitor_insights_cache_clear_failed"
	refreshWarningExternalCache    = "situation_monitor_external_cache_clear_failed"
	refreshWarningCrawlPermission  = "situation_monitor_crawl_permission_required"
	refreshWarningNoActiveSources  = "situation_monitor_no_active_sources"
	refreshWarningSchedulerBusy    = "situation_monitor_crawl_scheduler_busy"
	refreshWarningCrawlQueueFailed = "situation_monitor_crawl_queue_failed"
	refreshWarningTelegram         = "situation_monitor_telegram_refresh_failed"
	refreshWarningOref             = "situation_monitor_oref_refresh_failed"

	refreshInsightsCacheWarningMessage = "Failed to clear Situation Monitor insights cache."
	refreshExternalCacheWarningMessage = "Failed to clear Situation Monitor external cache."
	refreshCrawlPermissionMessage      = "You can refresh the view, but triggering crawl collection requires crawl.write permission."
	refreshNoActiveSourcesMessage      = "No active news sources are configured for this workspace, so no crawl jobs were queued."
	refreshSchedulerBusyWarningMessage = "Situation Monitor crawl scheduler is already busy, so immediate dispatch was skipped."
	refreshCrawlQueueFailedMessage     = "Failed to queue Situation Monitor crawl jobs."
	refreshTelegramFailedMessage       = "Failed to refresh Telegram signals."
	refreshOrefFailedMessage           = "Failed to refresh OREF signals."
	// refreshRequestFailedMessage is the NestJS safeErrorMessage fallback for a
	// thrown value that is neither an Error nor a string.
	refreshRequestFailedMessage = "Request failed"

	// refreshStatusAccepted is SituationMonitorRefreshResponse["status"] for a
	// refresh without warnings.
	refreshStatusAccepted refreshLifecycleStatus = "accepted"

	// refreshTelegramSource and refreshOrefSource are the source values of the two
	// signal warnings.
	refreshSourceTelegram refreshWarningSource = "telegram"
	refreshSourceOref     refreshWarningSource = "oref"
	refreshSourceCrawl    refreshWarningSource = "crawl"
	refreshSourceCore     refreshWarningSource = "core"
	refreshSourceExternal refreshWarningSource = "external"

	// refreshSeverityWarning and refreshSeverityError are the two severities the
	// refresh emits.
	refreshSeverityWarning refreshWarningSeverity = "warning"
	refreshSeverityError   refreshWarningSeverity = "error"

	// refreshUUIDBytes is the entropy of the v4 refresh id.
	refreshUUIDBytes = 16
)

// refreshWarningSource is the SituationMonitorWarning["source"] union.
type refreshWarningSource string

// refreshWarningSeverity is the SituationMonitorWarning["severity"] union.
type refreshWarningSeverity string

// refreshWarning is SituationMonitorWarning. The field order is the NestJS
// interface order, and detail is omitted when absent (an option in NestJS).
type refreshWarning struct {
	Code     string                 `json:"code"`
	Source   refreshWarningSource   `json:"source"`
	Severity refreshWarningSeverity `json:"severity"`
	Message  string                 `json:"message"`
	Detail   string                 `json:"detail,omitempty"`
}

// refreshCrawlResult is SituationMonitorRefreshRunRecord["crawl"] on the write side
// (refreshrun.go keeps the loose read-side projection of the same object).
type refreshCrawlResult struct {
	Attempted            bool   `json:"attempted"`
	Permitted            bool   `json:"permitted"`
	ActiveSourceCount    int    `json:"activeSourceCount"`
	ScheduledSourceCount int    `json:"scheduledSourceCount"`
	SchedulerTriggered   bool   `json:"schedulerTriggered"`
	CrawlTaskCount       int    `json:"crawlTaskCount"`
	AnalysisTaskCount    int    `json:"analysisTaskCount"`
	Message              string `json:"message"`
}

// refreshTaskResult is SituationMonitorRefreshTaskResult.
type refreshTaskResult struct {
	Attempted  bool   `json:"attempted"`
	OK         bool   `json:"ok"`
	Message    string `json:"message"`
	DurationMs int64  `json:"durationMs"`
}

// refreshSignals is the record's signals block (telegram then oref).
type refreshSignals struct {
	Telegram refreshTaskResult `json:"telegram"`
	Oref     refreshTaskResult `json:"oref"`
}

// refreshCacheSummary is the record's cache block.
type refreshCacheSummary struct {
	InsightsCleared int `json:"insightsCleared"`
	ExternalCleared int `json:"externalCleared"`
}

// refreshRunRecord is SituationMonitorRefreshRunRecord. Field order is the
// NestJS literal order and is part of the cached record's contract: the read side
// (refreshrun.go) and the NestJS getRefreshRun both parse it, and the key order is
// what the record round-trip test asserts.
type refreshRunRecord struct {
	RefreshID       string              `json:"refreshId"`
	OrgID           string              `json:"orgId"`
	RequestedAt     string              `json:"requestedAt"`
	TaskWindowStart string              `json:"taskWindowStart"`
	ActiveSourceIDs []string            `json:"activeSourceIds"`
	Crawl           refreshCrawlResult  `json:"crawl"`
	Signals         refreshSignals      `json:"signals"`
	Cache           refreshCacheSummary `json:"cache"`
	Warnings        []refreshWarning    `json:"warnings"`
	Terminal        bool                `json:"terminal"`
}

// refreshResponse is the POST /refresh body.
type refreshResponse struct {
	RefreshID       string                 `json:"refreshId"`
	RequestedAt     string                 `json:"requestedAt"`
	TaskWindowStart string                 `json:"taskWindowStart"`
	Status          refreshLifecycleStatus `json:"status"`
	Crawl           refreshCrawlResult     `json:"crawl"`
	Signals         refreshSignals         `json:"signals"`
	Cache           refreshCacheSummary    `json:"cache"`
	Warnings        []refreshWarning       `json:"warnings"`
	Terminal        bool                   `json:"terminal"`
}

// encodeJSON renders the refresh response.
func (r refreshResponse) encodeJSON() ([]byte, error) { return json.Marshal(r) }

// SignalPoller runs the poll cycles the refresh needs. The situations signals
// worker (internal/situationsignalsworker) implements it; both calls return after
// the cycle finished, including a Telegram cycle handed over to the lease owner
// (B2).
type SignalPoller interface {
	// PollTelegramWait runs one Telegram poll cycle, waiting for the lease owner
	// when this process does not own the single-instance lease.
	PollTelegramWait(ctx context.Context) error
	// PollOref runs one OREF poll cycle.
	PollOref(ctx context.Context) error
}

// NewsSourceDispatcher runs one immediate news source schedule pass. The news
// source scheduler service implements it through RunScheduleOnce.
type NewsSourceDispatcher interface {
	// RunScheduleOnce takes the shared cron:news-source-scheduler lease and runs
	// one schedule pass. ran is false when another scheduler holds the lease
	// (B1), which is the "scheduler is already busy" branch.
	RunScheduleOnce(ctx context.Context) (ran bool, err error)
}

// RefreshService owns POST /api/situation-monitor/refresh.
//
// It reuses the read side (Service) of the same package so the record written
// here is read back by the GET /refresh-runs/:refreshId path and the terminal
// state machine, exactly the way NestJS shares one service between the two
// routes.
type RefreshService struct {
	core      *Service
	poller    SignalPoller
	scheduler NewsSourceDispatcher
	now       func() time.Time
	newID     func() string
}

// NewRefreshService wires the refresh owner.
func NewRefreshService(core *Service, poller SignalPoller, scheduler NewsSourceDispatcher) *RefreshService {
	return &RefreshService{
		core:      core,
		poller:    poller,
		scheduler: scheduler,
		now:       time.Now,
		newID:     newRefreshID,
	}
}

// Refresh runs one refresh for orgID. canTriggerCrawl is the caller's
// crawl.write permission, re-derived from MySQL by the authentication chain (the
// handler resolves it from the identity, never from a request field).
func (s *RefreshService) Refresh(ctx context.Context, orgID string, canTriggerCrawl bool) (refreshResponse, error) {
	if s == nil || s.core == nil || s.core.db == nil {
		return refreshResponse{}, errNoDatabase
	}

	// A'3: requestedAt and taskWindowStart are two separate "now" reads, exactly
	// like the two new Date() calls in NestJS; they may differ by one millisecond.
	refreshID := s.newID()
	requestedAt := s.now()
	taskWindowStart := s.now()

	warnings := make([]refreshWarning, 0, 4)

	// Phase 1 (O2): both prefix clears and the active-source query run
	// concurrently. A cache failure becomes a warning with count 0; a failed
	// source query fails the request like the rejected Promise.all in NestJS.
	prelude, err := s.runPrelude(ctx, orgID)
	if err != nil {
		return refreshResponse{}, err
	}
	if prelude.insights.warning != nil {
		warnings = append(warnings, *prelude.insights.warning)
	}
	if prelude.external.warning != nil {
		warnings = append(warnings, *prelude.external.warning)
	}
	activeSourceIDs := prelude.activeSourceIDs

	// Phase 2 + 3: the crawl gate and the dispatch.
	crawl := refreshCrawlResult{
		Permitted:         canTriggerCrawl,
		ActiveSourceCount: len(activeSourceIDs),
	}
	plan := planRefreshCrawl(canTriggerCrawl, len(activeSourceIDs))
	crawl.Attempted = plan.attempted
	crawl.Message = plan.message
	warnings = append(warnings, plan.warnings...)
	if plan.dispatch {
		outcome, outcomeErr := s.dispatchCrawl(ctx, orgID, activeSourceIDs, taskWindowStart)
		// The values reached before the failure are kept, exactly like the NestJS
		// catch block: scheduledSourceCount and schedulerTriggered are assigned
		// outside the throw site and stay in the record.
		crawl.ScheduledSourceCount = outcome.scheduledSourceCount
		crawl.SchedulerTriggered = outcome.schedulerTriggered
		crawl.CrawlTaskCount = outcome.crawlTaskCount
		crawl.AnalysisTaskCount = outcome.analysisTaskCount
		crawl.Message = outcome.message
		warnings = append(warnings, outcome.warnings...)
		if outcomeErr != nil {
			// Every failure inside the NestJS try block (the source reorder, the
			// dispatch and the two counts) reports one crawl warning and the refresh
			// keeps whatever it already resolved.
			detail := safeRefreshErrorMessage(outcomeErr)
			crawl.Message = "Failed to queue crawl jobs: " + detail
			warnings = append(warnings, refreshWarning{
				Code:     refreshWarningCrawlQueueFailed,
				Source:   refreshSourceCrawl,
				Severity: refreshSeverityError,
				Message:  refreshCrawlQueueFailedMessage,
				Detail:   detail,
			})
		}
	}

	// Phase 4 (O1): Telegram and OREF run concurrently; the warning order is
	// fixed at Telegram then OREF regardless of which cycle finished first.
	telegramOutcome, orefOutcome := s.runSignalRefresh(ctx)
	if telegramOutcome.warning != nil {
		warnings = append(warnings, *telegramOutcome.warning)
	}
	if orefOutcome.warning != nil {
		warnings = append(warnings, *orefOutcome.warning)
	}
	signals := refreshSignals{Telegram: telegramOutcome.result, Oref: orefOutcome.result}
	cache := refreshCacheSummary{
		InsightsCleared: prelude.insights.count,
		ExternalCleared: prelude.external.count,
	}

	// Phase 5: persist, read back through the shared read side and answer.
	record := refreshRunRecord{
		RefreshID:       refreshID,
		OrgID:           orgID,
		RequestedAt:     nestISOTimeFromMillis(requestedAt.UnixMilli()),
		TaskWindowStart: nestISOTimeFromMillis(taskWindowStart.UnixMilli()),
		ActiveSourceIDs: activeSourceIDs,
		Crawl:           crawl,
		Signals:         signals,
		Cache:           cache,
		Warnings:        warnings,
		Terminal:        false,
	}
	if err := s.persistRefreshRun(ctx, record); err != nil {
		return refreshResponse{}, err
	}
	terminal, err := s.refreshTerminal(ctx, orgID, refreshID)
	if err != nil {
		return refreshResponse{}, err
	}

	status := refreshStatusAccepted
	if len(warnings) > 0 {
		status = refreshStatusPartial
	}
	return refreshResponse{
		RefreshID:       record.RefreshID,
		RequestedAt:     record.RequestedAt,
		TaskWindowStart: record.TaskWindowStart,
		Status:          status,
		Crawl:           crawl,
		Signals:         signals,
		Cache:           cache,
		Warnings:        warnings,
		Terminal:        terminal,
	}, nil
}

// errSignalPollerMissing is reported when the refresh owner was built without the
// signals worker. Production wiring validates the prerequisite switch at startup,
// so this only turns a wiring error into an error-severity warning instead of a
// silent "refresh completed".
var errSignalPollerMissing = errors.New("situationsignals: signal poller is not configured")

// refreshCacheClearResult is the outcome of one prefix clear: the removed count
// and, when the clear failed, the warning the refresh records with count 0.
type refreshCacheClearResult struct {
	count   int
	warning *refreshWarning
}

// refreshPrelude is the first phase: the two cache clears and the active source
// list.
type refreshPrelude struct {
	insights        refreshCacheClearResult
	external        refreshCacheClearResult
	activeSourceIDs []string
}

// runPrelude runs the two prefix clears and the active-source query
// concurrently. Every goroutine writes its own field, so no synchronization
// beyond the WaitGroup is needed.
func (s *RefreshService) runPrelude(ctx context.Context, orgID string) (refreshPrelude, error) {
	var prelude refreshPrelude
	var sourceErr error
	var wait sync.WaitGroup
	wait.Add(3)
	go func() {
		defer wait.Done()
		prelude.insights = s.clearCachePrefix(ctx, insightsCachePrefix, refreshWarningInsightsCache, refreshSourceCore, refreshInsightsCacheWarningMessage)
	}()
	go func() {
		defer wait.Done()
		prelude.external = s.clearCachePrefix(ctx, externalCachePrefix, refreshWarningExternalCache, refreshSourceExternal, refreshExternalCacheWarningMessage)
	}()
	go func() {
		defer wait.Done()
		prelude.activeSourceIDs, sourceErr = s.loadActiveSourceIDs(ctx, orgID)
	}()
	wait.Wait()
	if sourceErr != nil {
		return refreshPrelude{}, sourceErr
	}
	return prelude, nil
}

// clearCachePrefix mirrors clearCachePrefix: the removed count on success and a
// warning with count 0 on failure.
func (s *RefreshService) clearCachePrefix(ctx context.Context, prefix, code string, source refreshWarningSource, message string) refreshCacheClearResult {
	count, err := s.core.cache.deleteByPrefix(ctx, prefix)
	if err != nil {
		warning := refreshWarning{
			Code:     code,
			Source:   source,
			Severity: refreshSeverityWarning,
			Message:  message,
			Detail:   safeRefreshErrorMessage(err),
		}
		return refreshCacheClearResult{count: 0, warning: &warning}
	}
	return refreshCacheClearResult{count: count}
}

// loadActiveSourceIDs mirrors prisma.newsSource.findMany({where:{orgId,
// isActive:true}, select:{id:true}}): the ids of the organization's active
// sources, in database order.
func (s *RefreshService) loadActiveSourceIDs(ctx context.Context, orgID string) ([]string, error) {
	rows, err := s.core.db.QueryContext(ctx, "SELECT id FROM NewsSource WHERE orgId = ? AND isActive = 1", orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := make([]string, 0, 8)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return ids, nil
}

// refreshCrawlPlan is the result of the permission and active-source gates before
// any database write.
type refreshCrawlPlan struct {
	// attempted is the record's crawl.attempted.
	attempted bool
	// message is the crawl.message when no dispatch runs.
	message string
	// warnings are appended before any dispatch warning.
	warnings []refreshWarning
	// dispatch reports whether the reorder + dispatch step runs.
	dispatch bool
}

// planRefreshCrawl mirrors the first two branches of the NestJS refresh: a caller
// without crawl.write never attempts a crawl, and an organization without active
// sources has nothing to reorder.
func planRefreshCrawl(canTriggerCrawl bool, activeSourceCount int) refreshCrawlPlan {
	if !canTriggerCrawl {
		return refreshCrawlPlan{
			message: refreshCrawlPermissionMessage,
			warnings: []refreshWarning{{
				Code:     refreshWarningCrawlPermission,
				Source:   refreshSourceCrawl,
				Severity: refreshSeverityWarning,
				Message:  refreshCrawlPermissionMessage,
			}},
		}
	}
	if activeSourceCount == 0 {
		return refreshCrawlPlan{
			message: refreshNoActiveSourcesMessage,
			warnings: []refreshWarning{{
				Code:     refreshWarningNoActiveSources,
				Source:   refreshSourceCrawl,
				Severity: refreshSeverityWarning,
				Message:  refreshNoActiveSourcesMessage,
			}},
		}
	}
	return refreshCrawlPlan{attempted: true, dispatch: true}
}

// refreshCrawlOutcome is the dispatch result: the values the record carries.
type refreshCrawlOutcome struct {
	scheduledSourceCount int
	schedulerTriggered   bool
	crawlTaskCount       int
	analysisTaskCount    int
	message              string
	warnings             []refreshWarning
}

// dispatchCrawl mirrors the try block of the NestJS refresh: reorder the active
// sources, dispatch through the Go scheduler (B1), and count what the pass
// created.
//
// B1: NestJS compares the scheduleCron() result against null, but scheduleCron
// returns void, so the "already busy" branch never fires and a refresh whose
// scheduler lock was held reported schedulerTriggered=true with zero tasks.
// RunScheduleOnce reports whether the pass ran, so the busy branch below reports
// the truth: schedulerTriggered stays false and the caller sees the
// situation_monitor_crawl_scheduler_busy warning.
func (s *RefreshService) dispatchCrawl(ctx context.Context, orgID string, activeSourceIDs []string, taskWindowStart time.Time) (refreshCrawlOutcome, error) {
	// nextRunAt=now, circuitOpenUntil=null, consecutiveFailures=0 for every
	// active source of this organization. The WHERE clause carries orgId, so a
	// tenant can never reorder another tenant's sources.
	result, err := s.core.db.ExecContext(ctx,
		"UPDATE NewsSource SET nextRunAt = ?, circuitOpenUntil = NULL, consecutiveFailures = 0 WHERE orgId = ? AND isActive = 1",
		s.now().UTC().Truncate(time.Millisecond), orgID)
	if err != nil {
		return refreshCrawlOutcome{}, err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return refreshCrawlOutcome{}, err
	}
	outcome := refreshCrawlOutcome{scheduledSourceCount: int(affected)}

	if s.scheduler == nil {
		return outcome, errors.New("situationsignals: news source scheduler is not configured")
	}
	ran, err := s.scheduler.RunScheduleOnce(ctx)
	if err != nil {
		return outcome, err
	}
	if !ran {
		outcome.message = fmt.Sprintf(
			"Marked %d active news source%s for refresh, but the crawl scheduler is already busy. Crawl and analysis will start on the next scheduler tick.",
			outcome.scheduledSourceCount, pluralSuffix(outcome.scheduledSourceCount))
		outcome.warnings = []refreshWarning{{
			Code:     refreshWarningSchedulerBusy,
			Source:   refreshSourceCrawl,
			Severity: refreshSeverityWarning,
			Message:  refreshSchedulerBusyWarningMessage,
		}}
		return outcome, nil
	}

	outcome.schedulerTriggered = true
	crawlTaskCount, err := s.countCrawlTasks(ctx, orgID, activeSourceIDs, taskWindowStart)
	if err != nil {
		return outcome, err
	}
	pipelineJobCount, err := s.countPipelineJobs(ctx, orgID, activeSourceIDs, taskWindowStart)
	if err != nil {
		return outcome, err
	}
	outcome.crawlTaskCount = crawlTaskCount
	outcome.analysisTaskCount = pipelineJobCount - crawlTaskCount
	if outcome.analysisTaskCount < 0 {
		outcome.analysisTaskCount = 0
	}
	outcome.message = buildCrawlDispatchMessage(outcome.scheduledSourceCount, outcome.crawlTaskCount, outcome.analysisTaskCount)
	return outcome, nil
}

// countCrawlTasks mirrors prisma.crawlTask.count for the refresh summary. An
// empty source list skips the query (A'4), exactly like the NestJS null filter.
func (s *RefreshService) countCrawlTasks(ctx context.Context, orgID string, activeSourceIDs []string, taskWindowStart time.Time) (int, error) {
	if len(activeSourceIDs) == 0 {
		return 0, nil
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(activeSourceIDs)), ",")
	args := make([]any, 0, len(activeSourceIDs)+2)
	args = append(args, orgID)
	for _, sourceID := range activeSourceIDs {
		args = append(args, sourceID)
	}
	args = append(args, taskWindowStart.UTC().Truncate(time.Millisecond))
	var count int
	if err := s.core.db.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM CrawlTask WHERE orgId = ? AND newsSourceId IN ("+placeholders+") AND createdAt >= ?",
		args...).Scan(&count); err != nil {
		return 0, err
	}
	return count, nil
}

// countPipelineJobs mirrors prisma.pipelineJob.count for the refresh summary. An
// empty source list skips the query (A'4).
func (s *RefreshService) countPipelineJobs(ctx context.Context, orgID string, activeSourceIDs []string, taskWindowStart time.Time) (int, error) {
	if len(activeSourceIDs) == 0 {
		return 0, nil
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(activeSourceIDs)), ",")
	args := make([]any, 0, len(activeSourceIDs)+2)
	args = append(args, orgID)
	for _, sourceID := range activeSourceIDs {
		args = append(args, sourceID)
	}
	args = append(args, taskWindowStart.UTC().Truncate(time.Millisecond))
	var count int
	if err := s.core.db.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM PipelineJob WHERE orgId = ? AND sourceId IN ("+placeholders+") AND createdAt >= ?",
		args...).Scan(&count); err != nil {
		return 0, err
	}
	return count, nil
}

// buildCrawlDispatchMessage mirrors buildCrawlDispatchMessage, including the
// English singular/plural rule for sources, crawl tasks and analysis tasks.
func buildCrawlDispatchMessage(scheduledSourceCount, crawlTaskCount, analysisTaskCount int) string {
	scheduledLabel := fmt.Sprintf("Marked %d active news source%s for refresh", scheduledSourceCount, pluralSuffix(scheduledSourceCount))
	if crawlTaskCount == 0 && analysisTaskCount == 0 {
		return scheduledLabel + ", but this scheduler tick did not queue any new crawl or analysis tasks."
	}
	return scheduledLabel +
		fmt.Sprintf(" and immediately queued %d crawl task%s plus %d direct analysis task%s.",
			crawlTaskCount, pluralSuffix(crawlTaskCount), analysisTaskCount, pluralSuffix(analysisTaskCount))
}

// pluralSuffix mirrors the NestJS `${count === 1 ? "" : "s"}` rule.
func pluralSuffix(count int) string {
	if count == 1 {
		return ""
	}
	return "s"
}

// refreshSignalOutcome is one signal refresh result plus the warning it added.
type refreshSignalOutcome struct {
	result  refreshTaskResult
	warning *refreshWarning
}

// runSignalRefresh runs the Telegram and OREF cycles concurrently (O1) and
// returns them in the fixed Telegram, OREF order, so the warning order never
// depends on which cycle finished first. The request latency therefore becomes
// the slower of the two cycles instead of their sum.
func (s *RefreshService) runSignalRefresh(ctx context.Context) (refreshSignalOutcome, refreshSignalOutcome) {
	telegram := make(chan refreshSignalOutcome, 1)
	oref := make(chan refreshSignalOutcome, 1)
	go func() { telegram <- s.refreshTelegramSignal(ctx) }()
	go func() { oref <- s.refreshOrefSignal(ctx) }()
	return <-telegram, <-oref
}

// refreshTelegramSignal mirrors refreshTelegramSignal: run one cycle, then read
// the cached feed state for the message and the (non-fatal) warning.
func (s *RefreshService) refreshTelegramSignal(ctx context.Context) refreshSignalOutcome {
	startedAt := time.Now()
	if s.poller == nil {
		return refreshSignalFailure(refreshWarningTelegram, refreshSourceTelegram, refreshTelegramFailedMessage, startedAt, errSignalPollerMissing)
	}
	if err := s.poller.PollTelegramWait(ctx); err != nil {
		return refreshSignalFailure(refreshWarningTelegram, refreshSourceTelegram, refreshTelegramFailedMessage, startedAt, err)
	}

	state := s.core.loadCachedTelegramState(ctx)
	result := refreshTaskResult{Attempted: true, OK: true}
	switch {
	case state.LastError != nil:
		result.Message = *state.LastError
		result.OK = false
		warning := refreshWarning{
			Code:     refreshWarningTelegram,
			Source:   refreshSourceTelegram,
			Severity: refreshSeverityWarning,
			Message:  *state.LastError,
		}
		result.DurationMs = time.Since(startedAt).Milliseconds()
		return refreshSignalOutcome{result: result, warning: &warning}
	case state.LastPollAt != 0:
		result.Message = "Telegram refresh completed at " + nestISOTime(state.LastPollAt) + "."
	default:
		result.Message = "Telegram refresh completed."
	}
	result.DurationMs = time.Since(startedAt).Milliseconds()
	return refreshSignalOutcome{result: result}
}

// refreshOrefSignal mirrors refreshOrefSignal: run one cycle, then read the
// cached alerts state for the message and the (non-fatal) warning.
func (s *RefreshService) refreshOrefSignal(ctx context.Context) refreshSignalOutcome {
	startedAt := time.Now()
	if s.poller == nil {
		return refreshSignalFailure(refreshWarningOref, refreshSourceOref, refreshOrefFailedMessage, startedAt, errSignalPollerMissing)
	}
	if err := s.poller.PollOref(ctx); err != nil {
		return refreshSignalFailure(refreshWarningOref, refreshSourceOref, refreshOrefFailedMessage, startedAt, err)
	}

	state := s.core.loadCachedOrefState(ctx)
	result := refreshTaskResult{Attempted: true, OK: true}
	if state.LastError != nil {
		result.Message = *state.LastError
		result.OK = false
		warning := refreshWarning{
			Code:     refreshWarningOref,
			Source:   refreshSourceOref,
			Severity: refreshSeverityWarning,
			Message:  *state.LastError,
		}
		result.DurationMs = time.Since(startedAt).Milliseconds()
		return refreshSignalOutcome{result: result, warning: &warning}
	}
	if timestamp := currentOrCachedTimestamp(state.LastPollAt); timestamp != "" {
		result.Message = "OREF refresh completed at " + timestamp + "."
	} else {
		result.Message = "OREF refresh completed."
	}
	result.DurationMs = time.Since(startedAt).Milliseconds()
	return refreshSignalOutcome{result: result}
}

// refreshSignalFailure is the catch branch of both signal refreshes: a thrown
// cycle becomes an error-severity warning with the safe error message as detail.
func refreshSignalFailure(code string, source refreshWarningSource, message string, startedAt time.Time, err error) refreshSignalOutcome {
	detail := safeRefreshErrorMessage(err)
	warning := refreshWarning{
		Code:     code,
		Source:   source,
		Severity: refreshSeverityError,
		Message:  message,
		Detail:   detail,
	}
	return refreshSignalOutcome{
		result: refreshTaskResult{
			Attempted:  true,
			OK:         false,
			Message:    detail,
			DurationMs: time.Since(startedAt).Milliseconds(),
		},
		warning: &warning,
	}
}

// persistRefreshRun mirrors persistRefreshRun: the same key and the same 900
// second TTL.
func (s *RefreshService) persistRefreshRun(ctx context.Context, record refreshRunRecord) error {
	payload, err := json.Marshal(record)
	if err != nil {
		return err
	}
	return s.core.cache.set(ctx, refreshRunPrefix+record.RefreshID, payload, refreshRunTTL)
}

// refreshTerminal mirrors `const run = await this.getRefreshRun(...)` and
// `terminal: run?.terminal ?? false`: a missing record yields false, every other
// read failure is an error.
func (s *RefreshService) refreshTerminal(ctx context.Context, orgID, refreshID string) (bool, error) {
	run, err := s.core.getRefreshRun(ctx, orgID, refreshID)
	if err != nil {
		if errors.Is(err, errRefreshRunMissing) {
			return false, nil
		}
		return false, err
	}
	return run.Terminal, nil
}

// safeRefreshErrorMessage mirrors safeErrorMessage: an Error contributes its
// message, a thrown string is used verbatim (a Go error already carries the
// string) and anything else becomes "Request failed".
func safeRefreshErrorMessage(err error) string {
	if err == nil {
		return refreshRequestFailedMessage
	}
	return err.Error()
}

// newRefreshID returns a random RFC 4122 version 4 UUID, the shape
// crypto.randomUUID() produces.
func newRefreshID() string {
	buffer := make([]byte, refreshUUIDBytes)
	if _, err := rand.Read(buffer); err != nil {
		// A random-source failure must not fail the request: fall back to the
		// clock-shaped id, which is unique enough for one refresh run key.
		return fmt.Sprintf("%d-0000-4000-8000-000000000000", time.Now().UnixNano())
	}
	buffer[6] = (buffer[6] & 0x0f) | 0x40
	buffer[8] = (buffer[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", buffer[0:4], buffer[4:6], buffer[6:8], buffer[8:10], buffer[10:16])
}
