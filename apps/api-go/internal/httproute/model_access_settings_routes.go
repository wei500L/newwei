package httproute

import "net/http"

// ModelAccessSettingsKey is the handler registration key for the ten model access
// settings routes. A single key is enough because the handler dispatches on the
// request path and method itself.
const ModelAccessSettingsKey = "/api/system-settings#model-access"

// WithModelAccessSettings registers the Go router rules for this unit. Every rule is
// method-scoped and registered unconditionally by the always-on Go router;
// a path, method or segment that no rule claims is answered with the
// unmatched-route 404 (the Nest-shaped contract). No request is proxied.
//
// Served routes:
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
func WithModelAccessSettings(rules []Rule) []Rule {
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
