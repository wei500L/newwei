package httproute

import "net/http"

// AuthLoginKey is the handler registration key for the eleven POST /api/auth
// routes owned by the login/session/email-code unit. A single key is enough
// because the handler dispatches on the request path itself.
//
// The key is deliberately distinct from every other migration unit's key,
// including the two neighbouring auth units (/api/auth#factors for the
// authenticated MFA management and OIDC configuration routes and
// /api/auth#account-security for the account, session and machine-token routes).
// The three units own disjoint paths and must never share a registration.
const AuthLoginKey = "/api/auth#login"

// WithAuthLogin registers the Go router rules for this unit. Every rule is
// method-scoped and registered unconditionally by the always-on Go router;
// a path, method or segment that no rule claims is answered with the
// unmatched-route 404 (the Nest-shaped contract). No request is proxied.
//
// Served routes:
//
//	POST /api/auth/login
//	POST /api/auth/refresh
//	POST /api/auth/send-login-code
//	POST /api/auth/login-with-code
//	POST /api/auth/mfa/verify-login
//	POST /api/auth/mfa/enrollment/start
//	POST /api/auth/mfa/enrollment/complete
//	POST /api/auth/password/forgot
//	POST /api/auth/password/reset
//	POST /api/auth/send-verification
//	POST /api/auth/verify-email
func WithAuthLogin(rules []Rule) []Rule {
	base := "/api/auth"
	for _, path := range []string{
		"/login",
		"/refresh",
		"/send-login-code",
		"/login-with-code",
		"/mfa/verify-login",
		"/mfa/enrollment/start",
		"/mfa/enrollment/complete",
		"/password/forgot",
		"/password/reset",
		"/send-verification",
		"/verify-email",
	} {
		rules = appendExactKeyed(rules, AuthLoginKey, base+path, http.MethodPost)
	}
	return rules
}
