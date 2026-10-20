package classificationreviewseed

import "testing"

// TestProcessedItemIDPrecedence pins the id -> _id -> processedItemId order and
// the trim/empty rules from readProcessedItemId.
func TestProcessedItemIDPrecedence(t *testing.T) {
	cases := []struct {
		name string
		data string
		want string
	}{
		{"id wins", `{"id":"pid-1","_id":"pid-2","processedItemId":"pid-3"}`, "pid-1"},
		{"_id second", `{"id":"","_id":"pid-2","processedItemId":"pid-3"}`, "pid-2"},
		{"processedItemId third", `{"id":"   ","_id":null,"processedItemId":"pid-3"}`, "pid-3"},
		{"trims whitespace", `{"id":"  pid-1  "}`, "pid-1"},
		{"non-string skipped", `{"id":123,"_id":{"$oid":"x"},"processedItemId":"pid-3"}`, "pid-3"},
		{"null skipped", `{"id":null,"processedItemId":"pid-3"}`, "pid-3"},
		{"no candidates", `{"title":"x"}`, ""},
		{"wrapped returnvalue", `{"returnvalue":{"id":"pid-1"}}`, ""},
		{"array rejected", `["pid-1"]`, ""},
		{"scalar rejected", `"pid-1"`, ""},
		{"invalid json", `{`, ""},
		{"empty", ``, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := ProcessedItemID([]byte(tc.data)); got != tc.want {
				t.Fatalf("ProcessedItemID(%s) = %q, want %q", tc.data, got, tc.want)
			}
		})
	}
}

// TestReviewSeedJobID pins the shared id/name format.
func TestReviewSeedJobID(t *testing.T) {
	got := ReviewSeedJobID("org-1", "pid-1")
	want := "classification-quality-review-seed-item:org-1:pid-1"
	if got != want {
		t.Fatalf("job id = %q, want %q", got, want)
	}
	if ReviewSeedJobPrefix != "classification-quality-review-seed-item:" {
		t.Fatalf("prefix = %q", ReviewSeedJobPrefix)
	}
}

// TestTraceIDShape pins ensureTraceId(undefined): 32 lowercase hex characters.
func TestTraceIDShape(t *testing.T) {
	first := randomTraceID()
	second := randomTraceID()
	if len(first) != 32 {
		t.Fatalf("trace id length = %d", len(first))
	}
	for _, r := range first {
		if !((r >= '0' && r <= '9') || (r >= 'a' && r <= 'f')) {
			t.Fatalf("trace id %q is not lowercase hex", first)
		}
	}
	if first == second {
		t.Fatal("trace ids must not repeat")
	}
}
