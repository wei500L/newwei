package crawlmaintenance

import (
	"testing"
	"time"
)

// TestParseCleanupPayload covers parseOutboxPayload: only an object with the
// exact type and a non-blank string taskId is valid.
func TestParseCleanupPayload(t *testing.T) {
	cases := []struct {
		name     string
		payload  string
		wantOK   bool
		wantTask string
		wantOrg  string
	}{
		{"valid", `{"type":"cleanup_crawl_results","taskId":"task-1"}`, true, "task-1", ""},
		{"valid with org", `{"type":"cleanup_crawl_results","taskId":"task-1","orgId":"org-1"}`, true, "task-1", "org-1"},
		{"wrong type", `{"type":"processed_item","taskId":"task-1"}`, false, "", ""},
		{"missing type", `{"taskId":"task-1"}`, false, "", ""},
		{"blank task id", `{"type":"cleanup_crawl_results","taskId":"   "}`, false, "", ""},
		{"numeric task id", `{"type":"cleanup_crawl_results","taskId":7}`, false, "", ""},
		{"null payload", `null`, false, "", ""},
		{"array payload", `[]`, false, "", ""},
		{"blank org id", `{"type":"cleanup_crawl_results","taskId":"task-1","orgId":"  "}`, true, "task-1", ""},
	}
	for _, testCase := range cases {
		payload, ok := parseCleanupPayload([]byte(testCase.payload))
		if ok != testCase.wantOK {
			t.Errorf("%s: ok = %t, want %t", testCase.name, ok, testCase.wantOK)
			continue
		}
		if !ok {
			continue
		}
		if payload.TaskID != testCase.wantTask {
			t.Errorf("%s: taskId = %q, want %q", testCase.name, payload.TaskID, testCase.wantTask)
		}
		if testCase.wantOrg == "" {
			if payload.OrgID != nil {
				t.Errorf("%s: orgId = %q, want nil", testCase.name, *payload.OrgID)
			}
			continue
		}
		if payload.OrgID == nil || *payload.OrgID != testCase.wantOrg {
			t.Errorf("%s: orgId = %v, want %q", testCase.name, payload.OrgID, testCase.wantOrg)
		}
	}
}

// TestComputeBackoffDelay pins the documented backoff: base * 2^(min(attempt,5)-1)
// with a 0.5..1.5 jitter and Math.round.
func TestComputeBackoffDelay(t *testing.T) {
	midpoint := &CleanupOutboxScheduler{rand: func() float64 { return 0.5 }}
	cases := []struct {
		attempt int
		want    int
	}{
		{0, 30_000},
		{1, 30_000},
		{2, 60_000},
		{3, 120_000},
		{5, 480_000},
		{6, 480_000},
		{10, 480_000},
	}
	for _, testCase := range cases {
		if got := midpoint.computeBackoffDelay(cleanupOutboxBaseDelayMs, testCase.attempt, 5); got != testCase.want {
			t.Errorf("computeBackoffDelay(attempt=%d) = %d, want %d", testCase.attempt, got, testCase.want)
		}
	}
	low := &CleanupOutboxScheduler{rand: func() float64 { return 0 }}
	if got := low.computeBackoffDelay(cleanupOutboxBaseDelayMs, 1, 5); got != 15_000 {
		t.Errorf("minimum jitter delay = %d, want 15000", got)
	}
	high := &CleanupOutboxScheduler{rand: func() float64 { return 0.999999 }}
	if got := high.computeBackoffDelay(cleanupOutboxBaseDelayMs, 1, 5); got != 45_000 {
		t.Errorf("maximum jitter delay = %d, want 45000", got)
	}
}

// TestMergeRetryEntries covers the three-group merge: first occurrence wins,
// createdAt then id order, and the batch cut.
func TestMergeRetryEntries(t *testing.T) {
	pending := []cleanupOutboxEntry{
		{ID: "b", CreatedAt: time.Unix(2, 0)},
		{ID: "a", CreatedAt: time.Unix(1, 0)},
	}
	failed := []cleanupOutboxEntry{
		{ID: "a", CreatedAt: time.Unix(9, 0)},
		{ID: "c", CreatedAt: time.Unix(1, 0)},
	}
	stale := []cleanupOutboxEntry{{ID: "d", CreatedAt: time.Unix(3, 0)}}
	merged := mergeRetryEntries([][]cleanupOutboxEntry{pending, failed, stale}, 10)
	if len(merged) != 4 {
		t.Fatalf("merge length = %d, want 4", len(merged))
	}
	if merged[0].ID != "a" || merged[1].ID != "c" || merged[2].ID != "b" || merged[3].ID != "d" {
		t.Fatalf("order = %v", merged)
	}
	if !merged[0].CreatedAt.Equal(time.Unix(1, 0)) {
		t.Fatal("the first occurrence (pending) must win")
	}
	if cut := mergeRetryEntries([][]cleanupOutboxEntry{pending, failed, stale}, 2); len(cut) != 2 {
		t.Fatalf("cut length = %d, want 2", len(cut))
	}
}
