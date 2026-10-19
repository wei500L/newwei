package providers

import (
	"encoding/json"
	"math"
	"reflect"
	"testing"
	"time"
)

// pipelineFloatEqual compares a nullable number with an expected value; a nil
// want means the helper must have returned nil.
func pipelineFloatEqual(t *testing.T, label string, got, want *float64) {
	t.Helper()
	if want == nil {
		if got != nil {
			t.Fatalf("%s: want nil, got %v", label, *got)
		}
		return
	}
	if got == nil {
		t.Fatalf("%s: want %v, got nil", label, *want)
	}
	if *got != *want {
		t.Fatalf("%s: want %v, got %v", label, *want, *got)
	}
}

func TestPipelineQuantileCeilIndex(t *testing.T) {
	sequential := []float64{1, 2, 3, 4, 5, 6, 7, 8, 9, 10}

	cases := []struct {
		name       string
		values     []float64
		percentile float64
		want       *float64
	}{
		{name: "empty", values: nil, percentile: 90, want: nil},
		{name: "single", values: []float64{10}, percentile: 99, want: evaluationNumber(10)},
		// ceil(0.9*10)-1 = 8 -> the ninth smallest value.
		{name: "p90 of ten", values: sequential, percentile: 90, want: evaluationNumber(9)},
		// ceil(0.99*10)-1 = 9 -> the largest value.
		{name: "p99 of ten", values: sequential, percentile: 99, want: evaluationNumber(10)},
		// ceil(1.0*10)-1 = 9, clamped in range.
		{name: "p100", values: sequential, percentile: 100, want: evaluationNumber(10)},
		// ceil(0)-1 = -1, clamped to 0.
		{name: "p0", values: sequential, percentile: 0, want: evaluationNumber(1)},
		// ceil(0.5*3)-1 = 1 -> middle value after sorting.
		{name: "median of three", values: []float64{3, 1, 2}, percentile: 50, want: evaluationNumber(2)},
		// ceil(0.5*2)-1 = 0 -> lower of the two.
		{name: "two values", values: []float64{4, 2}, percentile: 50, want: evaluationNumber(2)},
		// Non-finite values are dropped before the index arithmetic.
		{
			name:       "drops non finite values",
			values:     []float64{math.NaN(), 2, math.Inf(1), 4},
			percentile: 50,
			want:       evaluationNumber(2),
		},
		{
			name:       "all non finite",
			values:     []float64{math.NaN(), math.Inf(-1)},
			percentile: 90,
			want:       nil,
		},
		// finite[NaN] is undefined in JavaScript, so the helper returns null.
		{name: "nan percentile", values: sequential, percentile: math.NaN(), want: nil},
		// An infinite percentile clamps to the largest value.
		{name: "infinite percentile", values: sequential, percentile: math.Inf(1), want: evaluationNumber(10)},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			pipelineFloatEqual(t, testCase.name,
				pipelineQuantile(testCase.values, testCase.percentile), testCase.want)
		})
	}
}

func TestPipelineCountChangePercent(t *testing.T) {
	pipelineFloatEqual(t, "previous zero", pipelineCountChangePercent(5, 0), nil)
	pipelineFloatEqual(t, "increase", pipelineCountChangePercent(15, 10), evaluationNumber(50))
	pipelineFloatEqual(t, "decrease", pipelineCountChangePercent(5, 10), evaluationNumber(-50))
	pipelineFloatEqual(t, "zero latest", pipelineCountChangePercent(0, 4), evaluationNumber(-100))
	pipelineFloatEqual(t, "same", pipelineCountChangePercent(3, 3), evaluationNumber(0))
}

func TestReadRuleMetadata(t *testing.T) {
	if metadata := readRuleMetadata(nil); metadata != nil {
		t.Fatalf("nil metadata: want nil, got %v", metadata)
	}
	if metadata := readRuleMetadata(json.RawMessage(`null`)); metadata != nil {
		t.Fatalf("null metadata: want nil, got %v", metadata)
	}
	// Array and scalar metadata are not objects, so toMetadata() returns null.
	if metadata := readRuleMetadata(json.RawMessage(`[{"a":1}]`)); metadata != nil {
		t.Fatalf("array metadata: want nil, got %v", metadata)
	}
	if metadata := readRuleMetadata(json.RawMessage(`"text"`)); metadata != nil {
		t.Fatalf("scalar metadata: want nil, got %v", metadata)
	}

	metadata := readRuleMetadata(json.RawMessage(`{"queueName":"q1","count":7,"ratio":0.25,"flag":true}`))
	if queueName, ok := metadata.text("queueName"); !ok || queueName != "q1" {
		t.Fatalf("queueName: want q1/true, got %q/%v", queueName, ok)
	}
	if value, ok := metadata.number("count"); !ok || value != 7 {
		t.Fatalf("count: want 7/true, got %v/%v", value, ok)
	}
	if value, ok := metadata.number("ratio"); !ok || value != 0.25 {
		t.Fatalf("ratio: want 0.25/true, got %v/%v", value, ok)
	}
	// typeof null === "object" and typeof true === "boolean": neither is a
	// number or a string.
	if _, ok := metadata.number("flag"); ok {
		t.Fatal("flag: boolean must not be a number")
	}
	if _, ok := metadata.text("flag"); ok {
		t.Fatal("flag: boolean must not be a string")
	}
	if _, ok := metadata.number("missing"); ok {
		t.Fatal("missing: absent key must not be a number")
	}
	if value := metadata.numberOr("missing", 4.5); value != 4.5 {
		t.Fatalf("numberOr fallback: want 4.5, got %v", value)
	}
}

func TestRequestedRuleStatuses(t *testing.T) {
	// Array entries that are not strings are filtered out, including null (a
	// json.Unmarshal of null into a string must not sneak through).
	metadata := readRuleMetadata(json.RawMessage(`{"statuses":["completed",7,null,"bogus"]}`))
	requested, ok := requestedRuleStatuses(metadata)
	if !ok {
		t.Fatal("statuses: want a filter")
	}
	if want := []string{"completed", "bogus"}; !reflect.DeepEqual(requested, want) {
		t.Fatalf("statuses: want %v, got %v", want, requested)
	}

	// An empty array is a present filter with no entries.
	metadata = readRuleMetadata(json.RawMessage(`{"statuses":[]}`))
	requested, ok = requestedRuleStatuses(metadata)
	if !ok || len(requested) != 0 {
		t.Fatalf("empty statuses: want present/empty, got %v/%v", requested, ok)
	}

	// statuses that is not an array falls back to the singular status.
	metadata = readRuleMetadata(json.RawMessage(`{"statuses":"completed","status":"failed"}`))
	requested, ok = requestedRuleStatuses(metadata)
	if !ok || !reflect.DeepEqual(requested, []string{"failed"}) {
		t.Fatalf("singular status: want [failed]/true, got %v/%v", requested, ok)
	}

	// status null is not a string.
	metadata = readRuleMetadata(json.RawMessage(`{"status":null}`))
	if _, ok := requestedRuleStatuses(metadata); ok {
		t.Fatal("null status: want no filter")
	}

	metadata = readRuleMetadata(nil)
	if _, ok := requestedRuleStatuses(metadata); ok {
		t.Fatal("absent metadata: want no filter")
	}
}

func TestFilterAllowedStatuses(t *testing.T) {
	got := filterAllowedStatuses([]string{"pending", "bogus", "pending", "completed"}, pipelineJobStatuses)
	want := []string{"pending", "pending", "completed"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("want %v, got %v", want, got)
	}

	// The result is non-nil so the context JSON renders [] rather than null.
	empty := filterAllowedStatuses(nil, pipelineJobStatuses)
	if empty == nil || len(empty) != 0 {
		t.Fatalf("want non-nil empty slice, got %#v", empty)
	}
}

func TestOutboxStatusesForSlug(t *testing.T) {
	cases := []struct {
		slug string
		want []string
	}{
		{"mongo_outbox.backlog", []string{"pending", "failed", "processing"}},
		{"mongo_outbox.pending", []string{"pending"}},
		{"mongo_outbox.failed", []string{"failed"}},
		{"mongo_outbox.processing", []string{"processing"}},
		{"mongo_outbox.dead", []string{"dead"}},
		// defaultStatusesBySlug[slug] ?? backlog
		{"mongo_outbox.unknown", []string{"pending", "failed", "processing"}},
	}
	for _, testCase := range cases {
		if got := outboxStatusesForSlug(testCase.slug); !reflect.DeepEqual(got, testCase.want) {
			t.Fatalf("%s: want %v, got %v", testCase.slug, testCase.want, got)
		}
	}

	// requestedStatuses still go through Object.values(MongoOutboxStatus); the
	// per-slug default only applies when the rule requested nothing.
	metadata := readRuleMetadata(json.RawMessage(`{"statuses":["pending","bogus","dead"]}`))
	if got, want := resolveOutboxStatuses(metadata, "mongo_outbox.backlog"),
		[]string{"pending", "dead"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("requested: want %v, got %v", want, got)
	}
	metadata = readRuleMetadata(json.RawMessage(`{"statuses":[]}`))
	if got := resolveOutboxStatuses(metadata, "mongo_outbox.backlog"); got == nil || len(got) != 0 {
		t.Fatalf("empty requested: want non-nil empty slice, got %#v", got)
	}
}

func TestResolvePipelineJobStatuses(t *testing.T) {
	cases := []struct {
		name     string
		metadata string
		want     []string
	}{
		{name: "default", metadata: `{}`, want: []string{"failed"}},
		{
			name:     "filtered",
			metadata: `{"statuses":["completed","bogus"]}`,
			want:     []string{"completed"},
		},
		{name: "empty", metadata: `{"statuses":[]}`, want: []string{}},
	}
	for _, testCase := range cases {
		metadata := readRuleMetadata(json.RawMessage(testCase.metadata))
		got := resolvePipelineJobStatuses(metadata)
		if !reflect.DeepEqual(got, testCase.want) {
			t.Fatalf("%s: want %#v, got %#v", testCase.name, testCase.want, got)
		}
		if got == nil {
			t.Fatalf("%s: resolution must return a non-nil slice", testCase.name)
		}
	}
}

func TestOutboxTypeFromMetadata(t *testing.T) {
	cases := []struct {
		name     string
		metadata string
		want     string
	}{
		{name: "absent", metadata: `{}`, want: outboxTypeProcessedItem},
		{name: "allowed", metadata: `{"type":"raw_item"}`, want: outboxTypeRawItem},
		{name: "trimmed", metadata: `{"type":"  cleanup_crawl_results  "}`, want: outboxTypeCleanupCrawlResults},
		{name: "unknown", metadata: `{"type":"bogus"}`, want: outboxTypeProcessedItem},
		{name: "empty", metadata: `{"type":"   "}`, want: outboxTypeProcessedItem},
		{name: "not a string", metadata: `{"type":5}`, want: outboxTypeProcessedItem},
		{name: "null", metadata: `{"type":null}`, want: outboxTypeProcessedItem},
	}
	for _, testCase := range cases {
		metadata := readRuleMetadata(json.RawMessage(testCase.metadata))
		if got := outboxTypeFromMetadata(metadata); got != testCase.want {
			t.Fatalf("%s: want %s, got %s", testCase.name, testCase.want, got)
		}
	}
}

func TestJSIsoTimestamp(t *testing.T) {
	zone := time.FixedZone("test", 3*60*60)
	value := time.Date(2026, 10, 20, 4, 5, 6, 7*int(time.Millisecond), zone)
	if got, want := jsISOTimestamp(value), "2026-10-20T01:05:06.007Z"; got != want {
		t.Fatalf("want %s, got %s", want, got)
	}
}

func TestProviderSQLPlaceholders(t *testing.T) {
	cases := map[int]string{0: "", 1: "?", 3: "?,?,?"}
	for count, want := range cases {
		if got := providerSQLPlaceholders(count); got != want {
			t.Fatalf("%d: want %q, got %q", count, want, got)
		}
	}
}
