package archivepreparationworker

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/archivereading"
	"github.com/wei500L/newwei/apps/api-go/internal/litellmcompat"
)

type fakeWorkerModel struct{}

func (fakeWorkerModel) RuntimeEmbeddingModel(context.Context) (litellmcompat.RuntimeModel, error) {
	return litellmcompat.RuntimeModel{}, nil
}
func (fakeWorkerModel) RuntimeRerankModel(context.Context) (litellmcompat.RuntimeModel, error) {
	return litellmcompat.RuntimeModel{}, nil
}
func (fakeWorkerModel) Completion(context.Context, litellmcompat.CompletionRequest) (litellmcompat.CompletionResponse, error) {
	return litellmcompat.CompletionResponse{}, errors.New("not used")
}
func (fakeWorkerModel) Embedding(context.Context, litellmcompat.EmbeddingRequest) (litellmcompat.EmbeddingResponse, error) {
	return litellmcompat.EmbeddingResponse{}, errors.New("not used")
}
func (fakeWorkerModel) Rerank(context.Context, litellmcompat.RerankRequest) (litellmcompat.RerankResponse, error) {
	return litellmcompat.RerankResponse{}, errors.New("not used")
}

type fakeCandidateReader struct {
	rows   []*archivereading.ArchiveRow
	cached map[string]bool
	calls  []*string
}

func (f *fakeCandidateReader) page(cursor *archivereading.Cursor, take int) []*archivereading.ArchiveRow {
	start := 0
	if cursor != nil {
		for index, row := range f.rows {
			if row.ID == cursor.ID {
				start = index + 1
				break
			}
		}
	}
	end := start + take
	if end > len(f.rows) {
		end = len(f.rows)
	}
	return f.rows[start:end]
}

func (f *fakeCandidateReader) note(cursor *archivereading.Cursor) {
	if cursor == nil {
		f.calls = append(f.calls, nil)
		return
	}
	id := cursor.ID
	f.calls = append(f.calls, &id)
}

func (f *fakeCandidateReader) RecentFirstBatch(_ context.Context, _ string, _ time.Time, take int) ([]*archivereading.ArchiveRow, error) {
	f.note(nil)
	return f.page(nil, take), nil
}

func (f *fakeCandidateReader) RecentBatch(_ context.Context, _ string, _ time.Time, cursor archivereading.Cursor, take int) ([]*archivereading.ArchiveRow, error) {
	f.note(&cursor)
	return f.page(&cursor, take), nil
}

func (f *fakeCandidateReader) RangeBatch(_ context.Context, _ string, _, _ archivereading.Cursor, cursor *archivereading.Cursor, take int) ([]*archivereading.ArchiveRow, error) {
	f.note(cursor)
	return f.page(cursor, take), nil
}

func (f *fakeCandidateReader) LoadCached(_ context.Context, _ string, lookups []archivereading.ClassificationLookup, _, _ *string) (map[string]archivereading.CachedClassification, error) {
	out := make(map[string]archivereading.CachedClassification, len(lookups))
	for _, lookup := range lookups {
		if f.cached[lookup.ProcessedArticleID] {
			out[lookup.ProcessedArticleID] = archivereading.CachedClassification{Fresh: true}
		}
	}
	return out, nil
}

func makeRows(count int) []*archivereading.ArchiveRow {
	rows := make([]*archivereading.ArchiveRow, 0, count)
	base := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	for index := 0; index < count; index++ {
		rows = append(rows, &archivereading.ArchiveRow{
			ID: fmt.Sprintf("r%03d", index), ProcessedAt: base.Add(-time.Duration(index) * time.Minute),
			Title: "title", ArticleID: "a", ArticleURL: "https://example.com",
		})
	}
	return rows
}

func TestSelectionCursorContinuesAcrossCalls(t *testing.T) {
	reader := &fakeCandidateReader{rows: makeRows(7), cached: map[string]bool{}}
	state := &selectionState{
		store: reader, models: fakeWorkerModel{}, orgID: "org", scope: "digest",
		anchor:  time.Date(2026, 10, 20, 23, 59, 59, 0, time.UTC),
		display: newTaskDisplay(nil),
	}
	var seen []string
	for round := 0; round < 10; round++ {
		rows, hasMore, err := state.Next(context.Background(), 2)
		if err != nil {
			t.Fatalf("next: %v", err)
		}
		for _, row := range rows {
			seen = append(seen, row.ID)
		}
		if len(rows) == 0 {
			break
		}
		if !hasMore && round < 3 {
			t.Fatalf("round %d unexpectedly finished", round)
		}
	}
	if len(seen) != 7 {
		t.Fatalf("seen = %v", seen)
	}
	unique := map[string]bool{}
	for _, id := range seen {
		if unique[id] {
			t.Fatalf("duplicate row %s in %v", id, seen)
		}
		unique[id] = true
	}
	if len(reader.calls) < 2 || reader.calls[1] == nil || *reader.calls[1] != "r001" {
		t.Fatalf("second page cursor = %v", reader.calls)
	}
}

func TestSelectionDigestScanBudgetIsTaskWide(t *testing.T) {
	rows := makeRows(maxBaseScan)
	cached := make(map[string]bool, len(rows))
	for _, row := range rows {
		cached[row.ID] = true
	}
	reader := &fakeCandidateReader{rows: rows, cached: cached}
	state := &selectionState{
		store: reader, models: fakeWorkerModel{}, orgID: "org", scope: "digest",
		anchor:  time.Date(2026, 10, 20, 23, 59, 59, 0, time.UTC),
		display: newTaskDisplay(nil),
	}
	selection, more, err := state.Next(context.Background(), 20)
	if err != nil {
		t.Fatalf("next: %v", err)
	}
	if len(selection) != 0 || more {
		t.Fatalf("selection = %d more=%v", len(selection), more)
	}
	if state.scanned != maxBaseScan {
		t.Fatalf("scanned = %d", state.scanned)
	}
	if len(reader.calls) != maxBaseScan/digestScanBatch {
		t.Fatalf("calls = %d", len(reader.calls))
	}
}

func TestResolveDigestAnchorUsesUTCDayEnd(t *testing.T) {
	now := time.Date(2026, 10, 20, 8, 30, 0, 0, time.FixedZone("MSK", 3*60*60))
	anchor, err := resolveDigestAnchor("", now)
	if err != nil {
		t.Fatalf("anchor: %v", err)
	}
	want := time.Date(2026, 10, 20, 23, 59, 59, 999*time.Millisecond, time.UTC)
	if !anchor.Equal(want) {
		t.Fatalf("anchor = %s, want %s", anchor, want)
	}
}

func TestResolveMonthRangeUsesUTCBounds(t *testing.T) {
	start, end, err := resolveMonthRange(" 2026-02 ")
	if err != nil {
		t.Fatalf("month: %v", err)
	}
	wantStart := time.Date(2026, 2, 1, 0, 0, 0, 0, time.UTC)
	wantEnd := time.Date(2026, 2, 28, 23, 59, 59, 999*time.Millisecond, time.UTC)
	if !start.ProcessedAt.Equal(wantStart) || !end.ProcessedAt.Equal(wantEnd) {
		t.Fatalf("range = %s .. %s", start.ProcessedAt, end.ProcessedAt)
	}
	if _, _, err := resolveMonthRange("2026-13"); err == nil {
		t.Fatal("month 13 must fail")
	}
}
