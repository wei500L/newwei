package httproute

import "net/http"

// IdentityOnboardingKey is the handler registration key for the sixteen
// registration, invitation and registration-application routes. A single key is
// enough because the handler dispatches on the request path and method itself.
//
// It is deliberately distinct from the two neighbouring auth units
// (/api/auth#login and /api/auth#factors) and from /api/auth#account-security:
// the four rule sets own disjoint paths and must never share a registration.
const IdentityOnboardingKey = "/api/auth#identity-onboarding"

// WithIdentityOnboarding registers the Go router rules for this unit. Every rule is
// method-scoped and registered unconditionally by the always-on Go router;
// a path, method or segment that no rule claims is answered with the
// unmatched-route 404 (the Nest-shaped contract). No request is proxied.
//
// Served routes:
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
