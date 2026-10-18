package settingscrawl

import (
	"context"
	"fmt"
	"testing"
	"time"
)

// reviewedEvidence renders a reviewed evidence document for the queue filter.
func reviewedEvidence(status string) []byte {
	return []byte(fmt.Sprintf(`{"review":{"status":%q}}`, status))
}

// fakeCandidateSource mimics the keyset scan over an in-memory, already ordered
// row set, so the paging walk can be tested without a database.
type fakeCandidateSource struct {
	rows      []reviewCandidate
	calls     int
	pageSizes []int
}

func (f *fakeCandidateSource) fetch(_ context.Context, cursor *reviewQueueCursor, pageSize int) ([]reviewCandidate, error) {
	f.calls++
	f.pageSizes = append(f.pageSizes, pageSize)
	filtered := make([]reviewCandidate, 0, len(f.rows))
	for _, row := range f.rows {
		if cursor != nil && !(row.createdAt.Before(cursor.createdAt) ||
			(row.createdAt.Equal(cursor.createdAt) && row.id < cursor.id)) {
			continue
		}
		filtered = append(filtered, row)
	}
	if len(filtered) > pageSize {
		filtered = filtered[:pageSize]
	}
	return filtered, nil
}

// TestSelectReviewCandidateIDsSeesPastReviewedPrefix pins the GAP-KG-001 fix:
// more than one page worth of already reviewed rows must not hide the pending
// rows behind them, and the fixed page size is a page size, not a total scan
// cap.
func TestSelectReviewCandidateIDsSeesPastReviewedPrefix(t *testing.T) {
	base := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	source := &fakeCandidateSource{}
	const reviewed = 520
	for i := 0; i < reviewed; i++ {
		source.rows = append(source.rows, reviewCandidate{
			id:        fmt.Sprintf("reviewed-%04d", reviewed-i),
			createdAt: base.Add(-time.Duration(i) * time.Millisecond),
			evidence:  reviewedEvidence("approved"),
		})
	}
	for i := 0; i < 3; i++ {
		source.rows = append(source.rows, reviewCandidate{
			id:        fmt.Sprintf("pending-%d", i),
			createdAt: base.Add(-time.Duration(reviewed+i) * time.Millisecond),
			evidence:  []byte(`{"extractor":"v1"}`),
		})
	}

	selected, err := selectReviewCandidateIDs(context.Background(), source.fetch, 2, true, 200)
	if err != nil {
		t.Fatal(err)
	}
	if len(selected) != 2 || selected[0] != "pending-0" || selected[1] != "pending-1" {
		t.Fatalf("selected = %v", selected)
	}
	if source.calls < 3 {
		t.Fatalf("scan stopped after %d pages; it must keep walking", source.calls)
	}
	for _, size := range source.pageSizes {
		if size != 200 {
			t.Fatalf("page size = %d", size)
		}
	}
}

// TestSelectReviewCandidateIDsAdvancesCursorOnSameTimestamp pins the
// (createdAt, id) key order: rows created in the same millisecond must still
// advance the cursor by id and must not be re-read.
func TestSelectReviewCandidateIDsAdvancesCursorOnSameTimestamp(t *testing.T) {
	created := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	source := &fakeCandidateSource{rows: []reviewCandidate{
		{id: "d", createdAt: created, evidence: []byte(`{}`)},
		{id: "c", createdAt: created, evidence: reviewedEvidence("rejected")},
		{id: "b", createdAt: created, evidence: []byte(`{}`)},
		{id: "a", createdAt: created, evidence: reviewedEvidence("corrected")},
	}}

	selected, err := selectReviewCandidateIDs(context.Background(), source.fetch, 2, true, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(selected) != 2 || selected[0] != "d" || selected[1] != "b" {
		t.Fatalf("selected = %v", selected)
	}
	if source.calls != 3 {
		t.Fatalf("pages = %d want 3", source.calls)
	}
}

// TestSelectReviewCandidateIDsHonoursLimitWhenIncludingReviewed pins that
// onlyUnreviewed=false still returns a limited, ordered slice.
func TestSelectReviewCandidateIDsHonoursLimitWhenIncludingReviewed(t *testing.T) {
	created := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	source := &fakeCandidateSource{rows: []reviewCandidate{
		{id: "c", createdAt: created, evidence: reviewedEvidence("approved")},
		{id: "b", createdAt: created, evidence: reviewedEvidence("rejected")},
		{id: "a", createdAt: created, evidence: []byte(`{}`)},
	}}

	selected, err := selectReviewCandidateIDs(context.Background(), source.fetch, 2, false, 50)
	if err != nil {
		t.Fatal(err)
	}
	if len(selected) != 2 || selected[0] != "c" || selected[1] != "b" {
		t.Fatalf("selected = %v", selected)
	}
	if source.calls != 1 {
		t.Fatalf("pages = %d want 1", source.calls)
	}
}

func TestIsReviewedEvidenceOnlyAcceptsTheThreeLiterals(t *testing.T) {
	cases := map[string]bool{
		`{"review":{"status":"approved"}}`:   true,
		`{"review":{"status":" rejected "}}`: true,
		`{"review":{"status":"corrected"}}`:  true,
		`{"review":{"status":"pending"}}`:    false,
		`{"review":{"status":""}}`:           false,
		`{"review":{"status":3}}`:            false,
		`{"review":null}`:                    false,
		`{"review":[]}`:                      false,
		`[]`:                                 false,
		`null`:                               false,
		``:                                   false,
		`not json`:                           false,
	}
	for raw, want := range cases {
		if got := isReviewedEvidence([]byte(raw)); got != want {
			t.Fatalf("isReviewedEvidence(%s) = %v want %v", raw, got, want)
		}
	}
}

func TestReviewQueuePageSizeIsAPageNotATotalCap(t *testing.T) {
	cases := map[int]int{1: 50, 10: 50, 50: 200, 125: 500, 200: 500}
	for limit, want := range cases {
		if got := reviewQueuePageSize(limit); got != want {
			t.Fatalf("reviewQueuePageSize(%d) = %d want %d", limit, got, want)
		}
	}
}
