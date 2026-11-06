package httproute

import "net/http"

// LLMGatewayProfilesKey is the handler registration key for the seven LLM
// gateway configuration-control routes. A single key is enough because the
// handler dispatches on the request path and method itself.
const LLMGatewayProfilesKey = "/api/system-settings/llm-gateways#profiles"

// WithLLMGatewayProfiles registers the Go router rules for this unit. Every rule is
// method-scoped and registered unconditionally by the always-on Go router;
// a path, method or segment that no rule claims is answered with the
// unmatched-route 404 (the Nest-shaped contract). No request is proxied.
//
// Served routes:
//
//	GET    /api/system-settings/llm-gateways
//	POST   /api/system-settings/llm-gateways
//	PUT    /api/system-settings/llm-gateways/active
//	PUT    /api/system-settings/llm-gateways/embedding-active
//	PUT    /api/system-settings/llm-gateways/rerank-active
//	PUT    /api/system-settings/llm-gateways/:id
//	DELETE /api/system-settings/llm-gateways/:id
func WithLLMGatewayProfiles(rules []Rule) []Rule {
	base := "/api/system-settings/llm-gateways"

	rules = appendExactKeyed(rules, LLMGatewayProfilesKey, base,
		http.MethodGet, http.MethodPost)
	rules = appendExactKeyed(rules, LLMGatewayProfilesKey, base+"/active",
		http.MethodPut)
	rules = appendExactKeyed(rules, LLMGatewayProfilesKey, base+"/embedding-active",
		http.MethodPut)
	rules = appendExactKeyed(rules, LLMGatewayProfilesKey, base+"/rerank-active",
		http.MethodPut)

	return appendSegmentRule(rules, LLMGatewayProfilesKey, base+"/", true, false, "",
		http.MethodPut, http.MethodDelete)
}
