package dashboardwarmap

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
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

type fakeArticles struct {
	mu        sync.Mutex
	org       string
	calls     int
	alertErr  error
	newsErr   error
	newsStart time.Time
	alerts    []alertRow
	news      []articlePoint
	markers   []markerRow
}

func (f *fakeArticles) note(orgID string) {
	f.mu.Lock()
	f.calls++
	f.org = orgID
	f.mu.Unlock()
}

func (f *fakeArticles) Alerts(_ context.Context, orgID string, _, _ time.Time) ([]alertRow, error) {
	f.note(orgID)
	if f.alertErr != nil {
		return nil, f.alertErr
	}
	return f.alerts, nil
}

func (f *fakeArticles) EventArticles(_ context.Context, orgID string, start, _ time.Time) ([]articlePoint, error) {
	f.mu.Lock()
	f.calls++
	f.org = orgID
	f.newsStart = start
	err := f.newsErr
	rows := f.news
	f.mu.Unlock()
	return rows, err
}

func (f *fakeArticles) MarkerArticles(_ context.Context, orgID string, _, _ time.Time) ([]markerRow, error) {
	f.note(orgID)
	return f.markers, f.newsErr
}

type fakeMongo struct {
	calls int
	org   string
	err   error
	rows  []mongoRow
}

func (f *fakeMongo) Locations(_ context.Context, orgID string, _, _ time.Time, _ int) ([]mongoRow, error) {
	f.calls++
	f.org = orgID
	if f.err != nil {
		return nil, f.err
	}
	return f.rows, nil
}

func testWorld() *geoIndex {
	return &geoIndex{byCode: map[string]geoPoint{
		"USA": {Name: "United States", Lat: 39, Lng: -98},
		"BEL": {Name: "Belgium", Lat: 50.5, Lng: 4.5},
		"NLD": {Name: "Netherlands", Lat: 51.0, Lng: 5.0},
		"FRA": {Name: "France", Lat: 46, Lng: 2},
		"JPN": {Name: "Japan", Lat: 36, Lng: 138},
	}}
}

func TestWarMapRejectsForeignOrgAndWrongPermission(t *testing.T) {
	articles := &fakeArticles{}
	handler := &Handler{
		auth: stubAuth{identity: authhttp.NewIdentity("user", "org-a", []string{"items.read"})},
		svc:  &Service{articles: articles, index: testWorld()},
		now:  func() time.Time { return time.Date(2026, 3, 15, 12, 0, 0, 0, time.UTC) },
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, EventsPath, nil))
	if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "dashboards.read") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if articles.calls != 0 {
		t.Fatal("permission failure must not query")
	}

	handler.auth = stubAuth{identity: authhttp.NewIdentity("user", "org-a", []string{"dashboards.read"})}
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, EventsPath+"?orgId=org-b", nil))
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "property orgId should not exist") {
		t.Fatalf("org query status=%d body=%s", rec.Code, rec.Body.String())
	}
	if articles.calls != 0 {
		t.Fatal("query orgId must not be used")
	}
}

func TestMySQLFailureDoesNotReturnEmptyOrQueryMongo(t *testing.T) {
	articles := &fakeArticles{newsErr: errors.New("mysql down")}
	mongo := &fakeMongo{rows: []mongoRow{{ID: "m1", Location: "France"}}}
	handler := &Handler{
		auth: stubAuth{identity: authhttp.NewIdentity("user", "org-a", []string{"dashboards.read"})},
		svc:  &Service{articles: articles, mongo: mongo, index: testWorld()},
		now:  func() time.Time { return time.Date(2026, 3, 15, 0, 0, 0, 0, time.UTC) },
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, EventsPath+"?start=2026-03-01T00:00:00.000Z&end=2026-03-15T00:00:00.000Z", nil))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if mongo.calls != 0 {
		t.Fatal("mysql failure must not fall back to mongo")
	}
	if strings.Contains(rec.Body.String(), `"events"`) {
		t.Fatal("mysql failure must not look like an empty success")
	}
}

func TestEmptyMySQLUsesMongoAndKeepsOrg(t *testing.T) {
	when := time.Date(2026, 4, 1, 8, 0, 0, 0, time.UTC)
	articles := &fakeArticles{}
	mongo := &fakeMongo{rows: []mongoRow{{
		ID: "mongo-1", Location: "France", Title: "mongo headline", SortAt: &when,
	}}}
	handler := &Handler{
		auth: stubAuth{identity: authhttp.NewIdentity("user", "org-a", []string{"dashboards.read"})},
		svc:  &Service{articles: articles, mongo: mongo, index: testWorld()},
		now:  func() time.Time { return time.Date(2026, 4, 2, 0, 0, 0, 0, time.UTC) },
	}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, NewsMarkersPath+"?start=2026-04-01T00:00:00.000Z&end=2026-04-02T00:00:00.000Z", nil)
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if articles.org != "org-a" || mongo.org != "org-a" || mongo.calls != 1 {
		t.Fatalf("org=%s mongoOrg=%s calls=%d", articles.org, mongo.org, mongo.calls)
	}
	var body markersResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Markers) != 1 || body.Markers[0].ID != "mongo-1" || body.Markers[0].GeoSource != "fallback-country" {
		t.Fatalf("markers=%+v", body.Markers)
	}
}

func TestGeocodeBudgetStopsAtThree(t *testing.T) {
	geo := &countingGeo{}
	rows := make([]markerRow, 0, 5)
	for _, location := range []string{"USA", "FRA", "BEL", "NLD", "JPN"} {
		rows = append(rows, markerRow{ID: location, Location: location, Title: location})
	}
	svc := &Service{articles: &fakeArticles{markers: rows}, geo: geo, index: testWorld()}
	body, err := svc.Markers(context.Background(), "org-a", time.Now().Add(-time.Hour), time.Now(), viewOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if geo.network != 3 {
		t.Fatalf("network calls=%d", geo.network)
	}
	if len(body.Markers) != 5 {
		t.Fatalf("fallback markers=%d", len(body.Markers))
	}
}

type countingGeo struct {
	network int
}

func (f *countingGeo) Resolve(_ context.Context, _ []string, _ string, network bool) (*geoHit, error) {
	if network {
		f.network++
	}
	return nil, nil
}

func TestUnalignedRangeAndDatetimeOverflow(t *testing.T) {
	articles := &fakeArticles{}
	handler := &Handler{
		auth: stubAuth{identity: authhttp.NewIdentity("user", "org-a", []string{"dashboards.read"})},
		svc:  &Service{articles: articles, index: testWorld()},
		now:  func() time.Time { return time.Date(2026, 3, 20, 12, 0, 0, 0, time.UTC) },
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, EventsPath+"?start=2026-03-15T23:00:00Z&end=2026-03-15T01:00:00Z", nil))
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "Start must be before end") {
		t.Fatalf("same-day order status=%d body=%s", rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, EventsPath+"?start=2026-02-31T12:00:00.000Z", nil))
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "Invalid date range") {
		t.Fatalf("datetime overflow status=%d body=%s", rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, EventsPath+"?start=2026-02-31&end=2026-03-10T00:00:00.000Z", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("date-only overflow status=%d body=%s", rec.Code, rec.Body.String())
	}
	if !articles.newsStart.Equal(time.Date(2026, 3, 3, 0, 0, 0, 0, time.UTC)) {
		t.Fatalf("overflow start=%s", articles.newsStart)
	}
}

func TestClusterAndBBox(t *testing.T) {
	when := time.Date(2026, 3, 12, 0, 0, 0, 0, time.UTC)
	earlier := when.Add(-time.Hour)
	articles := &fakeArticles{
		alerts: []alertRow{{TriggeredAt: when, Severity: "high", Context: map[string]any{"countryCode": "USA"}}},
		news: []articlePoint{
			{Location: "Netherlands", EventAt: &when},
			{Location: "Belgium", EventAt: &earlier},
		},
	}
	svc := &Service{articles: articles, index: testWorld()}
	body, err := svc.Events(context.Background(), "org-a", when.Add(-24*time.Hour), when.Add(time.Hour), viewOptions{
		Cluster: true,
		BBox:    &[4]float64{0, 40, 10, 60},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !body.Clustered || len(body.Events) != 1 || !body.Events[0].IsCluster {
		t.Fatalf("cluster=%+v", body.Events)
	}
	if body.Events[0].NewsCount != 2 || body.Events[0].AlertCount != 0 {
		t.Fatalf("cluster counts=%+v", body.Events[0])
	}
	open, err := svc.Events(context.Background(), "org-a", when.Add(-24*time.Hour), when.Add(time.Hour), viewOptions{})
	if err != nil {
		t.Fatal(err)
	}
	ids := map[string]bool{}
	for _, event := range open.Events {
		ids[event.ID] = true
	}
	if !ids["usa"] || !ids["bel"] || !ids["nld"] || ids["jpn"] {
		t.Fatalf("ids=%v", ids)
	}
}

func TestCountryPhrases(t *testing.T) {
	if got := normalizeCountryCode("USA"); got != "USA" {
		t.Fatal(got)
	}
	if got := extractCountryCodeFromText("New York, USA"); got != "USA" {
		t.Fatal(got)
	}
	if got := normalizeCountryCode("美国"); got != "USA" {
		t.Fatal(got)
	}
	if got := normalizeCountryCode("法国"); got != "FRA" {
		t.Fatalf("法国=%s", got)
	}
}

func TestSQLBindsOrg(t *testing.T) {
	for _, query := range []string{alertSQL, eventArticleSQL, markerArticleSQL} {
		if !strings.Contains(query, "orgId = ?") {
			t.Fatalf("query missing org bind: %s", query)
		}
	}
}

func TestCacheKeyIncludesOrg(t *testing.T) {
	start := time.Date(2026, 3, 1, 0, 0, 0, 0, time.UTC)
	end := time.Date(2026, 3, 2, 0, 0, 0, 0, time.UTC)
	a := dashboardCacheKey("war-map-events", "org-a", start, end)
	b := dashboardCacheKey("war-map-events", "org-b", start, end)
	if a == b || !strings.Contains(a, "dashboard:query:war-map-events:") {
		t.Fatalf("keys %s %s", a, b)
	}
}
