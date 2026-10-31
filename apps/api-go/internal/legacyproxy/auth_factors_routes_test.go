package legacyproxy

import (
	"net/http"
	"testing"
)

// authFactorsGoRoutes lists the seven routes (and their CORS preflight) the
// switch owns when it is go.
func authFactorsGoRoutes() []struct{ method, path string } {
	return []struct{ method, path string }{
		{http.MethodGet, "/api/auth/mfa"},
		{http.MethodPost, "/api/auth/mfa/enroll"},
		{http.MethodPost, "/api/auth/mfa/verify-enroll"},
		{http.MethodPost, "/api/auth/mfa/disable"},
		{http.MethodPost, "/api/auth/mfa/recovery/rotate"},
		{http.MethodGet, "/api/auth/admin/oidc-config"},
		{http.MethodPut, "/api/auth/admin/oidc-config"},
		{http.MethodOptions, "/api/auth/mfa"},
		{http.MethodOptions, "/api/auth/mfa/enroll"},
		{http.MethodOptions, "/api/auth/mfa/verify-enroll"},
		{http.MethodOptions, "/api/auth/mfa/disable"},
		{http.MethodOptions, "/api/auth/mfa/recovery/rotate"},
		{http.MethodOptions, "/api/auth/admin/oidc-config"},
	}
}

// authFactorsNestRoutes lists method/path pairs that must keep falling back to
// NestJS even when the switch is go.
func authFactorsNestRoutes() []struct{ method, path string } {
	return []struct{ method, path string }{
		// Public MFA challenges: never migrated by this batch.
		{http.MethodPost, "/api/auth/mfa/verify-login"},
		{http.MethodPost, "/api/auth/mfa/enrollment/start"},
		{http.MethodPost, "/api/auth/mfa/enrollment/complete"},
		// The OIDC login chain: never migrated by this batch.
		{http.MethodGet, "/api/auth/sso/oidc/start"},
		{http.MethodGet, "/api/auth/oidc/callback"},
		{http.MethodPost, "/api/auth/sso/handoff/exchange"},
		// Every other authenticated auth route.
		{http.MethodPost, "/api/auth/login"},
		{http.MethodPost, "/api/auth/refresh"},
		{http.MethodPost, "/api/auth/logout"},
		{http.MethodGet, "/api/auth/me"},
		{http.MethodPost, "/api/auth/change-password"},
		{http.MethodGet, "/api/auth/machine-tokens"},
		{http.MethodPost, "/api/auth/machine-tokens"},
		// Unlisted methods on taken-over paths.
		{http.MethodHead, "/api/auth/mfa"},
		{http.MethodPost, "/api/auth/mfa"},
		{http.MethodGet, "/api/auth/mfa/enroll"},
		{http.MethodPut, "/api/auth/mfa/enroll"},
		{http.MethodGet, "/api/auth/mfa/verify-enroll"},
		{http.MethodGet, "/api/auth/mfa/disable"},
		{http.MethodGet, "/api/auth/mfa/recovery/rotate"},
		{http.MethodPost, "/api/auth/admin/oidc-config"},
		{http.MethodDelete, "/api/auth/admin/oidc-config"},
		// Trailing slashes and similar prefixes.
		{http.MethodGet, "/api/auth/mfa/"},
		{http.MethodPost, "/api/auth/mfa/enroll/"},
		{http.MethodGet, "/api/auth/mfa-extra"},
		{http.MethodGet, "/api/auth/admin/oidc-config/"},
		{http.MethodGet, "/api/auth/admin/oidc-config-extra"},
		{http.MethodGet, "/api/auth/admin/"},
	}
}

// TestAuthFactorsStayLegacyByDefault locks the default, the empty value and the
// explicit legacy value.

// TestAuthFactorsGoOwnsRoutes locks the seven exact rules and their handler key.
func TestAuthFactorsGoOwnsRoutes(t *testing.T) {
	rules := BaseRules()
	rules = WithAuthFactors(rules)
	gateway := New(rules)
	for _, tc := range authFactorsGoRoutes() {
		got := gateway.match(tc.method, tc.path)
		if got.Prefix == "" {
			t.Fatalf("%s %s mode=%s, want go", tc.method, tc.path, got.Prefix)
		}
		if !got.Exact {
			t.Fatalf("%s %s must be an exact rule: %+v", tc.method, tc.path, got)
		}
		if got.HandlerKey != AuthFactorsKey {
			t.Fatalf("%s %s key=%s", tc.method, tc.path, got.HandlerKey)
		}
	}
}

// TestAuthFactorsUnmigratedRoutesStayNest locks every fallback, including the
// public MFA challenges and the OIDC login chain.
func TestAuthFactorsUnmigratedRoutesStayNest(t *testing.T) {
	rules := BaseRules()
	rules = WithAuthFactors(rules)
	gateway := New(rules)
	for _, tc := range authFactorsNestRoutes() {
		if got := gateway.match(tc.method, tc.path); got.Prefix != "" {
			t.Fatalf("%s %s mode=%s, want legacy", tc.method, tc.path, got.Prefix)
		}
	}
}

// TestAuthFactorsCoexistWithInfrastructureSettings locks rule attribution when
// both switches are go: neither switch may claim the other's routes, and the
// auth-factors key stays distinct from every other unit's key.
func TestAuthFactorsCoexistWithInfrastructureSettings(t *testing.T) {
	rules := BaseRules()
	rules = WithInfrastructureSettings(rules)
	rules = WithAuthFactors(rules)
	gateway := New(rules)
	for _, tc := range authFactorsGoRoutes() {
		got := gateway.match(tc.method, tc.path)
		if got.Prefix == "" || got.HandlerKey != AuthFactorsKey {
			t.Fatalf("%s %s = %+v", tc.method, tc.path, got)
		}
	}
	for _, tc := range infrastructureSettingsGoRoutes() {
		got := gateway.match(tc.method, tc.path)
		if got.Prefix == "" || got.HandlerKey != InfrastructureSettingsKey {
			t.Fatalf("%s %s = %+v", tc.method, tc.path, got)
		}
	}
	if AuthFactorsKey == InfrastructureSettingsKey || AuthFactorsKey == RuntimeSettingsKey {
		t.Fatalf("auth factors key collides with another unit: %s", AuthFactorsKey)
	}
}
