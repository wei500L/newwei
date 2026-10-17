package legacyproxy

import (
	"net/http"
	"testing"
)

// crawlReadTelemetryRoutes lists the seven routes the go mode must own,
// together with the shape assertion each rule has to satisfy.
func crawlReadTelemetryRoutes() []struct {
	method string
	path   string
	shape  string // "exact", "one", "two"
} {
	return []struct {
		method string
		path   string
		shape  string
	}{
		{http.MethodGet, "/api/crawl-tasks", "exact"},
		{http.MethodGet, "/api/crawl-tasks/task-1", "one"},
		{http.MethodGet, "/api/crawl-media-assets/asset-1/download", "two"},
		{http.MethodGet, "/api/admin/crawl4ai/quality", "exact"},
		{http.MethodGet, "/api/admin/crawl4ai/quality/sources/source-1", "one"},
		{http.MethodPost, "/api/search-telemetry", "exact"},
		{http.MethodGet, "/api/admin/search-telemetry/summary", "exact"},
	}
}

// crawlReadTelemetryNestRoutes lists methods and paths that must keep falling
// back to NestJS even in go mode: the crawl write queue, live crawler
// metadata, the crawl4ai queue admin surface and near-miss paths.
func crawlReadTelemetryNestRoutes() []struct{ method, path string } {
	return []struct{ method, path string }{
		// Crawl task write queue and live crawler metadata stay on NestJS.
		{http.MethodPost, "/api/crawl-tasks"},
		{http.MethodPost, "/api/crawl-tasks/metadata"},
		{http.MethodDelete, "/api/crawl-tasks/task-1"},
		{http.MethodPost, "/api/crawl-tasks/task-1/retry"},
		{http.MethodPatch, "/api/crawl-tasks/task-1"},
		{http.MethodGet, "/api/crawl-tasks/task-1/results"},
		{http.MethodGet, "/api/crawl-tasks/task-1/extra/segment"},
		{http.MethodGet, "/api/crawl-tasks/"},
		// crawl4ai queue administration is explicitly out of scope.
		{http.MethodGet, "/api/admin/crawl4ai/queue"},
		{http.MethodGet, "/api/admin/crawl4ai/queue/jobs"},
		{http.MethodPost, "/api/admin/crawl4ai/queue/clean"},
		// Only the registered method reaches Go.
		{http.MethodGet, "/api/search-telemetry"},
		{http.MethodPost, "/api/admin/search-telemetry/summary"},
		{http.MethodGet, "/api/admin/search-telemetry"},
		// Media asset path needs exactly two segments.
		{http.MethodGet, "/api/crawl-media-assets/asset-1"},
		{http.MethodGet, "/api/crawl-media-assets/asset-1/download/extra"},
		{http.MethodGet, "/api/crawl-media-assets/"},
		// Quality source path needs exactly one segment.
		{http.MethodGet, "/api/admin/crawl4ai/quality/sources"},
		{http.MethodGet, "/api/admin/crawl4ai/quality/sources/source-1/extra"},
		{http.MethodPost, "/api/admin/crawl4ai/quality"},
	}
}

func TestCrawlReadTelemetryStaysLegacyByDefault(t *testing.T) {
	rules := DefaultRules(ModeShadow, "")
	rules = WithCrawlReadTelemetry(rules, "")
	rules = WithCrawlReadTelemetry(rules, "legacy")
	gateway, err := New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range crawlReadTelemetryRoutes() {
		if got := gateway.match(tc.method, tc.path); got.Mode != ModeLegacy {
			t.Fatalf("%s %s mode=%s, want legacy", tc.method, tc.path, got.Mode)
		}
	}
}

func TestCrawlReadTelemetryGoOwnsSevenRoutes(t *testing.T) {
	rules := DefaultRules(ModeShadow, "")
	rules = WithCrawlReadTelemetry(rules, string(ModeGo))
	gateway, err := New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range crawlReadTelemetryRoutes() {
		got := gateway.match(tc.method, tc.path)
		if got.Mode != ModeGo {
			t.Fatalf("%s %s mode=%s, want go", tc.method, tc.path, got.Mode)
		}
		if got.HandlerKey != CrawlReadTelemetryKey {
			t.Fatalf("%s %s key=%s, want %s", tc.method, tc.path, got.HandlerKey, CrawlReadTelemetryKey)
		}
		switch tc.shape {
		case "exact":
			if !got.Exact || got.OneSegment || got.TwoSegments {
				t.Fatalf("%s %s was not exact: %+v", tc.method, tc.path, got)
			}
		case "one":
			if got.Exact || !got.OneSegment || got.TwoSegments {
				t.Fatalf("%s %s was not one segment: %+v", tc.method, tc.path, got)
			}
		case "two":
			if got.Exact || got.OneSegment || !got.TwoSegments {
				t.Fatalf("%s %s was not two segments: %+v", tc.method, tc.path, got)
			}
		}
	}
	// CORS preflight on the seven paths is answered by Go for the registered
	// methods; the write queue preflight is not registered at all.
	for _, tc := range crawlReadTelemetryRoutes() {
		if got := gateway.match(http.MethodOptions, tc.path); got.Mode != ModeGo {
			t.Fatalf("OPTIONS %s mode=%s, want go", tc.path, got.Mode)
		}
	}
}

func TestCrawlReadTelemetryUnmigratedRoutesStayNest(t *testing.T) {
	rules := DefaultRules(ModeShadow, "")
	rules = WithCrawlReadTelemetry(rules, string(ModeGo))
	gateway, err := New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range crawlReadTelemetryNestRoutes() {
		if got := gateway.match(tc.method, tc.path); got.Mode != ModeLegacy {
			t.Fatalf("%s %s mode=%s, want legacy", tc.method, tc.path, got.Mode)
		}
	}
}
