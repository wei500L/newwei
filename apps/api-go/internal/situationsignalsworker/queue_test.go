package situationsignalsworker

import (
	"context"
	"encoding/json"
	"math"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/vmihailenco/msgpack/v5"
)

// decodePackedMap decodes a MessagePack payload produced by queuePack.
func decodePackedMap(t *testing.T, raw []byte) map[string]any {
	t.Helper()
	var decoded map[string]any
	if err := msgpack.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("decode packed map: %v", err)
	}
	return decoded
}

// decodePackedArray decodes a MessagePack payload produced by queuePack.
func decodePackedArray(t *testing.T, raw []byte) []any {
	t.Helper()
	var decoded []any
	if err := msgpack.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("decode packed array: %v", err)
	}
	return decoded
}

// packedInt normalizes the concrete integer width the decoder picks.
func packedInt(t *testing.T, value any) int64 {
	t.Helper()
	switch typed := value.(type) {
	case int8:
		return int64(typed)
	case int16:
		return int64(typed)
	case int32:
		return int64(typed)
	case int64:
		return typed
	case uint8:
		return int64(typed)
	case uint16:
		return int64(typed)
	case uint32:
		return int64(typed)
	case uint64:
		return int64(typed)
	case float64:
		return int64(typed)
	default:
		t.Fatalf("value %T is not numeric", value)
		return 0
	}
}

func TestResolveSourceMatrix(t *testing.T) {
	cases := []struct {
		name       string
		dataSource string
		jobName    string
		want       PollSource
		ok         bool
	}{
		{"payload telegram", "telegram", "anything", SourceTelegram, true},
		{"payload oref", "oref", "anything", SourceOref, true},
		{"payload wins over name", "oref", "telegram-poll", SourceOref, true},
		{"payload wins over name reversed", "telegram", "oref-poll", SourceTelegram, true},
		{"telegram name prefix", "", "telegram-poll", SourceTelegram, true},
		{"telegram bootstrap name", "", "telegram-poll:bootstrap", SourceTelegram, true},
		{"oref name prefix", "", "oref-poll", SourceOref, true},
		{"oref bootstrap name", "", "oref-poll:bootstrap", SourceOref, true},
		{"unknown payload with known name", "carrier-pigeon", "oref-poll", SourceOref, true},
		{"unknown payload and name", "carrier-pigeon", "scan-active-rules", "", false},
		{"empty payload and name", "", "", "", false},
		{"case sensitive payload", "Telegram", "", "", false},
		{"no whitespace trimming", " telegram", "oref-poll", SourceOref, true},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got, ok := ResolveSource(testCase.dataSource, testCase.jobName)
			if got != testCase.want || ok != testCase.ok {
				t.Fatalf("ResolveSource(%q, %q) = (%q, %v), want (%q, %v)",
					testCase.dataSource, testCase.jobName, got, ok, testCase.want, testCase.ok)
			}
		})
	}
}

func TestQueueKeysMatchBullMQDefaults(t *testing.T) {
	keys := newQueueKeys(QueuePrefix, QueueName)
	if keys.Base != "bull:situationMonitorSignals:" {
		t.Fatalf("base = %q", keys.Base)
	}
	want := map[string]string{
		"wait":        "bull:situationMonitorSignals:wait",
		"paused":      "bull:situationMonitorSignals:paused",
		"meta":        "bull:situationMonitorSignals:meta",
		"id":          "bull:situationMonitorSignals:id",
		"completed":   "bull:situationMonitorSignals:completed",
		"failed":      "bull:situationMonitorSignals:failed",
		"delayed":     "bull:situationMonitorSignals:delayed",
		"active":      "bull:situationMonitorSignals:active",
		"events":      "bull:situationMonitorSignals:events",
		"marker":      "bull:situationMonitorSignals:marker",
		"stalled":     "bull:situationMonitorSignals:stalled",
		"limiter":     "bull:situationMonitorSignals:limiter",
		"pc":          "bull:situationMonitorSignals:pc",
		"prioritized": "bull:situationMonitorSignals:prioritized",
		"repeat":      "bull:situationMonitorSignals:repeat",
	}
	got := map[string]string{
		"wait": keys.Wait, "paused": keys.Paused, "meta": keys.Meta,
		"id": keys.ID, "completed": keys.Completed, "failed": keys.Failed,
		"delayed": keys.Delayed, "active": keys.Active, "events": keys.Events,
		"marker": keys.Marker, "stalled": keys.Stalled, "limiter": keys.Limiter,
		"pc": keys.PC, "prioritized": keys.Prioritized, "repeat": keys.Repeat,
	}
	for name, expected := range want {
		if got[name] != expected {
			t.Fatalf("%s = %q, want %q", name, got[name], expected)
		}
	}
	if keys.jobKey("42") != "bull:situationMonitorSignals:42" {
		t.Fatalf("job key = %q", keys.jobKey("42"))
	}
}

func TestScriptDigestsPinned(t *testing.T) {
	for name, want := range scriptDigests {
		content, err := scriptFiles.ReadFile("scripts/" + name)
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		if got := scriptSHA256(content); got != want {
			t.Fatalf("%s sha256 = %s, want %s", name, got, want)
		}
	}
	if len(scriptDigests) != 10 {
		t.Fatalf("vendored script count = %d, want 10", len(scriptDigests))
	}
	scripts, err := loadQueueScripts()
	if err != nil {
		t.Fatalf("load scripts: %v", err)
	}
	hashes := map[string]string{
		"addStandardJob":        scripts.addStandardJob.Hash(),
		"addDelayedJob":         scripts.addDelayedJob.Hash(),
		"addRepeatableJob":      scripts.addRepeatableJob.Hash(),
		"moveToActive":          scripts.moveToActive.Hash(),
		"moveToFinished":        scripts.moveToFinished.Hash(),
		"moveToDelayed":         scripts.moveToDelayed.Hash(),
		"extendLock":            scripts.extendLock.Hash(),
		"moveStalledJobsToWait": scripts.moveStalledJobsToWait.Hash(),
		"retryJob":              scripts.retryJob.Hash(),
		"updateJobScheduler":    scripts.updateJobScheduler.Hash(),
	}
	for name, hash := range hashes {
		if len(hash) != 40 {
			t.Fatalf("%s hash = %q, want a sha1", name, hash)
		}
	}
}

func TestQueuedJobFromFlat(t *testing.T) {
	flat := []any{
		"name", "telegram-poll:bootstrap",
		"data", `{"type":"poll","source":"telegram"}`,
		"opts", `{"attempts":3,"backoff":{"type":"exponential","delay":1000},` +
			`"removeOnComplete":true,"removeOnFail":{"age":604800,"count":10000}}`,
		"timestamp", "1700000000000",
		"delay", "0",
		"priority", "0",
		"atm", "1",
		"ats", "1",
	}
	job, err := queueQueuedJobFromFlat(flat, "token-1", "42")
	if err != nil {
		t.Fatalf("decode job: %v", err)
	}
	if job.ID != "42" || job.Name != "telegram-poll:bootstrap" || job.Token != "token-1" {
		t.Fatalf("job identity = %q/%q/%q", job.ID, job.Name, job.Token)
	}
	if job.AttemptsMade != 1 || job.AttemptsStarted != 1 {
		t.Fatalf("attempt counters = %d/%d", job.AttemptsMade, job.AttemptsStarted)
	}
	if job.Opts.Attempts == nil || *job.Opts.Attempts != 3 {
		t.Fatalf("attempts = %v", job.Opts.Attempts)
	}
	if job.Opts.Backoff == nil || job.Opts.Backoff.Type != "exponential" ||
		job.Opts.Backoff.Delay == nil || *job.Opts.Backoff.Delay != 1000 {
		t.Fatalf("backoff = %+v", job.Opts.Backoff)
	}
	source, ok := queueJobSource(job)
	if !ok || source != SourceTelegram {
		t.Fatalf("source = %q/%v", source, ok)
	}
}

func TestQueueJobSourceFallbacks(t *testing.T) {
	cases := []struct {
		name   string
		job    queuedJob
		want   PollSource
		wantOK bool
	}{
		{"data oref", queuedJob{Name: "telegram-poll", Data: json.RawMessage(`{"type":"poll","source":"oref"}`)}, SourceOref, true},
		{"data beats name", queuedJob{Name: "telegram-poll", Data: json.RawMessage(`{"type":"poll","source":"oref"}`)}, SourceOref, true},
		{"name fallback", queuedJob{Name: "oref-poll:repeat"}, SourceOref, true},
		{"invalid data keeps name fallback", queuedJob{Name: "telegram-poll", Data: json.RawMessage(`not-json`)}, SourceTelegram, true},
		{"nothing to resolve", queuedJob{Name: "scan-active-rules", Data: json.RawMessage(`{"type":"poll"}`)}, "", false},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got, ok := queueJobSource(testCase.job)
			if got != testCase.want || ok != testCase.wantOK {
				t.Fatalf("queueJobSource = (%q, %v), want (%q, %v)", got, ok, testCase.want, testCase.wantOK)
			}
		})
	}
}

// legacyOrefIteration is the job hash opts JSON BullMQ 5.63.2 writes for the
// first oref-poll repeat iteration (Queue.add merges the queue
// defaultJobOptions, Repeat.createNextJob adds the iteration fields).
const legacyOrefIteration = `{
  "attempts": 3,
  "backoff": {"type": "exponential", "delay": 1000},
  "removeOnComplete": true,
  "removeOnFail": {"age": 604800, "count": 10000},
  "jobId": "repeat:6b648cafe515bda8b978dcbd05bdb090:1700000120000",
  "delay": 120000,
  "timestamp": 1700000000000,
  "prevMillis": 1700000120000,
  "repeatJobKey": "6b648cafe515bda8b978dcbd05bdb090",
  "repeat": {"every": 300000, "jobId": "oref-poll:repeat", "count": 1}
}`

func TestQueueNextRepeatOptionsLegacyOref(t *testing.T) {
	var opts queueJobOptions
	if err := json.Unmarshal([]byte(legacyOrefIteration), &opts); err != nil {
		t.Fatalf("decode opts: %v", err)
	}
	job := queuedJob{
		ID:           "repeat:6b648cafe515bda8b978dcbd05bdb090:1700000120000",
		Name:         OrefPollJobName,
		RepeatJobKey: "6b648cafe515bda8b978dcbd05bdb090",
		Opts:         opts,
	}
	now := time.UnixMilli(1700000130000)
	packed, err := queuePack(queueNextRepeatOptions(job, now))
	if err != nil {
		t.Fatalf("pack next options: %v", err)
	}
	decoded := decodePackedMap(t, packed)

	if decoded["jobId"] != "repeat:6b648cafe515bda8b978dcbd05bdb090:undefined" {
		t.Fatalf("jobId = %v", decoded["jobId"])
	}
	if decoded["repeatJobKey"] != job.RepeatJobKey {
		t.Fatalf("repeatJobKey = %v", decoded["repeatJobKey"])
	}
	if got := packedInt(t, decoded["timestamp"]); got != now.UnixMilli() {
		t.Fatalf("timestamp = %d", got)
	}
	delay, ok := decoded["delay"].(float64)
	if !ok || !math.IsNaN(delay) {
		t.Fatalf("delay = %v, want NaN like JobScheduler.getNextJobOpts", decoded["delay"])
	}
	if _, present := decoded["prevMillis"]; present {
		t.Fatalf("prevMillis must stay undefined for an every schedule, got %v", decoded["prevMillis"])
	}
	if got := packedInt(t, decoded["attempts"]); got != defaultJobAttempts {
		t.Fatalf("attempts = %d", got)
	}
	backoff, ok := decoded["backoff"].(map[string]any)
	if !ok {
		t.Fatalf("backoff = %T", decoded["backoff"])
	}
	if backoff["type"] != "exponential" || packedInt(t, backoff["delay"]) != defaultBackoffDelayMs {
		t.Fatalf("backoff = %v", backoff)
	}
	if decoded["removeOnComplete"] != true {
		t.Fatalf("removeOnComplete = %v", decoded["removeOnComplete"])
	}
	retention, ok := decoded["removeOnFail"].(map[string]any)
	if !ok {
		t.Fatalf("removeOnFail = %T", decoded["removeOnFail"])
	}
	if packedInt(t, retention["age"]) != failedRetentionAgeSeconds ||
		packedInt(t, retention["count"]) != failedRetentionCount {
		t.Fatalf("removeOnFail = %v", retention)
	}
	repeat, ok := decoded["repeat"].(map[string]any)
	if !ok {
		t.Fatalf("repeat = %T", decoded["repeat"])
	}
	if packedInt(t, repeat["every"]) != 300_000 {
		t.Fatalf("repeat.every = %v", repeat["every"])
	}
	if repeat["jobId"] != orefRepeatJobID {
		t.Fatalf("repeat.jobId = %v", repeat["jobId"])
	}
	if got := packedInt(t, repeat["count"]); got != 2 {
		t.Fatalf("repeat.count = %d, want 2", got)
	}
	if value, present := repeat["offset"]; present && value != nil {
		t.Fatalf("repeat.offset = %v, want null", value)
	}
}

// jobSchedulerIteration is the opts JSON of a Telegram JobScheduler iteration:
// no nested repeat.jobId and no prevMillis (JobScheduler.getNextJobOpts leaves
// prevMillis undefined for an every schedule).
const jobSchedulerIteration = `{
  "attempts": 3,
  "backoff": {"type": "exponential", "delay": 1000},
  "removeOnComplete": true,
  "removeOnFail": {"age": 604800, "count": 10000},
  "jobId": "repeat:telegram-poll:scheduler:1700000060000",
  "delay": 0,
  "timestamp": 1700000000000,
  "repeatJobKey": "telegram-poll:scheduler",
  "repeat": {"every": 60000, "offset": null, "count": 3}
}`

func TestQueueNextRepeatOptionsJobScheduler(t *testing.T) {
	var opts queueJobOptions
	if err := json.Unmarshal([]byte(jobSchedulerIteration), &opts); err != nil {
		t.Fatalf("decode opts: %v", err)
	}
	job := queuedJob{
		ID:           "repeat:telegram-poll:scheduler:1700000060000",
		Name:         TelegramPollJobName,
		RepeatJobKey: "telegram-poll:scheduler",
		Opts:         opts,
	}
	now := time.UnixMilli(1700000061000)
	packed, err := queuePack(queueNextRepeatOptions(job, now))
	if err != nil {
		t.Fatalf("pack next options: %v", err)
	}
	decoded := decodePackedMap(t, packed)
	repeat, ok := decoded["repeat"].(map[string]any)
	if !ok {
		t.Fatalf("repeat = %T", decoded["repeat"])
	}
	if got := packedInt(t, repeat["count"]); got != 4 {
		t.Fatalf("repeat.count = %d, want 4", got)
	}
	if _, present := repeat["jobId"]; present {
		t.Fatalf("a JobScheduler repeat template has no nested jobId, got %v", repeat["jobId"])
	}
	if packedInt(t, repeat["every"]) != 60_000 {
		t.Fatalf("repeat.every = %v", repeat["every"])
	}
	if decoded["jobId"] != "repeat:telegram-poll:scheduler:undefined" {
		t.Fatalf("jobId = %v", decoded["jobId"])
	}
}

func TestRetryDelay(t *testing.T) {
	worker := &QueueWorker{}
	cases := []struct {
		name         string
		backoff      string
		attemptsMade int
		want         int64
		wantOK       bool
	}{
		{"no backoff retries immediately", "", 0, 0, true},
		{"fixed", `{"type":"fixed","delay":500}`, 0, 500, true},
		{"fixed second attempt", `{"type":"fixed","delay":500}`, 1, 500, true},
		{"exponential first", `{"type":"exponential","delay":1000}`, 0, 1000, true},
		{"exponential second", `{"type":"exponential","delay":1000}`, 1, 2000, true},
		{"exponential third", `{"type":"exponential","delay":1000}`, 2, 4000, true},
		{"unknown strategy", `{"type":"magic"}`, 0, 0, false},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			optsJSON := `{"attempts":3`
			if testCase.backoff != "" {
				optsJSON += `,"backoff":` + testCase.backoff
			}
			optsJSON += "}"
			var opts queueJobOptions
			if err := json.Unmarshal([]byte(optsJSON), &opts); err != nil {
				t.Fatalf("decode opts: %v", err)
			}
			got, ok := worker.retryDelay(queuedJob{Opts: opts, AttemptsMade: testCase.attemptsMade})
			if got != testCase.want || ok != testCase.wantOK {
				t.Fatalf("retryDelay = (%d, %v), want (%d, %v)", got, ok, testCase.want, testCase.wantOK)
			}
		})
	}
}

func TestFinalFailure(t *testing.T) {
	job := func(attempts *int, attemptsMade int, deferred string) queuedJob {
		return queuedJob{Opts: queueJobOptions{Attempts: attempts}, AttemptsMade: attemptsMade, DeferredFailure: deferred}
	}
	three := 3
	if job(nil, 0, "").attempts() != 1 {
		t.Fatal("a job without attempts must behave like one attempt")
	}
	if !job(nil, 0, "").finalFailure() {
		t.Fatal("a job without attempts fails on the first error")
	}
	if job(&three, 0, "").finalFailure() || job(&three, 1, "").finalFailure() {
		t.Fatal("attempts 3 must retry while atm+1 < 3")
	}
	if !job(&three, 2, "").finalFailure() {
		t.Fatal("attempts 3 must fail on the third error")
	}
	if !job(&three, 0, "job stalled more than allowable limit").finalFailure() {
		t.Fatal("a deferred failure is always final")
	}
}

func TestDecodeQueueKeepJobs(t *testing.T) {
	cases := []struct {
		raw      string
		wantOK   bool
		wantCond *int64
		wantAge  *int64
	}{
		{"", false, nil, nil},
		{"null", false, nil, nil},
		{"true", true, queueInt64(0), nil},
		{"false", true, queueInt64(-1), nil},
		{"50", true, queueInt64(50), nil},
		{`{"age":604800,"count":10000}`, true, queueInt64(10000), queueInt64(604800)},
	}
	for _, testCase := range cases {
		keep, ok := decodeQueueKeepJobs(json.RawMessage(testCase.raw))
		if ok != testCase.wantOK {
			t.Fatalf("decodeQueueKeepJobs(%q) ok = %v", testCase.raw, ok)
		}
		if !ok {
			continue
		}
		if !equalInt64Ptr(keep.Count, testCase.wantCond) || !equalInt64Ptr(keep.Age, testCase.wantAge) {
			t.Fatalf("decodeQueueKeepJobs(%q) = count %v age %v", testCase.raw, keep.Count, keep.Age)
		}
	}
}

func equalInt64Ptr(left, right *int64) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

func TestQueueWorkerLifecycleWithoutRedis(t *testing.T) {
	if _, err := NewQueueWorker(nil); err == nil {
		t.Fatal("NewQueueWorker(nil) must fail")
	}
	client := redis.NewClient(&redis.Options{
		Addr:        "127.0.0.1:1",
		DialTimeout: 50 * time.Millisecond,
		MaxRetries:  -1,
	})
	t.Cleanup(func() { _ = client.Close() })
	worker, err := NewQueueWorker(client)
	if err != nil {
		t.Fatalf("NewQueueWorker: %v", err)
	}
	worker.Close()
	worker.Close() // idempotent

	runClient := redis.NewClient(&redis.Options{
		Addr:        "127.0.0.1:1",
		DialTimeout: 50 * time.Millisecond,
		MaxRetries:  -1,
	})
	t.Cleanup(func() { _ = runClient.Close() })
	runWorker, err := NewQueueWorker(runClient)
	if err != nil {
		t.Fatalf("NewQueueWorker: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		runWorker.Run(ctx, func(context.Context, PollSource) error { return nil })
	}()
	cancel()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("Run did not return after its context was canceled")
	}
	runWorker.Close()
}
