package queue

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestMarshalJobDataMatchesJSONStringify(t *testing.T) {
	encoded, err := MarshalJobData(DeliverJobData{
		Type:       JobTypeDeliver,
		DeliveryID: "d1",
		OrgID:      "o1",
		TraceID:    "abc",
	})
	if err != nil {
		t.Fatalf("encode deliver data: %v", err)
	}
	if got, want := string(encoded), `{"type":"deliver","deliveryId":"d1","orgId":"o1","traceId":"abc"}`; got != want {
		t.Fatalf("deliver data = %s, want %s", got, want)
	}

	scheduledAt := int64(1_700_000_000_000)
	encoded, err = MarshalJobData(DeliverJobData{
		Type:          JobTypeDeliver,
		DeliveryID:    "d1",
		OrgID:         "o1",
		TraceID:       "abc",
		ScheduledAtMs: &scheduledAt,
	})
	if err != nil {
		t.Fatalf("encode delayed data: %v", err)
	}
	if got, want := string(encoded), `{"type":"deliver","deliveryId":"d1","orgId":"o1","traceId":"abc","scheduledAtMs":1700000000000}`; got != want {
		t.Fatalf("delayed deliver data = %s, want %s", got, want)
	}

	encoded, err = MarshalJobData(ScheduleJobData{Type: JobTypeEvaluate, RuleID: "r1", OrgID: "o1"})
	if err != nil {
		t.Fatalf("encode schedule data: %v", err)
	}
	if got, want := string(encoded), `{"type":"evaluate","ruleId":"r1","orgId":"o1"}`; got != want {
		t.Fatalf("schedule data = %s, want %s", got, want)
	}
}

func TestMarshalJobDataDoesNotEscapeHTML(t *testing.T) {
	encoded, err := MarshalJobData(ScanJobData{Type: "scan<&>"})
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	if strings.Contains(string(encoded), `\u003c`) {
		t.Fatalf("data was HTML escaped: %s", encoded)
	}
}

func TestRepeatKeysMatchBullMQ(t *testing.T) {
	concat := repeatConcatOptions(JobNameScan, JobNameScan, 300_000)
	if want := "scan-active-rules:scan-active-rules:::300000"; concat != want {
		t.Fatalf("concat options = %q, want %q", concat, want)
	}
	if got, want := hashRepeatKey(concat), "ce9ce89ea085b8356ae8dbddf1cee058"; got != want {
		t.Fatalf("repeat hash = %s, want %s", got, want)
	}
	if got, want := repeatDelayedJobID(hashRepeatKey(concat), 1_700_000_000_000),
		"repeat:ce9ce89ea085b8356ae8dbddf1cee058:1700000000000"; got != want {
		t.Fatalf("delayed job id = %s, want %s", got, want)
	}
	if got, want := legacyRepeatJobID(hashRepeatKey(concat)), "repeat:f01d9aabf7d57cee67d0a7ee05baa572:"; got != want {
		t.Fatalf("legacy repeat job id = %s, want %s", got, want)
	}
	if got := removalConcatOptions(hashRepeatKey(concat)); got != "" {
		t.Fatalf("removal concat options for a hashed key = %q, want empty", got)
	}
	if got := removalConcatOptions(concat); got != concat {
		t.Fatalf("removal concat options for a legacy key = %q, want %q", got, concat)
	}
}

func TestNextRepeatMillisIsTheNextIntervalBoundary(t *testing.T) {
	cases := []struct {
		millis int64
		every  int64
		want   int64
	}{
		{0, 300_000, 300_000},
		{1, 300_000, 300_000},
		{299_999, 300_000, 300_000},
		{300_000, 300_000, 600_000},
		{300_001, 300_000, 600_000},
		{1_700_000_123_456, 60_000, 1_700_000_160_000},
	}
	for _, tc := range cases {
		if got := nextRepeatMillis(tc.millis, tc.every); got != tc.want {
			t.Errorf("nextRepeatMillis(%d, %d) = %d, want %d", tc.millis, tc.every, got, tc.want)
		}
	}
}

func TestBuildJobArguments(t *testing.T) {
	args := buildJobArguments("bull:alerts:", "job-1", "scan-active-rules", 1234, "")
	if len(args) != 9 {
		t.Fatalf("arguments length = %d, want 9", len(args))
	}
	if args[0] != "bull:alerts:" || args[1] != "job-1" || args[2] != "scan-active-rules" || args[3] != int64(1234) {
		t.Fatalf("arguments = %#v", args)
	}
	for index := 4; index < 9; index++ {
		if args[index] != nil {
			t.Fatalf("slot %d = %#v, want nil", index, args[index])
		}
	}
	withRepeat := buildJobArguments("bull:alerts:", "job-1", "scan-active-rules", 1234, "repeat-key")
	if withRepeat[7] != "repeat-key" {
		t.Fatalf("repeat job key slot = %#v", withRepeat[7])
	}
}

func TestJobAttemptsAndFinalFailure(t *testing.T) {
	attempts := 4
	job := Job{Opts: JobOptions{Attempts: &attempts}, AttemptsMade: 0}
	if job.Attempts() != 4 {
		t.Fatalf("attempts = %d", job.Attempts())
	}
	for attemptsMade := 0; attemptsMade < 4; attemptsMade++ {
		job.AttemptsMade = attemptsMade
		want := attemptsMade+1 >= 4
		if job.FinalFailure() != want {
			t.Fatalf("attemptsMade=%d final=%t, want %t", attemptsMade, job.FinalFailure(), want)
		}
	}

	zero := 0
	job = Job{Opts: JobOptions{Attempts: &zero}}
	if job.Attempts() != 1 {
		t.Fatalf("attempts for the BullMQ default = %d, want 1", job.Attempts())
	}
	if !job.FinalFailure() {
		t.Fatal("a job without attempts must fail on the first attempt")
	}
}

func TestKeepJobsDecoding(t *testing.T) {
	job := Job{Opts: JobOptions{RemoveOnComplete: json.RawMessage("true")}}
	keep := KeepOnComplete(job.Opts)
	if keep.Count == nil || *keep.Count != 0 {
		t.Fatalf("removeOnComplete=true keepJobs = %+v", keep)
	}
	job = Job{Opts: JobOptions{RemoveOnFail: json.RawMessage(`{"age":604800,"count":10000}`)}}
	keep = KeepOnFail(job.Opts)
	if keep.Age == nil || *keep.Age != 604800 || keep.Count == nil || *keep.Count != 10000 {
		t.Fatalf("removeOnFail keepJobs = %+v", keep)
	}
	job = Job{}
	keep = KeepOnFail(job.Opts)
	if keep.Count == nil || *keep.Count != -1 {
		t.Fatalf("default keepJobs = %+v, want count -1", keep)
	}
}

func TestJobFromFlat(t *testing.T) {
	flat := []any{
		[]byte("id"), []byte("job-1"),
		[]byte("name"), []byte("evaluate-rule:r1"),
		[]byte("data"), []byte(`{"type":"evaluate","ruleId":"r1","orgId":"o1"}`),
		[]byte("opts"), []byte(`{"attempts":0,"removeOnComplete":true}`),
		[]byte("atm"), []byte("2"),
		[]byte("rjk"), []byte("ce9ce89ea085b8356ae8dbddf1cee058"),
		[]byte("timestamp"), []byte("1234"),
	}
	job, err := jobFromFlat(flat, "token-1", "")
	if err != nil {
		t.Fatalf("jobFromFlat: %v", err)
	}
	if job.ID != "job-1" || job.Name != "evaluate-rule:r1" || job.Token != "token-1" {
		t.Fatalf("job = %+v", job)
	}
	if job.AttemptsMade != 2 || job.Timestamp != 1234 {
		t.Fatalf("attemptsMade/timestamp = %d/%d", job.AttemptsMade, job.Timestamp)
	}
	if job.RepeatJobKey != "ce9ce89ea085b8356ae8dbddf1cee058" {
		t.Fatalf("repeat job key = %q", job.RepeatJobKey)
	}
	var payload EvaluateJobData
	if err := json.Unmarshal(job.Data, &payload); err != nil {
		t.Fatalf("decode data: %v", err)
	}
	if payload.RuleID != "r1" || payload.OrgID != "o1" {
		t.Fatalf("payload = %+v", payload)
	}
	if job.Opts.Attempts == nil || *job.Opts.Attempts != 0 {
		t.Fatalf("opts = %+v", job.Opts)
	}
}

func TestNextJobDataFromResult(t *testing.T) {
	flat := []any{[]byte("id"), []byte("job-1"), []byte("data"), []byte(`{"type":"scan"}`)}
	result := []any{flat, "job-1", int64(0), int64(1_700_000_000_000)}
	next, err := nextJobDataFromResult(result, "token")
	if err != nil {
		t.Fatalf("nextJobDataFromResult: %v", err)
	}
	if next.Job == nil || next.Job.ID != "job-1" {
		t.Fatalf("job = %+v", next.Job)
	}
	if next.DelayUntil != 1_700_000_000_000 {
		t.Fatalf("delay until = %d", next.DelayUntil)
	}

	next, err = nextJobDataFromResult([]any{[]any{}, "", int64(0), int64(0)}, "token")
	if err != nil || next.Job != nil {
		t.Fatalf("empty result = %+v, %v", next.Job, err)
	}
}

func TestBackoffDelay(t *testing.T) {
	worker := &Worker{opts: WorkerOptions{
		BackoffDelay: func(attempt int, backoffType string) (int64, bool) {
			if backoffType != "alertNotifications" {
				return 0, false
			}
			delays := []int64{60_000, 5 * 60_000, 15 * 60_000}
			index := attempt - 1
			if index < 0 {
				index = 0
			}
			if index >= len(delays) {
				index = len(delays) - 1
			}
			return delays[index], true
		},
	}}
	attempts := 4
	job := Job{Opts: JobOptions{Attempts: &attempts, Backoff: &BackoffOptions{Type: "alertNotifications"}}}
	for attemptsMade, want := range map[int]int64{0: 60_000, 1: 5 * 60_000, 2: 15 * 60_000, 3: 15 * 60_000} {
		job.AttemptsMade = attemptsMade
		got, ok := worker.backoffDelay(job, errors.New("boom"))
		if !ok || got != want {
			t.Errorf("attemptsMade=%d delay = %d/%t, want %d", attemptsMade, got, ok, want)
		}
	}

	fixed := 250.0
	job = Job{Opts: JobOptions{Backoff: &BackoffOptions{Type: "fixed", Delay: &fixed}}}
	if got, ok := worker.backoffDelay(job, nil); !ok || got != 250 {
		t.Fatalf("fixed backoff = %d/%t", got, ok)
	}
	exponential := 100.0
	job = Job{Opts: JobOptions{Backoff: &BackoffOptions{Type: "exponential", Delay: &exponential}}, AttemptsMade: 2}
	if got, ok := worker.backoffDelay(job, nil); !ok || got != 400 {
		t.Fatalf("exponential backoff = %d/%t, want 400", got, ok)
	}
	job = Job{Opts: JobOptions{Backoff: &BackoffOptions{Type: "unknown"}}}
	if _, ok := worker.backoffDelay(job, nil); ok {
		t.Fatal("an unknown backoff type without a strategy must not produce a delay")
	}
}

func TestDelayedErrorMessage(t *testing.T) {
	err := &DelayedError{UntilMs: 1_700_000_000_000}
	if !strings.Contains(err.Error(), "1700000000000") {
		t.Fatalf("message = %q", err.Error())
	}
}

func TestMergeRepeatOptions(t *testing.T) {
	every := int64(300_000)
	count := int64(3)
	attempts := 0
	job := Job{
		ID:           "repeat:key:1000",
		RepeatJobKey: "key",
		Opts: JobOptions{
			Attempts:         &attempts,
			RemoveOnFail:     json.RawMessage(`{"age":604800,"count":10000}`),
			RemoveOnComplete: json.RawMessage("true"),
			Repeat:           &RepeatOptions{Every: &every, JobID: "evaluate-rule:r1", Count: &count},
		},
	}
	merged, err := mergeRepeatOptions(job)
	if err != nil {
		t.Fatalf("mergeRepeatOptions: %v", err)
	}
	repeat, ok := merged["repeat"].(map[string]any)
	if !ok {
		t.Fatalf("repeat = %#v", merged["repeat"])
	}
	if repeat["every"] != int64(300_000) || repeat["count"] != int64(4) || repeat["jobId"] != "evaluate-rule:r1" {
		t.Fatalf("repeat = %#v", repeat)
	}
	if _, hasPrev := merged["prevMillis"]; hasPrev {
		t.Fatal("prevMillis must be absent like an undefined option")
	}
	if merged["attempts"] != int64(0) {
		t.Fatalf("attempts = %#v", merged["attempts"])
	}
	if keep, ok := merged["removeOnComplete"].(bool); !ok || !keep {
		t.Fatalf("removeOnComplete = %#v", merged["removeOnComplete"])
	}
	if keep, ok := merged["removeOnFail"].(map[string]any); !ok || keep["count"] != int64(10000) {
		t.Fatalf("removeOnFail = %#v", merged["removeOnFail"])
	}
}

func TestFinalAttemptHelperMirrorsB1(t *testing.T) {
	attempts := 4
	job := Job{Opts: JobOptions{Attempts: &attempts}}
	job.AttemptsMade = 0
	if job.FinalFailure() {
		t.Fatal("first attempt must not be final")
	}
	job.AttemptsMade = 3
	if !job.FinalFailure() {
		t.Fatal("fourth attempt must be final")
	}
	zero := 0
	job = Job{Opts: JobOptions{Attempts: &zero}}
	if !job.FinalFailure() {
		t.Fatal("a job without an attempt budget is final on the first attempt")
	}
}

func TestJobHandleRequiresWorker(t *testing.T) {
	handle := JobHandle{}
	if err := handle.UpdateData(nil, []byte(`{}`)); err == nil {
		t.Fatal("expected an error for a handle without a worker")
	}
}

func TestNewWorkerRequiresClients(t *testing.T) {
	if _, err := NewWorker(nil, nil, WorkerOptions{}); err == nil {
		t.Fatal("expected an error")
	}
}

func TestWorkerOptionsNormalized(t *testing.T) {
	opts := WorkerOptions{Logger: nil}.normalized()
	if opts.Concurrency != 1 || opts.Prefix != Prefix || opts.LockDuration != LockDuration {
		t.Fatalf("normalized = %+v", opts)
	}
	if opts.LockRenewTime != LockDuration/2 || opts.StalledInterval != StalledInterval || opts.DrainDelay != DrainDelay {
		t.Fatalf("normalized = %+v", opts)
	}
	if !sleepContext(context.Background(), time.Millisecond) {
		t.Fatal("sleepContext must report success for a live context")
	}
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if sleepContext(cancelled, time.Second) {
		t.Fatal("sleepContext must report cancellation")
	}
}
