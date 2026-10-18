package legacyproxy

import "net/http"

// LLMGatewayProfilesKey is the handler registration key for the seven LLM
// gateway configuration-control routes. A single key is enough because the
// handler dispatches on the request path and method itself.
const LLMGatewayProfilesKey = "/api/system-settings/llm-gateways#profiles"

// WithLLMGatewayProfiles takes over the seven LLM gateway profile routes when
// mode is go:
//
//	GET    /api/system-settings/llm-gateways
//	POST   /api/system-settings/llm-gateways
//	PUT    /api/system-settings/llm-gateways/active
//	PUT    /api/system-settings/llm-gateways/embedding-active
//	PUT    /api/system-settings/llm-gateways/rerank-active
//	PUT    /api/system-settings/llm-gateways/:id
//	DELETE /api/system-settings/llm-gateways/:id
//
// Registration order and shape matter:
//   - the collection path and the three activation paths are exact rules, so
//     they win over the dynamic rule by prefix length and are matched by the
//     handler before any :id lookup;
//   - the dynamic rule accepts exactly one non-empty path segment and only
//     PUT/DELETE plus the shared OPTIONS preflight, so GET/POST under :id and
//     every longer path (proxy-governance/preflight, :id/test, :id/models,
//     :id/proxy-health, :id/proxy-model-info, :id/proxy-lb-test) keep falling
//     back to the legacy /api/ prefix.
//
// PUT and DELETE /proxy-governance and /proxy-load-balancing are shaped like one
// dynamic segment, so the wiring detects those two static paths before
// authentication and forwards them to NestJS unchanged; this function
// deliberately does not add permanent ModeLegacy exact rules for them, because a
// future batch that migrates proxy governance must be able to register a more
// specific rule that wins naturally.
//
// An empty or legacy mode adds no rules at all, so the default deployment is
// unchanged and rollback only flips this one switch.
func WithLLMGatewayProfiles(rules []Rule, mode string) []Rule {
	if mode != string(ModeGo) {
		return rules
	}
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
