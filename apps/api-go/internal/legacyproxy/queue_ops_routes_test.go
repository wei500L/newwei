package legacyproxy

import (
	"net/http"
	"testing"
)

// TestWithQueueOpsRoutes pins the exact method/path ownership of the twelve
// console routes and proves no neighbouring rule shadows them.
func TestWithQueueOpsRoutes(t *testing.T) {
	rules := DefaultRulesWithWrite("", "", "")
	rules = WithQueueOps(rules, string(ModeGo))
	gateway := &Gateway{rules: rules}

	cases := []struct {
		method   string
		path     string
		wantKey  string
		wantMode Mode
	}{
		{http.MethodGet, "/api/admin/queue-ops/queues", QueueOpsKey, ModeGo},
		{http.MethodGet, "/api/admin/queue-ops/jobs", QueueOpsKey, ModeGo},
		{http.MethodGet, "/api/admin/queue-ops/jobs/detail", QueueOpsKey, ModeGo},
		{http.MethodPost, "/api/admin/queue-ops/jobs/retry", QueueOpsKey, ModeGo},
		{http.MethodPost, "/api/admin/queue-ops/jobs/delete", QueueOpsKey, ModeGo},
		{http.MethodPost, "/api/admin/queue-ops/jobs/promote", QueueOpsKey, ModeGo},
		{http.MethodPost, "/api/admin/queue-ops/queues/retry-failed", QueueOpsKey, ModeGo},
		{http.MethodPost, "/api/admin/queue-ops/queues/clean", QueueOpsKey, ModeGo},
		{http.MethodPost, "/api/admin/queue-ops/queues/pause", QueueOpsKey, ModeGo},
		{http.MethodPost, "/api/admin/queue-ops/queues/resume", QueueOpsKey, ModeGo},
		{http.MethodPost, "/api/admin/queue-ops/dlq/replay", QueueOpsKey, ModeGo},
		{http.MethodPost, "/api/admin/queue-ops/dlq/delete", QueueOpsKey, ModeGo},
		// appendExactKeyed adds OPTIONS to every rule so a CORS preflight
		// reaches the Go handler.
		{http.MethodOptions, "/api/admin/queue-ops/queues", QueueOpsKey, ModeGo},
		{http.MethodOptions, "/api/admin/queue-ops/jobs", QueueOpsKey, ModeGo},
		{http.MethodOptions, "/api/admin/queue-ops/jobs/detail", QueueOpsKey, ModeGo},
		{http.MethodOptions, "/api/admin/queue-ops/jobs/retry", QueueOpsKey, ModeGo},
		{http.MethodOptions, "/api/admin/queue-ops/jobs/delete", QueueOpsKey, ModeGo},
		{http.MethodOptions, "/api/admin/queue-ops/jobs/promote", QueueOpsKey, ModeGo},
		{http.MethodOptions, "/api/admin/queue-ops/queues/retry-failed", QueueOpsKey, ModeGo},
		{http.MethodOptions, "/api/admin/queue-ops/queues/clean", QueueOpsKey, ModeGo},
		{http.MethodOptions, "/api/admin/queue-ops/queues/pause", QueueOpsKey, ModeGo},
		{http.MethodOptions, "/api/admin/queue-ops/queues/resume", QueueOpsKey, ModeGo},
		{http.MethodOptions, "/api/admin/queue-ops/dlq/replay", QueueOpsKey, ModeGo},
		{http.MethodOptions, "/api/admin/queue-ops/dlq/delete", QueueOpsKey, ModeGo},
		// Other methods on the same paths keep falling back to /api/.
		{http.MethodGet, "/api/admin/queue-ops/jobs/retry", "/api/", ModeLegacy},
		{http.MethodPost, "/api/admin/queue-ops/jobs", "/api/", ModeLegacy},
		{http.MethodPost, "/api/admin/queue-ops/queues", "/api/", ModeLegacy},
		{http.MethodGet, "/api/admin/queue-ops/queues/clean", "/api/", ModeLegacy},
		{http.MethodDelete, "/api/admin/queue-ops/jobs/delete", "/api/", ModeLegacy},
		// Longer paths and trailing slashes are never exact matches.
		{http.MethodGet, "/api/admin/queue-ops/jobs/extra", "/api/", ModeLegacy},
		{http.MethodGet, "/api/admin/queue-ops/queues/", "/api/", ModeLegacy},
		{http.MethodPost, "/api/admin/queue-ops/dlq/replay/extra", "/api/", ModeLegacy},
		{http.MethodGet, "/api/admin/queue-ops", "/api/", ModeLegacy},
		// Bull Board keeps its own exact legacy rule; the crawl4ai queue route
		// is only claimed when its own switch is go (not here).
		{http.MethodGet, "/admin/queues", "/admin/queues", ModeLegacy},
		{http.MethodGet, "/api/admin/crawl4ai/queue", "/api/", ModeLegacy},
	}
	for _, testCase := range cases {
		rule := gateway.match(testCase.method, testCase.path)
		if rule.Mode != testCase.wantMode {
			t.Errorf("%s %s mode = %q, want %q", testCase.method, testCase.path, rule.Mode, testCase.wantMode)
		}
		if rule.HandlerKey != "" {
			if rule.HandlerKey != testCase.wantKey {
				t.Errorf("%s %s key = %q, want %q", testCase.method, testCase.path, rule.HandlerKey, testCase.wantKey)
			}
		} else if rule.Prefix != testCase.wantKey {
			t.Errorf("%s %s prefix = %q, want %q", testCase.method, testCase.path, rule.Prefix, testCase.wantKey)
		}
	}
}

// TestWithQueueOpsLegacyAddsNothing proves the default deployment is untouched:
// with the legacy mode the paths fall through to the legacy proxy, where NestJS
// (which never served /api/admin/queue-ops) answers 404.
func TestWithQueueOpsLegacyAddsNothing(t *testing.T) {
	base := DefaultRulesWithWrite("", "", "")
	for _, mode := range []string{"", string(ModeLegacy)} {
		rules := WithQueueOps(base, mode)
		if len(rules) != len(base) {
			t.Fatalf("mode %q added %d rules", mode, len(rules)-len(base))
		}
	}
}

// TestWithQueueOpsAddsTwelveRules proves the rule count matches the contract so a
// missing route cannot hide behind an exact-path wildcard.
func TestWithQueueOpsAddsTwelveRules(t *testing.T) {
	base := DefaultRulesWithWrite("", "", "")
	rules := WithQueueOps(base, string(ModeGo))
	if added := len(rules) - len(base); added != 12 {
		t.Fatalf("added %d rules, want 12", added)
	}
	for _, rule := range rules[len(base):] {
		if rule.HandlerKey != QueueOpsKey || !rule.Exact || rule.Mode != ModeGo {
			t.Fatalf("rule = %+v", rule)
		}
		if !rule.Methods[http.MethodOptions] {
			t.Fatalf("rule %q has no OPTIONS method", rule.Prefix)
		}
	}
}
