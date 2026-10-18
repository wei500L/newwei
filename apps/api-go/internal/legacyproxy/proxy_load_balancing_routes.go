package legacyproxy

import "net/http"

// ProxyLoadBalancingKey is the handler registration key for the four LiteLLM
// proxy load balancing routes. A single key is enough because the handler
// dispatches on the request path and method itself.
const ProxyLoadBalancingKey = "/api/system-settings/llm-gateways#proxy-load-balancing"

// WithProxyLoadBalancing takes over the four LiteLLM proxy load balancing
// configuration and distribution routes when mode is go:
//
//	GET    /api/system-settings/llm-gateways/proxy-load-balancing
//	PUT    /api/system-settings/llm-gateways/proxy-load-balancing
//	DELETE /api/system-settings/llm-gateways/proxy-load-balancing
//	GET    /api/internal/litellm/proxy-load-balancing
//
// Both paths are EXACT rules, so the two static paths can never be captured by
// the llm-gateways :id profile route (PR #59): that rule matches one dynamic
// segment under /api/system-settings/llm-gateways/, which is a shorter prefix
// and therefore loses to these exact rules. No other method, trailing slash,
// longer path or sibling llm-gateways route is registered here, so
// proxy-governance, the profile CRUD routes and every unmigrated settings route
// keep falling back to the legacy /api/ proxy.
//
// OPTIONS is whitelisted on each taken-over path so CORS preflight is answered
// by the Go handler; a non-preflight OPTIONS keeps the previous proxy
// destination. An empty or legacy mode adds nothing, so the default deployment
// is unchanged and rollback is a single environment variable change.
func WithProxyLoadBalancing(rules []Rule, mode string) []Rule {
	if mode != string(ModeGo) {
		return rules
	}

	rules = appendExactKeyed(rules, ProxyLoadBalancingKey,
		"/api/system-settings/llm-gateways/proxy-load-balancing",
		http.MethodGet, http.MethodPut, http.MethodDelete)

	return appendExactKeyed(rules, ProxyLoadBalancingKey,
		"/api/internal/litellm/proxy-load-balancing", http.MethodGet)
}
