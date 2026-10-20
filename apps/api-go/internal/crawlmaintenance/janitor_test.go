package crawlmaintenance

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/crawlqueue"
)

func timePointer(value time.Time) *time.Time { return &value }

// TestMergeStaleTaskRows covers the running merge: first occurrence wins, the
// effective timestamp (lastRunAt ?? updatedAt) orders the result and equal
// timestamps fall back to the id order.
func TestMergeStaleTaskRows(t *testing.T) {
	base := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	started := []staleTaskRow{
		{ID: "b", OrgID: "org-1", LastRunAt: timePointer(base.Add(2 * time.Second)), UpdatedAt: base},
		{ID: "a", OrgID: "org-1", LastRunAt: timePointer(base.Add(time.Second)), UpdatedAt: base},
	}
	withoutHeartbeat := []staleTaskRow{
		{ID: "a", OrgID: "org-1", LastRunAt: nil, UpdatedAt: base},
		{ID: "c", OrgID: "org-2", LastRunAt: nil, UpdatedAt: base.Add(time.Second)},
	}
	merged := mergeStaleTaskRows([][]staleTaskRow{started, withoutHeartbeat}, 10)
	if len(merged) != 3 {
		t.Fatalf("merge length = %d, want 3", len(merged))
	}
	if merged[0].ID != "a" || merged[1].ID != "c" || merged[2].ID != "b" {
		t.Fatalf("merged order = %s,%s,%s", merged[0].ID, merged[1].ID, merged[2].ID)
	}
	if merged[0].LastRunAt == nil {
		t.Fatal("first occurrence should keep the lastRunAt of the first group")
	}
	truncated := mergeStaleTaskRows([][]staleTaskRow{started, withoutHeartbeat}, 2)
	if len(truncated) != 2 || truncated[0].ID != "a" || truncated[1].ID != "c" {
		t.Fatalf("truncated = %v", truncated)
	}
}

// TestStaleTaskMessage pins the four lastError texts, including the integer
// millisecond values.
func TestStaleTaskMessage(t *testing.T) {
	config := JanitorConfig{RunningTimeoutMs: 1_800_000, QueuedTimeoutMs: 43_200_000}
	cases := map[string]string{
		"running": "stale crawl task timed out (running > 1800000ms)",
		"queued":  "stale crawl task timed out (queued > 43200000ms)",
		"pending": "stale crawl task stuck pending with no queue job (never enqueued > 43200000ms)",
	}
	for kind, want := range cases {
		if got := staleTaskMessage(kind, config); got != want {
			t.Errorf("staleTaskMessage(%q) = %q, want %q", kind, got, want)
		}
	}
}

type fakePendingQueue struct {
	count     int64
	ids       crawlqueue.TaskIDSet
	countErr  error
	listErr   error
	lastLimit int
	listCalls int
}

func (f *fakePendingQueue) PendingJobCount(context.Context) (int64, error) {
	return f.count, f.countErr
}

func (f *fakePendingQueue) ListPendingTaskIDs(_ context.Context, scanLimit int) (crawlqueue.TaskIDSet, error) {
	f.listCalls++
	f.lastLimit = scanLimit
	if f.listErr != nil {
		return nil, f.listErr
	}
	return f.ids, nil
}

// TestFilterQueuedTasksWithoutPendingJobs covers the shared O1 scan: the queue
// is counted and scanned once, both kinds use the same task-id set, and the
// effective scan limit is min(scanLimit, pendingCount).
func TestFilterQueuedTasksWithoutPendingJobs(t *testing.T) {
	queue := &fakePendingQueue{
		count: 3,
		ids:   crawlqueue.TaskIDSet{"queued-b": {}, "pending-c": {}},
	}
	scheduler := &JanitorScheduler{queue: queue, config: JanitorConfig{QueueScanLimit: 100}, logf: func(string, ...any) {}}
	queued := []staleTaskRow{{ID: "queued-a"}, {ID: "queued-b"}}
	pending := []staleTaskRow{{ID: "pending-c"}, {ID: "pending-d"}}
	queuedResult, pendingResult := scheduler.filterQueuedTasksWithoutPendingJobs(context.Background(), queued, pending)
	if len(queuedResult) != 1 || queuedResult[0].ID != "queued-a" {
		t.Fatalf("queued result = %v", queuedResult)
	}
	if len(pendingResult) != 1 || pendingResult[0].ID != "pending-d" {
		t.Fatalf("pending result = %v", pendingResult)
	}
	if queue.listCalls != 1 {
		t.Fatalf("list calls = %d, want 1 (queued and pending share one scan)", queue.listCalls)
	}
	if queue.lastLimit != 3 {
		t.Fatalf("scan limit = %d, want min(scanLimit, pendingCount)", queue.lastLimit)
	}
}

// TestFilterQueuedTasksSkipsOverLimitBacklog covers the "backlog too large"
// protection: both kinds are cleared and the queue is not listed.
func TestFilterQueuedTasksSkipsOverLimitBacklog(t *testing.T) {
	queue := &fakePendingQueue{count: 11, ids: crawlqueue.TaskIDSet{}}
	scheduler := &JanitorScheduler{queue: queue, config: JanitorConfig{QueueScanLimit: 10}, logf: func(string, ...any) {}}
	queuedResult, pendingResult := scheduler.filterQueuedTasksWithoutPendingJobs(context.Background(),
		[]staleTaskRow{{ID: "queued-a"}}, []staleTaskRow{{ID: "pending-b"}})
	if queuedResult != nil || pendingResult != nil {
		t.Fatalf("over-limit backlog should clear both lists, got %v / %v", queuedResult, pendingResult)
	}
	if queue.listCalls != 0 {
		t.Fatalf("list calls = %d, want 0", queue.listCalls)
	}
}

// TestFilterQueuedTasksErrorsClearBothKinds covers the warn-and-skip branch.
func TestFilterQueuedTasksErrorsClearBothKinds(t *testing.T) {
	scheduler := &JanitorScheduler{
		queue:  &fakePendingQueue{countErr: errors.New("redis down")},
		config: JanitorConfig{QueueScanLimit: 10},
		logf:   func(string, ...any) {},
	}
	queuedResult, pendingResult := scheduler.filterQueuedTasksWithoutPendingJobs(context.Background(),
		[]staleTaskRow{{ID: "queued-a"}}, []staleTaskRow{{ID: "pending-b"}})
	if queuedResult != nil || pendingResult != nil {
		t.Fatalf("scan error should clear both lists, got %v / %v", queuedResult, pendingResult)
	}
}

// TestNextTicks pins the wall-clock alignment used by the schedulers.
func TestNextTicks(t *testing.T) {
	now := time.Date(2026, 10, 20, 12, 7, 33, 0, time.UTC)
	if got := nextMinute(now); !got.Equal(time.Date(2026, 10, 20, 12, 8, 0, 0, time.UTC)) {
		t.Fatalf("nextMinute = %v", got)
	}
	if got := nextFiveMinutes(now); !got.Equal(time.Date(2026, 10, 20, 12, 10, 0, 0, time.UTC)) {
		t.Fatalf("nextFiveMinutes = %v", got)
	}
	if got := nextLocalHour(now, 1); !got.Equal(time.Date(2026, 10, 21, 1, 0, 0, 0, time.UTC)) {
		t.Fatalf("nextLocalHour = %v", got)
	}
	early := time.Date(2026, 10, 20, 0, 30, 0, 0, time.UTC)
	if got := nextLocalHour(early, 1); !got.Equal(time.Date(2026, 10, 20, 1, 0, 0, 0, time.UTC)) {
		t.Fatalf("nextLocalHour same day = %v", got)
	}
}
