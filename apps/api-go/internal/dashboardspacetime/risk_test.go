package dashboardspacetime

import (
	"context"
	"errors"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
)

func TestSnapshotJSONMatchesNestStringify(t *testing.T) {
	start := time.Date(2026, 3, 1, 0, 0, 0, 0, time.UTC)
	end := time.Date(2026, 3, 15, 23, 59, 59, 999000000, time.UTC)
	body, id, ok := marshalSnapshot("org-a", "evt-1", start, end, map[string][]string{
		"52.000:20.000": {"Poland"},
		"49.000:32.000": {"Ukraine", "Kyiv"},
	})
	if !ok {
		t.Fatal("snapshot was not built")
	}
	want := `{"v":1,"orgId":"org-a","eventId":"evt-1","rangeStart":"2026-03-01T00:00:00.000Z","rangeEnd":"2026-03-15T23:59:59.999Z","pointToLocationKeys":{"49.000:32.000":["Kyiv","Ukraine"],"52.000:20.000":["Poland"]}}`
	if string(body) != want {
		t.Fatalf("snapshot JSON = %s", body)
	}
	if len(id) != 64 {
		t.Fatalf("snapshot id = %s", id)
	}
	emptyEvent, _, ok := marshalSnapshot("org-a", "", start, end, map[string][]string{"49.000:32.000": {"Ukraine"}})
	if !ok || !strings.Contains(string(emptyEvent), `"eventId":null`) {
		t.Fatalf("empty event JSON = %s", emptyEvent)
	}
	view, parsed := parseSnapshot(body, "org-a")
	if !parsed || view.eventID != "evt-1" || len(view.keys["49.000:32.000"]) != 2 {
		t.Fatalf("parsed %#v %v", view, parsed)
	}
	if _, parsed := parseSnapshot(body, "org-b"); parsed {
		t.Fatal("snapshot from another org was accepted")
	}
}

func TestHeatmapSnapshotDrillAndTenantBoundary(t *testing.T) {
	start := time.Date(2026, 3, 1, 0, 0, 0, 0, time.UTC)
	end := time.Date(2026, 3, 15, 23, 59, 59, 999000000, time.UTC)
	ua := time.Date(2026, 3, 10, 8, 0, 0, 0, time.UTC)
	pl := time.Date(2026, 3, 10, 10, 0, 0, 0, time.UTC)
	refUA := "6565656565656565656565a1"
	refPL := "6565656565656565656565a2"
	url := "https://www.reuters.com/world"
	label := "Reuters"
	store := &memArticles{geo: map[string][]geoRow{
		"org-a": {
			{ID: "pa-ua", Location: "Ukraine", CleanedRef: refUA, EventAt: &ua, Title: "Kyiv desk", URL: &url, SourceLabel: &label},
			{ID: "pa-pl", Location: "Poland", CleanedRef: refPL, EventAt: &pl, Title: "Warsaw desk", URL: &url, SourceLabel: &label},
		},
		"org-b": {
			{ID: "pa-other", Location: "Poland", CleanedRef: refPL, EventAt: &pl, Title: "Other desk", URL: &url, SourceLabel: &label},
		},
	}}
	snaps := &memSnaps{data: map[string][]byte{}}
	svc := &Service{
		articles: store,
		items:    &memItems{labels: map[string]string{refUA: "negative", refPL: "positive"}},
		snaps:    snaps,
	}
	ctx := context.Background()
	heat, err := svc.Heatmap(ctx, "org-a", start, end, "evt-1", true)
	if err != nil {
		t.Fatal(err)
	}
	if len(heat.Points) != 2 || heat.SnapshotID == "" {
		t.Fatalf("points=%d snapshot=%q", len(heat.Points), heat.SnapshotID)
	}
	saved := snaps.data["org-a:"+heat.SnapshotID]
	if len(saved) == 0 {
		t.Fatal("snapshot was not stored")
	}
	ukraine := ""
	for _, point := range heat.Points {
		if point.Sentiment.Negative == 1 {
			ukraine = point.ID
		}
	}
	if ukraine == "" {
		t.Fatalf("ukraine point missing: %+v", heat.Points)
	}
	drilled, err := svc.HeatmapArticles(ctx, "org-a", start, end, "evt-1", heat.SnapshotID, ukraine, "", 30)
	if err != nil {
		t.Fatal(err)
	}
	if len(drilled.Articles) != 1 || drilled.Articles[0].ID != "pa-ua" || drilled.Articles[0].Sentiment == nil || *drilled.Articles[0].Sentiment != "negative" {
		t.Fatalf("snapshot drill = %+v", drilled.Articles)
	}
	direct, err := svc.HeatmapArticles(ctx, "org-a", start, end, "evt-1", "", ukraine, "", 30)
	if err != nil || len(direct.Articles) != 1 || direct.Articles[0].ID != "pa-ua" {
		t.Fatalf("geocode drill = %+v %v", direct.Articles, err)
	}
	if _, err := svc.HeatmapArticles(ctx, "org-b", start, end, "evt-1", heat.SnapshotID, ukraine, "", 30); err == nil || !strings.Contains(err.Error(), "Invalid snapshotId") {
		t.Fatalf("cross-org snapshot err = %v", err)
	}
	other, err := svc.Heatmap(ctx, "org-b", start, end, "evt-1", false)
	if err != nil || len(other.Points) != 1 || other.Points[0].Sentiment.Negative != 0 {
		t.Fatalf("other org heatmap = %+v %v", other, err)
	}
	snaps.failSave = true
	unsaved, err := svc.Heatmap(ctx, "org-a", start, end, "evt-1", false)
	if err != nil || unsaved.SnapshotID != "" || len(unsaved.Points) == 0 {
		t.Fatalf("failed save still returned snapshot %q (%d points, %v)", unsaved.SnapshotID, len(unsaved.Points), err)
	}
}

func TestPropagationDuplicateEdgeAndArticleDrill(t *testing.T) {
	start := time.Date(2026, 3, 1, 0, 0, 0, 0, time.UTC)
	end := time.Date(2026, 3, 15, 23, 59, 59, 999000000, time.UTC)
	parent := "6565656565656565656565a1"
	child := "6565656565656565656565a2"
	third := "6565656565656565656565a3"
	at := func(hour int) *time.Time {
		value := time.Date(2026, 3, 10, hour, 0, 0, 0, time.UTC)
		return &value
	}
	rows := []propRow{
		{ArticleID: "pa-r", ProcessedItemID: parent, Title: "Reuters copy", SourceLabel: "Reuters", URL: "https://www.reuters.com/a", Published: at(8)},
		{ArticleID: "pa-a", ProcessedItemID: child, Title: "AP copy", SourceLabel: "Associated Press", URL: "https://apnews.com/b", Published: at(10)},
		{ArticleID: "pa-b", ProcessedItemID: third, Title: "BBC copy", SourceLabel: "BBC", URL: "https://www.bbc.com/c", Published: at(12)},
	}
	sim := 0.82
	items := &memItems{labels: map[string]string{parent: "negative"}, links: []dupLink{{Child: child, Parent: parent, Similarity: &sim}}}
	svc := &Service{articles: &memArticles{prop: map[string][]propRow{"org-a": rows}}, items: items}
	ctx := context.Background()
	graph, err := svc.Propagation(ctx, "org-a", "evt-1", start, end, 24, 140, 320, 8)
	if err != nil {
		t.Fatal(err)
	}
	if len(graph.Nodes) != 3 || len(graph.Edges) < 2 {
		t.Fatalf("graph nodes=%d edges=%d", len(graph.Nodes), len(graph.Edges))
	}
	foundDup := false
	for _, edge := range graph.Edges {
		if edge.Source == edge.Target {
			t.Fatalf("self edge %+v", edge)
		}
		if edge.Kind == "duplicate" && edge.Source == "Reuters" && edge.Target == "Associated Press" && edge.Weight == 1 && edge.AvgDuplicateSimilarity != nil && math.Abs(*edge.AvgDuplicateSimilarity-0.82) < 1e-9 {
			foundDup = true
		}
	}
	if !foundDup {
		t.Fatalf("duplicate edge missing: %+v", graph.Edges)
	}
	articles, err := svc.PropagationArticles(ctx, "org-a", "evt-1", "Reuters", "", "", start, end, 30)
	if err != nil || len(articles.Articles) != 1 || articles.Articles[0].ID != "pa-r" || articles.Articles[0].Sentiment == nil || *articles.Articles[0].Sentiment != "negative" {
		t.Fatalf("source drill = %+v %v", articles.Articles, err)
	}
	items.failDup = true
	fallback, err := svc.Propagation(ctx, "org-a", "evt-1", start, end, 24, 140, 320, 8)
	if err != nil {
		t.Fatal(err)
	}
	for _, edge := range fallback.Edges {
		if edge.Kind == "duplicate" {
			t.Fatalf("duplicate query failure still produced %+v", edge)
		}
	}
	if !hasEdge(fallback.Edges, "time", "Reuters", "Associated Press") {
		t.Fatalf("time fallback missing: %+v", fallback.Edges)
	}
}

func TestMySQLFailureIsNotEmptySuccess(t *testing.T) {
	fixed := time.Date(2026, 3, 12, 0, 0, 0, 0, time.UTC)
	handler := &Handler{
		auth: stubAuth{id: authhttp.NewIdentity("user", "org-a", []string{"dashboards.read"})},
		svc:  &Service{articles: &memArticles{err: errors.New("mysql down")}},
		now:  func() time.Time { return fixed },
	}
	for _, path := range []string{
		GeoPath + "?start=2026-03-01T00:00:00.000Z&end=2026-03-15T00:00:00.000Z",
		PropagationPath + "?start=2026-03-01T00:00:00.000Z&end=2026-03-15T00:00:00.000Z&eventId=evt-1",
	} {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if rec.Code != http.StatusInternalServerError || strings.Contains(rec.Body.String(), `"points"`) || strings.Contains(rec.Body.String(), `"nodes"`) {
			t.Fatalf("%s status=%d body=%s", path, rec.Code, rec.Body.String())
		}
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, PropagationPath+"?start=2026-03-01T00:00:00.000Z&end=2026-03-15T00:00:00.000Z", nil))
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "eventId must be a string") {
		t.Fatalf("missing eventId = %d %s", rec.Code, rec.Body.String())
	}
}

func hasEdge(edges []edgeJSON, kind, source, target string) bool {
	for _, edge := range edges {
		if edge.Kind == kind && edge.Source == source && edge.Target == target {
			return true
		}
	}
	return false
}

type stubAuth struct {
	id *authhttp.Identity
}

func (s stubAuth) Authenticate(http.ResponseWriter, *http.Request) *authhttp.Identity {
	return s.id
}

type memArticles struct {
	geo  map[string][]geoRow
	prop map[string][]propRow
	err  error
}

func (m *memArticles) Geo(_ context.Context, orgID string, _, _ time.Time, _ string) ([]geoRow, error) {
	if m.err != nil {
		return nil, m.err
	}
	return append([]geoRow(nil), m.geo[orgID]...), nil
}

func (m *memArticles) Propagation(_ context.Context, orgID, _ string, _, _ time.Time) ([]propRow, error) {
	if m.err != nil {
		return nil, m.err
	}
	return append([]propRow(nil), m.prop[orgID]...), nil
}

type memItems struct {
	labels  map[string]string
	links   []dupLink
	failDup bool
}

func (m *memItems) Sentiments(context.Context, string, []string) (map[string]string, bool) {
	if m.labels == nil {
		return map[string]string{}, true
	}
	return m.labels, true
}

func (m *memItems) Duplicates(context.Context, string, []string) ([]dupLink, bool) {
	if m.failDup {
		return nil, false
	}
	return m.links, true
}

type memSnaps struct {
	data     map[string][]byte
	failSave bool
}

func (m *memSnaps) Load(_ context.Context, orgID, id string) ([]byte, bool, error) {
	body, ok := m.data[orgID+":"+id]
	return body, ok, nil
}

func (m *memSnaps) Save(_ context.Context, orgID, id string, body []byte) error {
	if m.failSave {
		return errors.New("redis down")
	}
	m.data[orgID+":"+id] = append([]byte(nil), body...)
	return nil
}
