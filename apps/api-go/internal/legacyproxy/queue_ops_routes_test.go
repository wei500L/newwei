package legacyproxy

import (
	"net/http"
	"testing"
)

var queueOpsPaths = []string{
	"/api/admin/queue-ops/queues",
	"/api/admin/queue-ops/jobs",
	"/api/admin/queue-ops/jobs/detail",
	"/api/admin/queue-ops/jobs/retry",
	"/api/admin/queue-ops/jobs/delete",
	"/api/admin/queue-ops/jobs/promote",
	"/api/admin/queue-ops/queues/retry-failed",
	"/api/admin/queue-ops/queues/clean",
	"/api/admin/queue-ops/queues/pause",
	"/api/admin/queue-ops/queues/resume",
	"/api/admin/queue-ops/dlq/replay",
	"/api/admin/queue-ops/dlq/delete",
}

// TestWithQueueOpsRoutes pins the exact method/path ownership of the twelve
// console routes and proves no neighbouring rule shadows them.
func TestWithQueueOpsRoutes(t *testing.T) {
	gateway := New(WithQueueOps(BaseRules()))

	cases := []struct {
		method  string
		path    string
		wantKey string // empty means "must not match anything"
	}{
		{http.MethodGet, "/api/admin/queue-ops/queues", QueueOpsKey},
		{http.MethodGet, "/api/admin/queue-ops/jobs", QueueOpsKey},
		{http.MethodGet, "/api/admin/queue-ops/jobs/detail", QueueOpsKey},
		{http.MethodPost, "/api/admin/queue-ops/jobs/retry", QueueOpsKey},
		{http.MethodPost, "/api/admin/queue-ops/jobs/delete", QueueOpsKey},
		{http.MethodPost, "/api/admin/queue-ops/jobs/promote", QueueOpsKey},
		{http.MethodPost, "/api/admin/queue-ops/queues/retry-failed", QueueOpsKey},
		{http.MethodPost, "/api/admin/queue-ops/queues/clean", QueueOpsKey},
		{http.MethodPost, "/api/admin/queue-ops/queues/pause", QueueOpsKey},
		{http.MethodPost, "/api/admin/queue-ops/queues/resume", QueueOpsKey},
		{http.MethodPost, "/api/admin/queue-ops/dlq/replay", QueueOpsKey},
		{http.MethodPost, "/api/admin/queue-ops/dlq/delete", QueueOpsKey},
		// appendExactKeyed adds OPTIONS to every rule so a CORS preflight
		// reaches the Go handler.
		{http.MethodOptions, "/api/admin/queue-ops/queues", QueueOpsKey},
		{http.MethodOptions, "/api/admin/queue-ops/jobs", QueueOpsKey},
		{http.MethodOptions, "/api/admin/queue-ops/jobs/detail", QueueOpsKey},
		{http.MethodOptions, "/api/admin/queue-ops/jobs/retry", QueueOpsKey},
		{http.MethodOptions, "/api/admin/queue-ops/jobs/delete", QueueOpsKey},
		{http.MethodOptions, "/api/admin/queue-ops/jobs/promote", QueueOpsKey},
		{http.MethodOptions, "/api/admin/queue-ops/queues/retry-failed", QueueOpsKey},
		{http.MethodOptions, "/api/admin/queue-ops/queues/clean", QueueOpsKey},
		{http.MethodOptions, "/api/admin/queue-ops/queues/pause", QueueOpsKey},
		{http.MethodOptions, "/api/admin/queue-ops/queues/resume", QueueOpsKey},
		{http.MethodOptions, "/api/admin/queue-ops/dlq/replay", QueueOpsKey},
		{http.MethodOptions, "/api/admin/queue-ops/dlq/delete", QueueOpsKey},
		// Other methods on the same paths are not claimed.
		{http.MethodGet, "/api/admin/queue-ops/jobs/retry", ""},
		{http.MethodPost, "/api/admin/queue-ops/jobs", ""},
		{http.MethodPost, "/api/admin/queue-ops/queues", ""},
		{http.MethodGet, "/api/admin/queue-ops/queues/clean", ""},
		{http.MethodDelete, "/api/admin/queue-ops/jobs/delete", ""},
		// Longer paths and trailing slashes are never exact matches.
		{http.MethodGet, "/api/admin/queue-ops/jobs/extra", ""},
		{http.MethodGet, "/api/admin/queue-ops/queues/", ""},
		{http.MethodPost, "/api/admin/queue-ops/dlq/replay/extra", ""},
		{http.MethodGet, "/api/admin/queue-ops", ""},
	}
	for _, testCase := range cases {
		rule, matched := gateway.matchRule(testCase.method, testCase.path)
		if testCase.wantKey == "" {
			if matched {
				t.Errorf("%s %s unexpectedly matched rule %q", testCase.method, testCase.path, rule.Prefix)
			}
			continue
		}
		if !matched {
			t.Errorf("%s %s matched nothing, want %q", testCase.method, testCase.path, testCase.wantKey)
			continue
		}
		key := rule.Prefix
		if rule.HandlerKey != "" {
			key = rule.HandlerKey
		}
		if key != testCase.wantKey {
			t.Errorf("%s %s key = %q, want %q", testCase.method, testCase.path, key, testCase.wantKey)
		}
	}
}

// TestWithQueueOpsAddsTwelveRules proves the rule count matches the contract so a
// missing route cannot hide behind an exact-path wildcard.
func TestWithQueueOpsAddsTwelveRules(t *testing.T) {
	base := BaseRules()
	rules := WithQueueOps(base)
	if added := len(rules) - len(base); added != 12 {
		t.Fatalf("added %d rules, want 12", added)
	}
	seen := map[string]bool{}
	for _, rule := range rules[len(base):] {
		if rule.HandlerKey != QueueOpsKey || !rule.Exact {
			t.Fatalf("rule = %+v", rule)
		}
		if !rule.Methods[http.MethodOptions] {
			t.Fatalf("rule %q has no OPTIONS method", rule.Prefix)
		}
		seen[rule.Prefix] = true
	}
	for _, path := range queueOpsPaths {
		if !seen[path] {
			t.Fatalf("missing queue-ops rule %q", path)
		}
	}
}
