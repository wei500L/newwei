package dashboardcharts

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
)

type stubAuth struct {
	identity *authhttp.Identity
}

func (s stubAuth) Authenticate(http.ResponseWriter, *http.Request) *authhttp.Identity {
	return s.identity
}

type fakeStore struct {
	calls     int
	start     time.Time
	end       time.Time
	err       error
	items     []sectorItem
	fields    map[string][]string
	candle    *candleItem
	matched   []rawPoint
	total     int
	available []string
}

func (f *fakeStore) SectorItems(context.Context) ([]sectorItem, error) {
	f.calls++
	return f.items, f.err
}

func (f *fakeStore) SectorFields(_ context.Context, _ []string, start, end time.Time) (map[string][]string, error) {
	f.start, f.end = start, end
	return f.fields, f.err
}

func (f *fakeStore) SectorPoint(context.Context, string, string, time.Time, time.Time, bool) (*samplePoint, error) {
	return nil, f.err
}

func (f *fakeStore) CandleItem(context.Context) (*candleItem, error) {
	f.calls++
	return f.candle, f.err
}

func (f *fakeStore) CandlePoints(context.Context, string, []string, time.Time, time.Time) ([]rawPoint, error) {
	return f.matched, f.err
}

func (f *fakeStore) CandleCount(context.Context, string, time.Time, time.Time) (int, error) {
	return f.total, f.err
}

func (f *fakeStore) CandleFields(context.Context, string, time.Time, time.Time) ([]string, error) {
	return f.available, f.err
}

func TestChartsRequireDashboardsReadAndRejectForeignQuery(t *testing.T) {
	store := &fakeStore{}
	handler := &Handler{
		gate:  membershipGate{auth: stubAuth{identity: authhttp.NewIdentity("user", "org-a", []string{"items.read"})}},
		store: store,
		now:   func() time.Time { return time.Date(2026, 10, 9, 0, 0, 0, 0, time.UTC) },
		world: newGeoAsset(worldGeoJSON),
	}
	for _, path := range Paths {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "dashboards.read") {
			t.Fatalf("%s status=%d body=%s", path, rec.Code, rec.Body.String())
		}
	}
	if store.calls != 0 {
		t.Fatal("forbidden request queried mysql")
	}

	handler.gate = membershipGate{auth: stubAuth{identity: authhttp.NewIdentity("user", "org-a", []string{"dashboards.read"})}}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, SectorHeatmapPath+"?orgId=org-b", nil))
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "property orgId should not exist") {
		t.Fatalf("orgId status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.calls != 0 {
		t.Fatal("rejected query still read mysql")
	}
}

func TestGeoJSONIsAuthenticatedAndCached(t *testing.T) {
	store := &fakeStore{}
	handler := &Handler{
		gate:  membershipGate{auth: stubAuth{identity: authhttp.NewIdentity("user", "org-a", []string{"dashboards.read"})}},
		store: store,
		now:   time.Now,
		world: newGeoAsset(worldGeoJSON),
	}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, WarMapGeoJSONPath+"?start=not-a-date", nil)
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest || store.calls != 0 {
		t.Fatalf("bad date status=%d calls=%d body=%s", rec.Code, store.calls, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, WarMapGeoJSONPath, nil))
	if rec.Code != http.StatusOK {
		t.Fatal(rec.Body.String())
	}
	if rec.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("cache = %q", rec.Header().Get("Cache-Control"))
	}
	if !strings.HasPrefix(rec.Body.String(), `{"name":"world","geoJson":{"type":"FeatureCollection","features":[`) {
		t.Fatalf("geo prefix = %.120s", rec.Body.String())
	}
	if store.calls != 0 {
		t.Fatal("geojson queried mysql")
	}

	handler.world = newGeoAsset([]byte(`{"type":"Feature","features":[]}`))
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, WarMapGeoJSONPath, nil))
	if rec.Code != http.StatusInternalServerError || !strings.Contains(rec.Body.String(), "GEOJSON_LOAD_FAILED") || rec.Header().Get("Cache-Control") != "" {
		t.Fatalf("bad geo status=%d cache=%q body=%s", rec.Code, rec.Header().Get("Cache-Control"), rec.Body.String())
	}
}

func TestHeatmapReadsStoreAndCandleMismatchHidesDriverText(t *testing.T) {
	day := time.Date(2026, 3, 10, 0, 0, 0, 0, time.UTC)
	store := fakeStore{
		items: []sectorItem{{
			ID: "a", Slug: "alpha", DisplayName: "Alpha",
			Metadata:    []byte(`{"dataViz":{"heatmap":{"preferredSourceFields":["close"]}}}`),
			DefaultUnit: sql.NullString{String: "pts", Valid: true},
		}},
		fields: map[string][]string{"a": {"close"}},
	}
	rich := &pointStore{fakeStore: store, point: samplePoint{RecordedAt: day, Value: 110.5, Unit: sql.NullString{String: "pts", Valid: true}}}
	handler := &Handler{
		gate:  membershipGate{auth: stubAuth{identity: authhttp.NewIdentity("user", "org-a", []string{"dashboards.read"})}},
		store: rich,
		now:   func() time.Time { return time.Date(2026, 10, 9, 14, 0, 0, 0, time.UTC) },
		world: newGeoAsset(worldGeoJSON),
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, SectorHeatmapPath, nil))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"sourceField":"close"`) || strings.Contains(rec.Body.String(), "demo") {
		t.Fatalf("heatmap = %d %s", rec.Code, rec.Body.String())
	}
	if toISO(rich.start) != "2026-09-09T00:00:00.000Z" {
		t.Fatalf("default start = %s", toISO(rich.start))
	}

	secret := "mysql://user:s3cret@db:3306/app"
	rich.err = errors.New(secret)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, FinancialCandlestickPath, nil))
	if rec.Code != http.StatusServiceUnavailable || strings.Contains(rec.Body.String(), "s3cret") {
		t.Fatalf("db failure = %d %s", rec.Code, rec.Body.String())
	}
}

type pointStore struct {
	fakeStore
	point samplePoint
}

func (p *pointStore) SectorFields(_ context.Context, _ []string, start, end time.Time) (map[string][]string, error) {
	p.start, p.end = start, end
	if p.err != nil {
		return nil, p.err
	}
	return p.fields, nil
}

func (p *pointStore) SectorPoint(context.Context, string, string, time.Time, time.Time, bool) (*samplePoint, error) {
	if p.err != nil {
		return nil, p.err
	}
	point := p.point
	return &point, nil
}

func (p *pointStore) CandleItem(context.Context) (*candleItem, error) {
	if p.err != nil {
		return nil, p.err
	}
	return p.candle, nil
}
