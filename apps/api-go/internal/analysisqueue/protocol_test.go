package analysisqueue

import (
	"encoding/json"
	"testing"

	"github.com/vmihailenco/msgpack/v5"
)

func TestJobFromFlatDecodesPayloadAndOptions(t *testing.T) {
	data, _ := json.Marshal(Payload{
		Type:       TypeCorrelation,
		AnalysisID: "64b7f0c2f1a2b3c4d5e6f701",
		OrgID:      "org-1",
		TraceID:    "trace-1",
	})
	flat := []any{
		"id", "corr-64b7f0c2f1a2b3c4d5e6f701",
		"name", TypeCorrelation,
		"data", string(data),
		"opts", `{"attempts":3,"removeOnComplete":true,"removeOnFail":{"age":604800,"count":10000}}`,
		"atm", int64(1),
		"ats", int64(2),
		"stc", int64(0),
		"timestamp", int64(1700000000000),
	}
	job, err := jobFromFlat(flat, "token-1", "corr-64b7f0c2f1a2b3c4d5e6f701")
	if err != nil {
		t.Fatalf("jobFromFlat: %v", err)
	}
	if job.ID != "corr-64b7f0c2f1a2b3c4d5e6f701" || job.Name != TypeCorrelation {
		t.Fatalf("job identity = %+v", job)
	}
	if job.Payload.AnalysisID != "64b7f0c2f1a2b3c4d5e6f701" || job.Payload.OrgID != "org-1" {
		t.Fatalf("payload = %+v", job.Payload)
	}
	if job.Opts.Attempts != 3 || job.AttemptsMade != 1 || job.AttemptsStarted != 2 {
		t.Fatalf("attempts = %+v atm=%d ats=%d", job.Opts, job.AttemptsMade, job.AttemptsStarted)
	}
	if job.Token != "token-1" {
		t.Fatalf("token = %q", job.Token)
	}
}

func TestKeepJobsMatchesBullMQSemantics(t *testing.T) {
	complete := KeepOnComplete(JobOptions{RemoveOnComplete: json.RawMessage("true")})
	if complete.Count == nil || *complete.Count != 0 {
		t.Fatalf("complete keep = %+v, want count 0", complete)
	}
	failed := KeepOnFail(JobOptions{
		RemoveOnFail: json.RawMessage(`{"age":604800,"count":10000}`),
	})
	if failed.Age == nil || *failed.Age != 604800 || failed.Count == nil || *failed.Count != 10000 {
		t.Fatalf("failed keep = %+v", failed)
	}
	fallback := KeepOnFail(JobOptions{})
	if fallback.Count == nil || *fallback.Count != -1 {
		t.Fatalf("missing removeOnFail = %+v, want count -1", fallback)
	}
	completedFallback := KeepOnComplete(JobOptions{})
	if completedFallback.Count == nil || *completedFallback.Count != -1 {
		t.Fatalf("missing removeOnComplete = %+v, want count -1", completedFallback)
	}
}

func TestFinalFailureUsesDeferredFailureAndAttempts(t *testing.T) {
	job := Job{AttemptsMade: 0, Opts: JobOptions{Attempts: 3}}
	if job.FinalFailure() {
		t.Fatal("first attempt of three must not be final")
	}
	job.AttemptsMade = 2
	if !job.FinalFailure() {
		t.Fatal("third attempt must be final")
	}
	job.AttemptsMade = 0
	job.DeferredFailure = "job stalled more than allowable limit"
	if !job.FinalFailure() {
		t.Fatal("deferred stalled failure must be final")
	}
}

func TestJobIDPrefixRejectsUnknownType(t *testing.T) {
	for _, analysisType := range []string{TypeCorrelation, TypeAnomaly, TypeGeoTransport} {
		if _, err := JobIDPrefix(analysisType); err != nil {
			t.Fatalf("JobIDPrefix(%q): %v", analysisType, err)
		}
	}
	if _, err := JobIDPrefix("assistant"); err == nil {
		t.Fatal("unknown type should be rejected")
	}
}

func TestQueueKeysUseBullPrefix(t *testing.T) {
	keys := newKeys("", QueueName)
	if keys.Wait != "bull:analysis:wait" {
		t.Fatalf("wait key = %q", keys.Wait)
	}
	if keys.Job("corr-1") != "bull:analysis:corr-1" {
		t.Fatalf("job key = %q", keys.Job("corr-1"))
	}
}

func TestMsgpackRoundTripOfJobOptions(t *testing.T) {
	opts := defaultRedisJobOptions(3)
	encoded, err := pack(opts)
	if err != nil {
		t.Fatalf("pack: %v", err)
	}
	var decoded struct {
		Attempts         int      `msgpack:"attempts"`
		RemoveOnComplete bool     `msgpack:"removeOnComplete"`
		RemoveOnFail     KeepJobs `msgpack:"removeOnFail"`
	}
	if err := msgpack.Unmarshal(encoded, &decoded); err != nil {
		t.Fatalf("unpack: %v", err)
	}
	if decoded.Attempts != 3 || !decoded.RemoveOnComplete {
		t.Fatalf("decoded opts = %+v", decoded)
	}
}
