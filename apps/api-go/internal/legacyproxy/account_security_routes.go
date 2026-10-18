package legacyproxy

import "net/http"

// AccountSecurityKey is the handler registration key for the eight authenticated
// account, session and machine-token routes. A single key is enough because the
// handler dispatches on the request path and method itself.
const AccountSecurityKey = "/api/auth#account-security"

// WithAccountSecurity takes over the eight routes when mode is go:
//
//	GET    /api/auth/me
//	PATCH  /api/auth/profile
//	POST   /api/auth/change-password
//	POST   /api/auth/logout
//	GET    /api/auth/machine-tokens
//	POST   /api/auth/machine-tokens
//	DELETE /api/auth/machine-tokens/:tokenId
//	POST   /api/auth/machine-tokens/:tokenId/rotate
//
// Registration order and shape matter. The collection route is one exact path
// with a GET+POST whitelist, so PUT/DELETE/HEAD on it keep falling back to the
// legacy /api/ rule. The two dynamic routes share the
// "/api/auth/machine-tokens/" prefix: the revoke rule is declared first and the
// rotate rule carries the "/rotate" tail, so a DELETE ending in /rotate and a
// GET of a token id never match either rule.
//
// `:tokenId` is exactly one non-empty path segment (never a multi-segment or
// empty value) and `/rotate` must be the final segment. Trailing slashes,
// longer paths, sibling auth routes (login, refresh, send-verification, mfa,
// oidc, data-export, avatar/presigned-url, invitations, ...) and every method
// not listed above stay on the legacy /api/ prefix and are proxied to NestJS.
// An empty or legacy mode adds no rules at all, so the default deployment is
// unchanged and rollback only flips this one switch.
//
// The shared rule helpers also whitelist OPTIONS for the taken-over paths, so
// CORS preflight is answered by the Go handler instead of reaching NestJS.
func WithAccountSecurity(rules []Rule, mode string) []Rule {
	if mode != string(ModeGo) {
		return rules
	}
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
