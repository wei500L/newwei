package legacyproxy

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

// WithAuthLogin takes over exactly these eleven routes when mode is go:
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
//
// Every rule is an exact path with a POST-only whitelist, so nothing is
// registered for a whole prefix: GET/HEAD/PUT/PATCH/DELETE, trailing slashes,
// similar prefixes and any longer path keep falling back to the legacy /api/
// rule. The authenticated MFA management routes (GET /api/auth/mfa and the four
// write routes), the OIDC configuration routes, /me, profile, change-password,
// logout, machine tokens and the whole OIDC login chain are never touched here
// even though several of them live under the same prefixes.
//
// An empty or legacy mode adds nothing, so the default deployment is unchanged
// and rollback only flips this one switch. The shared rule helper also
// whitelists OPTIONS for these paths, so CORS preflight is answered by the Go
// handler instead of reaching NestJS; a non-preflight OPTIONS request is sent
// back to the proxy by the wiring.
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
