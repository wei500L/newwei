package newssources

import (
	"encoding/json"
	"testing"
)

// TestEmptyIfNoSnapshotKeepsRuntime guards the list projection: a source without
// an ops snapshot row still reports the runtime counters and backpressure state
// the scheduler wrote to Redis, like the NestJS list does.
func TestEmptyIfNoSnapshotKeepsRuntime(t *testing.T) {
	until := "2026-10-22T00:00:00.000Z"
	pending := 3
	threshold := 10
	runtime := runtimeState{
		CrawlTaskQueuedCount:    2,
		CrawlTaskRunningCount:   1,
		BackpressureUntil:       &until,
		BackpressurePendingJobs: &pending,
		BackpressureThreshold:   &threshold,
		BackpressureCount24h:    4,
	}
	got := emptyIfNoSnapshot(opsSummary{Runtime: runtime})
	if got.LatestJob != nil || got.LatestCrawlTask != nil || got.LatestArticle != nil {
		t.Fatalf("latest rows = %#v, want nulls", got)
	}
	if got.Stats24h.SuccessRate != nil || got.Stats24h.AvgDurationMs != nil {
		t.Fatalf("stats24h = %#v, want the empty summary", got.Stats24h)
	}
	if got.Runtime != runtime {
		t.Fatalf("runtime = %#v, want %#v", got.Runtime, runtime)
	}
}

// TestEmptyIfNoSnapshotKeepsSnapshotRows leaves a real snapshot untouched.
func TestEmptyIfNoSnapshotKeepsSnapshotRows(t *testing.T) {
	job := json.RawMessage(`{"id":"job-1","status":"completed"}`)
	summary := opsSummary{LatestJob: job, Stats24h: stats24h{Completed: 2, Failed: 1}}
	got := emptyIfNoSnapshot(summary)
	if string(got.LatestJob) != string(job) {
		t.Fatalf("latestJob = %s, want %s", got.LatestJob, job)
	}
	if got.Stats24h.Completed != 2 || got.Stats24h.Failed != 1 {
		t.Fatalf("stats24h = %#v", got.Stats24h)
	}
}
