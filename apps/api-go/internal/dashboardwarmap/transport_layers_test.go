package dashboardwarmap

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
)

type storedTrack struct {
	org, kind, key string
	at             time.Time
	doc            map[string]any
}

type fakeTracks struct {
	state map[string]map[string]any
	rows  []storedTrack
	calls int
	org   string
}

func (f *fakeTracks) FindTransportState(_ context.Context, orgID, kind, objectKey string) (map[string]any, bool, error) {
	f.calls++
	f.org = orgID
	doc, ok := f.state[orgID+"|"+kind+"|"+objectKey]
	return doc, ok, nil
}

func (f *fakeTracks) FindTransportTracks(_ context.Context, orgID, kind, objectKey string, start, end *time.Time, limit int) ([]map[string]any, error) {
	f.calls++
	f.org = orgID
	matched := make([]storedTrack, 0)
	for _, row := range f.rows {
		if row.org != orgID || row.kind != kind || row.key != objectKey {
			continue
		}
		if start != nil && end != nil && (row.at.Before(*start) || row.at.After(*end)) {
			continue
		}
		matched = append(matched, row)
	}
	for i := 0; i < len(matched); i++ {
		for j := i + 1; j < len(matched); j++ {
			if matched[j].at.After(matched[i].at) {
				matched[i], matched[j] = matched[j], matched[i]
			}
		}
	}
	if limit > 0 && len(matched) > limit {
		matched = matched[:limit]
	}
	out := make([]map[string]any, 0, len(matched))
	for _, row := range matched {
		out = append(out, row.doc)
	}
	return out, nil
}

func TestTransportUsesRangeThenFallsBack(t *testing.T) {
	march10 := time.Date(2026, 3, 10, 0, 0, 0, 0, time.UTC)
	march12 := time.Date(2026, 3, 12, 0, 0, 0, 0, time.UTC)
	april := time.Date(2026, 4, 1, 0, 0, 0, 0, time.UTC)
	point := func(at time.Time, id string) map[string]any {
		return map[string]any{"_id": id, "objectKey": "opensky:abc", "observedAt": at, "lat": 50.0, "lng": 4.0, "speed": 120.0, "geoCell": id}
	}
	tracks := &fakeTracks{
		state: map[string]map[string]any{
			"org-a|aircraft|opensky:abc": {"callsign": "RCH100", "displayCategory": "Military flight", "role": "Military transport", "observedAt": march12},
		},
		rows: []storedTrack{
			{"org-a", "aircraft", "opensky:abc", march10, point(march10, "p10")},
			{"org-a", "aircraft", "opensky:abc", march12, point(march12, "p12")},
			{"org-a", "aircraft", "opensky:abc", april, point(april, "p4")},
			{"org-b", "aircraft", "opensky:abc", april, point(april, "other")},
		},
	}
	handler := &Handler{
		auth: stubAuth{identity: authhttp.NewIdentity("user", "org-a", []string{"dashboards.read"})},
		svc:  &Service{tracks: tracks},
		now:  func() time.Time { return time.Date(2026, 3, 20, 0, 0, 0, 0, time.UTC) },
	}
	get := func(path string) map[string]any {
		t.Helper()
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("%s status=%d body=%s", path, rec.Code, rec.Body.String())
		}
		var body map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		return body
	}
	ranged := get(TransportPath + "?kind=aircraft&objectKey=opensky:abc&start=2026-03-01T00:00:00.000Z&end=2026-03-15T00:00:00.000Z")
	detail := ranged["detail"].(map[string]any)
	if detail["title"] != "RCH100" || detail["subtitle"] != "Military flight · Military transport" {
		t.Fatalf("title=%v subtitle=%v", detail["title"], detail["subtitle"])
	}
	ids := pointIDs(t, detail)
	if strings.Join(ids, ",") != "p12,p10" {
		t.Fatalf("range ids=%v", ids)
	}
	if tracks.org != "org-a" {
		t.Fatalf("org=%s", tracks.org)
	}
	fallback := get(TransportPath + "?kind=aircraft&objectKey=opensky:abc&start=2026-02-01T00:00:00.000Z&end=2026-02-02T00:00:00.000Z")
	if strings.Join(pointIDs(t, fallback["detail"].(map[string]any)), ",") != "p4,p12,p10" {
		t.Fatalf("fallback=%s", fallback)
	}
	missing := get(TransportPath + "?kind=aircraft&objectKey=missing&start=2026-03-01T00:00:00.000Z&end=2026-03-15T00:00:00.000Z")
	if missing["detail"] != nil {
		t.Fatalf("missing=%v", missing["detail"])
	}

	tracks.calls = 0
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, TransportPath+"?kind=car&objectKey=opensky:abc", nil))
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "INVALID_TRANSPORT_KIND") || tracks.calls != 0 {
		t.Fatalf("kind status=%d calls=%d body=%s", rec.Code, tracks.calls, rec.Body.String())
	}
	handler.auth = stubAuth{identity: authhttp.NewIdentity("user", "org-a", []string{"items.read"})}
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, TransportPath+"?kind=aircraft&objectKey=opensky:abc", nil))
	if rec.Code != http.StatusForbidden || tracks.calls != 0 {
		t.Fatalf("permission status=%d calls=%d", rec.Code, tracks.calls)
	}
	handler.auth = stubAuth{identity: authhttp.NewIdentity("user", "org-a", []string{"dashboards.read"})}
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, TransportPath+"?kind=aircraft&objectKey=opensky:abc&orgId=org-b", nil))
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "property orgId should not exist") || tracks.calls != 0 {
		t.Fatalf("org query status=%d calls=%d body=%s", rec.Code, tracks.calls, rec.Body.String())
	}
}

func pointIDs(t *testing.T, detail map[string]any) []string {
	t.Helper()
	rows, _ := detail["trackPoints"].([]any)
	ids := make([]string, 0, len(rows))
	for _, row := range rows {
		ids = append(ids, row.(map[string]any)["id"].(string))
	}
	return ids
}

type memSnaps struct {
	adsb  *adsbSnapshot
	ais   *aisSnapshot
	calls int
	org   string
}

func (m *memSnaps) LatestAdsb(_ context.Context, orgID string) (*adsbSnapshot, error) {
	m.calls++
	m.org = orgID
	return m.adsb, nil
}

func (m *memSnaps) LatestAis(_ context.Context, orgID string) (*aisSnapshot, error) {
	m.calls++
	m.org = orgID
	return m.ais, nil
}

func (m *memSnaps) SourceState(context.Context, string, string) (map[string]any, error) {
	m.calls++
	return nil, nil
}

type fakeSky struct {
	calls int
}

func (f *fakeSky) Viewport(context.Context, *[4]float64, time.Time) (openskyResult, error) {
	f.calls++
	return openskyResult{}, nil
}

func TestLayersUseSnapshotsAndEventSeed(t *testing.T) {
	now := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	heading := 90.0
	altitude := 10000.0
	snaps := &memSnaps{
		adsb: &adsbSnapshot{
			Endpoint: "redis://adsb", UpdatedAt: now, LatestObserved: now, Total: 2, Valid: 2, StaleSec: 600,
			Aircraft: []adsbCraft{
				{ID: "abc123", ICAO24: "abc123", Callsign: "RCH100", Lat: 50.5, Lng: 4.5, ObservedAt: now, Source: "opensky", Heading: &heading, AltitudeFt: &altitude},
				{ID: "zzz999", ICAO24: "zzz999", Lat: 1, Lng: 100, ObservedAt: now, Source: "opensky"},
			},
		},
		ais: &aisSnapshot{
			Endpoint: "redis://ais", UpdatedAt: now, Connected: true, Vessels: 2, Candidates: []aisVessel{
				{MMSI: "111", Name: "Guard", Lat: 50.6, Lng: 4.4, ObservedAt: now},
				{MMSI: "222", Lat: 1, Lng: 1, ObservedAt: now},
			},
			Disruptions: []aisBreak{{ID: "break-1", Name: "Gap", Type: "dark", Severity: "high", Lat: 50.4, Lng: 4.6}},
			Density:     []aisZone{{ID: "zone-1", Name: "Dense", Lat: 50.4, Lng: 4.6, Intensity: 3}},
		},
	}
	sky := &fakeSky{}
	when := time.Date(2026, 3, 12, 12, 0, 0, 0, time.UTC)
	handler := &Handler{
		auth: stubAuth{identity: authhttp.NewIdentity("user", "org-a", []string{"dashboards.read"})},
		svc: &Service{
			articles: &fakeArticles{alerts: []alertRow{{TriggeredAt: when, Severity: "high", Context: map[string]any{"countryCode": "USA"}}}},
			index:    testWorld(),
			snaps:    snaps,
			sky:      sky,
		},
		now: func() time.Time { return when },
	}
	path := LayersPath + "?start=2026-03-01T00:00:00.000Z&end=2026-03-15T00:00:00.000Z&bbox=0,40,10,60&zoom=3"
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path+"&orgId=org-b", nil))
	if rec.Code != http.StatusBadRequest || snaps.calls != 0 || sky.calls != 0 {
		t.Fatalf("boundary status=%d snaps=%d sky=%d", rec.Code, snaps.calls, sky.calls)
	}
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("layers status=%d body=%s", rec.Code, rec.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if snaps.org != "org-a" || sky.calls != 0 {
		t.Fatalf("org=%s sky=%d", snaps.org, sky.calls)
	}
	layers := body["layers"].(map[string]any)
	flights := featureIDs(t, layers["flights"])
	if strings.Join(flights, ",") != "abc123" {
		t.Fatalf("flights=%v", flights)
	}
	ais := featureIDs(t, layers["ais"])
	joined := strings.Join(ais, ",")
	if !strings.Contains(joined, "ais-vessel-111") || strings.Contains(joined, "ais-vessel-222") || strings.Contains(joined, "zone-1") || !strings.Contains(joined, "break-1") {
		t.Fatalf("ais=%v", ais)
	}
	if !strings.Contains(rec.Body.String(), "evt-usa") || !strings.Contains(rec.Body.String(), `"id":"dc"`) {
		t.Fatal("missing event seed or static hotspot")
	}
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path+"&flightMode=all", nil))
	if rec.Code != http.StatusOK || sky.calls != 1 || !strings.Contains(rec.Body.String(), `"freshness":"not_configured"`) {
		t.Fatalf("all status=%d sky=%d body=%s", rec.Code, sky.calls, rec.Body.String())
	}
}

func featureIDs(t *testing.T, dataset any) []string {
	t.Helper()
	rows, _ := dataset.(map[string]any)["features"].([]any)
	ids := make([]string, 0, len(rows))
	for _, row := range rows {
		ids = append(ids, row.(map[string]any)["id"].(string))
	}
	return ids
}
