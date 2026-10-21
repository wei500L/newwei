//go:build integration

package crawlworker

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/crawlqueue"
)

// TestCrawlWorkerIntegrationTaskSucceeds is the end-to-end success path of the
// Go crawl4ai worker (A): the crawlqueue producer enqueues a crawl-task job, the
// worker claims it, the crawl execution service crawls the fake crawl4ai server,
// persists the result (MySQL row, Mongo content document with a media bucket and
// the CrawlMediaAsset/CrawlMediaBlob rows), writes the TaskLog stages, notifies
// the triggering user on notification:events:v1, stores the CrawlExecutionSummary
// as the BullMQ returnvalue and decrements crawl:activity exactly once.
func TestCrawlWorkerIntegrationTaskSucceeds(t *testing.T) {
	harness := newCrawlIntegration(t)
	harness.setSettings(t, `{
		"conditionalRequestEnabled": false,
		"maxConcurrency": 1,
		"maxRetries": 1,
		"retryBackoffMs": 60000,
		"requestTimeoutNormalMs": 15000,
		"requestTimeoutHotMs": 15000,
		"queueOverloadCooldownMs": 6000
	}`)
	harness.crawl.setRespond(func(int) (int, string) {
		return http.StatusOK, crawlSuccessBody(1, crawlIntegrationTarget, harness.crawl.mediaURL())
	})

	taskID := "crawl-task-success-1"
	harness.insertTask(t, crawlTaskSeed{
		ID:        taskID,
		Status:    "queued",
		TargetURL: crawlIntegrationTarget,
		Config:    `{"ingestToItems":false,"storeMedia":true,"orgContentDedupeWindowHours":0}`,
	})

	notifications := harness.subscribeNotifications(t)
	execution := harness.executionService(harness.crawlConfig(true), notifications.publish)

	jobID := harness.enqueueTask(t, taskID, crawlEnqueueOptions{
		TriggeredByID:   crawlStringPointer(crawlIntegrationUserID),
		RetainCompleted: true,
	})
	if count := harness.activityCount(t); count != 1 {
		t.Fatalf("crawl:activity activeTaskCount after the enqueue = %d, want 1", count)
	}

	harness.startWorker(t, execution)
	harness.waitForCompletedJob(t, crawlqueue.QueueNormal, jobID, 45*time.Second)
	harness.waitForActivity(t, 0, 15*time.Second)

	// ---- CrawlTask ---------------------------------------------------------
	task := harness.readTask(t, taskID)
	if task.Status != "completed" {
		t.Fatalf("crawl task status = %q, want completed", task.Status)
	}
	if task.RunCount != 1 {
		t.Fatalf("crawl task runCount = %d, want 1", task.RunCount)
	}
	if !task.LastResultAt.Valid || !task.LastSuccessAt.Valid || !task.LastRunAt.Valid {
		t.Fatalf("crawl task timestamps = %#v, want lastRunAt/lastSuccessAt/lastResultAt", task)
	}
	if task.LastError.Valid {
		t.Fatalf("crawl task lastError = %q, want NULL", task.LastError.String)
	}
	if !task.LastServerMemoryMB.Valid || task.LastServerMemoryMB.Float64 != 512 {
		t.Fatalf("crawl task lastServerMemoryMb = %#v, want 512", task.LastServerMemoryMB)
	}
	if !task.LastPeakMemoryMB.Valid || task.LastPeakMemoryMB.Float64 != 640 {
		t.Fatalf("crawl task lastPeakMemoryMb = %#v, want 640", task.LastPeakMemoryMB)
	}

	// ---- CrawlResult -------------------------------------------------------
	result := harness.readResult(t, taskID)
	if len(result.MarkdownRef) != 24 {
		t.Fatalf("crawl result markdownRef = %q, want a 24 character ObjectID hex", result.MarkdownRef)
	}
	if len(result.ContentHash) != 64 {
		t.Fatalf("crawl result contentHash = %q, want a sha256 hex", result.ContentHash)
	}
	if result.SourceURL != crawlIntegrationTarget {
		t.Fatalf("crawl result sourceUrl = %q, want %q", result.SourceURL, crawlIntegrationTarget)
	}
	if !result.Metadata.Valid || !strings.Contains(result.Metadata.String, `"canonicalUrl"`) ||
		!strings.Contains(result.Metadata.String, `"publishedAt"`) {
		t.Fatalf("crawl result metadata = %q, want canonicalUrl and publishedAt", result.Metadata.String)
	}

	// ---- CrawlResultContent ------------------------------------------------
	content := harness.readResultContent(t, result.ID)
	if content.ID.Hex() != result.MarkdownRef {
		t.Fatalf("markdownRef = %q, want the CrawlResultContent _id %q", result.MarkdownRef, content.ID.Hex())
	}
	if content.TaskID != taskID || content.ResultID != result.ID {
		t.Fatalf("content identity = taskId %q / resultId %q", content.TaskID, content.ResultID)
	}
	if !strings.Contains(content.Markdown, "Integration story 1") {
		t.Fatalf("content markdown = %q", content.Markdown)
	}
	if content.CrawlRunID == nil || *content.CrawlRunID != crawlIntegrationRunID {
		t.Fatalf("content crawlRunId = %#v, want %q", content.CrawlRunID, crawlIntegrationRunID)
	}
	if content.Media == nil || len(content.Media.Images) != 1 {
		t.Fatalf("content media = %#v, want one image bucket entry", content.Media)
	}
	if content.Media.Images[0].Src != harness.crawl.mediaURL() {
		t.Fatalf("content media src = %q, want %q", content.Media.Images[0].Src, harness.crawl.mediaURL())
	}

	// ---- CrawlMediaAsset / CrawlMediaBlob ----------------------------------
	var (
		provider    string
		kind        string
		mediaURL    string
		mediaBytes  int
		contentType sql.NullString
		blobID      sql.NullString
		storageKey  sql.NullString
	)
	if err := harness.db.QueryRowContext(harness.ctx,
		"SELECT `provider`, `kind`, `sourceUrl`, `bytes`, `contentType`, `blobId`, `storageKey` FROM `CrawlMediaAsset` WHERE `resultId` = ?",
		result.ID).Scan(&provider, &kind, &mediaURL, &mediaBytes, &contentType, &blobID, &storageKey); err != nil {
		t.Fatalf("read crawl media asset: %v", err)
	}
	if provider != "mysql" || kind != "images" {
		t.Fatalf("crawl media asset provider/kind = %q/%q, want mysql/images", provider, kind)
	}
	if mediaURL != harness.crawl.mediaURL() {
		t.Fatalf("crawl media asset sourceUrl = %q, want %q", mediaURL, harness.crawl.mediaURL())
	}
	if mediaBytes != len(harness.crawl.mediaBytes()) {
		t.Fatalf("crawl media asset bytes = %d, want %d", mediaBytes, len(harness.crawl.mediaBytes()))
	}
	if !contentType.Valid || contentType.String != "image/png" {
		t.Fatalf("crawl media asset contentType = %#v, want image/png", contentType)
	}
	if !blobID.Valid || blobID.String == "" {
		t.Fatalf("crawl media asset blobId = %#v, want the CrawlMediaBlob reference", blobID)
	}
	if storageKey.Valid {
		t.Fatalf("crawl media asset storageKey = %q, want NULL on the mysql provider", storageKey.String)
	}
	var (
		refCount  int
		sha256Hex string
		blobBytes int
	)
	if err := harness.db.QueryRowContext(harness.ctx,
		"SELECT `refCount`, `sha256`, `bytes` FROM `CrawlMediaBlob` WHERE `id` = ?", blobID.String).
		Scan(&refCount, &sha256Hex, &blobBytes); err != nil {
		t.Fatalf("read crawl media blob: %v", err)
	}
	digest := sha256.Sum256(harness.crawl.mediaBytes())
	if sha256Hex != hex.EncodeToString(digest[:]) || blobBytes != len(harness.crawl.mediaBytes()) || refCount != 1 {
		t.Fatalf("crawl media blob = %s bytes=%d refCount=%d", sha256Hex, blobBytes, refCount)
	}

	// ---- TaskLog -----------------------------------------------------------
	stages := make(map[string]string, 4)
	for _, document := range harness.readTaskLogs(t, taskID) {
		stages[document.Stage] = document.Status
	}
	for _, stage := range []string{"crawler", "dedupe", "complete"} {
		if stages[stage] != "completed" {
			t.Fatalf("task log stage %q = %q (all stages %#v), want completed", stage, stages[stage], stages)
		}
	}
	completeLog := harness.taskLogCompleteData(t, taskID)
	if completeLog == nil {
		t.Fatal("the complete task log has no data block")
	}
	if completeLog.Inserted != 1 || completeLog.Skipped != 0 {
		t.Fatalf("complete task log inserted/skipped = %d/%d, want 1/0", completeLog.Inserted, completeLog.Skipped)
	}
	if completeLog.RunID == nil || *completeLog.RunID != crawlIntegrationRunID {
		t.Fatalf("complete task log runId = %#v, want %q", completeLog.RunID, crawlIntegrationRunID)
	}

	// ---- Notification row + relay -----------------------------------------
	rows := harness.waitForNotifications(t, 1, 15*time.Second)
	if len(rows) != 1 {
		t.Fatalf("notification rows = %d, want exactly 1", len(rows))
	}
	row := rows[0]
	if !row.UserID.Valid || row.UserID.String != crawlIntegrationUserID {
		t.Fatalf("notification userId = %#v, want %q", row.UserID, crawlIntegrationUserID)
	}
	if row.Type != "crawl_completed" {
		t.Fatalf("notification type = %q, want crawl_completed", row.Type)
	}
	if want := "Crawl completed: " + crawlIntegrationTarget; row.Title != want {
		t.Fatalf("notification title = %q, want %q", row.Title, want)
	}
	if !row.Body.Valid || row.Body.String != "Inserted 1, skipped 0" {
		t.Fatalf("notification body = %#v, want \"Inserted 1, skipped 0\"", row.Body)
	}
	data := decodeCrawlNotificationData(t, row)
	if data.TaskID != taskID || data.Status != "completed" {
		t.Fatalf("notification data = %#v", data)
	}
	if data.LastResultAt == nil {
		t.Fatal("notification data lastResultAt is null, want the fetch timestamp")
	}
	if data.Presentation.Kind != "crawl_completed" {
		t.Fatalf("notification presentation kind = %q, want crawl_completed", data.Presentation.Kind)
	}
	if data.Presentation.Params.TaskID != taskID || data.Presentation.Params.Inserted != 1 ||
		data.Presentation.Params.Skipped != 0 {
		t.Fatalf("notification presentation params = %#v", data.Presentation.Params)
	}

	relayPayload := notifications.next(t, 15*time.Second)
	notifications.expectQuiet(t, 500*time.Millisecond)
	if count := notifications.publishes.Load(); count != 1 {
		t.Fatalf("relay publisher calls = %d, want 1", count)
	}
	var relay crawlNotificationRelayMessage
	if err := json.Unmarshal([]byte(relayPayload), &relay); err != nil {
		t.Fatalf("decode relay payload %q: %v", relayPayload, err)
	}
	if relay.Version != 1 || relay.NotificationID != row.ID || relay.OrgID != crawlIntegrationOrgID ||
		relay.UserID != crawlIntegrationUserID {
		t.Fatalf("relay payload = %#v", relay)
	}
	if strings.Contains(relayPayload, "Crawl completed") {
		t.Fatalf("relay payload must be identifiers-only, got %q", relayPayload)
	}

	// ---- BullMQ job --------------------------------------------------------
	if !harness.jobExists(t, crawlqueue.QueueNormal, jobID) {
		t.Fatalf("the retained completed job %s is gone", jobID)
	}
	if finishedOn := harness.jobField(t, crawlqueue.QueueNormal, jobID, "finishedOn"); finishedOn == "" {
		t.Fatal("completed job has no finishedOn field")
	}
	returnValue := harness.jobField(t, crawlqueue.QueueNormal, jobID, "returnvalue")
	if !strings.HasPrefix(returnValue, `{"inserted":1,"skipped":0`) {
		t.Fatalf("returnvalue = %q, want the CrawlExecutionSummary JSON starting with {\"inserted\":1,\"skipped\":0", returnValue)
	}
	var summary crawlExecutionSummaryDocument
	if err := json.Unmarshal([]byte(returnValue), &summary); err != nil {
		t.Fatalf("decode returnvalue %q: %v", returnValue, err)
	}
	if summary.RunID == nil || *summary.RunID != crawlIntegrationRunID {
		t.Fatalf("returnvalue runId = %#v, want %q", summary.RunID, crawlIntegrationRunID)
	}
	if summary.LastFetchedAt == nil {
		t.Fatal("returnvalue lastFetchedAt is missing")
	}
	if summary.Memory == nil || summary.Memory.ServerMemoryMB == nil || *summary.Memory.ServerMemoryMB != 512 {
		t.Fatalf("returnvalue memory = %#v, want serverMemoryMb 512", summary.Memory)
	}
	if summary.Memory.PeakMemoryMB == nil || *summary.Memory.PeakMemoryMB != 640 {
		t.Fatalf("returnvalue peakMemoryMb = %#v, want 640", summary.Memory.PeakMemoryMB)
	}
	if summary.RetryableFailures != nil || summary.Failures != nil {
		t.Fatalf("returnvalue failures = %#v / retryableFailures = %#v, want both absent", summary.Failures, summary.RetryableFailures)
	}
	if !harness.eventsContain(t, crawlqueue.QueueNormal, "completed", jobID) {
		t.Fatalf("bull:%s:events has no completed event for %s", crawlqueue.QueueNormal, jobID)
	}

	// ---- crawl:activity ----------------------------------------------------
	if count := harness.activityCount(t); count != 0 {
		t.Fatalf("crawl:activity activeTaskCount after the completion = %d, want 0", count)
	}
	if harness.listLength(t, "bull:"+crawlqueue.QueueNormal+":active") != 0 {
		t.Fatal("the active list still holds a job after the completion")
	}
	if harness.crawl.crawlCalls() != 1 {
		t.Fatalf("crawl4ai /crawl calls = %d, want 1", harness.crawl.crawlCalls())
	}
}

// crawlExecutionSummaryDocument is CrawlExecutionSummary (the BullMQ
// returnvalue) as the assertions read it.
type crawlExecutionSummaryDocument struct {
	Inserted          int                           `json:"inserted"`
	Skipped           int                           `json:"skipped"`
	ReusedResultID    *string                       `json:"reusedResultId"`
	ItemsQueued       *int                          `json:"itemsQueued"`
	ItemsQueueFailed  *int                          `json:"itemsQueueFailed"`
	LastFetchedAt     *string                       `json:"lastFetchedAt"`
	RunID             *string                       `json:"runId"`
	Memory            *crawlExecutionMemoryDocument `json:"memory"`
	Failures          []json.RawMessage             `json:"failures"`
	RetryableFailures *int                          `json:"retryableFailures"`
}

// crawlExecutionMemoryDocument is the memory block of CrawlExecutionSummary.
type crawlExecutionMemoryDocument struct {
	ServerMemoryMB    *float64 `json:"serverMemoryMb"`
	PeakMemoryMB      *float64 `json:"peakMemoryMb"`
	EfficiencyPercent *float64 `json:"efficiencyPercent"`
}
