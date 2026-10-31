package legacyproxy

import (
	"net/http"
	"testing"
)

// TestCrawlTaskWriteRulesGo pins the three crawl task write routes and the
// method scoping of the crawl task read paths.
func TestCrawlTaskWriteRulesGo(t *testing.T) {
	gateway := New(WithCrawlQueueOps(WithCrawlTaskWrite(nil)))

	owned := []struct{ method, path string }{
		{http.MethodPost, "/api/crawl-tasks"},
		{http.MethodDelete, "/api/crawl-tasks/task-1"},
		{http.MethodPost, "/api/crawl-tasks/task-1/retry"},
	}
	for _, test := range owned {
		rule, matched := gateway.matchRule(test.method, test.path)
		if !matched || rule.HandlerKey != CrawlTaskWriteKey {
			t.Fatalf("%s %s = %+v matched=%v, want %q", test.method, test.path, rule, matched, CrawlTaskWriteKey)
		}
	}
	for _, test := range []struct{ method, path string }{
		{http.MethodGet, "/api/crawl-tasks"},
		{http.MethodGet, "/api/crawl-tasks/task-1"},
		{http.MethodPost, "/api/crawl-tasks/metadata"},
		{http.MethodPut, "/api/crawl-tasks"},
		{http.MethodPost, "/api/crawl-tasks/task-1/other"},
	} {
		if _, matched := gateway.matchRule(test.method, test.path); matched {
			t.Fatalf("%s %s unexpectedly matched", test.method, test.path)
		}
	}
}

// TestCrawlQueueOpsRules pins the four crawl4ai queue administration routes and
// the method scoping of the queue path.
func TestCrawlQueueOpsRules(t *testing.T) {
	gateway := New(WithCrawlQueueOps(WithCrawlTaskWrite(nil)))

	owned := []struct{ method, path string }{
		{http.MethodGet, "/api/admin/crawl4ai/queue"},
		{http.MethodPost, "/api/admin/crawl4ai/queue/pause"},
		{http.MethodPost, "/api/admin/crawl4ai/queue/resume"},
		{http.MethodPost, "/api/admin/crawl4ai/queue/concurrency"},
	}
	for _, test := range owned {
		rule, matched := gateway.matchRule(test.method, test.path)
		if !matched || rule.HandlerKey != CrawlQueueOpsKey {
			t.Fatalf("%s %s = %+v matched=%v, want %q", test.method, test.path, rule, matched, CrawlQueueOpsKey)
		}
	}
	for _, test := range []struct{ method, path string }{
		{http.MethodDelete, "/api/admin/crawl4ai/queue"},
		{http.MethodGet, "/api/admin/crawl4ai/queue/pause"},
		{http.MethodPost, "/api/admin/crawl4ai/queue/other"},
	} {
		if _, matched := gateway.matchRule(test.method, test.path); matched {
			t.Fatalf("%s %s unexpectedly matched", test.method, test.path)
		}
	}
}
