package newssourcescheduler

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/crawlmetadata"
)

// The dispatch tests drive the shared body (O6) through both modes and assert
// the observable outcomes: the per-URL transaction inputs (O2), the enqueue
// results, the S1 dedupe rule, the O3 snapshot cadence and the O1 budget.

func dispatchTestConfig(mode string) map[string]any {
	return map[string]any{
		"seed": map[string]any{
			"enabled":             true,
			"mode":                mode,
			"domain":              "https://example.com",
			"feedUrl":             "https://example.com/feed.xml",
			"maxNewUrlsPerRun":    5,
			"dedupeWindowHours":   24,
			"queryParamAllowlist": []any{},
		},
	}
}

func discoveryCandidate(url string, publishedAtTs int64) crawlmetadata.DiscoveryCandidate {
	crawledAtTs := int64(1789000000000)
	return crawlmetadata.DiscoveryCandidate{
		URL:           url,
		PublishedAtTs: &publishedAtTs,
		CrawledAtTs:   &crawledAtTs,
	}
}

func TestDispatchManualWritesIdsAndMetadataInOneTransaction(t *testing.T) {
	repo := newFakeRepo()
	cache := newFakeCache()
	queue := newFakeQueue()
	discovery := &fakeDiscovery{candidates: []crawlmetadata.DiscoveryCandidate{
		discoveryCandidate("https://example.com/a?utm=1&id=2", 1789000000000),
		discoveryCandidate("https://example.com/b", 1789000000000),
	}}
	service := newTestService(repo, cache, Options{Discovery: discovery, Queue: queue})
	source := testSource("source-1", "org-1", dispatchTestConfig("sitemap"))
	actor := "user-42"

	outcome, err := service.dispatchSource(context.Background(), source, dispatchInput{
		Mode:    dispatchModeManual,
		ActorID: &actor,
	})
	if err != nil {
		t.Fatalf("dispatchSource: %v", err)
	}
	if outcome.Reason != pipelineDispatchReasonOK || outcome.ScheduledCount != 2 {
		t.Fatalf("outcome = %+v", outcome)
	}
	if len(repo.persistCalls) != 2 {
		t.Fatalf("persist calls = %d, want 2", len(repo.persistCalls))
	}
	if repo.syncQueueCalls != 1 || repo.upsertCalls != 1 {
		t.Fatalf("snapshot cadence: sync=%d upsert=%d, want 1/1 (O3)", repo.syncQueueCalls, repo.upsertCalls)
	}
	for _, call := range repo.persistCalls {
		if call.PipelineJobID == "" || call.CrawlTaskID == "" {
			t.Fatalf("pre-generated ids missing: %+v", call)
		}
		var metadata map[string]json.RawMessage
		if err := json.Unmarshal(call.JobMetadata, &metadata); err != nil {
			t.Fatalf("job metadata: %v", err)
		}
		var crawlTaskID string
		if err := json.Unmarshal(metadata["crawlTaskId"], &crawlTaskID); err != nil {
			t.Fatalf("crawlTaskId: %v", err)
		}
		if crawlTaskID != call.CrawlTaskID {
			t.Fatalf("metadata.crawlTaskId = %q, want %q (O2)", crawlTaskID, call.CrawlTaskID)
		}
		var triggeredBy string
		if err := json.Unmarshal(metadata["triggeredById"], &triggeredBy); err != nil {
			t.Fatalf("triggeredById: %v", err)
		}
		if triggeredBy != actor {
			t.Fatalf("triggeredById = %q, want %q", triggeredBy, actor)
		}
		var config map[string]json.RawMessage
		if err := json.Unmarshal(call.TaskConfig, &config); err != nil {
			t.Fatalf("task config: %v", err)
		}
		var pipelineJobID string
		if err := json.Unmarshal(config["pipelineJobId"], &pipelineJobID); err != nil {
			t.Fatalf("config.pipelineJobId: %v", err)
		}
		if pipelineJobID != call.PipelineJobID {
			t.Fatalf("config.pipelineJobId = %q, want %q (O2)", pipelineJobID, call.PipelineJobID)
		}
	}
	// The explicit empty allowlist strips the tracking parameter, so both URLs
	// survive and the queued targets are canonical.
	if len(queue.calls) != 2 {
		t.Fatalf("enqueue calls = %d, want 2", len(queue.calls))
	}
	if len(repo.taskQueued) != 2 {
		t.Fatalf("queued tasks = %d, want 2", len(repo.taskQueued))
	}
	// The manual path writes isActive/circuitOpenUntil/lastRunAt/nextRunAt in one
	// statement.
	if repo.manualRunUpdates != 1 {
		t.Fatalf("manual run updates = %d, want 1", repo.manualRunUpdates)
	}
}

func TestDispatchCronOmitsTriggeredByAndUsesResolvedActor(t *testing.T) {
	repo := newFakeRepo()
	cache := newFakeCache()
	queue := newFakeQueue()
	discovery := &fakeDiscovery{candidates: []crawlmetadata.DiscoveryCandidate{
		discoveryCandidate("https://example.com/a", 1789000000000),
	}}
	service := newTestService(repo, cache, Options{Discovery: discovery, Queue: queue})
	source := testSource("source-1", "org-1", dispatchTestConfig("sitemap"))
	runtimeSettings := defaultSeedRuntimeSettings()

	if _, err := service.dispatchSource(context.Background(), source, dispatchInput{
		Mode:            dispatchModeCron,
		RuntimeSettings: &runtimeSettings,
	}); err != nil {
		t.Fatalf("dispatchSource: %v", err)
	}
	if len(repo.persistCalls) != 1 {
		t.Fatalf("persist calls = %d, want 1", len(repo.persistCalls))
	}
	var metadata map[string]json.RawMessage
	if err := json.Unmarshal(repo.persistCalls[0].JobMetadata, &metadata); err != nil {
		t.Fatalf("job metadata: %v", err)
	}
	if _, present := metadata["triggeredById"]; present {
		t.Fatal("cron metadata must not carry triggeredById")
	}
	if repo.sourceRunUpdates != 1 || repo.manualRunUpdates != 0 {
		t.Fatalf("source updates: run=%d manual=%d", repo.sourceRunUpdates, repo.manualRunUpdates)
	}
}

func TestDispatchSkipsRecentArticleByURLAndCandidateFingerprint(t *testing.T) {
	repo := newFakeRepo()
	cache := newFakeCache()
	queue := newFakeQueue()
	canonicalURL, fingerprint, ok := buildCanonicalURLFingerprint("https://example.com/a", []string{})
	if !ok {
		t.Fatal("fingerprint failed")
	}
	old := "old-fingerprint"
	repo.articleByURL = []fingerprintRecord{{URL: canonicalURL, URLFingerprint: &old}}
	discovery := &fakeDiscovery{candidates: []crawlmetadata.DiscoveryCandidate{
		discoveryCandidate("https://example.com/a", 1789000000000),
	}}
	service := newTestService(repo, cache, Options{Discovery: discovery, Queue: queue})
	source := testSource("source-1", "org-1", dispatchTestConfig("sitemap"))

	outcome, err := service.dispatchSource(context.Background(), source, dispatchInput{Mode: dispatchModeManual, ActorID: strPtr("user-1")})
	if err != nil {
		t.Fatalf("dispatchSource: %v", err)
	}
	if len(queue.calls) != 0 {
		t.Fatalf("enqueue calls = %d, want 0 (the URL record must dedupe the candidate)", len(queue.calls))
	}
	if outcome.Reason != pipelineDispatchReasonNoNewURLs {
		t.Fatalf("reason = %q, want no_new_urls", outcome.Reason)
	}
	if fingerprint == "" {
		t.Fatal("empty fingerprint")
	}
}

func TestDispatchEnqueueFailureFailsBothRows(t *testing.T) {
	repo := newFakeRepo()
	cache := newFakeCache()
	queue := newFakeQueue()
	queue.failAll = errors.New("queue unavailable")
	discovery := &fakeDiscovery{candidates: []crawlmetadata.DiscoveryCandidate{
		discoveryCandidate("https://example.com/a", 1789000000000),
	}}
	service := newTestService(repo, cache, Options{Discovery: discovery, Queue: queue})
	source := testSource("source-1", "org-1", dispatchTestConfig("sitemap"))

	outcome, err := service.dispatchSource(context.Background(), source, dispatchInput{Mode: dispatchModeManual, ActorID: strPtr("user-1")})
	if err != nil {
		t.Fatalf("dispatchSource: %v", err)
	}
	if outcome.EnqueueFailures != 1 || outcome.ScheduledCount != 0 {
		t.Fatalf("outcome = %+v", outcome)
	}
	if len(repo.pipelineFailed) != 1 || len(repo.taskFailed) != 1 {
		t.Fatalf("failed rows: pipelines=%d tasks=%d", len(repo.pipelineFailed), len(repo.taskFailed))
	}
	if repo.syncQueueCalls != 1 || repo.upsertCalls != 1 {
		t.Fatalf("snapshot cadence after a failure: sync=%d upsert=%d", repo.syncQueueCalls, repo.upsertCalls)
	}
}

func TestDispatchSkipsQueuedCrawlTask(t *testing.T) {
	repo := newFakeRepo()
	repo.persistFn = func(dispatchPersist) (dispatchPersistResult, error) {
		return dispatchPersistResult{Skipped: true}, nil
	}
	cache := newFakeCache()
	queue := newFakeQueue()
	discovery := &fakeDiscovery{candidates: []crawlmetadata.DiscoveryCandidate{
		discoveryCandidate("https://example.com/a", 1789000000000),
	}}
	service := newTestService(repo, cache, Options{Discovery: discovery, Queue: queue})
	source := testSource("source-1", "org-1", dispatchTestConfig("sitemap"))

	outcome, err := service.dispatchSource(context.Background(), source, dispatchInput{Mode: dispatchModeCron, RuntimeSettings: runtimeSettingsPtr()})
	if err != nil {
		t.Fatalf("dispatchSource: %v", err)
	}
	if outcome.SkippedCount != 1 || outcome.ScheduledCount != 0 {
		t.Fatalf("outcome = %+v", outcome)
	}
	if repo.rescheduleIfDue != 1 {
		t.Fatalf("reschedule calls = %d, want 1", repo.rescheduleIfDue)
	}
	if len(queue.calls) != 0 {
		t.Fatalf("enqueue calls = %d, want 0", len(queue.calls))
	}
}

func TestDispatchInFlightBlocksAndReschedules(t *testing.T) {
	for _, mode := range []dispatchMode{dispatchModeManual, dispatchModeCron} {
		t.Run(string(mode), func(t *testing.T) {
			repo := newFakeRepo()
			repo.inFlight = []inFlightJob{{ID: "job-1", Status: "queued", CreatedAt: time.Unix(0, 0)}}
			cache := newFakeCache()
			queue := newFakeQueue()
			service := newTestService(repo, cache, Options{Queue: queue})
			config := dispatchTestConfig("sitemap")
			config["seed"].(map[string]any)["maxNewUrlsPerRun"] = 1
			source := testSource("source-1", "org-1", config)

			input := dispatchInput{Mode: mode}
			if mode == dispatchModeManual {
				input.ActorID = strPtr("user-1")
			} else {
				input.RuntimeSettings = runtimeSettingsPtr()
			}
			outcome, err := service.dispatchSource(context.Background(), source, input)
			if err != nil {
				t.Fatalf("dispatchSource: %v", err)
			}
			if outcome.Reason != pipelineDispatchReasonInFlight {
				t.Fatalf("reason = %q, want in_flight", outcome.Reason)
			}
			if len(repo.persistCalls) != 0 {
				t.Fatalf("persist calls = %d, want 0", len(repo.persistCalls))
			}
			if mode == dispatchModeManual && repo.manualUpdates != 1 {
				t.Fatalf("manual reschedule = %d, want 1", repo.manualUpdates)
			}
			if mode == dispatchModeCron && repo.rescheduleIfDue != 1 {
				t.Fatalf("cron reschedule = %d, want 1", repo.rescheduleIfDue)
			}
		})
	}
}

func TestDispatchBudgetCapsEnqueues(t *testing.T) {
	repo := newFakeRepo()
	cache := newFakeCache()
	queue := newFakeQueue()
	discovery := &fakeDiscovery{candidates: []crawlmetadata.DiscoveryCandidate{
		discoveryCandidate("https://example.com/a", 1789000000000),
		discoveryCandidate("https://example.com/b", 1789000000001),
		discoveryCandidate("https://example.com/c", 1789000000002),
	}}
	service := newTestService(repo, cache, Options{Discovery: discovery, Queue: queue})
	source := testSource("source-1", "org-1", dispatchTestConfig("sitemap"))
	budget := newEnqueueBudget(1)

	outcome, err := service.dispatchSource(context.Background(), source, dispatchInput{
		Mode:            dispatchModeCron,
		RuntimeSettings: runtimeSettingsPtr(),
		Budget:          budget,
	})
	if err != nil {
		t.Fatalf("dispatchSource: %v", err)
	}
	if len(repo.persistCalls) != 1 || len(queue.calls) != 1 {
		t.Fatalf("persist=%d enqueue=%d, want 1/1", len(repo.persistCalls), len(queue.calls))
	}
	if outcome.enqueued != 1 {
		t.Fatalf("enqueued = %d, want 1", outcome.enqueued)
	}
	if !budget.Exhausted() {
		t.Fatal("budget must be exhausted")
	}
}

func TestEnqueueBudgetReserveRelease(t *testing.T) {
	budget := newEnqueueBudget(3)
	if got := budget.Reserve(2); got != 2 {
		t.Fatalf("Reserve(2) = %d", got)
	}
	if budget.Exhausted() {
		t.Fatal("budget must not be exhausted yet")
	}
	if got := budget.Reserve(2); got != 1 {
		t.Fatalf("Reserve(2) = %d, want 1", got)
	}
	if !budget.Exhausted() {
		t.Fatal("budget must be exhausted")
	}
	budget.Release(1)
	if got := budget.Reserve(1); got != 1 {
		t.Fatalf("Reserve after Release = %d, want 1", got)
	}
	if newEnqueueBudget(0) != nil {
		t.Fatal("a zero limit means unlimited and must not allocate")
	}
}

func TestDispatchRSSSkipNoBody(t *testing.T) {
	repo := newFakeRepo()
	cache := newFakeCache()
	queue := newFakeQueue()
	discovery := &fakeDiscovery{candidates: []crawlmetadata.DiscoveryCandidate{
		discoveryCandidate("https://example.com/a", 1789000000000),
	}}
	service := newTestService(repo, cache, Options{Discovery: discovery, Queue: queue})
	source := testSource("source-1", "org-1", dispatchTestConfig("rss"))

	outcome, err := service.dispatchSource(context.Background(), source, dispatchInput{Mode: dispatchModeManual, ActorID: strPtr("user-1")})
	if err != nil {
		t.Fatalf("dispatchSource: %v", err)
	}
	if outcome.RSSSkippedNoBodyCount == nil || *outcome.RSSSkippedNoBodyCount != 1 {
		t.Fatalf("rssSkippedNoBodyCount = %v, want 1", outcome.RSSSkippedNoBodyCount)
	}
	if len(repo.rssCalls) != 0 || len(queue.calls) != 0 {
		t.Fatalf("rss writes=%d enqueues=%d, want 0/0", len(repo.rssCalls), len(queue.calls))
	}
	if cache.incrs["news-source:metric:rss-no-body-skip:source:source-1:24h"] != 1 {
		t.Fatal("the RSS no-body metric must be recorded")
	}
}

func TestDispatchRSSPrefetchedBody(t *testing.T) {
	repo := newFakeRepo()
	cache := newFakeCache()
	items := &fakeItems{result: true}
	markdown := "# Body"
	candidate := discoveryCandidate("https://example.com/a", 1789000000000)
	candidate.PrefetchedArticle = &crawlmetadata.PrefetchedArticle{Markdown: markdown}
	discovery := &fakeDiscovery{candidates: []crawlmetadata.DiscoveryCandidate{candidate}}
	service := newTestService(repo, cache, Options{Discovery: discovery, Items: items})
	source := testSource("source-1", "org-1", dispatchTestConfig("rss"))

	outcome, err := service.dispatchSource(context.Background(), source, dispatchInput{Mode: dispatchModeManual, ActorID: strPtr("user-1")})
	if err != nil {
		t.Fatalf("dispatchSource: %v", err)
	}
	if len(repo.rssCalls) != 1 {
		t.Fatalf("rss writes = %d, want 1", len(repo.rssCalls))
	}
	call := repo.rssCalls[0]
	var metadata map[string]json.RawMessage
	if err := json.Unmarshal(call.JobMetadata, &metadata); err != nil {
		t.Fatalf("job metadata: %v", err)
	}
	var ingestPath string
	_ = json.Unmarshal(metadata["ingestPath"], &ingestPath)
	if ingestPath != "rss_prefetched" {
		t.Fatalf("ingestPath = %q", ingestPath)
	}
	if call.ExternalID != "newsSourceRss:"+call.PipelineJobID {
		t.Fatalf("externalId = %q", call.ExternalID)
	}
	if call.Payload.Prefetched == nil {
		t.Fatal("the outbox payload must carry the prefetched article")
	}
	if len(items.delivered) != 1 || len(outcome.PipelineJobIDs) != 1 {
		t.Fatalf("delivered=%d pipelineJobs=%v", len(items.delivered), outcome.PipelineJobIDs)
	}
}

func TestComputeSharedDispatchDedupeKey(t *testing.T) {
	now := time.Date(2026, 10, 20, 13, 30, 25, 123_000_000, time.UTC)
	window := computeSharedDispatchDedupeKey("source-1", now)
	if window.Key != "news-source:dispatch:source-1:2026-10-20T13:30:25.000Z" {
		t.Fatalf("key = %q", window.Key)
	}
	if window.Until != "2026-10-20T13:30:50.000Z" {
		t.Fatalf("until = %q", window.Until)
	}
	// ceil(24877 / 1000) + 2 = 27
	if window.TTLSeconds != 27 {
		t.Fatalf("ttl = %d, want 27", window.TTLSeconds)
	}
}

func TestSetBackpressureStateTracksHits(t *testing.T) {
	repo := newFakeRepo()
	cache := newFakeCache()
	service := newTestService(repo, cache, Options{})
	pending := 120
	threshold := 100
	for index := 0; index < 2; index++ {
		if err := service.SetBackpressureState(context.Background(), "source-1", &backpressureState{
			Until:       "2026-10-20T13:35:25.000Z",
			PendingJobs: &pending,
			Threshold:   &threshold,
			ObservedAt:  service.now().Add(time.Duration(index) * time.Second),
		}); err != nil {
			t.Fatalf("SetBackpressureState: %v", err)
		}
	}
	var stored listRuntimeState
	if err := json.Unmarshal([]byte(cache.values[listRuntimeKey("source-1")]), &stored); err != nil {
		t.Fatalf("runtime state: %v", err)
	}
	if len(stored.BackpressureHitTimes) != 2 {
		t.Fatalf("hit timestamps = %d, want 2", len(stored.BackpressureHitTimes))
	}
	if stored.BackpressureUntil == nil || *stored.BackpressureUntil != "2026-10-20T13:35:25.000Z" {
		t.Fatalf("until = %v", stored.BackpressureUntil)
	}
	if err := service.SetBackpressureState(context.Background(), "source-1", nil); err != nil {
		t.Fatalf("clear: %v", err)
	}
	if err := json.Unmarshal([]byte(cache.values[listRuntimeKey("source-1")]), &stored); err != nil {
		t.Fatalf("runtime state: %v", err)
	}
	if stored.BackpressureUntil != nil || stored.BackpressurePendingJobs != nil {
		t.Fatal("clearing must drop the marker and keep the history")
	}
	if len(stored.BackpressureHitTimes) != 2 {
		t.Fatalf("history = %d, want 2", len(stored.BackpressureHitTimes))
	}
}

func runtimeSettingsPtr() *seedRuntimeSettings {
	value := defaultSeedRuntimeSettings()
	return &value
}

func strPtr(value string) *string {
	return &value
}
