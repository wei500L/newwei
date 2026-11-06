package httproute

import "net/http"

// AuthFactorsKey is the handler registration key for the seven authenticated
// MFA management and organization OIDC configuration routes. A single key is
// enough because the handler dispatches on the request path and method itself.
// It is deliberately distinct from every other migration unit's key, including
// the account-security batch: the two batches own disjoint paths and must never
// share a registration.
const AuthFactorsKey = "/api/auth#factors"

// WithAuthFactors registers the Go router rules for this unit. Every rule is
// method-scoped and registered unconditionally by the always-on Go router;
// a path, method or segment that no rule claims is answered with the
// unmatched-route 404 (the Nest-shaped contract). No request is proxied.
//
// Served routes:
//
//	GET  /api/auth/mfa
//	POST /api/auth/mfa/enroll
//	POST /api/auth/mfa/verify-enroll
//	POST /api/auth/mfa/disable
//	POST /api/auth/mfa/recovery/rotate
//	GET  /api/auth/admin/oidc-config
//	PUT  /api/auth/admin/oidc-config
//
// POST /api/auth/mfa/enrollment/complete) and the whole OIDC login chain
// POST /api/auth/sso/handoff/exchange) are never taken over.
func WithAuthFactors(rules []Rule) []Rule {
	rules = appendExactKeyed(rules, AuthFactorsKey, "/api/auth/mfa", http.MethodGet)
	rules = appendExactKeyed(rules, AuthFactorsKey, "/api/auth/mfa/enroll", http.MethodPost)
	rules = appendExactKeyed(rules, AuthFactorsKey, "/api/auth/mfa/verify-enroll", http.MethodPost)
	rules = appendExactKeyed(rules, AuthFactorsKey, "/api/auth/mfa/disable", http.MethodPost)
	rules = appendExactKeyed(rules, AuthFactorsKey, "/api/auth/mfa/recovery/rotate", http.MethodPost)
	return appendExactKeyed(rules, AuthFactorsKey, "/api/auth/admin/oidc-config",
		http.MethodGet, http.MethodPut)
}
