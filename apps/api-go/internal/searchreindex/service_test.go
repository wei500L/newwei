package searchreindex

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// TestIsoTimestampMatchesJavaScriptToISOString pins the response timestamp
// format to Date.toISOString(): UTC with millisecond precision and a Z suffix.
func TestIsoTimestampMatchesJavaScriptToISOString(t *testing.T) {
	cases := []struct {
		name string
		when time.Time
		want string
	}{
		{
			name: "whole second",
			when: time.Date(2026, time.April, 18, 2, 49, 27, 0, time.UTC),
			want: "2026-04-18T02:49:27.000Z",
		},
		{
			name: "milliseconds",
			when: time.Date(2026, time.April, 18, 2, 49, 27, 123_000_000, time.UTC),
			want: "2026-04-18T02:49:27.123Z",
		},
		{
			name: "non utc offset is converted",
			when: time.Date(2026, time.April, 18, 5, 49, 27, 0, time.FixedZone("UTC+3", 3*60*60)),
			want: "2026-04-18T02:49:27.000Z",
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := isoTimestamp(testCase.when); got != testCase.want {
				t.Fatalf("isoTimestamp() = %q, want %q", got, testCase.want)
			}
		})
	}
}

// TestBuildSearchDocumentKeepsNullAndEmptyArraySemantics guards the existing
// index document shape: null arrays become empty arrays, null text stays null
// and a null searchText becomes an empty string.
func TestBuildSearchDocumentKeepsNullAndEmptyArraySemantics(t *testing.T) {
	sourceName := "Wire"
	document, err := buildSearchDocument(itemReadModelDocument{
		OrgID:      "org-1",
		ItemMetaID: "item-1",
		Title:      "title",
		ExternalID: "external-1",
		SourceName: &sourceName,
		SearchText: nil,
		SortAt:     time.Date(2026, time.April, 18, 0, 0, 0, 0, time.UTC),
		CreatedAt:  time.Date(2026, time.April, 17, 12, 0, 0, 0, time.UTC),
	})
	if err != nil {
		t.Fatal(err)
	}
	if document.Topics == nil || document.Entities == nil {
		t.Fatal("null arrays must serialize as empty arrays")
	}
	if document.Summary != nil || document.Region != nil {
		t.Fatal("null text fields must stay null")
	}
	if document.SearchText != "" {
		t.Fatalf("searchText = %q, want empty string", document.SearchText)
	}
	if document.SortAt != "2026-04-18T00:00:00.000Z" || document.CreatedAt != "2026-04-17T12:00:00.000Z" {
		t.Fatalf("dates = %q / %q, want valid UTC ISO strings", document.SortAt, document.CreatedAt)
	}
	payload, err := json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`"topics":[]`, `"entities":[]`, `"summary":null`, `"sourceName":"Wire"`, `"searchText":""`} {
		if !bytes.Contains(payload, []byte(want)) {
			t.Fatalf("payload %s is missing %s", payload, want)
		}
	}
}

// TestBuildSearchDocumentRejectsMissingDates keeps invalid dates out of the
// index instead of writing a zero timestamp.
func TestBuildSearchDocumentRejectsMissingDates(t *testing.T) {
	if _, err := buildSearchDocument(itemReadModelDocument{ItemMetaID: "item-1"}); err == nil {
		t.Fatal("a missing sortAt must fail the document")
	}
	if _, err := buildSearchDocument(itemReadModelDocument{
		ItemMetaID: "item-1",
		SortAt:     time.Date(2026, time.April, 18, 0, 0, 0, 0, time.UTC),
	}); err == nil {
		t.Fatal("a missing createdAt must fail the document")
	}
}

// TestJobJSONShapeMatchesNestJSKeyOrder pins the Redis and response JSON shape:
// the error field is appended last and omitted for a completed job.
func TestJobJSONShapeMatchesNestJSKeyOrder(t *testing.T) {
	failed, err := json.Marshal(Job{
		ID:        "job-1",
		OrgID:     "org-1",
		Status:    JobStatusFailed,
		Indexed:   3,
		CreatedAt: "2026-04-18T02:49:27.000Z",
		UpdatedAt: "2026-04-18T02:50:27.000Z",
		Error:     "boom",
	})
	if err != nil {
		t.Fatal(err)
	}
	wantFailed := `{"id":"job-1","orgId":"org-1","status":"failed","indexed":3,` +
		`"createdAt":"2026-04-18T02:49:27.000Z","updatedAt":"2026-04-18T02:50:27.000Z","error":"boom"}`
	if string(failed) != wantFailed {
		t.Fatalf("failed job JSON = %s, want %s", failed, wantFailed)
	}
	completed, err := json.Marshal(Job{
		ID:        "job-1",
		OrgID:     "org-1",
		Status:    JobStatusCompleted,
		Indexed:   5,
		CreatedAt: "2026-04-18T02:49:27.000Z",
		UpdatedAt: "2026-04-18T02:51:27.000Z",
	})
	if err != nil {
		t.Fatal(err)
	}
	wantCompleted := `{"id":"job-1","orgId":"org-1","status":"completed","indexed":5,` +
		`"createdAt":"2026-04-18T02:49:27.000Z","updatedAt":"2026-04-18T02:51:27.000Z"}`
	if string(completed) != wantCompleted {
		t.Fatalf("completed job JSON = %s, want %s", completed, wantCompleted)
	}
}

// TestNewJobIDIsUUIDVersion4 keeps the id shape of the NestJS randomUUID call.
func TestNewJobIDIsUUIDVersion4(t *testing.T) {
	id, err := newJobID()
	if err != nil {
		t.Fatal(err)
	}
	if len(id) != 36 || strings.Count(id, "-") != 4 {
		t.Fatalf("id = %q, want a 36 character UUID", id)
	}
	if id[14] != '4' {
		t.Fatalf("id = %q, want version 4", id)
	}
	if !strings.ContainsRune("89ab", rune(id[19])) {
		t.Fatalf("id = %q, want an RFC 4122 variant", id)
	}
}

// TestBulkFailureErrorNamesTheItem documents the job error content: itemMetaId,
// error type and a short reason, with no credentials or document body.
func TestBulkFailureErrorNamesTheItem(t *testing.T) {
	err := bulkFailureError([]bulkFailure{{
		itemMetaID: "item-9",
		errorType:  "mapper_parsing_exception",
		reason:     "failed to parse field [sortAt]",
	}})
	message := err.Error()
	for _, want := range []string{"itemMetaId=item-9", "mapper_parsing_exception", "failed to parse field [sortAt]"} {
		if !strings.Contains(message, want) {
			t.Fatalf("message %q is missing %q", message, want)
		}
	}
}

// TestTruncateTextCollapsesWhitespace keeps the sanitized reason on one line.
func TestTruncateTextCollapsesWhitespace(t *testing.T) {
	if got := truncateText("a\n  b\tc", 40); got != "a b c" {
		t.Fatalf("truncateText() = %q, want %q", got, "a b c")
	}
	got := truncateText(strings.Repeat("x", 10), 4)
	if got != "xxxx..." {
		t.Fatalf("truncateText() = %q, want %q", got, "xxxx...")
	}
}
