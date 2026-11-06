package httproute

import "net/http"

// AccountSecurityKey is the handler registration key for the eight authenticated
// account, session and machine-token routes. A single key is enough because the
// handler dispatches on the request path and method itself.
const AccountSecurityKey = "/api/auth#account-security"

// WithAccountSecurity registers the Go router rules for this unit. Every rule is
// method-scoped and registered unconditionally by the always-on Go router;
// a path, method or segment that no rule claims is answered with the
// unmatched-route 404 (the Nest-shaped contract). No request is proxied.
//
// Served routes:
//
//	GET    /api/auth/me
//	PATCH  /api/auth/profile
//	POST   /api/auth/change-password
//	POST   /api/auth/logout
//	GET    /api/auth/machine-tokens
//	POST   /api/auth/machine-tokens
//	DELETE /api/auth/machine-tokens/:tokenId
//	POST   /api/auth/machine-tokens/:tokenId/rotate
func WithAccountSecurity(rules []Rule) []Rule {
	base := "/api/auth"

	rules = appendExactKeyed(rules, AccountSecurityKey, base+"/me", http.MethodGet)
	rules = appendExactKeyed(rules, AccountSecurityKey, base+"/profile", http.MethodPatch)
	rules = appendExactKeyed(rules, AccountSecurityKey, base+"/change-password", http.MethodPost)
	rules = appendExactKeyed(rules, AccountSecurityKey, base+"/logout", http.MethodPost)
	rules = appendExactKeyed(rules, AccountSecurityKey, base+"/machine-tokens",
		http.MethodGet, http.MethodPost)

	// Declared before the rotate rule: both share the same prefix length, so the
	// stable sort keeps this order and the DELETE whitelist wins for a plain
	// token id.
	rules = appendSegmentRule(rules, AccountSecurityKey, base+"/machine-tokens/",
		true, false, "", http.MethodDelete)
	return appendSegmentRule(rules, AccountSecurityKey, base+"/machine-tokens/",
		true, false, "/rotate", http.MethodPost)
}
