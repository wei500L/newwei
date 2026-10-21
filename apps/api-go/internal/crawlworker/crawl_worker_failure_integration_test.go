//go:build integration

package crawlworker

import (
	"net/http"
	"strings"
	"testing"
	"time"
	"unicode/utf16"

	"github.com/wei500L/newwei/apps/api-go/internal/crawlqueue"
)

// TestCrawlWorkerIntegrationRetryableFailureRetries is B: a crawl4ai 503 is a
// retryable error, so the CrawlTask returns to queued with the failure text and
// the task log records willRetry, the BullMQ job moves to delayed with the
// queue backoff, and the second attempt completes the task.
func TestCrawlWorkerIntegrationRetryableFailureRetries(t *testing.T) {
	harness := newCrawlIntegration(t)
	harness.setSettings(t, `{
		"conditionalRequestEnabled": false,
		"maxConcurrency": 1,
		"maxRetries": 2,
		"retryBackoffMs": 2000,
		"requestTimeoutNormalMs": 15000,
		"requestTimeoutHotMs": 15000
	}`)
	harness.crawl.setRespond(func(call int) (int, string) {
		if call == 1 {
			return http.StatusServiceUnavailable, crawlFailureBody("crawl4ai is temporarily unavailable")
		}
		return http.StatusOK, crawlSuccessBody(2, crawlIntegrationTarget, harness.crawl.mediaURL())
	})

	taskID := "crawl-task-retry-1"
	harness.insertTask(t, crawlTaskSeed{
		ID:        taskID,
		Status:    "queued",
		TargetURL: crawlIntegrationTarget,
		Config:    `{"ingestToItems":false,"orgContentDedupeWindowHours":0}`,
	})
	execution := harness.executionService(harness.crawlConfig(false), nil)
	jobID := harness.enqueueTask(t, taskID, crawlEnqueueOptions{})
	harness.startWorker(t, execution)

	// ---- first attempt: retry scheduled ------------------------------------
	waitFor(t, 30*time.Second, "the delayed retry of "+jobID, func() bool {
		return harness.zcard(t, "bull:"+crawlqueue.QueueNormal+":delayed") == 1
	})
	firstAttempt := harness.readTask(t, taskID)
	if firstAttempt.Status != "queued" {
		t.Fatalf("crawl task status after the retryable failure = %q, want queued", firstAttempt.Status)
	}
	if !firstAttempt.LastError.Valid || !strings.Contains(firstAttempt.LastError.String, "temporarily unavailable") {
		t.Fatalf("crawl task lastError = %#v, want the crawl4ai message", firstAttempt.LastError)
	}
	if attemptsMade := harness.jobField(t, crawlqueue.QueueNormal, jobID, "atm"); attemptsMade != "1" {
		t.Fatalf("attemptsMade after the first failure = %q, want 1", attemptsMade)
	}
	errorLog := harness.taskLogErrorData(t, taskID)
	if errorLog == nil {
		t.Fatal("the error task log was not written")
	}
	if !errorLog.WillRetry || !errorLog.Retryable {
		t.Fatalf("error task log retry flags = %#v, want retryable and willRetry", errorLog)
	}
	if errorLog.Attempt != 1 || errorLog.MaxAttempts != 2 {
		t.Fatalf("error task log attempt/maxAttempts = %d/%d, want 1/2", errorLog.Attempt, errorLog.MaxAttempts)
	}
	if errorLog.BackoffDelayMs == nil || *errorLog.BackoffDelayMs != 2000 {
		t.Fatalf("error task log backoffDelayMs = %#v, want 2000", errorLog.BackoffDelayMs)
	}
	if errorLog.NextRetryAt == nil {
		t.Fatal("error task log nextRetryAt is null, want the retry timestamp")
	}
	if harness.zcard(t, "bull:"+crawlqueue.QueueNormal+":failed") != 0 {
		t.Fatal("a retryable failure must not enter the failed set")
	}

	// ---- second attempt: success -------------------------------------------
	harness.waitForTaskStatus(t, taskID, "completed", 45*time.Second)
	harness.waitForActivity(t, 0, 15*time.Second)

	completed := harness.readTask(t, taskID)
	if completed.RunCount != 1 {
		t.Fatalf("crawl task runCount = %d, want 1", completed.RunCount)
	}
	if completed.LastError.Valid {
		t.Fatalf("crawl task lastError = %q after the successful retry, want NULL", completed.LastError.String)
	}
	if harness.countResults(t, taskID) != 1 {
		t.Fatalf("crawl results = %d, want 1", harness.countResults(t, taskID))
	}
	if harness.crawl.crawlCalls() != 2 {
		t.Fatalf("crawl4ai /crawl calls = %d, want 2 (one failure, one success)", harness.crawl.crawlCalls())
	}
	if !harness.eventsContain(t, crawlqueue.QueueNormal, "completed", jobID) {
		t.Fatal("the queue events stream has no completed event")
	}
	if harness.zcard(t, "bull:"+crawlqueue.QueueNormal+":delayed") != 0 {
		t.Fatal("the delayed set is not empty after the successful retry")
	}
}

// TestCrawlWorkerIntegrationUnrecoverableFailure is C: a crawl4ai 400 is not
// retryable, so the worker moves the job straight to the failed set (even with
// attempts left), CrawlTask becomes failed with the lastError text and the
// activity counter is decremented once.
func TestCrawlWorkerIntegrationUnrecoverableFailure(t *testing.T) {
	harness := newCrawlIntegration(t)
	harness.setSettings(t, `{
		"conditionalRequestEnabled": false,
		"maxConcurrency": 1,
		"maxRetries": 3,
		"retryBackoffMs": 2000
	}`)
	harness.crawl.setRespond(func(int) (int, string) {
		return http.StatusBadRequest, crawlFailureBody("target URL is rejected by the upstream robots policy")
	})

	taskID := "crawl-task-unrecoverable-1"
	harness.insertTask(t, crawlTaskSeed{
		ID:        taskID,
		Status:    "queued",
		TargetURL: crawlIntegrationTarget,
		Config:    `{"ingestToItems":false}`,
	})
	execution := harness.executionService(harness.crawlConfig(false), nil)
	jobID := harness.enqueueTask(t, taskID, crawlEnqueueOptions{})
	harness.startWorker(t, execution)

	waitFor(t, 30*time.Second, "the failed job "+jobID, func() bool {
		return harness.zcard(t, "bull:"+crawlqueue.QueueNormal+":failed") == 1
	})
	harness.waitForActivity(t, 0, 15*time.Second)

	task := harness.readTask(t, taskID)
	if task.Status != "failed" {
		t.Fatalf("crawl task status = %q, want failed", task.Status)
	}
	if !task.LastError.Valid || !strings.Contains(task.LastError.String, "robots policy") ||
		!strings.Contains(task.LastError.String, "status 400") {
		t.Fatalf("crawl task lastError = %#v, want the 400 crawl4ai message", task.LastError)
	}
	if harness.listLength(t, "bull:"+crawlqueue.QueueNormal+":delayed") != 0 {
		t.Fatal("an unrecoverable failure must not enter the delayed set")
	}
	if failedReason := harness.jobField(t, crawlqueue.QueueNormal, jobID, "failedReason"); !strings.Contains(failedReason, "robots policy") {
		t.Fatalf("job failedReason = %q, want the crawl4ai message", failedReason)
	}
	if attemptsMade := harness.jobField(t, crawlqueue.QueueNormal, jobID, "atm"); attemptsMade != "1" {
		t.Fatalf("attemptsMade = %q, want 1", attemptsMade)
	}
	if !harness.eventsContain(t, crawlqueue.QueueNormal, "failed", jobID) {
		t.Fatal("the queue events stream has no failed event")
	}
	if harness.countResults(t, taskID) != 0 {
		t.Fatal("a failed crawl must not persist a CrawlResult row")
	}
}

// TestCrawlWorkerIntegrationFailedLastErrorTruncated is D: the final failure
// stores at most 4000 UTF-16 code units of the failedReason and marks the cut
// with the ellipsis the NestJS truncateText appends.
func TestCrawlWorkerIntegrationFailedLastErrorTruncated(t *testing.T) {
	harness := newCrawlIntegration(t)
	harness.setSettings(t, `{
		"conditionalRequestEnabled": false,
		"maxConcurrency": 1,
		"maxRetries": 1
	}`)
	longMessage := strings.Repeat("a", 5000)
	harness.crawl.setRespond(func(int) (int, string) {
		return http.StatusBadRequest, crawlFailureBody(longMessage)
	})

	taskID := "crawl-task-truncated-error-1"
	harness.insertTask(t, crawlTaskSeed{
		ID:        taskID,
		Status:    "queued",
		TargetURL: crawlIntegrationTarget,
		Config:    `{"ingestToItems":false}`,
	})
	execution := harness.executionService(harness.crawlConfig(false), nil)
	jobID := harness.enqueueTask(t, taskID, crawlEnqueueOptions{})
	harness.startWorker(t, execution)

	waitFor(t, 30*time.Second, "the failed job "+jobID, func() bool {
		return harness.zcard(t, "bull:"+crawlqueue.QueueNormal+":failed") == 1
	})
	harness.waitForActivity(t, 0, 15*time.Second)

	task := harness.readTask(t, taskID)
	if task.Status != "failed" {
		t.Fatalf("crawl task status = %q, want failed", task.Status)
	}
	if !task.LastError.Valid {
		t.Fatal("crawl task lastError is NULL, want the truncated failure text")
	}
	lastError := task.LastError.String
	if length := len(utf16.Encode([]rune(lastError))); length != 4000 {
		t.Fatalf("crawl task lastError length = %d UTF-16 code units, want 4000", length)
	}
	if !strings.HasSuffix(lastError, "…") {
		t.Fatalf("crawl task lastError does not end with the ellipsis: %q", lastError[len(lastError)-8:])
	}
	if strings.HasSuffix(strings.TrimSuffix(lastError, "…"), " ") {
		t.Fatal("crawl task lastError keeps a trailing space before the ellipsis")
	}
	if failedReason := harness.jobField(t, crawlqueue.QueueNormal, jobID, "failedReason"); len(failedReason) < 5000 {
		t.Fatalf("job failedReason length = %d, want the untruncated reason", len(failedReason))
	}
}

// TestCrawlWorkerIntegrationMemoryPressureRequeue is E (requeue branch): the
// crawl4ai memory pressure error rate limits every crawl queue for the scaled
// cooldown, increments memoryPressureRequeues and returns the job to wait
// without consuming a BullMQ attempt.
func TestCrawlWorkerIntegrationMemoryPressureRequeue(t *testing.T) {
	harness := newCrawlIntegration(t)
	harness.setSettings(t, `{
		"conditionalRequestEnabled": false,
		"maxConcurrency": 1,
		"maxRetries": 3,
		"queueOverloadCooldownMs": 6000
	}`)
	harness.crawl.setRespond(func(int) (int, string) {
		return http.StatusServiceUnavailable, crawlFailureBody("Refusing new browser instance: memory at 97%")
	})

	taskID := "crawl-task-memory-pressure-1"
	harness.insertTask(t, crawlTaskSeed{
		ID:        taskID,
		Status:    "queued",
		TargetURL: crawlIntegrationTarget,
		Config:    `{"ingestToItems":false}`,
	})
	execution := harness.executionService(harness.crawlConfig(false), nil)
	jobID := harness.enqueueTask(t, taskID, crawlEnqueueOptions{})
	harness.startWorker(t, execution)

	// The requeue is observable as (job back in wait) plus (limiter set).
	waitFor(t, 30*time.Second, "the memory pressure requeue of "+jobID, func() bool {
		value, _ := harness.limiterValue(t, crawlqueue.QueueNormal)
		return value == crawlBullLimiterSentinel &&
			harness.listContains(t, "bull:"+crawlqueue.QueueNormal+":wait", jobID)
	})

	for _, queue := range []string{crawlqueue.QueueHot, crawlqueue.QueueNormal, crawlqueue.QueueLegacy} {
		value, ttl := harness.limiterValue(t, queue)
		if value != crawlBullLimiterSentinel {
			t.Fatalf("bull:%s:limiter = %q, want the BullMQ rate limit sentinel %s", queue, value, crawlBullLimiterSentinel)
		}
		// Base cooldown 6000ms scaled by 3 for the 97% memory reading (the
		// multiplier tiers are >=94% x2, >=96% x3 and >=98% x4) = 18000ms.
		if ttl < 17*time.Second || ttl > 18*time.Second {
			t.Fatalf("bull:%s:limiter PTTL = %s, want ~18000ms (6000ms x3)", queue, ttl)
		}
	}
	data := harness.jobData(t, crawlqueue.QueueNormal, jobID)
	if data.MemoryPressureRequeues != 1 {
		t.Fatalf("job data memoryPressureRequeues = %d, want 1", data.MemoryPressureRequeues)
	}
	if attemptsMade := harness.jobField(t, crawlqueue.QueueNormal, jobID, "atm"); attemptsMade != "" && attemptsMade != "0" {
		t.Fatalf("attemptsMade = %q, want 0: the memory pressure requeue does not consume an attempt", attemptsMade)
	}
	if attemptsStarted := harness.jobField(t, crawlqueue.QueueNormal, jobID, "ats"); attemptsStarted != "1" {
		t.Fatalf("attemptsStarted = %q, want 1", attemptsStarted)
	}
	if harness.zcard(t, "bull:"+crawlqueue.QueueNormal+":failed") != 0 {
		t.Fatal("a requeued memory pressure job must not enter the failed set")
	}
	if harness.zcard(t, "bull:"+crawlqueue.QueueNormal+":delayed") != 0 {
		t.Fatal("a requeued memory pressure job must not enter the delayed set")
	}
	if harness.zcard(t, "bull:"+crawlqueue.QueueNormal+":completed") != 0 {
		t.Fatal("a requeued memory pressure job must not complete")
	}

	task := harness.readTask(t, taskID)
	if task.Status != "queued" {
		t.Fatalf("crawl task status = %q, want queued", task.Status)
	}
	if !task.LastError.Valid || !strings.Contains(task.LastError.String, "memory at 97%") {
		t.Fatalf("crawl task lastError = %#v, want the memory pressure message", task.LastError)
	}
	errorLog := harness.taskLogErrorData(t, taskID)
	if errorLog == nil {
		t.Fatal("the error task log was not written")
	}
	if !errorLog.WillRetry {
		t.Fatalf("error task log willRetry = false, want true with 3 attempts configured: %#v", errorLog)
	}
	if count := harness.activityCount(t); count != 1 {
		t.Fatalf("crawl:activity activeTaskCount = %d, want 1: a requeue is not a terminal state", count)
	}
}

// TestCrawlWorkerIntegrationMemoryPressureBudgetExhausted is E (budget branch):
// with a single attempt the memory pressure error cannot be requeued, so the job
// fails unrecoverably without a cooldown and the task/activity terminal writes
// happen once.
func TestCrawlWorkerIntegrationMemoryPressureBudgetExhausted(t *testing.T) {
	harness := newCrawlIntegration(t)
	harness.setSettings(t, `{
		"conditionalRequestEnabled": false,
		"maxConcurrency": 1,
		"maxRetries": 1,
		"queueOverloadCooldownMs": 6000
	}`)
	harness.crawl.setRespond(func(int) (int, string) {
		return http.StatusServiceUnavailable, crawlFailureBody("Refusing new browser instance: memory at 97%")
	})

	taskID := "crawl-task-memory-pressure-exhausted-1"
	harness.insertTask(t, crawlTaskSeed{
		ID:        taskID,
		Status:    "queued",
		TargetURL: crawlIntegrationTarget,
		Config:    `{"ingestToItems":false}`,
	})
	execution := harness.executionService(harness.crawlConfig(false), nil)
	jobID := harness.enqueueTask(t, taskID, crawlEnqueueOptions{})
	harness.startWorker(t, execution)

	waitFor(t, 30*time.Second, "the failed job "+jobID, func() bool {
		return harness.zcard(t, "bull:"+crawlqueue.QueueNormal+":failed") == 1
	})
	harness.waitForActivity(t, 0, 15*time.Second)

	task := harness.readTask(t, taskID)
	if task.Status != "failed" {
		t.Fatalf("crawl task status = %q, want failed", task.Status)
	}
	if !task.LastError.Valid || !strings.Contains(task.LastError.String, "memory at 97%") {
		t.Fatalf("crawl task lastError = %#v, want the memory pressure message", task.LastError)
	}
	// The exhausted budget must not set the queue cooldown: only the BullMQ
	// per-second manual limiter counter may exist, and it never carries the
	// rate limit sentinel.
	if value, _ := harness.limiterValue(t, crawlqueue.QueueNormal); value == crawlBullLimiterSentinel {
		t.Fatalf("bull:%s:limiter carries the rate limit sentinel after an exhausted memory pressure budget",
			crawlqueue.QueueNormal)
	}
	if harness.listContains(t, "bull:"+crawlqueue.QueueNormal+":wait", jobID) {
		t.Fatal("the job is still in the wait list after the unrecoverable failure")
	}
	if harness.zcard(t, "bull:"+crawlqueue.QueueNormal+":delayed") != 0 {
		t.Fatal("the job entered the delayed set, want a terminal failure")
	}
	if !harness.eventsContain(t, crawlqueue.QueueNormal, "failed", jobID) {
		t.Fatal("the queue events stream has no failed event")
	}
}
