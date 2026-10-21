package crawlexecution

// FullSummary JSON contract: BullMQ stores the runTask resolve value as the job
// returnvalue, so the serialized bytes have to match the NestJS object member
// for member: same order, same undefined-omission, same Date rendering.

import (
	"bytes"
	"encoding/json"
	"io"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func intPointer(value int) *int { return &value }

func floatPointer(value float64) *float64 { return &value }

func TestFullSummaryMarshalJSONMatchesNestOrder(t *testing.T) {
	fetchedAt := time.Date(2026, 10, 20, 8, 30, 45, 123_000_000, time.UTC)
	summary := FullSummary{
		Inserted:         3,
		Skipped:          1,
		ReusedResultID:   stringPtr("result-1"),
		ItemsQueued:      intPointer(2),
		ItemsQueueFailed: intPointer(1),
		LastFetchedAt:    &fetchedAt,
		RunID:            stringPtr("run-1"),
		Memory: &MemoryStats{
			ServerMemoryMB:    floatPointer(123.5),
			PeakMemoryMB:      floatPointer(200),
			EfficiencyPercent: floatPointer(61.75),
		},
		Failures: []Failure{
			{URL: "https://example.com/a", Message: "timeout", StatusCode: intPointer(503), Retryable: true},
			{Message: "boom"},
		},
		RetryableFailures: intPointer(1),
	}
	encoded, err := json.Marshal(summary)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"inserted":3,"skipped":1,"reusedResultId":"result-1","itemsQueued":2,"itemsQueueFailed":1,` +
		`"lastFetchedAt":"2026-10-20T08:30:45.123Z","runId":"run-1",` +
		`"memory":{"serverMemoryMb":123.5,"peakMemoryMb":200,"efficiencyPercent":61.75},` +
		`"failures":[{"url":"https://example.com/a","statusCode":503,"error":"timeout","retryable":true},` +
		`{"error":"boom","retryable":false}],"retryableFailures":1}`
	if string(encoded) != want {
		t.Fatalf("summary JSON mismatch\n got: %s\nwant: %s", encoded, want)
	}
}

func TestFullSummaryMarshalJSONOmitsUndefinedMembers(t *testing.T) {
	cases := []struct {
		name    string
		summary FullSummary
		want    string
	}{
		{
			name:    "minimal",
			summary: FullSummary{},
			want:    `{"inserted":0,"skipped":0}`,
		},
		{
			name: "304 reuse",
			summary: FullSummary{
				Inserted:       0,
				Skipped:        1,
				ReusedResultID: stringPtr("result-9"),
				LastFetchedAt:  fullSummaryTimePointer(t, "2026-10-19T08:00:00.000Z"),
			},
			want: `{"inserted":0,"skipped":1,"reusedResultId":"result-9","lastFetchedAt":"2026-10-19T08:00:00.000Z"}`,
		},
		{
			name: "zero item counters are present when ingestToItems ran",
			summary: FullSummary{
				Inserted:         1,
				Skipped:          0,
				ItemsQueued:      intPointer(0),
				ItemsQueueFailed: intPointer(0),
			},
			want: `{"inserted":1,"skipped":0,"itemsQueued":0,"itemsQueueFailed":0}`,
		},
		{
			name: "zero retryableFailures is present when failures exist",
			summary: FullSummary{
				Inserted:          1,
				Skipped:           0,
				Failures:          []Failure{{Message: "boom"}},
				RetryableFailures: intPointer(0),
			},
			want: `{"inserted":1,"skipped":0,"failures":[{"error":"boom","retryable":false}],"retryableFailures":0}`,
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			encoded, err := json.Marshal(testCase.summary)
			if err != nil {
				t.Fatal(err)
			}
			if string(encoded) != testCase.want {
				t.Fatalf("got %s, want %s", encoded, testCase.want)
			}
		})
	}
}

func fullSummaryTimePointer(t *testing.T, value string) *time.Time {
	t.Helper()
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil {
		t.Fatal(err)
	}
	return &parsed
}

func TestMemoryStatsMarshalJSONOmitsNilMembers(t *testing.T) {
	encoded, err := json.Marshal(MemoryStats{PeakMemoryMB: floatPointer(240)})
	if err != nil {
		t.Fatal(err)
	}
	if string(encoded) != `{"peakMemoryMb":240}` {
		t.Fatalf("memory JSON = %s", encoded)
	}
	encoded, err = json.Marshal(MemoryStats{})
	if err != nil {
		t.Fatal(err)
	}
	if string(encoded) != `{}` {
		t.Fatalf("empty memory JSON = %s", encoded)
	}
}

func TestFailureMarshalJSONOmitsEmptyURLAndNilStatus(t *testing.T) {
	encoded, err := json.Marshal(Failure{URL: "https://example.com/x", Message: "nope", StatusCode: intPointer(404), Retryable: true})
	if err != nil {
		t.Fatal(err)
	}
	if string(encoded) != `{"url":"https://example.com/x","statusCode":404,"error":"nope","retryable":true}` {
		t.Fatalf("failure JSON = %s", encoded)
	}
	encoded, err = json.Marshal(Failure{Message: "nope"})
	if err != nil {
		t.Fatal(err)
	}
	if string(encoded) != `{"error":"nope","retryable":false}` {
		t.Fatalf("failure JSON = %s", encoded)
	}
}

func TestFullSummaryFromPersistedMatchesNestProjection(t *testing.T) {
	fetchedAt := time.Date(2026, 10, 20, 8, 30, 45, 0, time.UTC)
	persisted := Summary{
		Inserted:         2,
		Skipped:          1,
		ReusedResultID:   "result-1",
		RunID:            "run-1",
		LastFetchedAt:    &fetchedAt,
		ItemsQueued:      4,
		ItemsQueueFailed: 0,
	}
	full := fullSummaryFromPersisted(persisted, memoryStats{}, false)
	if full.ReusedResultID == nil || *full.ReusedResultID != "result-1" {
		t.Fatalf("reusedResultId = %#v", full.ReusedResultID)
	}
	if full.ItemsQueued != nil || full.ItemsQueueFailed != nil {
		t.Fatal("item counters must be omitted without ingestToItems")
	}
	if full.Memory != nil {
		t.Fatal("memory must be omitted when no stat exists")
	}
	if full.RunID == nil || *full.RunID != "run-1" || full.LastFetchedAt == nil {
		t.Fatalf("summary = %#v", full)
	}

	withItems := fullSummaryFromPersisted(persisted, memoryStats{ServerMemoryMB: floatPointer(12)}, true)
	if withItems.ItemsQueued == nil || *withItems.ItemsQueued != 4 ||
		withItems.ItemsQueueFailed == nil || *withItems.ItemsQueueFailed != 0 {
		t.Fatalf("item counters = %#v/%#v", withItems.ItemsQueued, withItems.ItemsQueueFailed)
	}
	if withItems.Memory == nil || withItems.Memory.ServerMemoryMB == nil || *withItems.Memory.ServerMemoryMB != 12 {
		t.Fatalf("memory = %#v", withItems.Memory)
	}
}

func TestPipelineSummaryFromRoundTrip(t *testing.T) {
	fetchedAt := time.Date(2026, 10, 20, 8, 30, 45, 0, time.UTC)
	full := FullSummary{
		Inserted:          5,
		Skipped:           2,
		ReusedResultID:    stringPtr("result-1"),
		ItemsQueued:       intPointer(1),
		ItemsQueueFailed:  intPointer(2),
		LastFetchedAt:     &fetchedAt,
		RunID:             stringPtr("run-2"),
		RetryableFailures: intPointer(3),
		Failures:          []Failure{{Message: "timeout", Retryable: true}},
	}
	summary := pipelineSummaryFrom(full)
	if summary.Inserted != 5 || summary.Skipped != 2 || summary.ReusedResultID != "result-1" ||
		summary.ItemsQueued != 1 || summary.ItemsQueueFailed != 2 || summary.RunID != "run-2" ||
		summary.RetryableFailures != 3 || summary.LastFetchedAt == nil {
		t.Fatalf("summary = %#v", summary)
	}
	if len(summary.Failures) != 1 || summary.Failures[0].Message != "timeout" {
		t.Fatalf("failures = %#v", summary.Failures)
	}
}

func TestOrderedSummaryDocumentKeepsMemberOrder(t *testing.T) {
	fetchedAt := time.Date(2026, 10, 20, 8, 30, 45, 123_000_000, time.UTC)
	summary := FullSummary{
		Inserted:      1,
		Skipped:       0,
		LastFetchedAt: &fetchedAt,
		RunID:         stringPtr("run-1"),
		Memory:        &MemoryStats{PeakMemoryMB: floatPointer(64)},
		Failures:      []Failure{{URL: "https://example.com/a", Message: "boom", StatusCode: intPointer(500), Retryable: true}},
	}
	document := orderedSummaryDocument(summary)
	wantKeys := []string{"inserted", "skipped", "lastFetchedAt", "runId", "memory", "failures"}
	if len(document) != len(wantKeys) {
		t.Fatalf("document members = %d, want %d", len(document), len(wantKeys))
	}
	for index, key := range wantKeys {
		if document[index].Key != key {
			t.Fatalf("member %d = %q, want %q", index, document[index].Key, key)
		}
	}
	memory, ok := document[4].Value.(bson.D)
	if !ok {
		t.Fatalf("memory member type = %T", document[4].Value)
	}
	if len(memory) != 1 || memory[0].Key != "peakMemoryMb" {
		t.Fatalf("memory document = %#v", memory)
	}
	failures, ok := document[5].Value.(bson.A)
	if !ok || len(failures) != 1 {
		t.Fatalf("failures member = %#v", document[5].Value)
	}
	failure, ok := failures[0].(bson.D)
	if !ok {
		t.Fatalf("failure document type = %T", failures[0])
	}
	failureKeys := make([]string, 0, len(failure))
	for _, member := range failure {
		failureKeys = append(failureKeys, member.Key)
	}
	wantFailureKeys := []string{"url", "statusCode", "error", "retryable"}
	if len(failureKeys) != len(wantFailureKeys) {
		t.Fatalf("failure keys = %#v", failureKeys)
	}
	for index, key := range wantFailureKeys {
		if failureKeys[index] != key {
			t.Fatalf("failure member %d = %q, want %q", index, failureKeys[index], key)
		}
	}
}

// topLevelJSONKeys returns the member names of a JSON object in wire order.
func topLevelJSONKeys(t *testing.T, encoded []byte) []string {
	t.Helper()
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	token, err := decoder.Token()
	if err != nil {
		t.Fatal(err)
	}
	if delimiter, ok := token.(json.Delim); !ok || delimiter != '{' {
		t.Fatalf("expected a JSON object, got %#v", token)
	}
	keys := make([]string, 0, 10)
	depth := 1
	for depth > 0 {
		token, err := decoder.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		switch value := token.(type) {
		case json.Delim:
			switch value {
			case '{', '[':
				depth++
			case '}', ']':
				depth--
			}
		case string:
			if depth == 1 {
				keys = append(keys, value)
				// The key token is followed by its value; skip it so a string
				// value is never mistaken for a key.
				var raw json.RawMessage
				if err := decoder.Decode(&raw); err != nil {
					t.Fatal(err)
				}
			}
		}
	}
	return keys
}

// bsonKeys returns the member names of an ordered BSON document.
func bsonKeys(document bson.D) []string {
	keys := make([]string, 0, len(document))
	for _, member := range document {
		keys = append(keys, member.Key)
	}
	return keys
}

// TestCompleteTaskLogDataMatchesSummaryJSONOrder pins that the complete-stage
// TaskLog data leaf orders its members exactly like the runTask summary JSON, so
// the persisted document and the BullMQ returnvalue agree field for field. It
// flattens the ordered BSON document, no Mongo required.
func TestCompleteTaskLogDataMatchesSummaryJSONOrder(t *testing.T) {
	fetchedAt := time.Date(2026, 10, 20, 8, 30, 45, 123_000_000, time.UTC)
	summary := FullSummary{
		Inserted:          3,
		Skipped:           1,
		ReusedResultID:    stringPtr("result-1"),
		ItemsQueued:       intPointer(2),
		ItemsQueueFailed:  intPointer(1),
		LastFetchedAt:     &fetchedAt,
		RunID:             stringPtr("run-1"),
		Memory:            &MemoryStats{ServerMemoryMB: floatPointer(12.5), PeakMemoryMB: floatPointer(40)},
		Failures:          []Failure{{URL: "https://example.com/a", Message: "timeout", StatusCode: intPointer(503), Retryable: true}},
		RetryableFailures: intPointer(1),
	}
	document := completeTaskLogDocument("task-1", "org-1", summary, fetchedAt)

	// The TaskLog document keeps the writer's field set and order.
	wantDocumentKeys := []string{"_id", "queue", "jobId", "orgId", "stage", "status", "data", "createdAt", "updatedAt"}
	if got := bsonKeys(document); len(got) != len(wantDocumentKeys) {
		t.Fatalf("document keys = %#v", got)
	} else {
		for index, key := range wantDocumentKeys {
			if got[index] != key {
				t.Fatalf("document member %d = %q, want %q", index, got[index], key)
			}
		}
	}

	var dataLeaf bson.D
	for _, member := range document {
		if member.Key != "data" {
			continue
		}
		element, ok := member.Value.(bson.D)
		if !ok {
			t.Fatalf("data leaf type = %T", member.Value)
		}
		dataLeaf = element
	}
	if dataLeaf == nil {
		t.Fatal("data leaf missing")
	}

	encoded, err := json.Marshal(summary)
	if err != nil {
		t.Fatal(err)
	}
	jsonKeys := topLevelJSONKeys(t, encoded)
	bsonMemberKeys := bsonKeys(dataLeaf)
	if len(jsonKeys) != len(bsonMemberKeys) {
		t.Fatalf("JSON keys %#v vs BSON keys %#v", jsonKeys, bsonMemberKeys)
	}
	for index, key := range jsonKeys {
		if bsonMemberKeys[index] != key {
			t.Fatalf("member %d = %q in BSON, %q in JSON", index, bsonMemberKeys[index], key)
		}
	}
	// The ordered summary document is the same value the log embeds.
	if got := bsonKeys(orderedSummaryDocument(summary)); len(got) != len(bsonMemberKeys) {
		t.Fatalf("orderedSummaryDocument keys = %#v", got)
	}
}
