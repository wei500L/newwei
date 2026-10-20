package qualityqueue

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/vmihailenco/msgpack/v5"
)

// TestEmbeddedScripts ensures the go:embed glob still matches every script the
// worker needs; a renamed file must not surface as a runtime panic in production.
func TestEmbeddedScripts(t *testing.T) {
	for name, script := range map[string]string{
		"addStandardJob":        scriptAddStandardJob.Hash(),
		"moveToActive":          scriptMoveToActive.Hash(),
		"moveToFinished":        scriptMoveToFinished.Hash(),
		"moveToDelayed":         scriptMoveToDelayed.Hash(),
		"extendLock":            scriptExtendLock.Hash(),
		"moveStalledJobsToWait": scriptMoveStalledJobsToWait.Hash(),
	} {
		if script == "" {
			t.Fatalf("script %s has no content", name)
		}
	}
	raw, err := scriptFiles.ReadFile("scripts/moveToFinished.lua")
	if err != nil {
		t.Fatal(err)
	}
	// Guard against copying the unexpanded command file: the include directives
	// would make Redis fail at runtime with "attempt to call a nil value".
	if strings.Contains(string(raw), "@include") {
		t.Fatal("moveToFinished.lua still contains --- @include directives")
	}
	if !strings.Contains(string(raw), "local function removeLock") {
		t.Fatal("moveToFinished.lua is missing the expanded removeLock helper")
	}
}

// TestParseKeepJobsShapes covers the three shapes BullMQ stores and the default.
func TestParseKeepJobsShapes(t *testing.T) {
	cases := []struct {
		name      string
		raw       string
		wantCount int64
	}{
		{name: "true removes immediately", raw: "true", wantCount: 0},
		{name: "false keeps forever", raw: "false", wantCount: -1},
		{name: "number is a count", raw: "250", wantCount: 250},
		{name: "object carries age and count", raw: `{"age":604800,"count":10000}`},
		{name: "unset keeps forever", raw: "", wantCount: -1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			keep := parseKeepJobs(json.RawMessage(tc.raw))
			if tc.name == "object carries age and count" {
				if keep.Age == nil || *keep.Age != 604800 || keep.Count == nil || *keep.Count != 10000 {
					t.Fatalf("keep = %+v", keep)
				}
				return
			}
			if keep.Count == nil || *keep.Count != tc.wantCount {
				t.Fatalf("count = %v, want %d", keep.Count, tc.wantCount)
			}
			if keep.Age != nil {
				t.Fatalf("age = %v, want nil", *keep.Age)
			}
		})
	}
}

// TestKeepJobsPerTarget verifies the completed/failed selection.
func TestKeepJobsPerTarget(t *testing.T) {
	options := JobOptions{
		RemoveOnComplete: json.RawMessage("true"),
		RemoveOnFail:     json.RawMessage(`{"age":604800,"count":10000}`),
	}
	completed := options.keepJobs("completed")
	if completed.Count == nil || *completed.Count != 0 || completed.Age != nil {
		t.Fatalf("completed keepJobs = %+v", completed)
	}
	failed := options.keepJobs("failed")
	if failed.Age == nil || *failed.Age != 604800 || failed.Count == nil || *failed.Count != 10000 {
		t.Fatalf("failed keepJobs = %+v", failed)
	}
}

// TestBackoffDelayExponential mirrors BullMQ's
// round(2^(attemptsMade-1) * delay) for the 2000 ms exponential backoff.
func TestBackoffDelayExponential(t *testing.T) {
	backoff := &Backoff{Type: "exponential", Delay: 2000}
	cases := map[int64]int64{1: 2000, 2: 4000, 3: 8000}
	for attemptsMade, want := range cases {
		if got := backoffDelay(backoff, attemptsMade); got != want {
			t.Fatalf("attemptsMade=%d delay=%d, want %d", attemptsMade, got, want)
		}
	}
	if got := backoffDelay(nil, 1); got != 0 {
		t.Fatalf("nil backoff = %d, want 0", got)
	}
	if got := backoffDelay(&Backoff{Type: "fixed", Delay: 500}, 3); got != 500 {
		t.Fatalf("fixed backoff = %d, want 500", got)
	}
}

// TestJobFromFields mirrors how the hash fields are read after moveToActive.
func TestJobFromFields(t *testing.T) {
	fields := map[string]string{
		"name": "classification-quality-report:abc",
		"data": `{"jobType":"report","orgId":"org-1","reportJobId":"abc"}`,
		"opts": `{"attempts":3,"backoff":{"type":"exponential","delay":2000},"removeOnComplete":true,"removeOnFail":{"age":604800,"count":10000}}`,
		"atm":  "1",
		"ats":  "2",
		"stc":  "1",
	}
	job := jobFromFields("classification-quality-report:abc", fields, "token-1")
	if job.ID != "classification-quality-report:abc" || job.Token != "token-1" {
		t.Fatalf("job = %+v", job)
	}
	if job.Options.Attempts != 3 {
		t.Fatalf("attempts = %d, want 3", job.Options.Attempts)
	}
	if job.Options.Backoff == nil || job.Options.Backoff.Delay != 2000 {
		t.Fatalf("backoff = %+v", job.Options.Backoff)
	}
	if job.AttemptsMade != 1 || job.AttemptsStarted != 2 || job.StalledCount != 1 {
		t.Fatalf("counters = %+v", job)
	}
	if string(job.Data) != fields["data"] {
		t.Fatalf("data = %s", job.Data)
	}

	// A missing data field and malformed counters keep BullMQ's defaults.
	sparse := jobFromFields("job-2", map[string]string{"defa": "job stalled more than allowable limit"}, "token-2")
	if string(sparse.Data) != "{}" {
		t.Fatalf("default data = %s, want {}", sparse.Data)
	}
	if sparse.AttemptsMade != 0 || sparse.Options.Attempts != 0 {
		t.Fatalf("defaults = %+v", sparse)
	}
	if sparse.DeferredFailure == "" {
		t.Fatal("defa must be surfaced as DeferredFailure")
	}
}

// TestAddJobOptionsFieldNames guards the Redis hash contract: NestJS reads these
// keys with Job.optsFromJSON, so a rename would silently disable retries or
// retention on jobs produced by Go.
func TestAddJobOptionsFieldNames(t *testing.T) {
	zero := int64(0)
	packed, err := pack(addJobOptions{
		JobID:            "classification-quality-report:abc",
		Attempts:         3,
		Backoff:          Backoff{Type: "exponential", Delay: 2000},
		RemoveOnComplete: KeepJobs{Count: &zero},
		RemoveOnFail:     Retention(604800, 10000),
	})
	if err != nil {
		t.Fatal(err)
	}
	var decoded struct {
		JobID            string   `msgpack:"jobId"`
		Attempts         int64    `msgpack:"attempts"`
		Backoff          Backoff  `msgpack:"backoff"`
		RemoveOnComplete KeepJobs `msgpack:"removeOnComplete"`
		RemoveOnFail     KeepJobs `msgpack:"removeOnFail"`
	}
	if err := msgpack.Unmarshal(packed, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.JobID != "classification-quality-report:abc" || decoded.Attempts != 3 {
		t.Fatalf("decoded = %+v", decoded)
	}
	if decoded.Backoff.Type != "exponential" || decoded.Backoff.Delay != 2000 {
		t.Fatalf("backoff = %+v", decoded.Backoff)
	}
	if decoded.RemoveOnComplete.Count == nil || *decoded.RemoveOnComplete.Count != 0 {
		t.Fatalf("removeOnComplete = %+v", decoded.RemoveOnComplete)
	}
	if decoded.RemoveOnFail.Age == nil || *decoded.RemoveOnFail.Age != 604800 {
		t.Fatalf("removeOnFail = %+v", decoded.RemoveOnFail)
	}
}

// TestQueueNameMatchesNestJS locks the shared queue name. NestJS spells it with
// an underscore; a hyphen here would silently split the queue in two.
func TestQueueNameMatchesNestJS(t *testing.T) {
	if QueueName != "classification_quality" {
		t.Fatalf("QueueName = %q", QueueName)
	}
	keys := newKeySpace("", QueueName)
	if keys.wait() != "bull:classification_quality:wait" {
		t.Fatalf("wait key = %q", keys.wait())
	}
	if keys.job("abc") != "bull:classification_quality:abc" {
		t.Fatalf("job key = %q", keys.job("abc"))
	}
	if keys.metrics("failed") != "bull:classification_quality:metrics:failed" {
		t.Fatalf("metrics key = %q", keys.metrics("failed"))
	}
	if keys.lock("abc") != "bull:classification_quality:abc:lock" {
		t.Fatalf("lock key = %q", keys.lock("abc"))
	}
}
