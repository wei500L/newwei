package crawlfrontiernode

// summary_test.go locks the CrawlExecutionSummary JSON the BullMQ job resolves
// with.
//
// Derivation (apps/api/src/modules/crawl/crawl-result.service.ts,
// persistResults' return literal):
//
//	return {
//	  inserted,
//	  skipped,
//	  ...(reusedResultId ? { reusedResultId } : {}),
//	  ...(ingestToItems ? { itemsQueued, itemsQueueFailed } : {}),
//	  lastFetchedAt: latestResultAt ?? reusedResultFetchedAt,
//	  runId,
//	  memory,
//	};
//
// The Frontier call site (crawl-frontier.service.ts persistFrontierResponse,
// 2478) passes neither ingestToItems nor memory, so both spreads/spellings are
// `undefined` and JSON.stringify drops the two keys. `reusedResultId` is only
// present when the persist step reused an existing CrawlResult row, while
// `lastFetchedAt`/`runId` are always *present* keys on the object - they just
// serialize as dropped when their value is undefined. Go has no undefined, so
// the empty string / nil pointer stand in for it and MarshalJSON omits them
// (summary.go).
//
// What the tests below therefore prove:
//   - the four serialized shapes NestJS can produce, byte for byte;
//   - the key order inside the JSON (inserted, skipped, reusedResultId,
//     lastFetchedAt, runId), which only holds because MarshalJSON writes the
//     bytes itself instead of going through a Go map;
//   - Date.prototype.toISOString formatting (UTC, exactly three millisecond
//     digits, trailing Z);
//   - the two short-circuit summaries `{ inserted: 0, skipped: 0 }`;
//   - the projection that drops the persistResults fields the Frontier call
//     site never requests.

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/crawlexecution"
)

// testFixedTime is a millisecond-precise instant; NestJS Date has millisecond
// resolution and the DATETIME(3) columns store the same precision.
func testFixedTime() time.Time {
	return time.Date(2025, 3, 4, 5, 6, 7, 891_000_000, time.UTC)
}

func TestSummaryEmptySerializesInsertedSkippedOnly(t *testing.T) {
	// `return { inserted: 0, skipped: 0 }` in both processQueuedNode
	// short-circuits (canceled run and hot->normal demotion).
	encoded, err := marshalSummary(emptySummary())
	if err != nil {
		t.Fatalf("marshal empty summary: %v", err)
	}
	if got, want := string(encoded), `{"inserted":0,"skipped":0}`; got != want {
		t.Fatalf("empty summary = %s, want %s", got, want)
	}
}

func TestSummaryOmittedKeysFollowNestStringify(t *testing.T) {
	// `lastFetchedAt: latestResultAt ?? reusedResultFetchedAt` and `runId` are
	// always keys of the NestJS object literal; only their undefined values
	// make JSON.stringify drop them. The same object with a reused result id
	// keeps the id and still has no lastFetchedAt/runId.
	cases := []struct {
		name    string
		summary CrawlExecutionSummary
		want    string
	}{
		{
			name:    "inserted and skipped only",
			summary: CrawlExecutionSummary{Inserted: 2, Skipped: 1},
			want:    `{"inserted":2,"skipped":1}`,
		},
		{
			name:    "reused result id present",
			summary: CrawlExecutionSummary{Inserted: 0, Skipped: 3, ReusedResultID: "result-9"},
			want:    `{"inserted":0,"skipped":3,"reusedResultId":"result-9"}`,
		},
		{
			name:    "run id present",
			summary: CrawlExecutionSummary{Inserted: 1, Skipped: 0, RunID: "crawl-run-1"},
			want:    `{"inserted":1,"skipped":0,"runId":"crawl-run-1"}`,
		},
		{
			name:    "last fetched at present",
			summary: CrawlExecutionSummary{Inserted: 1, Skipped: 0, LastFetchedAt: testTimePointer(testFixedTime())},
			want:    `{"inserted":1,"skipped":0,"lastFetchedAt":"2025-03-04T05:06:07.891Z"}`,
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			encoded, err := marshalSummary(testCase.summary)
			if err != nil {
				t.Fatalf("marshal summary: %v", err)
			}
			if got := string(encoded); got != testCase.want {
				t.Fatalf("summary = %s, want %s", got, testCase.want)
			}
		})
	}
}

func TestSummaryKeyOrderMatchesNestConstructionOrder(t *testing.T) {
	// The NestJS literal order is inserted, skipped, reusedResultId?,
	// itemsQueued?/itemsQueueFailed?, lastFetchedAt, runId, memory. The Frontier
	// call site never sets the item counters or memory, so the serialized order
	// is exactly the one asserted here. A Go map or a struct without a custom
	// MarshalJSON could not guarantee it.
	summary := CrawlExecutionSummary{
		Inserted:       4,
		Skipped:        5,
		ReusedResultID: "result-1",
		LastFetchedAt:  testTimePointer(testFixedTime()),
		RunID:          "run-1",
	}
	encoded, err := marshalSummary(summary)
	if err != nil {
		t.Fatalf("marshal summary: %v", err)
	}
	want := `{"inserted":4,"skipped":5,"reusedResultId":"result-1","lastFetchedAt":"2025-03-04T05:06:07.891Z","runId":"run-1"}`
	if got := string(encoded); got != want {
		t.Fatalf("summary = %s, want %s", got, want)
	}
}

func TestSummaryLastFetchedAtUsesISOMillisecondZ(t *testing.T) {
	// Date.prototype.toISOString always renders UTC with exactly three
	// fractional digits and a trailing Z, whatever the stored offset was. The
	// test feeds a +02:00 instant and a whole second, and expects both to be
	// normalized.
	cases := []struct {
		name      string
		fetchedAt time.Time
		want      string
	}{
		{
			name:      "non utc offset is converted",
			fetchedAt: time.Date(2025, 3, 4, 7, 6, 7, 891_000_000, time.FixedZone("MSK", 2*60*60)),
			want:      "2025-03-04T05:06:07.891Z",
		},
		{
			name:      "whole second keeps three zero digits",
			fetchedAt: time.Date(2025, 3, 4, 5, 6, 7, 0, time.UTC),
			want:      "2025-03-04T05:06:07.000Z",
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			encoded, err := marshalSummary(CrawlExecutionSummary{LastFetchedAt: testTimePointer(testCase.fetchedAt)})
			if err != nil {
				t.Fatalf("marshal summary: %v", err)
			}
			var decoded struct {
				LastFetchedAt string `json:"lastFetchedAt"`
			}
			if err := json.Unmarshal(encoded, &decoded); err != nil {
				t.Fatalf("decode summary: %v", err)
			}
			if decoded.LastFetchedAt != testCase.want {
				t.Fatalf("lastFetchedAt = %q, want %q", decoded.LastFetchedAt, testCase.want)
			}
		})
	}
}

func TestSummaryProjectionDropsUnrequestedPersistResultsFields(t *testing.T) {
	// crawlExecutionSummaryOf (record.go) keeps the five keys the Frontier call
	// site serializes and drops the persistResults fields it never passes:
	// itemsQueued/itemsQueueFailed only exist when ingestToItems is truthy and
	// the failure details / retryable counter / memory block are job-log data,
	// not part of the BullMQ return value.
	fetchedAt := testFixedTime()
	crawlexecutionSummary := crawlexecution.Summary{
		Inserted:          2,
		Skipped:           1,
		ReusedResultID:    "result-7",
		RunID:             "crawl-run-2",
		LastFetchedAt:     &fetchedAt,
		ItemsQueued:       9,
		ItemsQueueFailed:  8,
		Failures:          []crawlexecution.Failure{{URL: "https://example.com/a", Message: "boom"}},
		RetryableFailures: 7,
	}
	projected := crawlExecutionSummaryOf(crawlexecutionSummary)
	want := CrawlExecutionSummary{
		Inserted:       2,
		Skipped:        1,
		ReusedResultID: "result-7",
		RunID:          "crawl-run-2",
		LastFetchedAt:  &fetchedAt,
	}
	if projected != want {
		t.Fatalf("projection = %+v, want %+v", projected, want)
	}
	encoded, err := marshalSummary(projected)
	if err != nil {
		t.Fatalf("marshal summary: %v", err)
	}
	wantJSON := `{"inserted":2,"skipped":1,"reusedResultId":"result-7","lastFetchedAt":"2025-03-04T05:06:07.891Z","runId":"crawl-run-2"}`
	if got := string(encoded); got != wantJSON {
		t.Fatalf("summary = %s, want %s", got, wantJSON)
	}
}

// testTimePointer returns a pointer to value for the optional summary field.
func testTimePointer(value time.Time) *time.Time { return &value }
