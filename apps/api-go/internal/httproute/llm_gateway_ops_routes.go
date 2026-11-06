package httproute

import "net/http"

// LLMGatewayOpsKey is the handler registration key for the twelve governance and
// diagnostics routes. One key is enough because the handler dispatches on the
// request path and method itself.
const LLMGatewayOpsKey = "/api/system-settings/llm-gateways#ops"

// WithLLMGatewayOps registers the Go router rules for this unit. Every rule is
// method-scoped and registered unconditionally by the always-on Go router;
// a path, method or segment that no rule claims is answered with the
// unmatched-route 404 (the Nest-shaped contract). No request is proxied.
//
// Served routes:
//
//	GET    /api/system-settings/llm-gateways/proxy-governance
//	PUT    /api/system-settings/llm-gateways/proxy-governance
//	DELETE /api/system-settings/llm-gateways/proxy-governance
//	POST   /api/system-settings/llm-gateways/proxy-governance/preflight
//	POST   /api/system-settings/llm-gateways/proxy-governance/rotate-key
//	POST   /api/system-settings/llm-gateways/models-config
//	POST   /api/system-settings/llm-gateways/test-config
//	GET    /api/system-settings/llm-gateways/:id/models
//	POST   /api/system-settings/llm-gateways/:id/test
//	GET    /api/system-settings/llm-gateways/:id/proxy-health
//	GET    /api/system-settings/llm-gateways/:id/proxy-model-info
//	POST   /api/system-settings/llm-gateways/:id/proxy-lb-test
func WithLLMGatewayOps(rules []Rule) []Rule {
	base := "/api/system-settings/llm-gateways"

	rules = appendExactKeyed(rules, LLMGatewayOpsKey, base+"/proxy-governance",
		http.MethodGet, http.MethodPut, http.MethodDelete)
	rules = appendExactKeyed(rules, LLMGatewayOpsKey, base+"/proxy-governance/preflight",
		http.MethodPost)
	rules = appendExactKeyed(rules, LLMGatewayOpsKey, base+"/proxy-governance/rotate-key",
		http.MethodPost)
	rules = appendExactKeyed(rules, LLMGatewayOpsKey, base+"/models-config",
		http.MethodPost)
	rules = appendExactKeyed(rules, LLMGatewayOpsKey, base+"/test-config",
		http.MethodPost)

	rules = appendSegmentRule(rules, LLMGatewayOpsKey, base+"/", true, false, "/models",
		http.MethodGet)
	rules = appendSegmentRule(rules, LLMGatewayOpsKey, base+"/", true, false, "/test",
		http.MethodPost)
	rules = appendSegmentRule(rules, LLMGatewayOpsKey, base+"/", true, false, "/proxy-health",
		http.MethodGet)
	rules = appendSegmentRule(rules, LLMGatewayOpsKey, base+"/", true, false, "/proxy-model-info",
		http.MethodGet)
	return appendSegmentRule(rules, LLMGatewayOpsKey, base+"/", true, false, "/proxy-lb-test",
		http.MethodPost)
}
