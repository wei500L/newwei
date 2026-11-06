package httproute

import "net/http"

// OIDCLoginKey is the handler registration key for the three public
// organization-SSO routes. It is distinct from every other auth unit key: the
// OIDC configuration CRUD belongs to /api/auth#factors and the password/email
// login routes belong to /api/auth#login.
const OIDCLoginKey = "/api/auth#oidc-login"

// WithOIDCLogin registers the Go router rules for this unit. Every rule is
// method-scoped and registered unconditionally by the always-on Go router;
// a path, method or segment that no rule claims is answered with the
// unmatched-route 404 (the Nest-shaped contract). No request is proxied.
//
// Served routes:
//
//	GET  /api/auth/sso/oidc/start
//	GET  /api/auth/oidc/callback
//	POST /api/auth/sso/handoff/exchange
func WithOIDCLogin(rules []Rule) []Rule {
	rules = appendExactKeyed(rules, OIDCLoginKey, "/api/auth/sso/oidc/start", http.MethodGet)
	rules = appendExactKeyed(rules, OIDCLoginKey, "/api/auth/oidc/callback", http.MethodGet)
	rules = appendExactKeyed(rules, OIDCLoginKey, "/api/auth/sso/handoff/exchange", http.MethodPost)
	return rules
}
