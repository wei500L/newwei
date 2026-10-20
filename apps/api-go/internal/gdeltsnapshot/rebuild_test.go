package gdeltsnapshot

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"
)

// seedPrevious stores a previous snapshot in the fresh cache layer so the
// rebuild has content to reuse.
func seedPrevious(t *testing.T, rig *testRig, payload *Payload) {
	t.Helper()
	encoded, err := marshalJSON(payload)
	if err != nil {
		t.Fatalf("marshal previous: %v", err)
	}
	rig.cache.seed(freshCacheKey, string(encoded))
}

func previousPayload(generatedAt, govContentGeneratedAt string, govHeadlines []Headline) *Payload {
	states := emptyCategoryStates()
	states.Gov = CategoryState{
		Status:             categoryStatusFresh,
		ArticleCount:       len(govHeadlines),
		ContentGeneratedAt: &govContentGeneratedAt,
	}
	headlines := emptyHeadlinesByCategory()
	headlines.Gov = govHeadlines
	return &Payload{
		Source:              sourceName,
		Scope:               scope,
		VariantKey:          variantKey,
		Status:              StatusPartial,
		GeneratedAt:         generatedAt,
		ExpiresAt:           generatedAt,
		Partial:             true,
		Warnings:            []Warning{},
		Diagnostics:         Diagnostics{RequestedCategories: 6, FetchedCategories: []Category{CategoryGov}, ReusedCategories: []Category{}, FailedCategories: []Category{}, TotalHeadlines: len(govHeadlines)},
		CategoryStates:      states,
		HeadlinesByCategory: headlines,
	}
}

// TestRebuildClassifiesCategoriesAndStatus drives one rebuild through all three
// category outcomes and checks the derived diagnostics, states, warnings and
// status.
func TestRebuildClassifiesCategoriesAndStatus(t *testing.T) {
	previousGov := Headline{ID: "gdelt:https://old.example.com/gov", Title: "Old gov", Link: "https://old.example.com/gov", Source: "old.example.com", Timestamp: 1, Category: CategoryGov, Origin: "gdelt"}
	responses := map[Category]gdeltStubResponse{
		CategoryPolitics: {status: http.StatusOK, body: articlesBody(article("politics-1", "Politics one", "p.example.com", "20261020T101112Z"))},
		CategoryTech:     {status: http.StatusTooManyRequests},
		CategoryFinance:  {status: http.StatusOK, body: `{"articles":[]}`},
		CategoryGov:      {status: http.StatusInternalServerError},
		CategoryAI:       {status: http.StatusOK, body: articlesBody(article("ai-1", "AI one", "ai.example.com", "20261020T101112Z"))},
		CategoryIntel:    {status: http.StatusOK, body: articlesBody(article("intel-1", "Intel one", "i.example.com", "20261020T101112Z"))},
	}
	rig := newTestRig(t, rigOptions{enabled: true, responses: responses, sleepRecords: true})
	seedPrevious(t, rig, previousPayload("2026-10-20T12:20:00.000Z", "2026-10-20T12:19:00.000Z", []Headline{previousGov}))

	payload, err := rig.service.rebuild(context.Background())
	if err != nil {
		t.Fatalf("rebuild: %v", err)
	}

	if payload.Status != StatusPartial || !payload.Partial {
		t.Errorf("status = %s partial = %v, want partial true", payload.Status, payload.Partial)
	}
	if payload.GeneratedAt != "2026-10-20T12:34:56.789Z" {
		t.Errorf("generatedAt = %q", payload.GeneratedAt)
	}
	if payload.ExpiresAt != "2026-10-20T12:54:56.789Z" {
		t.Errorf("expiresAt = %q", payload.ExpiresAt)
	}
	wantFetched := []Category{CategoryPolitics, CategoryAI, CategoryIntel}
	wantReused := []Category{CategoryGov}
	wantFailed := []Category{CategoryTech, CategoryFinance}
	if !equalCategories(payload.Diagnostics.FetchedCategories, wantFetched) {
		t.Errorf("fetched = %v, want %v", payload.Diagnostics.FetchedCategories, wantFetched)
	}
	if !equalCategories(payload.Diagnostics.ReusedCategories, wantReused) {
		t.Errorf("reused = %v, want %v", payload.Diagnostics.ReusedCategories, wantReused)
	}
	if !equalCategories(payload.Diagnostics.FailedCategories, wantFailed) {
		t.Errorf("failed = %v, want %v", payload.Diagnostics.FailedCategories, wantFailed)
	}
	if payload.Diagnostics.TotalHeadlines != 4 {
		t.Errorf("totalHeadlines = %d, want 4", payload.Diagnostics.TotalHeadlines)
	}

	if len(payload.Warnings) != 3 {
		t.Fatalf("warnings = %+v, want 3 groups", payload.Warnings)
	}
	wantWarnings := []struct{ code, severity, detail string }{
		{codeRateLimited, severityWarning, "Categories: tech. HTTP 429"},
		{codeEmpty, severityInfo, "Categories: finance"},
		{codeHTTPError, severityWarning, "Categories: gov"},
	}
	for index, want := range wantWarnings {
		got := payload.Warnings[index]
		if got.Code != want.code || got.Severity != want.severity || got.Detail != want.detail {
			t.Errorf("warning[%d] = %+v, want %+v", index, got, want)
		}
	}

	politics := payload.CategoryStates.Politics
	if politics.Status != categoryStatusFresh || politics.ArticleCount != 1 ||
		politics.ContentGeneratedAt == nil || *politics.ContentGeneratedAt != payload.GeneratedAt {
		t.Errorf("politics state = %+v", politics)
	}
	tech := payload.CategoryStates.Tech
	if tech.Status != categoryStatusEmpty || tech.ArticleCount != 0 || tech.ReasonCode != codeRateLimited || tech.ContentGeneratedAt != nil {
		t.Errorf("tech state = %+v", tech)
	}
	finance := payload.CategoryStates.Finance
	if finance.Status != categoryStatusEmpty || finance.ReasonCode != codeEmpty {
		t.Errorf("finance state = %+v", finance)
	}
	gov := payload.CategoryStates.Gov
	if gov.Status != categoryStatusReused || gov.ArticleCount != 1 || gov.ReasonCode != codeHTTPError {
		t.Errorf("gov state = %+v", gov)
	}
	if gov.ContentGeneratedAt == nil || *gov.ContentGeneratedAt != "2026-10-20T12:19:00.000Z" {
		t.Errorf("gov contentGeneratedAt = %v, want the previous category timestamp", gov.ContentGeneratedAt)
	}
	if len(payload.HeadlinesByCategory.Gov) != 1 || payload.HeadlinesByCategory.Gov[0].Link != previousGov.Link {
		t.Errorf("gov headlines = %+v, want the reused previous headline", payload.HeadlinesByCategory.Gov)
	}

	// Five pauses for six categories: never after the last one.
	if len(rig.sleeps) != 5 {
		t.Fatalf("sleeps = %v, want 5 pauses", rig.sleeps)
	}
	for _, paused := range rig.sleeps {
		if paused != categoryFetchDelay {
			t.Errorf("pause = %v, want %v", paused, categoryFetchDelay)
		}
	}
	if rig.stub.requestCount() != 6 {
		t.Errorf("requests = %d, want 6", rig.stub.requestCount())
	}
}

// TestRebuildWithoutContentIsFailed proves an all-failure rebuild with no
// previous snapshot is failed and groups every category under one warning.
func TestRebuildWithoutContentIsFailed(t *testing.T) {
	rig := newTestRig(t, rigOptions{
		enabled:   true,
		responses: allCategoriesFailed(http.StatusInternalServerError, ""),
	})
	payload, err := rig.service.rebuild(context.Background())
	if err != nil {
		t.Fatalf("rebuild: %v", err)
	}
	if payload.Status != StatusFailed || !payload.Partial {
		t.Errorf("status = %s partial = %v, want failed/true", payload.Status, payload.Partial)
	}
	if len(payload.Diagnostics.FailedCategories) != 6 {
		t.Errorf("failed = %v, want all six", payload.Diagnostics.FailedCategories)
	}
	if len(payload.Warnings) != 1 || payload.Warnings[0].Detail != "Categories: politics, tech, finance, gov, ai, intel" {
		t.Errorf("warnings = %+v", payload.Warnings)
	}
}

// TestRebuildAllFreshIsCompleted covers the only completed case: content in
// every category and no warning, reuse or failure.
func TestRebuildAllFreshIsCompleted(t *testing.T) {
	rig := newTestRig(t, rigOptions{enabled: true, responses: allCategoriesArticles()})
	payload, err := rig.service.rebuild(context.Background())
	if err != nil {
		t.Fatalf("rebuild: %v", err)
	}
	if payload.Status != StatusCompleted || payload.Partial {
		t.Errorf("status = %s partial = %v, want completed/false", payload.Status, payload.Partial)
	}
	if len(payload.Warnings) != 0 {
		t.Errorf("warnings = %+v, want none", payload.Warnings)
	}
	if payload.Diagnostics.TotalHeadlines != 6 {
		t.Errorf("totalHeadlines = %d, want 6", payload.Diagnostics.TotalHeadlines)
	}
	for _, category := range Categories {
		state := payload.CategoryStates.state(category)
		if state.Status != categoryStatusFresh || state.ContentGeneratedAt == nil || *state.ContentGeneratedAt != payload.GeneratedAt {
			t.Errorf("%s state = %+v", category, state)
		}
	}
}

// TestRebuildPayloadJSONGolden pins the serialized payload: key order, ISO
// millisecond timestamps, [] for empty collections and null for an absent
// content timestamp. Any change here breaks the NestJS and insights readers.
func TestRebuildPayloadJSONGolden(t *testing.T) {
	rig := newTestRig(t, rigOptions{
		enabled:   true,
		responses: allCategoriesFailed(http.StatusOK, `{"articles":[]}`),
	})
	payload, err := rig.service.rebuild(context.Background())
	if err != nil {
		t.Fatalf("rebuild: %v", err)
	}
	encoded, err := marshalJSON(payload)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	emptyStates := `{"status":"empty","articleCount":0,"contentGeneratedAt":null,"reasonCode":"gdelt_empty"}`
	want := `{"source":"scheduler","scope":"gdelt_global","variantKey":"default","status":"failed",` +
		`"generatedAt":"2026-10-20T12:34:56.789Z","expiresAt":"2026-10-20T12:54:56.789Z","partial":true,` +
		`"warnings":[{"code":"gdelt_empty","severity":"info","message":"GDELT returned no articles for this category",` +
		`"detail":"Categories: politics, tech, finance, gov, ai, intel"}],` +
		`"diagnostics":{"requestedCategories":6,"fetchedCategories":[],"reusedCategories":[],` +
		`"failedCategories":["politics","tech","finance","gov","ai","intel"],"totalHeadlines":0},` +
		`"categoryStates":{"politics":` + emptyStates + `,"tech":` + emptyStates + `,"finance":` + emptyStates +
		`,"gov":` + emptyStates + `,"ai":` + emptyStates + `,"intel":` + emptyStates + `},` +
		`"headlinesByCategory":{"politics":[],"tech":[],"finance":[],"gov":[],"ai":[],"intel":[]}}`
	if string(encoded) != want {
		t.Errorf("payload JSON =\n%s\nwant\n%s", encoded, want)
	}
	if strings.Contains(string(encoded), `\u003c`) || strings.Contains(string(encoded), `\u0026`) {
		t.Error("payload JSON HTML-escapes characters; JSON.stringify does not")
	}
}

// TestRebuildPersistsHistoryCachesAndPrune checks the write order contract: one
// history row whose payload equals both cache values, the NestJS cache keys and
// TTLs, and the seven-day prune cutoff.
func TestRebuildPersistsHistoryCachesAndPrune(t *testing.T) {
	rig := newTestRig(t, rigOptions{enabled: true, responses: allCategoriesArticles()})
	payload, err := rig.service.rebuild(context.Background())
	if err != nil {
		t.Fatalf("rebuild: %v", err)
	}
	if len(rig.store.rows) != 1 {
		t.Fatalf("rows = %d, want 1", len(rig.store.rows))
	}
	row := rig.store.rows[0]
	encoded, _ := marshalJSON(payload)
	if string(row.Payload) != string(encoded) {
		t.Error("history payload differs from the in-memory payload")
	}
	if row.Scope != scope || row.VariantKey != variantKey || row.Source != sourceName || row.Status != StatusCompleted {
		t.Errorf("row = %+v", row)
	}
	if !strings.HasPrefix(row.ID, "c") || len(row.ID) != 25 {
		t.Errorf("row id = %q, want a cuid-shaped c + 24 hex", row.ID)
	}
	if row.GeneratedAt.Format(time.RFC3339Nano) != "2026-10-20T12:34:56.789Z" {
		t.Errorf("row generatedAt = %s", row.GeneratedAt)
	}
	if !row.ExpiresAt.Equal(row.GeneratedAt.Add(freshTTL)) {
		t.Errorf("row expiresAt = %s, want generatedAt + 20m", row.ExpiresAt)
	}

	wantWarnings, _ := marshalJSON(payload.Warnings)
	wantDiagnostics, _ := marshalJSON(payload.Diagnostics)
	if string(row.Warnings) != string(wantWarnings) || string(row.Diagnostics) != string(wantDiagnostics) {
		t.Error("warnings/diagnostics columns differ from the payload members")
	}

	fresh, ok := rig.cache.written(freshCacheKey)
	if !ok || fresh != string(encoded) {
		t.Error("fresh cache value differs from the history payload")
	}
	stale, ok := rig.cache.written(staleCacheKey)
	if !ok || stale != string(encoded) {
		t.Error("stale cache value differs from the history payload")
	}
	ttls := map[string]time.Duration{}
	for _, write := range rig.cache.writes {
		ttls[write.key] = write.ttl
	}
	if ttls[freshCacheKey] != freshTTL {
		t.Errorf("fresh TTL = %v, want %v", ttls[freshCacheKey], freshTTL)
	}
	if ttls[staleCacheKey] != staleTTL {
		t.Errorf("stale TTL = %v, want %v", ttls[staleCacheKey], staleTTL)
	}
	if len(rig.store.pruned) != 1 {
		t.Fatalf("prune calls = %d, want 1", len(rig.store.pruned))
	}
	wantCutoff := rig.now.Add(-7 * 24 * time.Hour)
	if !rig.store.pruned[0].Equal(wantCutoff) {
		t.Errorf("prune cutoff = %s, want %s", rig.store.pruned[0], wantCutoff)
	}
}

// TestRebuildWriteFailuresPropagate keeps the NestJS behavior: any failed write
// fails the run instead of reporting a stored snapshot.
func TestRebuildWriteFailuresPropagate(t *testing.T) {
	t.Run("insert", func(t *testing.T) {
		rig := newTestRig(t, rigOptions{enabled: true, responses: allCategoriesArticles()})
		rig.store.insertErr = errors.New("insert failed")
		if _, err := rig.service.rebuild(context.Background()); err == nil {
			t.Fatal("rebuild error = nil, want the insert failure")
		}
		if len(rig.store.pruned) != 0 {
			t.Error("prune ran after a failed insert")
		}
	})
	t.Run("cache", func(t *testing.T) {
		rig := newTestRig(t, rigOptions{enabled: true, responses: allCategoriesArticles()})
		rig.cache.setErr = errors.New("cache failed")
		if _, err := rig.service.rebuild(context.Background()); err == nil {
			t.Fatal("rebuild error = nil, want the cache failure")
		}
	})
	t.Run("prune", func(t *testing.T) {
		rig := newTestRig(t, rigOptions{enabled: true, responses: allCategoriesArticles()})
		rig.store.pruneErr = errors.New("prune failed")
		if _, err := rig.service.rebuild(context.Background()); err == nil {
			t.Fatal("rebuild error = nil, want the prune failure")
		}
	})
}

// TestRefreshScheduledGating covers the disabled short circuit and the busy
// lease: no GDELT request and no rebuild in either case.
func TestRefreshScheduledGating(t *testing.T) {
	disabled := newTestRig(t, rigOptions{enabled: false, responses: allCategoriesArticles()})
	if err := disabled.service.refreshScheduled(context.Background()); err != nil {
		t.Fatalf("disabled refresh: %v", err)
	}
	if disabled.lock.calls != 0 {
		t.Error("disabled refresh acquired the lock")
	}
	if disabled.stub.requestCount() != 0 {
		t.Error("disabled refresh issued a GDELT request")
	}

	busy := newTestRig(t, rigOptions{enabled: true, responses: allCategoriesArticles()})
	busy.lock.acquired = false
	if err := busy.service.refreshScheduled(context.Background()); err != nil {
		t.Fatalf("busy refresh: %v", err)
	}
	if busy.lock.calls != 1 {
		t.Errorf("lock calls = %d, want 1", busy.lock.calls)
	}
	if busy.stub.requestCount() != 0 {
		t.Error("busy refresh issued a GDELT request while another run held the lock")
	}
	if busy.lock.lastKey != refreshLockKey || busy.lock.lastTTL != lockTTL {
		t.Errorf("lock = %q/%v, want %q/%v", busy.lock.lastKey, busy.lock.lastTTL, refreshLockKey, lockTTL)
	}
}

// TestRebuildRequestOrder pins the sequential category order.
func TestRebuildRequestOrder(t *testing.T) {
	rig := newTestRig(t, rigOptions{enabled: true, responses: allCategoriesArticles()})
	if _, err := rig.service.rebuild(context.Background()); err != nil {
		t.Fatalf("rebuild: %v", err)
	}
	if len(rig.stub.requests) != 6 {
		t.Fatalf("requests = %d, want 6", len(rig.stub.requests))
	}
	for index, category := range Categories {
		if !strings.Contains(rig.stub.requests[index], "query="+url.QueryEscape(categoryQueries[category])) {
			t.Errorf("request %d = %q, want the %s query", index, rig.stub.requests[index], category)
		}
	}
}

func equalCategories(got, want []Category) bool {
	if len(got) != len(want) {
		return false
	}
	for index := range got {
		if got[index] != want[index] {
			return false
		}
	}
	return true
}
