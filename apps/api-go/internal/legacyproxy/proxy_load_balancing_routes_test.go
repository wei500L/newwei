package legacyproxy

import (
	"net/http"
	"testing"
)

// proxyLoadBalancingRoutes lists the four routes the go mode must own.
func proxyLoadBalancingRoutes() []struct {
	method string
	path   string
} {
	return []struct {
		method string
		path   string
	}{
		{http.MethodGet, "/api/system-settings/llm-gateways/proxy-load-balancing"},
		{http.MethodPut, "/api/system-settings/llm-gateways/proxy-load-balancing"},
		{http.MethodDelete, "/api/system-settings/llm-gateways/proxy-load-balancing"},
		{http.MethodGet, "/api/internal/litellm/proxy-load-balancing"},
	}
}

// newProxyLoadBalancingGateway builds a gateway with the load balancing rules in
// the given mode.
func newProxyLoadBalancingGateway(t *testing.T) *Gateway {
	t.Helper()
	rules := BaseRules()
	rules = WithProxyLoadBalancing(rules)
	gateway := New(rules)
	return gateway
}

// TestProxyLoadBalancingStaysLegacyByDefault proves an unset/legacy mode adds
// nothing.

// TestProxyLoadBalancingGoOwnsFourExactRoutes proves the exact ownership and the
// rule shape.
func TestProxyLoadBalancingGoOwnsFourExactRoutes(t *testing.T) {
	gateway := newProxyLoadBalancingGateway(t)
	routes := proxyLoadBalancingRoutes()
	if len(routes) != 4 {
		t.Fatalf("the batch owns four routes, the table lists %d", len(routes))
	}
	for _, testCase := range routes {
		got := gateway.match(testCase.method, testCase.path)
		if got.Prefix == "" {
			t.Fatalf("%s %s mode=%s, want go", testCase.method, testCase.path, got.Prefix)
		}
		if got.HandlerKey != ProxyLoadBalancingKey {
			t.Fatalf("%s %s key=%s, want %s", testCase.method, testCase.path, got.HandlerKey, ProxyLoadBalancingKey)
		}
		if !got.Exact || got.OneSegment {
			t.Fatalf("%s %s must be an exact rule: %+v", testCase.method, testCase.path, got)
		}
	}
	// CORS preflight on the taken-over paths is answered by Go.
	for _, testCase := range routes {
		if got := gateway.match(http.MethodOptions, testCase.path); got.Prefix == "" {
			t.Fatalf("OPTIONS %s mode=%s, want go", testCase.path, got.Prefix)
		}
	}
}

// TestProxyLoadBalancingDoesNotCaptureSiblings proves nothing else is captured,
// including other methods on the taken-over paths.
func TestProxyLoadBalancingDoesNotCaptureSiblings(t *testing.T) {
	gateway := newProxyLoadBalancingGateway(t)
	for _, testCase := range []struct{ method, path string }{
		{http.MethodGet, "/api/system-settings/llm-gateways"},
		{http.MethodPost, "/api/system-settings/llm-gateways"},
		{http.MethodGet, "/api/system-settings/llm-gateways/active"},
		{http.MethodPut, "/api/system-settings/llm-gateways/proxy-governance"},
		{http.MethodDelete, "/api/system-settings/llm-gateways/proxy-governance"},
		{http.MethodPost, "/api/system-settings/llm-gateways/proxy-load-balancing"},
		{http.MethodGet, "/api/system-settings/llm-gateways/proxy-load-balancing/extra"},
		{http.MethodGet, "/api/system-settings/llm-gateways/proxy-load-balancing/"},
		{http.MethodPost, "/api/internal/litellm/proxy-load-balancing"},
		{http.MethodGet, "/api/internal/litellm/proxy-load-balancing/extra"},
	} {
		if got := gateway.match(testCase.method, testCase.path); got.Prefix != "" {
			t.Fatalf("%s %s mode=%s, want legacy", testCase.method, testCase.path, got.Prefix)
		}
	}
}

// TestProxyLoadBalancingWinsOverTheProfileIdRule proves the exact static path
// beats the llm-gateways :id segment rule PR #59 registers, while that rule keeps
// owning real profile ids.
func TestProxyLoadBalancingWinsOverTheProfileIdRule(t *testing.T) {
	const simulatedProfilesKey = "/api/system-settings/llm-gateways#profiles"

	rules := BaseRules()
	rules = appendSegmentRule(rules, simulatedProfilesKey,
		"/api/system-settings/llm-gateways/", true, false, "",
		http.MethodPut, http.MethodDelete)
	rules = WithProxyLoadBalancing(rules)
	gateway := New(rules)

	for _, method := range []string{http.MethodPut, http.MethodDelete} {
		got := gateway.match(method, "/api/system-settings/llm-gateways/proxy-load-balancing")
		if got.Prefix == "" || got.HandlerKey != ProxyLoadBalancingKey {
			t.Fatalf("%s proxy-load-balancing resolved to mode=%s key=%s", method, got.Prefix, got.HandlerKey)
		}
		if got := gateway.match(method, "/api/system-settings/llm-gateways/abc123"); got.Prefix == "" || got.HandlerKey != simulatedProfilesKey {
			t.Fatalf("%s :id resolved to mode=%s key=%s", method, got.Prefix, got.HandlerKey)
		}
	}
}
