package legacyproxy

import "net/http"

// AuthFactorsKey is the handler registration key for the seven authenticated
// MFA management and organization OIDC configuration routes. A single key is
// enough because the handler dispatches on the request path and method itself.
// It is deliberately distinct from every other migration unit's key, including
// the account-security batch: the two batches own disjoint paths and must never
// share a registration.
const AuthFactorsKey = "/api/auth#factors"

// WithAuthFactors takes over exactly these seven routes when mode is go:
//
//	GET  /api/auth/mfa
//	POST /api/auth/mfa/enroll
//	POST /api/auth/mfa/verify-enroll
//	POST /api/auth/mfa/disable
//	POST /api/auth/mfa/recovery/rotate
//	GET  /api/auth/admin/oidc-config
//	PUT  /api/auth/admin/oidc-config
//
// Every rule is an exact path with an explicit method whitelist, so nothing is
// registered for a whole prefix: HEAD, unlisted methods, trailing slashes,
// similar prefixes and any longer path keep falling back to the legacy /api/
// rule. In particular the public MFA login and forced-enrollment challenges
// (POST /api/auth/mfa/verify-login, POST /api/auth/mfa/enrollment/start,
// POST /api/auth/mfa/enrollment/complete) and the whole OIDC login chain
// (GET /api/auth/sso/oidc/start, GET /api/auth/oidc/callback,
// POST /api/auth/sso/handoff/exchange) are never taken over.
//
// An empty or legacy mode adds nothing, so the default deployment is unchanged
// and rollback only flips this one switch. The shared rule helper also
// whitelists OPTIONS for these paths, so CORS preflight is answered by the Go
// handler instead of reaching NestJS; a non-preflight OPTIONS request is sent
// back to the proxy by the wiring.
func WithAuthFactors(rules []Rule) []Rule {
	rules = appendExactKeyed(rules, AuthFactorsKey, "/api/auth/mfa", http.MethodGet)
	rules = appendExactKeyed(rules, AuthFactorsKey, "/api/auth/mfa/enroll", http.MethodPost)
	rules = appendExactKeyed(rules, AuthFactorsKey, "/api/auth/mfa/verify-enroll", http.MethodPost)
	rules = appendExactKeyed(rules, AuthFactorsKey, "/api/auth/mfa/disable", http.MethodPost)
	rules = appendExactKeyed(rules, AuthFactorsKey, "/api/auth/mfa/recovery/rotate", http.MethodPost)
	return appendExactKeyed(rules, AuthFactorsKey, "/api/auth/admin/oidc-config",
		http.MethodGet, http.MethodPut)
}
