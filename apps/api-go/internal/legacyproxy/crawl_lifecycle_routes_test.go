package legacyproxy

import (
	"net/http"
	"testing"
)

func lifecycleGateway(t *testing.T, taskMode, queueMode string) *Gateway {
	t.Helper()
	rules := WithCrawlTaskWrite(nil, taskMode)
	rules = WithCrawlQueueOps(rules, queueMode)
	gateway, err := New("http://localhost:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	return gateway
}

func TestCrawlTaskWriteRulesGo(t *testing.T) {
	gateway := lifecycleGateway(t, string(ModeGo), "")
	cases := []struct {
		method string
		path   string
		want   Mode
	}{
		{http.MethodPost, "/api/crawl-tasks", ModeGo},
		{http.MethodDelete, "/api/crawl-tasks/task-1", ModeGo},
		{http.MethodPost, "/api/crawl-tasks/task-1/retry", ModeGo},
		{http.MethodGet, "/api/crawl-tasks", ModeLegacy},
		{http.MethodGet, "/api/crawl-tasks/task-1", ModeLegacy},
		{http.MethodPost, "/api/crawl-tasks/metadata", ModeLegacy},
		{http.MethodPut, "/api/crawl-tasks", ModeLegacy},
		{http.MethodPost, "/api/crawl-tasks/task-1/other", ModeLegacy},
	}
	for _, test := range cases {
		got := gateway.match(test.method, test.path)
		if got.Mode != test.want {
			t.Fatalf("%s %s mode = %s, want %s", test.method, test.path, got.Mode, test.want)
		}
	}
}

func TestCrawlTaskWriteRulesLegacy(t *testing.T) {
	gateway := lifecycleGateway(t, string(ModeLegacy), "")
	for _, test := range []struct{ method, path string }{
		{http.MethodPost, "/api/crawl-tasks"},
		{http.MethodDelete, "/api/crawl-tasks/task-1"},
		{http.MethodPost, "/api/crawl-tasks/task-1/retry"},
	} {
		if got := gateway.match(test.method, test.path); got.Mode != ModeLegacy {
			t.Fatalf("%s %s mode = %s", test.method, test.path, got.Mode)
		}
	}
}

func TestCrawlQueueOpsRules(t *testing.T) {
	gateway := lifecycleGateway(t, "", string(ModeGo))
	cases := []struct {
		method string
		path   string
		want   Mode
	}{
		{http.MethodGet, "/api/admin/crawl4ai/queue", ModeGo},
		{http.MethodPost, "/api/admin/crawl4ai/queue/pause", ModeGo},
		{http.MethodPost, "/api/admin/crawl4ai/queue/resume", ModeGo},
		{http.MethodPost, "/api/admin/crawl4ai/queue/concurrency", ModeGo},
		{http.MethodDelete, "/api/admin/crawl4ai/queue", ModeLegacy},
		{http.MethodGet, "/api/admin/crawl4ai/queue/pause", ModeLegacy},
		{http.MethodPost, "/api/admin/crawl4ai/queue/other", ModeLegacy},
	}
	for _, test := range cases {
		got := gateway.match(test.method, test.path)
		if got.Mode != test.want {
			t.Fatalf("%s %s mode = %s, want %s", test.method, test.path, got.Mode, test.want)
		}
	}
}

func TestCrawlQueueOpsRulesLegacy(t *testing.T) {
	gateway := lifecycleGateway(t, "", "")
	if got := gateway.match(http.MethodGet, "/api/admin/crawl4ai/queue"); got.Mode != ModeLegacy {
		t.Fatalf("legacy mode = %s", got.Mode)
	}
}
