package legacyproxy

import (
	"net/http"
	"testing"
)

// crawlFrontierWriteRoutes are the three routes API_GO_CRAWL_FRONTIER_WRITES_MODE
// takes over when it is go.
func crawlFrontierWriteRoutes() []struct{ method, path string } {
	return []struct{ method, path string }{
		{http.MethodPost, "/api/admin/crawl-frontier/runs"},
		{http.MethodPost, "/api/admin/crawl-frontier/nodes/retry"},
		{http.MethodPost, "/api/admin/crawl-frontier/nodes/node-1/retry"},
	}
}

// TestCrawlFrontierWritesStayLegacyByDefault proves the default keeps every path
// on NestJS: an unset and an explicit legacy switch add no rules at all.
func TestCrawlFrontierWritesStayLegacyByDefault(t *testing.T) {
	for _, mode := range []string{"", "legacy"} {
		rules := WithCrawlFrontierWrites(DefaultRules(ModeShadow, ""), mode)
		gateway, err := New("http://legacy:4000", rules)
		if err != nil {
			t.Fatal(err)
		}
		for _, tc := range crawlFrontierWriteRoutes() {
			if got := gateway.match(tc.method, tc.path); got.Mode != ModeLegacy {
				t.Fatalf("mode %q: %s %s matched %+v, want legacy", mode, tc.method, tc.path, got)
			}
		}
	}
}

// TestCrawlFrontierWritesGoOwnsRoutes covers the go table, including the CORS
// preflight on each route.
func TestCrawlFrontierWritesGoOwnsRoutes(t *testing.T) {
	rules := WithCrawlFrontierWrites(DefaultRules(ModeShadow, ""), string(ModeGo))
	gateway, err := New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range crawlFrontierWriteRoutes() {
		got := gateway.match(tc.method, tc.path)
		if got.Mode != ModeGo || got.HandlerKey != CrawlFrontierWritesKey {
			t.Fatalf("%s %s rule=%+v, want go key %s", tc.method, tc.path, got, CrawlFrontierWritesKey)
		}
		preflight := gateway.match(http.MethodOptions, tc.path)
		if preflight.Mode != ModeGo || preflight.HandlerKey != CrawlFrontierWritesKey {
			t.Fatalf("OPTIONS %s rule=%+v, want go", tc.path, preflight)
		}
	}

	// nodes/retry must be an exact rule: with a segment rule on the /nodes/
	// prefix, "retry" would be read as the :id of nodes/:id/retry.
	bulkRetry := gateway.match(http.MethodPost, "/api/admin/crawl-frontier/nodes/retry")
	if !bulkRetry.Exact {
		t.Fatalf("nodes/retry rule=%+v, want an exact rule", bulkRetry)
	}
	singleRetry := gateway.match(http.MethodPost, "/api/admin/crawl-frontier/nodes/node-1/retry")
	if !singleRetry.OneSegment || singleRetry.Tail != "/retry" {
		t.Fatalf("nodes/:id/retry rule=%+v, want one segment with the /retry tail", singleRetry)
	}
}

// TestCrawlFrontierWritesDoNotClaimOtherShapes guards the inverse direction: the
// switch must not steal methods or path shapes that belong to NestJS or to the
// read switch.
func TestCrawlFrontierWritesDoNotClaimOtherShapes(t *testing.T) {
	rules := WithCrawlFrontierWrites(DefaultRules(ModeShadow, ""), string(ModeGo))
	gateway, err := New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/api/admin/crawl-frontier/runs"},
		{http.MethodPut, "/api/admin/crawl-frontier/runs"},
		{http.MethodDelete, "/api/admin/crawl-frontier/runs"},
		{http.MethodPost, "/api/admin/crawl-frontier/runs/cancel"},
		{http.MethodPost, "/api/admin/crawl-frontier/runs/run-1/retry"},
		{http.MethodGet, "/api/admin/crawl-frontier/nodes/retry"},
		{http.MethodPost, "/api/admin/crawl-frontier/nodes/retry/extra"},
		{http.MethodPost, "/api/admin/crawl-frontier/nodes/node-1"},
		{http.MethodPost, "/api/admin/crawl-frontier/nodes/node-1/retry/extra"},
		{http.MethodPost, "/api/admin/crawl-frontier/workflow-runs/wrun-1/replay"},
	} {
		if got := gateway.match(tc.method, tc.path); got.Mode != ModeLegacy {
			t.Fatalf("%s %s matched %+v, want legacy", tc.method, tc.path, got)
		}
	}
}

// TestCrawlFrontierWritesAndRunsShareThePrefix runs the two switches together,
// which config.go forces in go mode. Each route keeps exactly one owner.
func TestCrawlFrontierWritesAndRunsShareThePrefix(t *testing.T) {
	rules := DefaultRules(ModeShadow, "")
	rules = WithCrawlFrontierRuns(rules, string(ModeGo))
	rules = WithCrawlFrontierWrites(rules, string(ModeGo))
	gateway, err := New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		method string
		path   string
		key    string
	}{
		{http.MethodGet, "/api/admin/crawl-frontier/runs", CrawlFrontierRunsKey},
		{http.MethodGet, "/api/admin/crawl-frontier/runs/run-1", CrawlFrontierRunsKey},
		{http.MethodPost, "/api/admin/crawl-frontier/runs/cancel", CrawlFrontierRunsKey},
		{http.MethodGet, "/api/admin/crawl-frontier/nodes/node-1", CrawlFrontierRunsKey},
		{http.MethodPost, "/api/admin/crawl-frontier/runs", CrawlFrontierWritesKey},
		{http.MethodPost, "/api/admin/crawl-frontier/nodes/retry", CrawlFrontierWritesKey},
		{http.MethodPost, "/api/admin/crawl-frontier/nodes/node-1/retry", CrawlFrontierWritesKey},
	}
	for _, tc := range cases {
		got := gateway.match(tc.method, tc.path)
		if got.Mode != ModeGo || got.HandlerKey != tc.key {
			t.Fatalf("%s %s rule=%+v, want go key %s", tc.method, tc.path, got, tc.key)
		}
	}
}
