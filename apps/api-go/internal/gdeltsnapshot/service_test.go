package gdeltsnapshot

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

// samplePayload builds a stored snapshot fixture with one politics headline.
func samplePayload(generatedAt, expiresAt string) *Payload {
	headlines := emptyHeadlinesByCategory()
	headlines.Politics = []Headline{{
		ID: "gdelt:https://example.com/x", Title: "Sample", Link: "https://example.com/x",
		Source: "example.com", Timestamp: 1700000000000, Category: CategoryPolitics,
		Origin: "gdelt",
	}}
	states := emptyCategoryStates()
	states.Politics = CategoryState{Status: categoryStatusFresh, ArticleCount: 1, ContentGeneratedAt: &generatedAt}
	return &Payload{
		Source:              sourceName,
		Scope:               scope,
		VariantKey:          variantKey,
		Status:              StatusCompleted,
		GeneratedAt:         generatedAt,
		ExpiresAt:           expiresAt,
		Warnings:            []Warning{},
		Diagnostics:         Diagnostics{RequestedCategories: 6, FetchedCategories: []Category{CategoryPolitics}, ReusedCategories: []Category{}, FailedCategories: []Category{}, TotalHeadlines: 1},
		CategoryStates:      states,
		HeadlinesByCategory: headlines,
	}
}

func mustMarshal(t *testing.T, payload *Payload) string {
	t.Helper()
	encoded, err := marshalJSON(payload)
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	return string(encoded)
}

// TestReadSnapshotCachePrecedence covers fresh cache, stale cache and the
// database fallback with its cache refill.
func TestReadSnapshotCachePrecedence(t *testing.T) {
	ctx := context.Background()

	t.Run("fresh cache wins", func(t *testing.T) {
		rig := newTestRig(t, rigOptions{enabled: true, responses: allCategoriesArticles()})
		rig.cache.seed(freshCacheKey, mustMarshal(t, samplePayload("2026-10-20T12:34:00.000Z", "2026-10-20T12:54:00.000Z")))
		rig.cache.seed(staleCacheKey, mustMarshal(t, samplePayload("2026-10-20T11:00:00.000Z", "2026-10-20T11:20:00.000Z")))
		result, err := rig.service.readSnapshot(ctx)
		if err != nil {
			t.Fatalf("readSnapshot: %v", err)
		}
		if result.payload == nil || result.payload.GeneratedAt != "2026-10-20T12:34:00.000Z" {
			t.Errorf("payload = %+v, want the fresh entry", result.payload)
		}
		if result.stale {
			t.Error("stale = true, want false")
		}
	})

	t.Run("expired fresh cache is still returned and marked stale", func(t *testing.T) {
		rig := newTestRig(t, rigOptions{enabled: true, responses: allCategoriesArticles()})
		rig.cache.seed(freshCacheKey, mustMarshal(t, samplePayload("2026-10-20T11:00:00.000Z", "2026-10-20T11:20:00.000Z")))
		rig.cache.seed(staleCacheKey, mustMarshal(t, samplePayload("2026-10-20T10:00:00.000Z", "2026-10-20T10:20:00.000Z")))
		result, err := rig.service.readSnapshot(ctx)
		if err != nil {
			t.Fatalf("readSnapshot: %v", err)
		}
		// The fresh entry is what CacheService returns first; the staleness flag
		// reports that the payload itself has expired.
		if result.payload == nil || !result.stale {
			t.Errorf("result = %+v, want the fresh entry marked stale", result)
		}
	})

	t.Run("empty fresh value falls through to stale", func(t *testing.T) {
		rig := newTestRig(t, rigOptions{enabled: true, responses: allCategoriesArticles()})
		rig.cache.seed(freshCacheKey, "")
		rig.cache.seed(staleCacheKey, mustMarshal(t, samplePayload("2026-10-20T12:34:00.000Z", "2026-10-20T12:54:00.000Z")))
		result, err := rig.service.readSnapshot(ctx)
		if err != nil {
			t.Fatalf("readSnapshot: %v", err)
		}
		if result.payload == nil || result.payload.GeneratedAt != "2026-10-20T12:34:00.000Z" || result.stale {
			t.Errorf("result = %+v, want the stale entry", result)
		}
	})

	t.Run("corrupted fresh cache is an error", func(t *testing.T) {
		rig := newTestRig(t, rigOptions{enabled: true, responses: allCategoriesArticles()})
		rig.cache.seed(freshCacheKey, "not json")
		if _, err := rig.service.readSnapshot(ctx); err == nil {
			t.Fatal("readSnapshot error = nil, want the JSON.parse failure")
		}
	})

	t.Run("database fallback refills both layers", func(t *testing.T) {
		rig := newTestRig(t, rigOptions{enabled: true, responses: allCategoriesArticles()})
		payload := samplePayload("2026-10-20T12:34:00.000Z", "2026-10-20T12:54:00.000Z")
		rig.store.payload = []byte(mustMarshal(t, payload))
		rig.store.found = true
		result, err := rig.service.readSnapshot(ctx)
		if err != nil {
			t.Fatalf("readSnapshot: %v", err)
		}
		if result.payload == nil || result.payload.GeneratedAt != payload.GeneratedAt || result.stale {
			t.Errorf("result = %+v", result)
		}
		if _, ok := rig.cache.written(freshCacheKey); !ok {
			t.Error("fresh cache was not refilled")
		}
		if _, ok := rig.cache.written(staleCacheKey); !ok {
			t.Error("stale cache was not refilled")
		}
	})

	t.Run("expired database payload refills only the stale layer", func(t *testing.T) {
		rig := newTestRig(t, rigOptions{enabled: true, responses: allCategoriesArticles()})
		payload := samplePayload("2026-10-20T11:00:00.000Z", "2026-10-20T11:20:00.000Z")
		rig.store.payload = []byte(mustMarshal(t, payload))
		rig.store.found = true
		result, err := rig.service.readSnapshot(ctx)
		if err != nil {
			t.Fatalf("readSnapshot: %v", err)
		}
		if !result.stale {
			t.Error("stale = false, want true")
		}
		if _, ok := rig.cache.written(freshCacheKey); ok {
			t.Error("fresh cache was refilled with an expired payload")
		}
		if _, ok := rig.cache.written(staleCacheKey); !ok {
			t.Error("stale cache was not refilled")
		}
	})

	t.Run("no snapshot anywhere", func(t *testing.T) {
		rig := newTestRig(t, rigOptions{enabled: true, responses: allCategoriesArticles()})
		result, err := rig.service.readSnapshot(ctx)
		if err != nil {
			t.Fatalf("readSnapshot: %v", err)
		}
		if result.payload != nil || result.stale {
			t.Errorf("result = %+v, want an empty result", result)
		}
	})

	t.Run("unusable database payload is a miss", func(t *testing.T) {
		rig := newTestRig(t, rigOptions{enabled: true, responses: allCategoriesArticles()})
		rig.store.payload = []byte(`{"status":"partial"}`)
		rig.store.found = true
		result, err := rig.service.readSnapshot(ctx)
		if err != nil {
			t.Fatalf("readSnapshot: %v", err)
		}
		if result.payload != nil {
			t.Errorf("payload = %+v, want nil", result.payload)
		}
	})
}

// TestForceRefreshPaths covers the disabled short circuit, the busy-lease
// fallback and the rebuild path.
func TestForceRefreshPaths(t *testing.T) {
	ctx := context.Background()

	t.Run("disabled", func(t *testing.T) {
		rig := newTestRig(t, rigOptions{enabled: false, responses: allCategoriesArticles()})
		summary, err := rig.service.ForceRefresh(ctx)
		if err != nil {
			t.Fatalf("ForceRefresh: %v", err)
		}
		if summary.Enabled || summary.Status != "disabled" || summary.NextScheduledAt != nil {
			t.Errorf("summary = %+v", summary)
		}
		if rig.lock.calls != 0 || rig.stub.requestCount() != 0 {
			t.Error("disabled force refresh touched the lock or GDELT")
		}
	})

	t.Run("busy lease returns the current snapshot", func(t *testing.T) {
		rig := newTestRig(t, rigOptions{enabled: true, responses: allCategoriesArticles()})
		rig.lock.acquired = false
		payload := samplePayload("2026-10-20T11:00:00.000Z", "2026-10-20T11:20:00.000Z")
		rig.cache.seed(staleCacheKey, mustMarshal(t, payload))
		summary, err := rig.service.ForceRefresh(ctx)
		if err != nil {
			t.Fatalf("ForceRefresh: %v", err)
		}
		if summary.Status != string(StatusCompleted) || !summary.Stale {
			t.Errorf("summary = %+v, want the stale current snapshot", summary)
		}
		if len(rig.store.rows) != 0 {
			t.Error("busy force refresh rebuilt the snapshot")
		}
	})

	t.Run("rebuild", func(t *testing.T) {
		rig := newTestRig(t, rigOptions{enabled: true, responses: allCategoriesArticles()})
		summary, err := rig.service.ForceRefresh(ctx)
		if err != nil {
			t.Fatalf("ForceRefresh: %v", err)
		}
		if summary.Status != string(StatusCompleted) || summary.Stale || !summary.Enabled {
			t.Errorf("summary = %+v", summary)
		}
		if len(rig.store.rows) != 1 {
			t.Errorf("rows = %d, want 1", len(rig.store.rows))
		}
		if rig.lock.lastKey != refreshLockKey {
			t.Errorf("lock key = %q", rig.lock.lastKey)
		}
	})

	t.Run("rebuild failure propagates", func(t *testing.T) {
		rig := newTestRig(t, rigOptions{enabled: true, responses: allCategoriesArticles()})
		rig.store.insertErr = errors.New("insert failed")
		if _, err := rig.service.ForceRefresh(ctx); err == nil {
			t.Fatal("ForceRefresh error = nil, want the write failure")
		}
	})

	t.Run("status metric failure propagates", func(t *testing.T) {
		rig := newTestRig(t, rigOptions{enabled: true, responses: allCategoriesArticles()})
		rig.store.aggregateErr = errors.New("query failed")
		if _, err := rig.service.ForceRefresh(ctx); err == nil {
			t.Fatal("ForceRefresh error = nil, want the metrics failure")
		}
	})
}

// referenceRow is one stored snapshot as the reference metrics computation sees
// it.
type referenceRow struct {
	status      Status
	payload     []byte
	generatedAt time.Time
}

// referenceAggregates is the payload-based reference for the projected SQL
// aggregate: it decodes every payload exactly like loadStatusMetrics does and
// derives the same counters. snapshot_integration_test.go compares this
// reference with the real SQL projection over the same rows.
func referenceAggregates(rows []referenceRow) aggregateRow {
	var aggregate aggregateRow
	for _, row := range rows {
		aggregate.RecentCount++
		if row.status == StatusCompleted {
			aggregate.CompletedCount++
			if aggregate.LastFullSuccessAt == nil {
				at := row.generatedAt
				aggregate.LastFullSuccessAt = &at
			}
		}
		if row.status == StatusPartial || row.status == StatusFailed {
			if aggregate.LastNonSuccessAt == nil {
				at := row.generatedAt
				aggregate.LastNonSuccessAt = &at
			}
		}
		payload := normalizePayload(row.payload)
		if payload == nil {
			continue
		}
		aggregate.ValidPayloadCount++
		for _, warning := range payload.Warnings {
			if warning.Code == codeRateLimited {
				aggregate.RateLimitedCount++
				break
			}
		}
		for _, category := range Categories {
			if len(payload.HeadlinesByCategory.headlines(category)) > 0 {
				aggregate.AvailableCategorySum++
			}
		}
	}
	return aggregate
}

// TestReferenceAggregatesSemantics pins the reference counters, including the
// rows that must not contribute to the payload-derived metrics.
func TestReferenceAggregatesSemantics(t *testing.T) {
	generatedAt := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	rateLimited := samplePayload("2026-10-20T12:00:00.000Z", "2026-10-20T12:20:00.000Z")
	rateLimited.Status = StatusPartial
	rateLimited.Partial = true
	rateLimited.Warnings = []Warning{{Code: codeRateLimited, Severity: severityWarning, Message: "m"}}

	rows := []referenceRow{
		{status: StatusCompleted, generatedAt: generatedAt, payload: []byte(mustMarshal(t, samplePayload("2026-10-20T12:00:00.000Z", "2026-10-20T12:20:00.000Z")))},
		{status: StatusPartial, generatedAt: generatedAt.Add(-time.Minute), payload: []byte(mustMarshal(t, rateLimited))},
		// A payload without string timestamps is dropped from the
		// payload-derived counters but still counts as a recent record.
		{status: StatusPartial, generatedAt: generatedAt.Add(-2 * time.Minute), payload: []byte(`{"status":"partial"}`)},
	}
	aggregate := referenceAggregates(rows)
	if aggregate.RecentCount != 3 || aggregate.ValidPayloadCount != 2 {
		t.Errorf("recent/valid = %d/%d, want 3/2", aggregate.RecentCount, aggregate.ValidPayloadCount)
	}
	if aggregate.CompletedCount != 1 || aggregate.RateLimitedCount != 1 || aggregate.AvailableCategorySum != 2 {
		t.Errorf("aggregate = %+v", aggregate)
	}
	if aggregate.LastFullSuccessAt == nil || !aggregate.LastFullSuccessAt.Equal(generatedAt) {
		t.Errorf("lastFullSuccessAt = %v", aggregate.LastFullSuccessAt)
	}
	if aggregate.LastNonSuccessAt == nil || !aggregate.LastNonSuccessAt.Equal(generatedAt.Add(-time.Minute)) {
		t.Errorf("lastNonSuccessAt = %v", aggregate.LastNonSuccessAt)
	}
}

// TestRestoreCachesWritesOneMarshalledPayload keeps the cache and history JSON
// identical.
func TestRestoreCachesWritesOneMarshalledPayload(t *testing.T) {
	rig := newTestRig(t, rigOptions{enabled: true, responses: allCategoriesArticles()})
	payload := samplePayload("2026-10-20T12:34:00.000Z", "2026-10-20T12:54:00.000Z")
	if err := rig.service.restoreCaches(context.Background(), payload); err != nil {
		t.Fatalf("restoreCaches: %v", err)
	}
	want := mustMarshal(t, payload)
	for _, key := range []string{freshCacheKey, staleCacheKey} {
		value, ok := rig.cache.written(key)
		if !ok || value != want {
			t.Errorf("%s = %q, want the marshalled payload", key, value)
		}
	}
	if !strings.Contains(want, `"source":"scheduler"`) {
		t.Errorf("payload = %s", want)
	}
}
