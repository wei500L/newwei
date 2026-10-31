package legacyproxy

import (
	"net/http"
	"testing"
)

// TestCrawlMetadataStaysLegacyByDefault pins that an unset, empty or legacy
// switch adds no rule at all.

// TestCrawlMetadataGoOwnsOnlyTheExactPost pins the exact takeover boundary: the
// POST and its CORS preflight, and nothing else.
func TestCrawlMetadataGoOwnsOnlyTheExactPost(t *testing.T) {
	rules := BaseRules()
	rules = WithCrawlMetadata(rules)
	gateway := New(rules)

	post := gateway.match(http.MethodPost, "/api/crawl-tasks/metadata")
	if post.Prefix == "" || !post.Exact || post.HandlerKey != CrawlMetadataKey {
		t.Fatalf("POST rule = %+v", post)
	}
	options := gateway.match(http.MethodOptions, "/api/crawl-tasks/metadata")
	if options.Prefix == "" || !options.Exact || options.HandlerKey != CrawlMetadataKey {
		t.Fatalf("OPTIONS rule = %+v", options)
	}

	for _, tc := range []struct{ method, path string }{
		// GET keeps the existing GET /api/crawl-tasks/:id ownership.
		{http.MethodGet, "/api/crawl-tasks/metadata"},
		{http.MethodPut, "/api/crawl-tasks/metadata"},
		{http.MethodDelete, "/api/crawl-tasks/metadata"},
		// The trailing-slash and longer paths are different routes.
		{http.MethodPost, "/api/crawl-tasks/metadata/"},
		{http.MethodPost, "/api/crawl-tasks/metadata/extra"},
		// The neighbouring crawl task writes are not part of this batch.
		{http.MethodPost, "/api/crawl-tasks"},
		{http.MethodPost, "/api/crawl-tasks/task-1/retry"},
		{http.MethodDelete, "/api/crawl-tasks/task-1"},
		{http.MethodPost, "/api/admin/crawl4ai/queue/pause"},
	} {
		if got := gateway.match(tc.method, tc.path); got.Prefix != "" {
			t.Fatalf("%s %s mode=%s want legacy", tc.method, tc.path, got.Prefix)
		}
	}
}

// TestCrawlMetadataDoesNotChangeCrawlTaskDetailOwnership pins that the existing
// GET /api/crawl-tasks/:id rule keeps owning GET /api/crawl-tasks/metadata when
// the crawl read telemetry switch is on.
func TestCrawlMetadataDoesNotChangeCrawlTaskDetailOwnership(t *testing.T) {
	rules := BaseRules()
	rules = WithCrawlReadTelemetry(rules)
	rules = WithCrawlMetadata(rules)
	gateway := New(rules)
	got := gateway.match(http.MethodGet, "/api/crawl-tasks/metadata")
	if got.Prefix == "" || got.HandlerKey != CrawlReadTelemetryKey {
		t.Fatalf("GET ownership = %+v", got)
	}
	if post := gateway.match(http.MethodPost, "/api/crawl-tasks/metadata"); post.HandlerKey != CrawlMetadataKey {
		t.Fatalf("POST ownership = %+v", post)
	}
}
