package bullmq

import (
	"encoding/json"
	"testing"

	"github.com/vmihailenco/msgpack/v5"
)

// TestScriptsLoadAndParseKeys proves every embedded Lua file loads and that its
// filename suffix is a positive numberOfKeys.
func TestScriptsLoadAndParseKeys(t *testing.T) {
	entries := Scripts()
	if len(entries) != 25 {
		t.Fatalf("embedded script count = %d, want 25", len(entries))
	}
	for _, entry := range entries {
		if entry.Name == "" {
			t.Fatalf("script with empty name")
		}
		if entry.NumberOfKeys <= 0 {
			t.Fatalf("%s: numberOfKeys = %d", entry.Name, entry.NumberOfKeys)
		}
		if entry.Script == nil {
			t.Fatalf("%s: nil script", entry.Name)
		}
	}
}

func mustDecodeMap(t *testing.T, value any) map[string]any {
	t.Helper()
	encoded, err := msgpack.Marshal(value)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var decoded map[string]any
	if err := msgpack.Unmarshal(encoded, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	return decoded
}

// jsonKey canonicalizes a decoded msgpack map so numeric width differences
// (int vs int64) do not produce false mismatches. Map key order is not part of
// the BullMQ contract: cmsgpack.unpack yields an unordered Lua table.
func jsonKey(t *testing.T, value any) string {
	t.Helper()
	encoded, err := json.Marshal(mustDecodeMap(t, value))
	if err != nil {
		t.Fatalf("json marshal: %v", err)
	}
	return string(encoded)
}

// TestJobOptionsMatchesHistoricalEncodings pins JobOptions against the option
// structs the individual producers used before the unification. Each historical
// struct is reproduced here with the exact msgpack tags from the original
// source; the assertion compares the decoded option maps, which is what the Lua
// add commands actually observe after cmsgpack.unpack.
func TestJobOptionsMatchesHistoricalEncodings(t *testing.T) {
	type keepJobs struct {
		Age   *int64 `msgpack:"age,omitempty"`
		Count *int64 `msgpack:"count,omitempty"`
	}
	type backoff struct {
		Type  string `msgpack:"type"`
		Delay int64  `msgpack:"delay"`
	}
	type retention struct {
		Age   int64 `msgpack:"age"`
		Count int64 `msgpack:"count"`
	}
	i64 := func(v int64) *int64 { return &v }

	t.Run("qualityqueue", func(t *testing.T) {
		age, count := int64(0), int64(1000)
		historical := struct {
			JobID            string   `msgpack:"jobId"`
			Attempts         int64    `msgpack:"attempts"`
			Backoff          backoff  `msgpack:"backoff"`
			RemoveOnComplete keepJobs `msgpack:"removeOnComplete"`
			RemoveOnFail     keepJobs `msgpack:"removeOnFail"`
		}{JobID: "job-1", Attempts: 3, Backoff: backoff{Type: "exponential", Delay: 2000},
			RemoveOnComplete: keepJobs{Count: &age}, RemoveOnFail: keepJobs{Count: &count}}
		got := JobOptions{JobID: "job-1", Attempts: i64(3), Backoff: &Backoff{Type: "exponential", Delay: 2000},
			RemoveOnComplete: KeepJobs{Count: &age}, RemoveOnFail: KeepJobs{Count: &count}}
		if jsonKey(t, historical) != jsonKey(t, got) {
			t.Fatalf("qualityqueue options differ\n historical=%s\n unified=%s", jsonKey(t, historical), jsonKey(t, got))
		}
	})

	t.Run("pipelineenqueue", func(t *testing.T) {
		priority := int64(5)
		historical := struct {
			JobID            string    `msgpack:"jobId"`
			RemoveOnComplete bool      `msgpack:"removeOnComplete"`
			RemoveOnFail     retention `msgpack:"removeOnFail"`
			Attempts         int64     `msgpack:"attempts"`
			Backoff          backoff   `msgpack:"backoff"`
			Priority         *int64    `msgpack:"priority,omitempty"`
		}{JobID: "item-1-raw-1", RemoveOnComplete: true, RemoveOnFail: retention{Age: 7 * 24 * 3600, Count: 10000},
			Attempts: 5, Backoff: backoff{Type: "exponential", Delay: 2000}, Priority: &priority}
		got := JobOptions{JobID: "item-1-raw-1", RemoveOnComplete: true,
			RemoveOnFail: KeepJobs{Age: i64(7 * 24 * 3600), Count: i64(10000)}, Attempts: i64(5),
			Backoff: &Backoff{Type: "exponential", Delay: 2000}, Priority: &priority}
		if jsonKey(t, historical) != jsonKey(t, got) {
			t.Fatalf("pipelineenqueue options differ\n historical=%s\n unified=%s", jsonKey(t, historical), jsonKey(t, got))
		}
	})

	t.Run("itempipeline-dlq", func(t *testing.T) {
		age, count := int64(604800), int64(10000)
		historical := struct {
			JobID            string   `msgpack:"jobId"`
			RemoveOnComplete keepJobs `msgpack:"removeOnComplete"`
			RemoveOnFail     keepJobs `msgpack:"removeOnFail"`
			Attempts         int64    `msgpack:"attempts"`
		}{JobID: "dlq-1", RemoveOnComplete: keepJobs{Age: &age, Count: &count}, RemoveOnFail: keepJobs{Age: &age, Count: &count}, Attempts: 1}
		got := JobOptions{JobID: "dlq-1", RemoveOnComplete: KeepJobs{Age: &age, Count: &count},
			RemoveOnFail: KeepJobs{Age: &age, Count: &count}, Attempts: i64(1)}
		if jsonKey(t, historical) != jsonKey(t, got) {
			t.Fatalf("itempipeline options differ\n historical=%s\n unified=%s", jsonKey(t, historical), jsonKey(t, got))
		}
	})

	t.Run("crawlqueue", func(t *testing.T) {
		priority := int64(201)
		type dedup struct {
			ID string `msgpack:"id"`
		}
		historical := struct {
			Attempts         int64     `msgpack:"attempts"`
			RemoveOnComplete bool      `msgpack:"removeOnComplete"`
			RemoveOnFail     retention `msgpack:"removeOnFail"`
			Backoff          *backoff  `msgpack:"backoff,omitempty"`
			JobID            string    `msgpack:"jobId"`
			Deduplication    *dedup    `msgpack:"de,omitempty"`
			Priority         *int64    `msgpack:"priority,omitempty"`
		}{Attempts: 3, RemoveOnComplete: true, RemoveOnFail: retention{Age: 7 * 24 * 3600, Count: 10000},
			JobID: "task-1-1700000000000-hot", Deduplication: &dedup{ID: "crawl-task:task-1"}, Priority: &priority}
		got := JobOptions{Attempts: i64(3), RemoveOnComplete: true,
			RemoveOnFail: KeepJobs{Age: i64(7 * 24 * 3600), Count: i64(10000)}, JobID: "task-1-1700000000000-hot",
			Deduplication: &Deduplication{ID: "crawl-task:task-1"}, Priority: &priority}
		if jsonKey(t, historical) != jsonKey(t, got) {
			t.Fatalf("crawlqueue options differ\n historical=%s\n unified=%s", jsonKey(t, historical), jsonKey(t, got))
		}
	})

	t.Run("archivepreparation", func(t *testing.T) {
		historical := struct {
			Attempts         int64     `msgpack:"attempts"`
			Backoff          backoff   `msgpack:"backoff"`
			RemoveOnComplete retention `msgpack:"removeOnComplete"`
			RemoveOnFail     retention `msgpack:"removeOnFail"`
			JobID            string    `msgpack:"jobId"`
		}{Attempts: 5, Backoff: backoff{Type: "exponential", Delay: 15000},
			RemoveOnComplete: retention{Age: 3600, Count: 1000}, RemoveOnFail: retention{Age: 604800, Count: 10000}, JobID: "digest:org:2026-01-01"}
		got := JobOptions{Attempts: i64(5), Backoff: &Backoff{Type: "exponential", Delay: 15000},
			RemoveOnComplete: KeepJobs{Age: i64(3600), Count: i64(1000)}, RemoveOnFail: KeepJobs{Age: i64(604800), Count: i64(10000)}, JobID: "digest:org:2026-01-01"}
		if jsonKey(t, historical) != jsonKey(t, got) {
			t.Fatalf("archivepreparation options differ\n historical=%s\n unified=%s", jsonKey(t, historical), jsonKey(t, got))
		}
	})
}
