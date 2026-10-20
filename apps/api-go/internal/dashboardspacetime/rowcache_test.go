package dashboardspacetime

import (
	"context"
	"errors"
	"strconv"
	"sync/atomic"
	"testing"
	"time"
)

// countingArticles records how many times the heatmap row query would run.
type countingArticles struct {
	calls atomic.Int32
	rows  []geoRow
	err   error
}

func (c *countingArticles) Geo(context.Context, string, time.Time, time.Time, string) ([]geoRow, error) {
	c.calls.Add(1)
	if c.err != nil {
		return nil, c.err
	}
	return c.rows, nil
}

func (c *countingArticles) Propagation(context.Context, string, string, time.Time, time.Time) ([]propRow, error) {
	return nil, nil
}

func heatRows() []geoRow {
	at := time.Date(2026, 3, 10, 8, 0, 0, 0, time.UTC)
	return []geoRow{{ID: "pa-ua", Location: "Ukraine", EventAt: &at}}
}

// A dashboard polls the heatmap from the chart and from the SSE stream; both
// must share one row read inside the ten second window Nest uses.
func TestHeatmapSharesRowReadWithinTTL(t *testing.T) {
	articles := &countingArticles{rows: heatRows()}
	current := time.Date(2026, 3, 15, 12, 0, 0, 0, time.UTC)
	svc := &Service{articles: articles, rows: newGeoRowsCache(), now: func() time.Time { return current }}
	start := time.Date(2026, 3, 1, 0, 0, 0, 0, time.UTC)
	end := time.Date(2026, 3, 15, 23, 59, 59, 999000000, time.UTC)

	heat := func() {
		t.Helper()
		if _, err := svc.Heatmap(context.Background(), "org-a", start, end, "", false); err != nil {
			t.Fatalf("heatmap: %v", err)
		}
	}
	for round := 0; round < 3; round++ {
		heat()
	}
	if got := articles.calls.Load(); got != 1 {
		t.Fatalf("row reads inside the window = %d, want 1", got)
	}

	current = current.Add(sharedQueryTTL - time.Millisecond)
	heat()
	if got := articles.calls.Load(); got != 1 {
		t.Fatalf("read refreshed before the window ended: %d", got)
	}

	current = current.Add(2 * time.Millisecond)
	heat()
	if got := articles.calls.Load(); got != 2 {
		t.Fatalf("row reads after the window = %d, want 2", got)
	}
}

func TestHeatmapCacheKeepsTenantsAndEventsApart(t *testing.T) {
	articles := &countingArticles{rows: heatRows()}
	fixed := time.Date(2026, 3, 15, 12, 0, 0, 0, time.UTC)
	svc := &Service{articles: articles, rows: newGeoRowsCache(), now: func() time.Time { return fixed }}
	start := time.Date(2026, 3, 1, 0, 0, 0, 0, time.UTC)
	end := time.Date(2026, 3, 15, 23, 59, 59, 999000000, time.UTC)

	for _, call := range []struct {
		orgID   string
		eventID string
	}{{"org-a", ""}, {"org-b", ""}, {"org-a", "evt-1"}} {
		if _, err := svc.Heatmap(context.Background(), call.orgID, start, end, call.eventID, false); err != nil {
			t.Fatalf("heatmap %+v: %v", call, err)
		}
	}
	if got := articles.calls.Load(); got != 3 {
		t.Fatalf("distinct org/event keys shared a read: %d calls, want 3", got)
	}
	if got := svc.rows.size(); got != 3 {
		t.Fatalf("cache entries = %d, want 3", got)
	}
}

func TestHeatmapDoesNotCacheFailures(t *testing.T) {
	articles := &countingArticles{err: errors.New("mysql down")}
	fixed := time.Date(2026, 3, 15, 12, 0, 0, 0, time.UTC)
	svc := &Service{articles: articles, rows: newGeoRowsCache(), now: func() time.Time { return fixed }}
	start := time.Date(2026, 3, 1, 0, 0, 0, 0, time.UTC)
	end := time.Date(2026, 3, 15, 23, 59, 59, 999000000, time.UTC)

	if _, err := svc.Heatmap(context.Background(), "org-a", start, end, "", false); err == nil {
		t.Fatal("expected the read error to surface")
	}
	if got := svc.rows.size(); got != 0 {
		t.Fatalf("failed read was memoized: %d entries", got)
	}
	articles.err = nil
	articles.rows = heatRows()
	if _, err := svc.Heatmap(context.Background(), "org-a", start, end, "", false); err != nil {
		t.Fatalf("retry after failure: %v", err)
	}
	if got := articles.calls.Load(); got != 2 {
		t.Fatalf("calls = %d, want a retry", got)
	}
}

func TestRowsCacheCapsEntries(t *testing.T) {
	cache := newGeoRowsCache()
	now := time.Date(2026, 3, 15, 12, 0, 0, 0, time.UTC)
	for index := 0; index < maxCachedRowSets+5; index++ {
		key := "org-" + strconv.Itoa(index)
		if _, err := cache.load(context.Background(), key, now, func(context.Context) ([]geoRow, error) {
			return nil, nil
		}); err != nil {
			t.Fatal(err)
		}
	}
	if cache.size() > maxCachedRowSets {
		t.Fatalf("cache grew to %d entries, cap is %d", cache.size(), maxCachedRowSets)
	}
}

// A shared read that is still running must not be pruned, otherwise two callers
// could run the same query.
func TestRowsCacheKeepsInFlightEntries(t *testing.T) {
	cache := newGeoRowsCache()
	now := time.Date(2026, 3, 15, 12, 0, 0, 0, time.UTC)
	release := make(chan struct{})
	started := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		_, _ = cache.load(context.Background(), "org-a", now, func(context.Context) ([]geoRow, error) {
			close(started)
			<-release
			return heatRows(), nil
		})
	}()
	<-started
	if _, err := cache.load(context.Background(), "org-b", now.Add(sharedQueryTTL), func(context.Context) ([]geoRow, error) {
		return nil, nil
	}); err != nil {
		t.Fatal(err)
	}
	close(release)
	<-done
	if got := cache.size(); got > maxCachedRowSets {
		t.Fatalf("cache entries = %d", got)
	}
	if _, err := cache.load(context.Background(), "org-a", now, func(context.Context) ([]geoRow, error) {
		t.Fatal("pruned in-flight entry forced a duplicate read")
		return nil, nil
	}); err != nil {
		t.Fatal(err)
	}
}
