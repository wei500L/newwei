package httproute

import "net/http"

// ProxyLoadBalancingKey is the handler registration key for the four LiteLLM
// proxy load balancing routes. A single key is enough because the handler
// dispatches on the request path and method itself.
const ProxyLoadBalancingKey = "/api/system-settings/llm-gateways#proxy-load-balancing"

// WithProxyLoadBalancing registers the Go router rules for this unit. Every rule is
// method-scoped and registered unconditionally by the always-on Go router;
// a path, method or segment that no rule claims is answered with the
// unmatched-route 404 (the Nest-shaped contract). No request is proxied.
//
// Served routes:
//
//	GET    /api/system-settings/llm-gateways/proxy-load-balancing
//	PUT    /api/system-settings/llm-gateways/proxy-load-balancing
//	DELETE /api/system-settings/llm-gateways/proxy-load-balancing
//	GET    /api/internal/litellm/proxy-load-balancing
func WithProxyLoadBalancing(rules []Rule) []Rule {

	rules = appendExactKeyed(rules, ProxyLoadBalancingKey,
		"/api/system-settings/llm-gateways/proxy-load-balancing",
		http.MethodGet, http.MethodPut, http.MethodDelete)

	return appendExactKeyed(rules, ProxyLoadBalancingKey,
		"/api/internal/litellm/proxy-load-balancing", http.MethodGet)
}
