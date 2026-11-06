package crawlworker

import (
	"encoding/json"
	"errors"
	"testing"

	"github.com/wei500L/newwei/apps/api-go/internal/bullmq"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlqueue"
)

func TestScriptsLoad(t *testing.T) {
	scripts, err := loadQueueScripts()
	if err != nil {
		t.Fatalf("load scripts: %v", err)
	}
	for name, hash := range map[string]string{
		"moveToFinished":          scripts.moveToFinished.Hash(),
		"moveJobFromActiveToWait": scripts.moveJobFromActiveToWait.Hash(),
		"retryJob":                scripts.retryJob.Hash(),
		"moveToDelayed":           scripts.moveToDelayed.Hash(),
		"updateData":              scripts.updateData.Hash(),
	} {
		if len(hash) != 40 {
			t.Errorf("%s hash = %q, want a sha1", name, hash)
		}
	}
}

func TestQueueSpecsCoverTheThreeCrawlQueues(t *testing.T) {
	specs := queueSpecs()
	if len(specs) != 3 {
		t.Fatalf("queue specs = %d, want 3", len(specs))
	}
	if specs[0].Name != crawlqueue.QueueHot || specs[0].Class != crawlqueue.PriorityClassHot {
		t.Errorf("first queue = %+v, want the hot queue", specs[0])
	}
	if specs[2].Name != crawlqueue.QueueLegacy || specs[2].Class != crawlqueue.PriorityClassNormal || !specs[2].Legacy {
		t.Errorf("last queue = %+v, want the legacy queue as normal/legacy", specs[2])
	}
}

func TestKeysFollowTheBullMQLayout(t *testing.T) {
	queueKeys := newKeys("crawl4ai-hot")
	if queueKeys.Base != "bull:crawl4ai-hot:" {
		t.Fatalf("base = %q", queueKeys.Base)
	}
	if queueKeys.Wait != "bull:crawl4ai-hot:wait" || queueKeys.Marker != "bull:crawl4ai-hot:marker" {
		t.Errorf("wait/marker = %q/%q", queueKeys.Wait, queueKeys.Marker)
	}
	if got := queueKeys.Job("42"); got != "bull:crawl4ai-hot:42" {
		t.Errorf("job key = %q", got)
	}
}

func TestClaimedJobFromBullmqDecodesTheHashes(t *testing.T) {
	job, err := claimedJobFromBullmq(&bullmq.Job{
		ID:              "task-1",
		Token:           "token-1",
		Data:            json.RawMessage(`{"taskId":"task-1","orgId":"org-1","sourceId":"source-9","traceId":"trace-1","memoryPressureRequeues":2,"priorityClass":"hot","jobKind":"frontier_node","frontierNodeId":"node-7"}`),
		Opts:            json.RawMessage(`{"attempts":5,"backoff":{"type":"exponential","delay":1000}}`),
		AttemptsMade:    1,
		AttemptsStarted: 2,
		StalledCount:    0,
	})
	if err != nil {
		t.Fatalf("decode job: %v", err)
	}
	if job.ID != "task-1" || job.Token != "token-1" {
		t.Fatalf("job identity = %+v", job)
	}
	if job.Data.TaskID != "task-1" || job.Data.OrgID != "org-1" || job.Data.TraceID != "trace-1" {
		t.Errorf("job data = %+v", job.Data)
	}
	if job.Data.SourceID == nil || *job.Data.SourceID != "source-9" {
		t.Errorf("sourceId = %v", job.Data.SourceID)
	}
	if job.Data.MemoryPressureRequeues != 2 {
		t.Errorf("memoryPressureRequeues = %d", job.Data.MemoryPressureRequeues)
	}
	if !job.Data.IsFrontierNode() || job.Data.FrontierNodeID != "node-7" {
		t.Errorf("frontier payload = %+v", job.Data)
	}
	if job.Attempts() != 5 || job.AttemptsMade != 1 || job.AttemptsStarted != 2 {
		t.Errorf("attempts = %d/%d/%d", job.Attempts(), job.AttemptsMade, job.AttemptsStarted)
	}
	if job.Opts.LIFO || len(job.Opts.Backoff) == 0 {
		t.Errorf("options = %+v", job.Opts)
	}
}

func TestClaimedJobFromBullmqRejectsABrokenDataDocument(t *testing.T) {
	_, err := claimedJobFromBullmq(&bullmq.Job{
		ID:   "task-1",
		Data: json.RawMessage("{"),
		Opts: json.RawMessage("{}"),
	})
	if err == nil {
		t.Fatal("expected a decode error")
	}
}

func TestJobDataReadsThroughTheNestTypeofGuards(t *testing.T) {
	var data JobData
	if err := data.UnmarshalJSON([]byte(`{"taskId":42,"orgId":"org-1","sourceId":null,"memoryPressureRequeues":"3","frontierNodeId":7}`)); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if data.TaskID != "" {
		t.Errorf("taskId = %q, want empty for a number", data.TaskID)
	}
	if data.OrgID != "org-1" {
		t.Errorf("orgId = %q", data.OrgID)
	}
	if data.SourceID != nil {
		t.Errorf("sourceId = %v, want nil", data.SourceID)
	}
	if data.MemoryPressureRequeues != 0 {
		t.Errorf("memoryPressureRequeues = %d, want 0 for a string", data.MemoryPressureRequeues)
	}
	if data.IsFrontierNode() {
		t.Error("a numeric frontierNodeId must not read as a frontier job")
	}
}

func TestDecodeJobOptionsDefaultsToOneAttempt(t *testing.T) {
	options, err := decodeJobOptions(nil)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if options.Attempts != 1 {
		t.Fatalf("attempts = %d, want 1", options.Attempts)
	}
	options, err = decodeJobOptions([]byte(`{"attempts":4.6,"lifo":true}`))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if options.Attempts != 5 || !options.LIFO {
		t.Fatalf("options = %+v", options)
	}
}

func TestKeepJobsFollowsGetKeepJobs(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want keepJobs
	}{
		{"absent", "", keepJobs{Count: intPointer(-1)}},
		{"true", "true", keepJobs{Count: intPointer(0)}},
		{"false", "false", keepJobs{Count: intPointer(-1)}},
		{"number", "25", keepJobs{Count: intPointer(25)}},
		{"object", `{"age":604800,"count":10000}`, keepJobs{Age: intPointer(604800), Count: intPointer(10000)}},
	}
	for _, testCase := range cases {
		options := jobOptions{RemoveOnFail: []byte(testCase.raw)}
		got := KeepOnFail(options)
		if got.Count == nil || *got.Count != *testCase.want.Count {
			t.Errorf("%s: count = %v, want %v", testCase.name, got.Count, *testCase.want.Count)
			continue
		}
		if (got.Age == nil) != (testCase.want.Age == nil) {
			t.Errorf("%s: age = %v, want %v", testCase.name, got.Age, testCase.want.Age)
			continue
		}
		if got.Age != nil && *got.Age != *testCase.want.Age {
			t.Errorf("%s: age = %d, want %d", testCase.name, *got.Age, *testCase.want.Age)
		}
	}
}

func TestPackFinishOptionsCarriesTheLimiter(t *testing.T) {
	packed, err := pack(finishOptions{
		Token:          "token-1",
		KeepJobs:       keepJobs{Count: intPointer(-1)},
		Limiter:        limiterOptions{Max: 500, Duration: 1_000},
		LockDuration:   30_000,
		Attempts:       3,
		MaxMetricsSize: "",
	})
	if err != nil {
		t.Fatalf("pack: %v", err)
	}
	if len(packed) == 0 {
		t.Fatal("empty msgpack payload")
	}
}

func TestParseWorkerConcurrencyMessage(t *testing.T) {
	cases := []struct {
		name    string
		message string
		want    int
		wantErr error
	}{
		{"valid", `{"version":1,"maxConcurrency":5}`, 5, nil},
		{"valid one", `{"version":1,"maxConcurrency":1}`, 1, nil},
		{"valid twenty", `{"version":1,"maxConcurrency":20}`, 20, nil},
		{"valid integral float", `{"version":1,"maxConcurrency":5.0}`, 5, nil},
		{"extra keys", `{"version":1,"maxConcurrency":3,"ignored":true}`, 3, nil},
		{"zero", `{"version":1,"maxConcurrency":0}`, 0, errUnsupportedPayloadMessage},
		{"twenty one", `{"version":1,"maxConcurrency":21}`, 0, errUnsupportedPayloadMessage},
		{"fraction", `{"version":1,"maxConcurrency":2.5}`, 0, errUnsupportedPayloadMessage},
		{"string concurrency", `{"version":1,"maxConcurrency":"5"}`, 0, errUnsupportedPayloadMessage},
		{"boolean concurrency", `{"version":1,"maxConcurrency":true}`, 0, errUnsupportedPayloadMessage},
		{"null concurrency", `{"version":1,"maxConcurrency":null}`, 0, errUnsupportedPayloadMessage},
		{"missing concurrency", `{"version":1}`, 0, errUnsupportedPayloadMessage},
		{"wrong version", `{"version":2,"maxConcurrency":5}`, 0, errUnsupportedPayloadMessage},
		{"string version", `{"version":"1","maxConcurrency":5}`, 0, errUnsupportedPayloadMessage},
		{"missing version", `{"maxConcurrency":5}`, 0, errUnsupportedPayloadMessage},
		{"invalid json", `{"version":1,`, 0, errInvalidJSONMessage},
		{"empty", ``, 0, errInvalidJSONMessage},
		{"array", `[1,2]`, 0, errNotObjectMessage},
		{"string", `"hello"`, 0, errNotObjectMessage},
		{"null", `null`, 0, errNotObjectMessage},
	}
	for _, testCase := range cases {
		got, err := parseWorkerConcurrencyMessage(testCase.message)
		if !errors.Is(err, testCase.wantErr) {
			t.Errorf("%s: err = %v, want %v", testCase.name, err, testCase.wantErr)
			continue
		}
		if got != testCase.want {
			t.Errorf("%s: concurrency = %d, want %d", testCase.name, got, testCase.want)
		}
	}
}

func TestStacktraceIsAJSONArray(t *testing.T) {
	if got := stacktraceJSON("boom"); got != `["boom"]` {
		t.Fatalf("stacktrace = %q", got)
	}
}

func TestRateLimitAllQueuesSetsEveryCrawlerLimiter(t *testing.T) {
	// The pipeline writes Number.MAX_SAFE_INTEGER with the PX cooldown on the
	// limiter key of all three crawl queues. Without Redis only the key layout can
	// be asserted here; the integration test covers the Redis effect.
	for _, spec := range queueSpecs() {
		if got := newKeys(spec.Name).Limiter; got != "bull:"+spec.Name+":limiter" {
			t.Errorf("limiter key = %q", got)
		}
	}
	if bullmq.ScriptMoveJobFromActiveToWait.Hash() == "" {
		t.Fatal("the shared moveJobFromActiveToWait script must be loaded")
	}
}
