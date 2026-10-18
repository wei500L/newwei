package legacyproxy

import "net/http"

// LLMGatewayOpsKey is the handler registration key for the twelve governance and
// diagnostics routes. One key is enough because the handler dispatches on the
// request path and method itself.
const LLMGatewayOpsKey = "/api/system-settings/llm-gateways#ops"

// WithLLMGatewayOps takes over the twelve governance/diagnostics routes when mode
// is go:
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
//
// Why these rules are more specific than the profile ones:
//   - the five static paths are exact rules whose prefixes are longer than the
//     profile dynamic prefix, so the longest-prefix match picks them first and a
//     PUT/DELETE on /proxy-governance can never be read as a profile id;
//   - the five profile sub-resources are one-segment rules with a fixed tail, so
//     they match exactly one more path segment and every longer path keeps
//     falling back to the legacy /api/ prefix.
//
// This function never registers a rule for the collection path, the three
// activation paths or the bare :id item, which stay owned by
// WithLLMGatewayProfiles. An empty or legacy mode adds nothing, so the default
// deployment is unchanged and rollback only flips this one switch.
func WithLLMGatewayOps(rules []Rule, mode string) []Rule {
	if mode != string(ModeGo) {
		return rules
	}
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
