//go:build integration

package crawlworker

import (
	"context"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/crawlqueue"
)

// TestCrawlWorkerIntegrationTerminalDecrementOnce is F (B1): two worker
// instances share one Redis and finish one task each. The terminal side effect
// lives in the worker that finished the job (the QueueEvents readers are gone),
// so crawl:activity is decremented once per finished task, never once per
// worker, and starting the second instance does not reset the counter.
func TestCrawlWorkerIntegrationTerminalDecrementOnce(t *testing.T) {
	harness := newCrawlIntegration(t)
	harness.setSettings(t, `{
		"conditionalRequestEnabled": false,
		"maxConcurrency": 1,
		"maxRetries": 1
	}`)
	harness.crawl.setRespond(func(call int) (int, string) {
		return http.StatusOK, crawlSuccessBody(call, fmt.Sprintf("%s/story/%d", crawlIntegrationTarget, call), harness.crawl.mediaURL())
	})

	taskIDs := []string{"crawl-task-b1-1", "crawl-task-b1-2"}
	for index, taskID := range taskIDs {
		harness.insertTask(t, crawlTaskSeed{
			ID:        taskID,
			Status:    "queued",
			TargetURL: fmt.Sprintf("%s/story/%d", crawlIntegrationTarget, index+1),
			Config:    `{"ingestToItems":false,"orgContentDedupeWindowHours":0}`,
		})
	}

	// Two unrelated in-flight tasks keep the counter above the number of test
	// tasks: a double decrement then lands on 2 instead of being hidden by the
	// floor-at-zero rule.
	harness.addActivity(t, 2)
	execution := harness.executionService(harness.crawlConfig(false), nil)
	first, _ := harness.startWorker(t, execution)
	second, _ := harness.startWorker(t, execution)
	if first == second {
		t.Fatal("the two crawl workers are the same instance")
	}
	if count := harness.activityCount(t); count != 2 {
		t.Fatalf("crawl:activity activeTaskCount after both workers started = %d, want 2 (startup must not overwrite it)", count)
	}

	for _, taskID := range taskIDs {
		harness.enqueueTask(t, taskID, crawlEnqueueOptions{})
	}
	if count := harness.activityCount(t); count != 4 {
		t.Fatalf("crawl:activity activeTaskCount after the enqueues = %d, want 4", count)
	}

	// Wait for the two terminal decrements. The expected value is 2; a double
	// decrement per job settles on 0 and fails the assertion below instead of
	// hanging until the timeout.
	waitFor(t, 60*time.Second, "the terminal crawl activity decrements", func() bool {
		return harness.activityCount(t) <= 2
	})
	// A duplicate decrement emitted by the second worker would land right after
	// its own completion, so the counter is re-read after a short settle window
	// instead of on the first observation of 2.
	time.Sleep(300 * time.Millisecond)
	for _, taskID := range taskIDs {
		task := harness.readTask(t, taskID)
		if task.Status != "completed" {
			t.Fatalf("crawl task %s status = %q, want completed", taskID, task.Status)
		}
		if task.RunCount != 1 {
			t.Fatalf("crawl task %s runCount = %d, want 1", taskID, task.RunCount)
		}
	}
	if count := harness.countEvents(t, crawlqueue.QueueNormal, "completed", ""); count != len(taskIDs) {
		t.Fatalf("completed queue events = %d, want %d", count, len(taskIDs))
	}
	// 4 - 2 = 2. A second (double) decrement per job would leave 0.
	if count := harness.activityCount(t); count != 2 {
		t.Fatalf("crawl:activity activeTaskCount = %d after two completions, want 2 (one decrement per task)", count)
	}
}

// TestCrawlWorkerIntegrationStalledRequeue is H: a job the crashed worker left
// in the active list without a lock is recovered by the stalled check, and the
// CrawlTask goes back to queued with the BullMQ stalled message.
func TestCrawlWorkerIntegrationStalledRequeue(t *testing.T) {
	harness := newCrawlIntegration(t)
	harness.setSettings(t, `{
		"conditionalRequestEnabled": false,
		"maxConcurrency": 1,
		"maxRetries": 1
	}`)
	taskID := "crawl-task-stalled-1"
	harness.insertTask(t, crawlTaskSeed{
		ID:        taskID,
		Status:    "running",
		TargetURL: crawlIntegrationTarget,
		Config:    `{"ingestToItems":false}`,
	})
	jobID := harness.enqueueTask(t, taskID, crawlEnqueueOptions{})

	// Reproduce the state moveStalledJobsToWait-8 expects: the job is in the
	// active list, its lock is gone (the worker died), the stalled set lists it
	// and the stalled-check debounce key does not exist.
	activeKey := "bull:" + crawlqueue.QueueNormal + ":active"
	waitKey := "bull:" + crawlqueue.QueueNormal + ":wait"
	stalledKey := "bull:" + crawlqueue.QueueNormal + ":stalled"
	if err := harness.redis.LRem(harness.ctx, waitKey, 1, jobID).Err(); err != nil {
		t.Fatalf("remove the job from the wait list: %v", err)
	}
	if err := harness.redis.LPush(harness.ctx, activeKey, jobID).Err(); err != nil {
		t.Fatalf("push the job onto the active list: %v", err)
	}
	if err := harness.redis.SAdd(harness.ctx, stalledKey, jobID).Err(); err != nil {
		t.Fatalf("mark the job as stalled: %v", err)
	}

	execution := harness.executionService(harness.crawlConfig(false), nil)
	worker, _ := harness.newWorker(t, execution)
	defer func() {
		closeCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		_ = worker.Close(closeCtx)
	}()
	// One stalled pass, without the 30s BullMQ interval: the worker runtime owns
	// the checker, but the test drives a single run so the assertion does not
	// wait for the timer.
	runtime, err := worker.newQueueRuntime(queueSpec{Name: crawlqueue.QueueNormal, Class: crawlqueue.PriorityClassNormal})
	if err != nil {
		t.Fatalf("build the crawl queue runtime: %v", err)
	}
	defer runtime.close()
	runtime.checkStalled(harness.ctx)

	task := harness.readTask(t, taskID)
	if task.Status != "queued" {
		t.Fatalf("crawl task status = %q, want queued after the stalled recovery", task.Status)
	}
	if !task.LastError.Valid || task.LastError.String != "crawl job stalled; re-queued by bullmq" {
		t.Fatalf("crawl task lastError = %#v, want the stalled requeue message", task.LastError)
	}
	if !harness.listContains(t, waitKey, jobID) {
		t.Fatal("the recovered job is not in the wait list")
	}
	if harness.listContains(t, activeKey, jobID) {
		t.Fatal("the recovered job is still in the active list")
	}
	if stalledCount := harness.jobField(t, crawlqueue.QueueNormal, jobID, "stc"); stalledCount != "1" {
		t.Fatalf("job stalled counter = %q, want 1", stalledCount)
	}
	if !harness.eventsContain(t, crawlqueue.QueueNormal, "stalled", jobID) {
		t.Fatal("the queue events stream has no stalled event")
	}
	if count := harness.activityCount(t); count != 1 {
		t.Fatalf("crawl:activity activeTaskCount = %d, want 1: a stalled recovery is not terminal", count)
	}
}

// TestCrawlWorkerIntegrationLegacyQueueWorker is I: the legacy `crawl4ai` queue
// only gets a worker (and a dedicated blocking connection) while it still holds
// waiting/active/delayed/paused work.
func TestCrawlWorkerIntegrationLegacyQueueWorker(t *testing.T) {
	harness := newCrawlIntegration(t)
	harness.setSettings(t, `{
		"conditionalRequestEnabled": false,
		"maxConcurrency": 1,
		"maxRetries": 1
	}`)
	taskID := "crawl-task-legacy-1"
	harness.insertTask(t, crawlTaskSeed{
		ID:        taskID,
		Status:    "queued",
		TargetURL: crawlIntegrationTarget,
		Config:    `{"ingestToItems":false}`,
	})
	execution := harness.executionService(harness.crawlConfig(false), nil)

	// ---- empty legacy queue: hot + normal only ----------------------------
	emptyWorker, emptyClients := harness.newWorker(t, execution)
	if err := emptyWorker.Start(context.Background()); err != nil {
		t.Fatalf("start the crawl worker without a legacy backlog: %v", err)
	}
	if names := crawlQueueNames(emptyWorker); len(names) != 2 ||
		names[0] != crawlqueue.QueueHot || names[1] != crawlqueue.QueueNormal {
		t.Fatalf("running queues = %v, want [%s %s]", names, crawlqueue.QueueHot, crawlqueue.QueueNormal)
	}
	if count := emptyClients.count(); count != 2 {
		t.Fatalf("blocking connections without a legacy backlog = %d, want 2", count)
	}
	closeCrawlWorker(t, emptyWorker)

	// ---- legacy backlog: a third worker plus its blocking connection ------
	legacyJobID := "legacy-crawl-job-1"
	legacyJobKey := "bull:" + crawlqueue.QueueLegacy + ":" + legacyJobID
	if err := harness.redis.HSet(harness.ctx, legacyJobKey,
		"name", crawlqueue.JobName,
		"data", `{"taskId":"`+taskID+`","orgId":"`+crawlIntegrationOrgID+`","memoryPressureRequeues":0,"priorityClass":"normal"}`,
		"opts", `{"attempts":1}`,
		"timestamp", harness.now.UnixMilli(),
		"delay", 0,
		"priority", 0,
	).Err(); err != nil {
		t.Fatalf("seed the legacy job hash: %v", err)
	}
	if err := harness.redis.LPush(harness.ctx, "bull:"+crawlqueue.QueueLegacy+":wait", legacyJobID).Err(); err != nil {
		t.Fatalf("seed the legacy wait list: %v", err)
	}
	// The legacy job must not be processed: only the worker creation is under
	// test, so the queue is paused before the worker starts.
	if err := harness.redis.HSet(harness.ctx, "bull:"+crawlqueue.QueueLegacy+":meta", "paused", 1).Err(); err != nil {
		t.Fatalf("pause the legacy queue: %v", err)
	}

	backlogWorker, backlogClients := harness.newWorker(t, execution)
	if err := backlogWorker.Start(context.Background()); err != nil {
		t.Fatalf("start the crawl worker with a legacy backlog: %v", err)
	}
	names := crawlQueueNames(backlogWorker)
	if len(names) != 3 || names[2] != crawlqueue.QueueLegacy {
		t.Fatalf("running queues with a legacy backlog = %v, want hot, normal and %s", names, crawlqueue.QueueLegacy)
	}
	if count := backlogClients.count(); count != 3 {
		t.Fatalf("blocking connections with a legacy backlog = %d, want 3", count)
	}
	closeCrawlWorker(t, backlogWorker)
	// The paused legacy job keeps its place in the wait list.
	if !harness.listContains(t, "bull:"+crawlqueue.QueueLegacy+":wait", legacyJobID) {
		t.Fatal("the legacy job left the wait list although its queue is paused")
	}
}

// crawlQueueNames lists the queue workers a started worker runs.
func crawlQueueNames(worker *Worker) []string {
	names := make([]string, 0, len(worker.queues))
	for _, runtime := range worker.queues {
		names = append(names, runtime.spec.Name)
	}
	return names
}

// closeCrawlWorker closes one started worker.
func closeCrawlWorker(t *testing.T, worker *Worker) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if err := worker.Close(ctx); err != nil {
		t.Fatalf("close the crawl worker: %v", err)
	}
}
