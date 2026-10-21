package situationsignals

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeSignalPoller records the two cycles and can delay them independently, so a
// test can prove that the refresh runs them concurrently but still reports them in
// the Telegram, OREF order.
type fakeSignalPoller struct {
	mu            sync.Mutex
	telegramCalls int
	orefCalls     int
	telegramErr   error
	orefErr       error
	telegramDelay time.Duration
	orefDelay     time.Duration
}

func (p *fakeSignalPoller) PollTelegramWait(context.Context) error {
	p.mu.Lock()
	p.telegramCalls++
	delay, err := p.telegramDelay, p.telegramErr
	p.mu.Unlock()
	if delay > 0 {
		time.Sleep(delay)
	}
	return err
}

func (p *fakeSignalPoller) PollOref(context.Context) error {
	p.mu.Lock()
	p.orefCalls++
	delay, err := p.orefDelay, p.orefErr
	p.mu.Unlock()
	if delay > 0 {
		time.Sleep(delay)
	}
	return err
}

func (p *fakeSignalPoller) calls() (telegram, oref int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.telegramCalls, p.orefCalls
}

// TestBuildCrawlDispatchMessagePlurals pins the English singular/plural rule of
// buildCrawlDispatchMessage verbatim to the NestJS source.
func TestBuildCrawlDispatchMessagePlurals(t *testing.T) {
	cases := []struct {
		name                       string
		scheduled, crawl, analysis int
		want                       string
	}{
		{
			name:      "one source no tasks",
			scheduled: 1,
			want:      "Marked 1 active news source for refresh, but this scheduler tick did not queue any new crawl or analysis tasks.",
		},
		{
			name:      "two sources no tasks",
			scheduled: 2,
			want:      "Marked 2 active news sources for refresh, but this scheduler tick did not queue any new crawl or analysis tasks.",
		},
		{
			name:      "one of each task",
			scheduled: 1, crawl: 1, analysis: 1,
			want: "Marked 1 active news source for refresh and immediately queued 1 crawl task plus 1 direct analysis task.",
		},
		{
			name:      "plural crawl task only",
			scheduled: 3, crawl: 2, analysis: 0,
			want: "Marked 3 active news sources for refresh and immediately queued 2 crawl tasks plus 0 direct analysis tasks.",
		},
		{
			name:      "plural analysis task only",
			scheduled: 2, crawl: 0, analysis: 4,
			want: "Marked 2 active news sources for refresh and immediately queued 0 crawl tasks plus 4 direct analysis tasks.",
		},
		{
			name:      "zero sources",
			scheduled: 0,
			want:      "Marked 0 active news sources for refresh, but this scheduler tick did not queue any new crawl or analysis tasks.",
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got := buildCrawlDispatchMessage(testCase.scheduled, testCase.crawl, testCase.analysis)
			if got != testCase.want {
				t.Fatalf("message = %q, want %q", got, testCase.want)
			}
		})
	}
}

// TestPlanRefreshCrawlPermissionBranches covers the two NestJS warning branches
// before any database write.
func TestPlanRefreshCrawlPermissionBranches(t *testing.T) {
	denied := planRefreshCrawl(false, 3)
	if denied.dispatch || denied.attempted {
		t.Fatalf("denied plan dispatched: %+v", denied)
	}
	if denied.message != refreshCrawlPermissionMessage {
		t.Fatalf("denied message = %q", denied.message)
	}
	if len(denied.warnings) != 1 {
		t.Fatalf("denied warnings = %+v", denied.warnings)
	}
	if got := denied.warnings[0]; got.Code != refreshWarningCrawlPermission ||
		got.Source != refreshSourceCrawl || got.Severity != refreshSeverityWarning ||
		got.Message != refreshCrawlPermissionMessage || got.Detail != "" {
		t.Fatalf("denied warning = %+v", got)
	}

	noSources := planRefreshCrawl(true, 0)
	if noSources.dispatch || noSources.attempted {
		t.Fatalf("no-sources plan dispatched: %+v", noSources)
	}
	if noSources.message != refreshNoActiveSourcesMessage {
		t.Fatalf("no-sources message = %q", noSources.message)
	}
	if len(noSources.warnings) != 1 {
		t.Fatalf("no-sources warnings = %+v", noSources.warnings)
	}
	if got := noSources.warnings[0]; got.Code != refreshWarningNoActiveSources ||
		got.Source != refreshSourceCrawl || got.Severity != refreshSeverityWarning ||
		got.Message != refreshNoActiveSourcesMessage {
		t.Fatalf("no-sources warning = %+v", got)
	}

	permitted := planRefreshCrawl(true, 2)
	if !permitted.dispatch || !permitted.attempted {
		t.Fatalf("permitted plan = %+v", permitted)
	}
	if permitted.message != "" || len(permitted.warnings) != 0 {
		t.Fatalf("permitted plan carries a message/warning: %+v", permitted)
	}
}

// TestRunSignalRefreshKeepsTelegramThenOrefOrder proves O1: the two cycles run
// concurrently (the OREF one finishes first here) and the outcomes are still
// returned Telegram first, OREF second, which is the order the warnings are
// appended in.
func TestRunSignalRefreshKeepsTelegramThenOrefOrder(t *testing.T) {
	store, ops := newMemoryCache()
	store.values[telegramStateKey] = []byte(`{"channelSet":"full","cursorByHandle":{},"items":[],"lastPollAt":1000,"lastError":"telegram-state-error"}`)
	store.values[orefAlertsKey] = []byte(`{"alerts":[],"timestamp":"2026-01-01T00:00:00.000Z","error":"oref-state-error"}`)

	poller := &fakeSignalPoller{telegramDelay: 40 * time.Millisecond}
	service := NewRefreshService(&Service{cache: ops}, poller, nil)

	started := time.Now()
	telegram, oref := service.runSignalRefresh(t.Context())
	elapsed := time.Since(started)

	if telegram, orefCalls := poller.calls(); telegram != 1 || orefCalls != 1 {
		t.Fatalf("poller calls = %d/%d, want one each", telegram, orefCalls)
	}
	// Concurrency: the 40ms Telegram delay and the immediate OREF cycle overlap,
	// so the pair finishes in about one Telegram delay, not two cycles.
	if elapsed >= 80*time.Millisecond {
		t.Fatalf("elapsed = %s, want the two cycles to overlap", elapsed)
	}
	if telegram.result.Message != "telegram-state-error" || telegram.warning == nil {
		t.Fatalf("telegram outcome = %+v", telegram)
	}
	if oref.result.Message != "oref-state-error" || oref.warning == nil {
		t.Fatalf("oref outcome = %+v", oref)
	}
	if telegram.warning.Source != refreshSourceTelegram || oref.warning.Source != refreshSourceOref {
		t.Fatalf("warning sources = %s/%s", telegram.warning.Source, oref.warning.Source)
	}
	if telegram.warning.Severity != refreshSeverityWarning || oref.warning.Severity != refreshSeverityWarning {
		t.Fatalf("cached feed errors must be warnings, not errors: %+v / %+v", telegram.warning, oref.warning)
	}
	if !telegram.result.Attempted || telegram.result.OK || oref.result.OK {
		t.Fatalf("results = %+v / %+v", telegram.result, oref.result)
	}
}

// TestRunSignalRefreshFailureBranch covers the catch branch: a throwing cycle
// reports an error-severity warning with the message as detail.
func TestRunSignalRefreshFailureBranch(t *testing.T) {
	store, ops := newMemoryCache()
	store.values[telegramStateKey] = []byte(`{"channelSet":"full","cursorByHandle":{},"items":[],"lastPollAt":0}`)
	store.values[orefAlertsKey] = []byte(`{"alerts":[],"timestamp":"2026-01-01T00:00:00.000Z","error":"oref-state-error"}`)

	poller := &fakeSignalPoller{telegramErr: errSignalPollerMissing, orefErr: errSignalPollerMissing}
	service := NewRefreshService(&Service{cache: ops}, poller, nil)

	telegram, oref := service.runSignalRefresh(t.Context())

	if telegram.warning == nil || telegram.warning.Severity != refreshSeverityError {
		t.Fatalf("telegram warning = %+v", telegram.warning)
	}
	if telegram.warning.Code != refreshWarningTelegram || telegram.warning.Message != refreshTelegramFailedMessage {
		t.Fatalf("telegram warning = %+v", telegram.warning)
	}
	if telegram.warning.Detail != errSignalPollerMissing.Error() {
		t.Fatalf("telegram detail = %q", telegram.warning.Detail)
	}
	if telegram.result.OK || telegram.result.Message != errSignalPollerMissing.Error() {
		t.Fatalf("telegram result = %+v", telegram.result)
	}
	if oref.warning == nil || oref.warning.Severity != refreshSeverityError {
		t.Fatalf("oref warning = %+v", oref.warning)
	}
	if oref.warning.Code != refreshWarningOref || oref.warning.Message != refreshOrefFailedMessage {
		t.Fatalf("oref warning = %+v", oref.warning)
	}
}

// TestClearCachePrefixWarningBranch covers clearCachePrefix: a Redis failure
// records the prefix warning with count 0, and a success records the removed count
// with no warning.
func TestClearCachePrefixWarningBranch(t *testing.T) {
	store, ops := newMemoryCache()
	store.values["situation-monitor:insights:v2:core:org-a:wh72:mi400:scall:gd1:dbg0:lr0"] = []byte("{}")
	store.values["situation-monitor:insights:learning-rev:v1:org-b"] = []byte("3")
	store.deleteErr = errSignalPollerMissing
	service := NewRefreshService(&Service{cache: ops}, nil, nil)

	failed := service.clearCachePrefix(t.Context(), insightsCachePrefix, refreshWarningInsightsCache, refreshSourceCore, refreshInsightsCacheWarningMessage)
	if failed.count != 0 || failed.warning == nil {
		t.Fatalf("failed clear = %+v", failed)
	}
	if failed.warning.Code != refreshWarningInsightsCache || failed.warning.Source != refreshSourceCore ||
		failed.warning.Severity != refreshSeverityWarning || failed.warning.Message != refreshInsightsCacheWarningMessage ||
		failed.warning.Detail != errSignalPollerMissing.Error() {
		t.Fatalf("failed warning = %+v", failed.warning)
	}
	if len(store.deletedPrefixes) != 1 || store.deletedPrefixes[0] != insightsCachePrefix {
		t.Fatalf("prefixes = %v", store.deletedPrefixes)
	}

	store.deleteErr = nil
	succeeded := service.clearCachePrefix(t.Context(), insightsCachePrefix, refreshWarningInsightsCache, refreshSourceCore, refreshInsightsCacheWarningMessage)
	if succeeded.count != 2 || succeeded.warning != nil {
		t.Fatalf("successful clear = %+v", succeeded)
	}
}

// TestRefreshRunRecordJSONFieldOrder pins the cached record layout: the read side
// (refreshrun.go) and the NestJS getRefreshRun both parse it, and the key order is
// the NestJS literal order.
func TestRefreshRunRecordJSONFieldOrder(t *testing.T) {
	record := refreshRunRecord{
		RefreshID:       "11111111-1111-4111-8111-111111111111",
		OrgID:           "org-1",
		RequestedAt:     "2026-10-21T12:00:00.000Z",
		TaskWindowStart: "2026-10-21T12:00:00.001Z",
		ActiveSourceIDs: []string{"source-1"},
		Crawl: refreshCrawlResult{
			Attempted:            true,
			Permitted:            true,
			ActiveSourceCount:    1,
			ScheduledSourceCount: 1,
			SchedulerTriggered:   true,
			CrawlTaskCount:       1,
			AnalysisTaskCount:    0,
			Message:              "Marked 1 active news source for refresh",
		},
		Signals: refreshSignals{
			Telegram: refreshTaskResult{Attempted: true, OK: true, Message: "Telegram refresh completed.", DurationMs: 12},
			Oref:     refreshTaskResult{Attempted: true, OK: false, Message: "OREF refresh completed at 2026-10-21T12:00:00.000Z.", DurationMs: 30},
		},
		Cache:    refreshCacheSummary{InsightsCleared: 2, ExternalCleared: 0},
		Warnings: []refreshWarning{},
		Terminal: false,
	}
	encoded, err := json.Marshal(record)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"refreshId":"11111111-1111-4111-8111-111111111111","orgId":"org-1",` +
		`"requestedAt":"2026-10-21T12:00:00.000Z","taskWindowStart":"2026-10-21T12:00:00.001Z",` +
		`"activeSourceIds":["source-1"],` +
		`"crawl":{"attempted":true,"permitted":true,"activeSourceCount":1,"scheduledSourceCount":1,` +
		`"schedulerTriggered":true,"crawlTaskCount":1,"analysisTaskCount":0,` +
		`"message":"Marked 1 active news source for refresh"},` +
		`"signals":{"telegram":{"attempted":true,"ok":true,"message":"Telegram refresh completed.","durationMs":12},` +
		`"oref":{"attempted":true,"ok":false,"message":"OREF refresh completed at 2026-10-21T12:00:00.000Z.","durationMs":30}},` +
		`"cache":{"insightsCleared":2,"externalCleared":0},` +
		`"warnings":[],"terminal":false}`
	if string(encoded) != want {
		t.Fatalf("record JSON = %s\nwant %s", encoded, want)
	}
}

// TestRefreshRunRecordRoundTrip writes a record with the write side and reads it
// back with the shared read side, then compares the result with what the NestJS
// getRefreshRun logic derives from the same record:
//
//   - activeSourceIds is empty, so all twelve counts are 0 without a database
//     query and the terminal expression collapses to activeSourceCount === 0 →
//     terminal true;
//   - the record carries the no-active-sources warning and no error-severity
//     warning, so the status is "partial" (hasWarnings wins over completed);
//   - signals and cache are echoed verbatim.
func TestRefreshRunRecordRoundTrip(t *testing.T) {
	store, ops := newMemoryCache()
	core := &Service{cache: ops}
	service := NewRefreshService(core, nil, nil)

	record := refreshRunRecord{
		RefreshID:       "22222222-2222-4222-8222-222222222222",
		OrgID:           "org-1",
		RequestedAt:     "2026-10-21T12:00:00.000Z",
		TaskWindowStart: "2026-10-21T12:00:00.001Z",
		ActiveSourceIDs: []string{},
		Crawl: refreshCrawlResult{
			Attempted:            true,
			Permitted:            true,
			ActiveSourceCount:    0,
			ScheduledSourceCount: 0,
			SchedulerTriggered:   false,
			CrawlTaskCount:       0,
			AnalysisTaskCount:    0,
			Message:              refreshNoActiveSourcesMessage,
		},
		Signals: refreshSignals{
			Telegram: refreshTaskResult{Attempted: true, OK: true, Message: "Telegram refresh completed.", DurationMs: 5},
			Oref:     refreshTaskResult{Attempted: true, OK: true, Message: "OREF refresh completed at 2026-10-21T12:00:00.000Z.", DurationMs: 7},
		},
		Cache: refreshCacheSummary{InsightsCleared: 0, ExternalCleared: 0},
		Warnings: []refreshWarning{{
			Code:     refreshWarningNoActiveSources,
			Source:   refreshSourceCrawl,
			Severity: refreshSeverityWarning,
			Message:  refreshNoActiveSourcesMessage,
		}},
		Terminal: false,
	}
	if err := service.persistRefreshRun(t.Context(), record); err != nil {
		t.Fatalf("persist: %v", err)
	}
	key := refreshRunPrefix + record.RefreshID
	if ttl := store.ttls[key]; ttl != refreshRunTTL {
		t.Fatalf("record TTL = %s, want %s", ttl, refreshRunTTL)
	}

	terminal, err := service.refreshTerminal(t.Context(), record.OrgID, record.RefreshID)
	if err != nil {
		t.Fatalf("terminal: %v", err)
	}
	if !terminal {
		t.Fatalf("terminal = false, want true for an empty source list")
	}

	response, err := core.getRefreshRun(t.Context(), record.OrgID, record.RefreshID)
	if err != nil {
		t.Fatalf("getRefreshRun: %v", err)
	}
	if response.Status != refreshStatusPartial {
		t.Fatalf("status = %s, want partial (the record carries a warning)", response.Status)
	}
	if !response.Terminal {
		t.Fatalf("read-side terminal = false")
	}
	if response.Progress.CrawlTasks != (crawlTaskCounts{}) || response.Progress.AnalysisTasks != (analysisTaskCounts{}) {
		t.Fatalf("progress = %+v", response.Progress)
	}
	encoded := string(mustEncode(t, response))
	for _, fragment := range []string{
		`"refreshId":"22222222-2222-4222-8222-222222222222"`,
		`"requestedAt":"2026-10-21T12:00:00.000Z"`,
		`"taskWindowStart":"2026-10-21T12:00:00.001Z"`,
		`"message":"No active news sources are configured for this workspace, so no crawl jobs were queued."`,
		`"telegram":{"attempted":true,"ok":true,"message":"Telegram refresh completed.","durationMs":5}`,
		`"cache":{"insightsCleared":0,"externalCleared":0}`,
		`"code":"situation_monitor_no_active_sources"`,
	} {
		if !strings.Contains(encoded, fragment) {
			t.Fatalf("response %s is missing %s", encoded, fragment)
		}
	}

	// The read side wrote the computed terminal back into the cached record, so a
	// second read no longer needs to patch it.
	stored, ok := store.values[key]
	if !ok {
		t.Fatalf("record disappeared")
	}
	if !strings.Contains(string(stored), `"terminal":true`) {
		t.Fatalf("stored record = %s", stored)
	}
}

// TestRefreshTerminalMissingRecordIsFalse mirrors `run?.terminal ?? false`: a
// record that cannot be found does not fail the refresh answer.
func TestRefreshTerminalMissingRecordIsFalse(t *testing.T) {
	_, ops := newMemoryCache()
	service := NewRefreshService(&Service{cache: ops}, nil, nil)
	terminal, err := service.refreshTerminal(t.Context(), "org-1", "missing")
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if terminal {
		t.Fatalf("terminal = true for a missing record")
	}
}

// TestRefreshIDShape pins the refresh id shape (a canonical v4 UUID, the shape
// crypto.randomUUID produces) because the id is part of the cache key.
func TestRefreshIDShape(t *testing.T) {
	seen := map[string]bool{}
	for index := 0; index < 32; index++ {
		id := newRefreshID()
		if len(id) != 36 || id[14] != '4' {
			t.Fatalf("id = %q, want a v4 UUID", id)
		}
		if id[8] != '-' || id[13] != '-' || id[18] != '-' || id[23] != '-' {
			t.Fatalf("id = %q, want dashed groups", id)
		}
		switch id[19] {
		case '8', '9', 'a', 'b':
		default:
			t.Fatalf("id = %q, want the RFC 4122 variant nibble", id)
		}
		if seen[id] {
			t.Fatalf("duplicate id %q", id)
		}
		seen[id] = true
	}
}
