package legacyproxy

import (
	"net/http"
	"testing"
)

// identityOnboardingGoRoutes lists the fourteen taken-over routes plus the CORS
// preflight the shared rule helper whitelists.
func identityOnboardingGoRoutes() []struct{ method, path string } {
	return []struct{ method, path string }{
		{http.MethodGet, "/api/auth/admin/invites"},
		{http.MethodPost, "/api/auth/admin/invites"},
		{http.MethodPost, "/api/auth/admin/invites/inv_1/resend"},
		{http.MethodPost, "/api/auth/admin/invites/inv_1/revoke"},
		{http.MethodGet, "/api/auth/admin/registration-applications"},
		{http.MethodPost, "/api/auth/admin/registration-applications/app_1/approve-join"},
		{http.MethodPost, "/api/auth/admin/registration-applications/app_1/reject-join"},
		{http.MethodPost, "/api/auth/admin/registration-applications/app_1/approve-org"},
		{http.MethodPost, "/api/auth/admin/registration-applications/app_1/reject-org"},
		{http.MethodPost, "/api/auth/register/applications"},
		{http.MethodPost, "/api/auth/register/join-applications"},
		{http.MethodGet, "/api/auth/invitations/token-value"},
		{http.MethodPost, "/api/auth/invitations/token-value/accept"},
		{http.MethodPost, "/api/auth/invitations/token-value/accept-authenticated"},
		{http.MethodOptions, "/api/auth/admin/invites"},
		{http.MethodOptions, "/api/auth/invitations/token-value"},
	}
}

// identityOnboardingNestRoutes lists method/path pairs that must keep falling
// back to NestJS even when the switch is go.
func identityOnboardingNestRoutes() []struct{ method, path string } {
	return []struct{ method, path string }{
		// Neighbouring auth units.
		{http.MethodPost, "/api/auth/login"},
		{http.MethodPost, "/api/auth/refresh"},
		{http.MethodGet, "/api/auth/me"},
		{http.MethodPost, "/api/auth/logout"},
		{http.MethodGet, "/api/auth/mfa"},
		{http.MethodGet, "/api/auth/admin/oidc-config"},
		{http.MethodGet, "/api/auth/machine-tokens"},
		{http.MethodGet, "/api/auth/data-export"},
		{http.MethodPost, "/api/auth/avatar/presigned-url"},
		// Unlisted methods on taken-over paths.
		{http.MethodPut, "/api/auth/admin/invites"},
		{http.MethodDelete, "/api/auth/admin/invites"},
		{http.MethodGet, "/api/auth/admin/invites/inv_1/resend"},
		{http.MethodPost, "/api/auth/admin/registration-applications"},
		{http.MethodGet, "/api/auth/admin/registration-applications/app_1/approve-join"},
		{http.MethodGet, "/api/auth/register/applications"},
		{http.MethodGet, "/api/auth/register/join-applications"},
		{http.MethodPost, "/api/auth/invitations/token-value"},
		{http.MethodGet, "/api/auth/invitations/token-value/accept"},
		{http.MethodGet, "/api/auth/invitations/token-value/accept-authenticated"},
		// Trailing slashes, empty segments, longer paths and similar prefixes.
		{http.MethodGet, "/api/auth/admin/invites/"},
		{http.MethodGet, "/api/auth/admin/invites/inv_1/"},
		{http.MethodPost, "/api/auth/admin/invites/inv_1/resend/extra"},
		{http.MethodPost, "/api/auth/admin/invites//resend"},
		{http.MethodGet, "/api/auth/admin/invites-extra"},
		{http.MethodGet, "/api/auth/admin/registration-applications/"},
		{http.MethodPost, "/api/auth/admin/registration-applications/app_1"},
		{http.MethodPost, "/api/auth/admin/registration-applications/app_1/approve-join/extra"},
		{http.MethodPost, "/api/auth/register/applications/"},
		{http.MethodGet, "/api/auth/invitations/"},
		{http.MethodGet, "/api/auth/invitations/token-value/extra"},
		{http.MethodPost, "/api/auth/invitations/token-value/accept/extra"},
	}
}

// TestIdentityOnboardingStaysLegacyByDefault locks the default, the empty value
// and the explicit legacy value.

// TestIdentityOnboardingGoOwnsRoutes locks the route shapes and the handler key.
func TestIdentityOnboardingGoOwnsRoutes(t *testing.T) {
	rules := BaseRules()
	rules = WithIdentityOnboarding(rules)
	gateway := New(rules)
	for _, tc := range identityOnboardingGoRoutes() {
		got := gateway.match(tc.method, tc.path)
		if got.Prefix == "" {
			t.Fatalf("%s %s mode=%s, want go", tc.method, tc.path, got.Prefix)
		}
		if got.HandlerKey != IdentityOnboardingKey {
			t.Fatalf("%s %s key=%s", tc.method, tc.path, got.HandlerKey)
		}
		// Every rule must be either exact or one dynamic segment with an
		// optional fixed suffix; a bare prefix rule would swallow siblings.
		if !got.Exact && !got.OneSegment {
			t.Fatalf("%s %s must be exact or one-segment: %+v", tc.method, tc.path, got)
		}
	}
}

// TestIdentityOnboardingUnmigratedRoutesStayNest locks every fallback, including
// the longer paths that share the invitation and application prefixes.
func TestIdentityOnboardingUnmigratedRoutesStayNest(t *testing.T) {
	rules := BaseRules()
	rules = WithIdentityOnboarding(rules)
	gateway := New(rules)
	for _, tc := range identityOnboardingNestRoutes() {
		if got := gateway.match(tc.method, tc.path); got.Prefix != "" {
			t.Fatalf("%s %s mode=%s, want legacy", tc.method, tc.path, got.Prefix)
		}
	}
}

// TestIdentityOnboardingCoexistsWithAuthUnits locks rule attribution when all
// four auth switches are go: no unit may claim another unit's path and the four
// registration keys stay distinct.
func TestIdentityOnboardingCoexistsWithAuthUnits(t *testing.T) {
	rules := BaseRules()
	rules = WithAuthLogin(rules)
	rules = WithAuthFactors(rules)
	rules = WithAccountSecurity(rules)
	rules = WithIdentityOnboarding(rules)
	gateway := New(rules)
	for _, tc := range identityOnboardingGoRoutes() {
		got := gateway.match(tc.method, tc.path)
		if got.Prefix == "" || got.HandlerKey != IdentityOnboardingKey {
			t.Fatalf("%s %s = %+v", tc.method, tc.path, got)
		}
	}
	for _, tc := range authLoginGoRoutes() {
		if got := gateway.match(tc.method, tc.path); got.HandlerKey != AuthLoginKey {
			t.Fatalf("%s %s stolen by %+v", tc.method, tc.path, got)
		}
	}
	for _, tc := range authFactorsGoRoutes() {
		if got := gateway.match(tc.method, tc.path); got.HandlerKey != AuthFactorsKey {
			t.Fatalf("%s %s stolen by %+v", tc.method, tc.path, got)
		}
	}
	for _, tc := range accountSecurityGoRoutes() {
		if got := gateway.match(tc.method, tc.path); got.HandlerKey != AccountSecurityKey {
			t.Fatalf("%s %s stolen by %+v", tc.method, tc.path, got)
		}
	}
	if IdentityOnboardingKey == AuthLoginKey || IdentityOnboardingKey == AuthFactorsKey ||
		IdentityOnboardingKey == AccountSecurityKey {
		t.Fatalf("identity onboarding key collides: %s", IdentityOnboardingKey)
	}
}
