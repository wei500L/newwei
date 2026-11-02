package legacyproxy

import "net/http"

// IdentityOnboardingKey is the handler registration key for the sixteen
// registration, invitation and registration-application routes. A single key is
// enough because the handler dispatches on the request path and method itself.
//
// It is deliberately distinct from the two neighbouring auth units
// (/api/auth#login and /api/auth#factors) and from /api/auth#account-security:
// the four rule sets own disjoint paths and must never share a registration.
const IdentityOnboardingKey = "/api/auth#identity-onboarding"

// WithIdentityOnboarding takes over exactly these sixteen routes when mode is
// go:
//
//	GET  /api/auth/admin/invites
//	POST /api/auth/admin/invites
//	POST /api/auth/admin/invites/:id/resend
//	POST /api/auth/admin/invites/:id/revoke
//	GET  /api/auth/admin/registration-applications
//	POST /api/auth/admin/registration-applications/:id/approve-join
//	POST /api/auth/admin/registration-applications/:id/reject-join
//	POST /api/auth/admin/registration-applications/:id/approve-org
//	POST /api/auth/admin/registration-applications/:id/reject-org
//	POST /api/auth/admin/registration-applications/:id/recover-org
//	POST /api/auth/admin/registration-applications/:id/resend-invite
//	POST /api/auth/register/applications
//	POST /api/auth/register/join-applications
//	GET  /api/auth/invitations/:token
//	POST /api/auth/invitations/:token/accept
//	POST /api/auth/invitations/:token/accept-authenticated
//
// Every rule is an exact path, or a fixed prefix followed by exactly one
// non-empty segment and a fixed suffix. Nothing is registered for a whole
// prefix: HEAD, unlisted methods, trailing slashes, similar prefixes and any
// longer path keep falling back to the legacy /api/ rule. In particular login,
// refresh, logout, /me, profile, change-password, machine tokens, MFA management
// and the whole OIDC chain are never touched.
//
// An empty or legacy mode adds nothing, so the default deployment is unchanged
// and rollback only flips this one switch. The shared rule helper also
// whitelists OPTIONS for these paths, so CORS preflight is answered by the Go
// handler instead of reaching NestJS; a non-preflight OPTIONS request is sent
// back to the proxy by the wiring.
func WithIdentityOnboarding(rules []Rule) []Rule {
	rules = appendExactKeyed(rules, IdentityOnboardingKey, "/api/auth/admin/invites",
		http.MethodGet, http.MethodPost)
	rules = appendSegmentRule(rules, IdentityOnboardingKey, "/api/auth/admin/invites/", true, false, "/resend",
		http.MethodPost)
	rules = appendSegmentRule(rules, IdentityOnboardingKey, "/api/auth/admin/invites/", true, false, "/revoke",
		http.MethodPost)
	rules = appendExactKeyed(rules, IdentityOnboardingKey, "/api/auth/admin/registration-applications",
		http.MethodGet)
	for _, suffix := range []string{"/approve-join", "/reject-join", "/approve-org", "/reject-org", "/recover-org", "/resend-invite"} {
		rules = appendSegmentRule(rules, IdentityOnboardingKey,
			"/api/auth/admin/registration-applications/", true, false, suffix, http.MethodPost)
	}
	rules = appendExactKeyed(rules, IdentityOnboardingKey, "/api/auth/register/applications", http.MethodPost)
	rules = appendExactKeyed(rules, IdentityOnboardingKey, "/api/auth/register/join-applications", http.MethodPost)
	rules = appendSegmentRule(rules, IdentityOnboardingKey, "/api/auth/invitations/", true, false, "",
		http.MethodGet)
	rules = appendSegmentRule(rules, IdentityOnboardingKey, "/api/auth/invitations/", true, false, "/accept",
		http.MethodPost)
	return appendSegmentRule(rules, IdentityOnboardingKey, "/api/auth/invitations/", true, false,
		"/accept-authenticated", http.MethodPost)
}
