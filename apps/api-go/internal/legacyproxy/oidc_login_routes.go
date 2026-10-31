package legacyproxy

import "net/http"

// OIDCLoginKey is the handler registration key for the three public
// organization-SSO routes. It is distinct from every other auth unit key: the
// OIDC configuration CRUD belongs to /api/auth#factors and the password/email
// login routes belong to /api/auth#login.
const OIDCLoginKey = "/api/auth#oidc-login"

// WithOIDCLogin takes over exactly these public routes when mode is go:
//
//	GET  /api/auth/sso/oidc/start
//	GET  /api/auth/oidc/callback
//	POST /api/auth/sso/handoff/exchange
//
// Each rule is an exact path with a method whitelist. Other methods, trailing
// slashes, similar prefixes and every other /api/auth path keep falling back to
// the generic NestJS proxy. The shared rule helper also whitelists OPTIONS so a
// CORS preflight reaches the Go handler; a non-preflight OPTIONS request is sent
// back to the proxy by the wiring.
//
// The empty and legacy values add nothing, so the default deployment is
// unchanged and rollback is one variable.
func WithOIDCLogin(rules []Rule) []Rule {
	rules = appendExactKeyed(rules, OIDCLoginKey, "/api/auth/sso/oidc/start", http.MethodGet)
	rules = appendExactKeyed(rules, OIDCLoginKey, "/api/auth/oidc/callback", http.MethodGet)
	rules = appendExactKeyed(rules, OIDCLoginKey, "/api/auth/sso/handoff/exchange", http.MethodPost)
	return rules
}
