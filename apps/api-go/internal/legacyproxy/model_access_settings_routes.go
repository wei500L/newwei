package legacyproxy

import "net/http"

// ModelAccessSettingsKey is the handler registration key for the ten model access
// settings routes. A single key is enough because the handler dispatches on the
// request path and method itself.
const ModelAccessSettingsKey = "/api/system-settings#model-access"

// WithModelAccessSettings takes over the ten model service configuration and
// OpenAI key distribution HTTP routes when mode is go:
//
//	GET    /api/system-settings/model-service
//	PUT    /api/system-settings/model-service
//	DELETE /api/system-settings/model-service
//	GET    /api/system-settings/openai-keys
//	PUT    /api/system-settings/openai-keys
//	POST   /api/system-settings/openai-keys
//	DELETE /api/system-settings/openai-keys/key/:fingerprint
//	DELETE /api/system-settings/openai-keys
//	GET    /api/internal/litellm/openai-keys
//	POST   /api/internal/litellm/openai-keys/applied
//
// An empty or legacy mode appends nothing, so the default deployment is unchanged
// and rollback is a single environment variable change.
//
// The rules are deliberately narrow. There is no big-prefix takeover of
// /api/system-settings or /api/internal/litellm: the longer
// /api/internal/litellm/openai-keys/applied path is declared before
// /api/internal/litellm/openai-keys, and both are EXACT paths, so
// /api/internal/litellm/proxy-load-balancing and every /api/system-settings route
// this batch does not own (llm-gateways, security, vector-service, ...) keep
// falling back to the legacy /api/ proxy.
//
// `:fingerprint` is exactly one non-empty path segment: the collection path, a
// trailing slash and /key/:fingerprint/extra never match this rule. OPTIONS is
// whitelisted on each taken-over path so CORS preflight is answered by the Go
// handler rather than reaching NestJS; unlisted methods (HEAD, PATCH, ...) keep
// falling back.
func WithModelAccessSettings(rules []Rule, mode string) []Rule {
	if mode != string(ModeGo) {
		return rules
	}
	base := "/api/system-settings"
	internal := "/api/internal/litellm"

	// The applied route is longer than the plain keys route; declaring it first
	// keeps the intent obvious even though both are exact matches.
	rules = appendExactKeyed(rules, ModelAccessSettingsKey, internal+"/openai-keys/applied",
		http.MethodPost)
	rules = appendExactKeyed(rules, ModelAccessSettingsKey, internal+"/openai-keys",
		http.MethodGet)

	rules = appendExactKeyed(rules, ModelAccessSettingsKey, base+"/model-service",
		http.MethodGet, http.MethodPut, http.MethodDelete)
	rules = appendExactKeyed(rules, ModelAccessSettingsKey, base+"/openai-keys",
		http.MethodGet, http.MethodPut, http.MethodPost, http.MethodDelete)

	return appendSegmentRule(rules, ModelAccessSettingsKey, base+"/openai-keys/key/",
		true, false, "", http.MethodDelete)
}
