package bullmqwire

import (
	"encoding/json"
	"testing"
)

// TestKeepsFinishedJob pins every branch of keepsFinishedJob
// (apps/api/src/common/bullmq-retention.ts). The retention flags decide whether
// the org queue counters keep a per-job meta row, so a drift here changes the
// dashboard numbers.
func TestKeepsFinishedJob(t *testing.T) {
	cases := []struct {
		name   string
		option string
		want   bool
	}{
		{name: "absent", option: "", want: true},
		{name: "null", option: "null", want: true},
		{name: "true means remove immediately", option: "true", want: false},
		{name: "false keeps the job", option: "false", want: true},
		{name: "positive number", option: "25", want: true},
		{name: "zero number", option: "0", want: false},
		{name: "age and count", option: `{"age":604800,"count":10000}`, want: true},
		{name: "zero age", option: `{"age":0,"count":10000}`, want: false},
		{name: "zero count", option: `{"age":604800,"count":0}`, want: false},
		{name: "absent keys are not zero", option: `{"age":604800}`, want: true},
		{name: "empty object", option: `{}`, want: true},
		{name: "unparsable object keeps the job", option: `{"age":"x"}`, want: true},
		{name: "unparsable scalar keeps the job", option: `"yes"`, want: true},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got := KeepsFinishedJob(json.RawMessage(testCase.option))
			if got != testCase.want {
				t.Fatalf("KeepsFinishedJob(%s) = %t, want %t", testCase.option, got, testCase.want)
			}
		})
	}
}

// TestOrgIDFromData covers the tenant extraction the tracker and the DLQ replay
// depend on.
func TestOrgIDFromData(t *testing.T) {
	cases := []struct {
		name string
		data string
		want string
	}{
		{name: "org id", data: `{"orgId":"org-1","itemMetaId":"m"}`, want: "org-1"},
		{name: "missing", data: `{"itemMetaId":"m"}`, want: ""},
		{name: "non string", data: `{"orgId":42}`, want: ""},
		{name: "empty document", data: ``, want: ""},
		{name: "invalid document", data: `{`, want: ""},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := OrgIDFromData(json.RawMessage(testCase.data)); got != testCase.want {
				t.Fatalf("OrgIDFromData(%s) = %q, want %q", testCase.data, got, testCase.want)
			}
		})
	}
}

// TestKeys pins the physical key layout BullMQ 5.63.2 writes.
func TestKeys(t *testing.T) {
	keys := NewKeys("", "itemPipeline")
	if keys.Prefix != Prefix || keys.Base != "bull:itemPipeline:" {
		t.Fatalf("NewKeys default prefix = %q/%q", keys.Prefix, keys.Base)
	}
	if got := keys.Job("42"); got != "bull:itemPipeline:42" {
		t.Fatalf("Job = %q", got)
	}
	if got := keys.Logs("42"); got != "bull:itemPipeline:42:logs" {
		t.Fatalf("Logs = %q", got)
	}
	if keys.Wait != "bull:itemPipeline:wait" || keys.Events != "bull:itemPipeline:events" {
		t.Fatalf("unexpected derived keys: %+v", keys)
	}
	custom := NewKeys("custom", "alerts")
	if got := custom.Meta; got != "custom:alerts:meta" {
		t.Fatalf("custom Meta = %q", got)
	}
}

// TestDecodeHelpers covers the numeric/JSON coercions that mirror parseInt and
// JSON.parse in Job.fromJSON.
func TestDecodeHelpers(t *testing.T) {
	if got := int64Value("1729512345678"); got != 1729512345678 {
		t.Fatalf("int64Value = %d", got)
	}
	if got := int64Value(""); got != 0 {
		t.Fatalf("int64Value empty = %d", got)
	}
	if got := int64Value("abc"); got != 0 {
		t.Fatalf("int64Value malformed = %d", got)
	}
	if got := millisPointer(""); got != nil {
		t.Fatalf("millisPointer empty = %v", got)
	}
	if got := millisPointer("1000"); got == nil || *got != 1000 {
		t.Fatalf("millisPointer = %v", got)
	}
	if got := stringArray(`["a","b"]`); len(got) != 2 || got[1] != "b" {
		t.Fatalf("stringArray = %v", got)
	}
	if got := stringArray(`{"not":"array"}`); got != nil {
		t.Fatalf("stringArray object = %v", got)
	}
	if got := rawJSON(`{"a":1}`); string(got) != `{"a":1}` {
		t.Fatalf("rawJSON object = %s", got)
	}
	if got := rawJSON(`not json`); string(got) != `"not json"` {
		t.Fatalf("rawJSON invalid = %s", got)
	}
	if got := stringValue([]interface{}{nil}, 0); got != "" {
		t.Fatalf("stringValue nil = %q", got)
	}
	if got := stringValue([]interface{}{nil}, 3); got != "" {
		t.Fatalf("stringValue out of range = %q", got)
	}
	if got := stringValue([]interface{}{int64(7)}, 0); got != "7" {
		t.Fatalf("stringValue int64 = %q", got)
	}
}

// TestJobOptionsKeepsRetention checks the retention flags derived from a stored
// opts document, including the two shapes itemPipeline producers write.
func TestJobOptionsKeepsRetention(t *testing.T) {
	producer := &Job{Opts: json.RawMessage(`{"jobId":"m-r","removeOnComplete":true,"removeOnFail":{"age":604800,"count":10000},"attempts":5}`)}
	if producer.KeepCompleted() {
		t.Fatal("itemPipeline producer removes completed jobs; KeepCompleted must be false")
	}
	if !producer.KeepFailed() {
		t.Fatal("itemPipeline producer retains failed jobs; KeepFailed must be true")
	}
	if got := producer.Options().Attempts; got != 5 {
		t.Fatalf("Options().Attempts = %d", got)
	}
	malformed := &Job{Opts: json.RawMessage(`{`)}
	if !malformed.KeepCompleted() || !malformed.KeepFailed() {
		t.Fatal("a malformed opts document must fall back to keeping finished jobs")
	}
	if nilJob := (*Job)(nil); !nilJob.KeepCompleted() {
		t.Fatal("nil job must keep finished jobs")
	}
}
