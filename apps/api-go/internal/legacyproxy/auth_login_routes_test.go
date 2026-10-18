package legacyproxy

import (
	"net/http"
	"testing"
)

// authLoginGoRoutes lists the eleven routes (and their CORS preflight) the switch
// owns when it is go.
func authLoginGoRoutes() []struct{ method, path string } {
	posts := []string{
		"/api/auth/login",
		"/api/auth/refresh",
		"/api/auth/send-login-code",
		"/api/auth/login-with-code",
		"/api/auth/mfa/verify-login",
		"/api/auth/mfa/enrollment/start",
		"/api/auth/mfa/enrollment/complete",
		"/api/auth/password/forgot",
		"/api/auth/password/reset",
		"/api/auth/send-verification",
		"/api/auth/verify-email",
	}
	routes := make([]struct{ method, path string }, 0, len(posts)*2)
	for _, path := range posts {
		routes = append(routes, struct{ method, path string }{http.MethodPost, path})
		routes = append(routes, struct{ method, path string }{http.MethodOptions, path})
	}
	return routes
}

// authLoginNestRoutes lists method/path pairs that must keep falling back to
// NestJS even when the switch is go.
func authLoginNestRoutes() []struct{ method, path string } {
	return []struct{ method, path string }{
		// The authenticated MFA management routes owned by the auth-factors unit.
		{http.MethodGet, "/api/auth/mfa"},
		{http.MethodPost, "/api/auth/mfa/enroll"},
		{http.MethodPost, "/api/auth/mfa/verify-enroll"},
		{http.MethodPost, "/api/auth/mfa/disable"},
		{http.MethodPost, "/api/auth/mfa/recovery/rotate"},
		{http.MethodGet, "/api/auth/admin/oidc-config"},
		{http.MethodPut, "/api/auth/admin/oidc-config"},
		// The account-security unit's routes.
		{http.MethodGet, "/api/auth/me"},
		{http.MethodPatch, "/api/auth/profile"},
		{http.MethodPost, "/api/auth/change-password"},
		{http.MethodPost, "/api/auth/logout"},
		{http.MethodGet, "/api/auth/machine-tokens"},
		{http.MethodPost, "/api/auth/machine-tokens"},
		// Routes the whole login unit deliberately does not migrate.
		{http.MethodPost, "/api/auth/sso/handoff/exchange"},
		{http.MethodGet, "/api/auth/sso/oidc/start"},
		{http.MethodGet, "/api/auth/oidc/callback"},
		{http.MethodPost, "/api/auth/register/applications"},
		{http.MethodPost, "/api/auth/invitations/tok/accept"},
		{http.MethodPost, "/api/auth/avatar/presigned-url"},
		// Unlisted methods on taken-over paths.
		{http.MethodGet, "/api/auth/login"},
		{http.MethodPut, "/api/auth/login"},
		{http.MethodGet, "/api/auth/refresh"},
		{http.MethodGet, "/api/auth/send-login-code"},
		{http.MethodGet, "/api/auth/login-with-code"},
		{http.MethodGet, "/api/auth/mfa/verify-login"},
		{http.MethodGet, "/api/auth/mfa/enrollment/start"},
		{http.MethodGet, "/api/auth/mfa/enrollment/complete"},
		{http.MethodGet, "/api/auth/password/forgot"},
		{http.MethodGet, "/api/auth/password/reset"},
		{http.MethodGet, "/api/auth/send-verification"},
		{http.MethodGet, "/api/auth/verify-email"},
		// Trailing slashes and similar prefixes.
		{http.MethodPost, "/api/auth/login/"},
		{http.MethodPost, "/api/auth/refresh/"},
		{http.MethodPost, "/api/auth/password/forgot/"},
		{http.MethodPost, "/api/auth/login-extra"},
		{http.MethodPost, "/api/auth/password/forgot-extra"},
		{http.MethodPost, "/api/auth/mfa/enrollment"},
		{http.MethodPost, "/api/auth/password/"},
	}
}

// TestAuthLoginStayLegacyByDefault locks the default, the empty value and the
// explicit legacy value.
func TestAuthLoginStayLegacyByDefault(t *testing.T) {
	rules := DefaultRules(ModeShadow, "")
	rules = WithAuthLogin(rules, "")
	rules = WithAuthLogin(rules, "legacy")
	gateway, err := New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range append(authLoginGoRoutes(), authLoginNestRoutes()...) {
		if got := gateway.match(tc.method, tc.path); got.Mode != ModeLegacy {
			t.Fatalf("%s %s mode=%s, want legacy", tc.method, tc.path, got.Mode)
		}
	}
}

// TestAuthLoginGoOwnsRoutes locks the eleven exact POST rules and their handler
// key.
func TestAuthLoginGoOwnsRoutes(t *testing.T) {
	rules := DefaultRules(ModeShadow, "")
	rules = WithAuthLogin(rules, string(ModeGo))
	gateway, err := New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range authLoginGoRoutes() {
		got := gateway.match(tc.method, tc.path)
		if got.Mode != ModeGo {
			t.Fatalf("%s %s mode=%s, want go", tc.method, tc.path, got.Mode)
		}
		if !got.Exact {
			t.Fatalf("%s %s must be an exact rule: %+v", tc.method, tc.path, got)
		}
		if got.HandlerKey != AuthLoginKey {
			t.Fatalf("%s %s key=%s", tc.method, tc.path, got.HandlerKey)
		}
	}
}

// TestAuthLoginUnmigratedRoutesStayNest locks every fallback, including the
// neighbouring auth units and the OIDC login chain.
func TestAuthLoginUnmigratedRoutesStayNest(t *testing.T) {
	rules := DefaultRules(ModeShadow, "")
	rules = WithAuthLogin(rules, string(ModeGo))
	gateway, err := New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range authLoginNestRoutes() {
		if got := gateway.match(tc.method, tc.path); got.Mode != ModeLegacy {
			t.Fatalf("%s %s mode=%s, want legacy", tc.method, tc.path, got.Mode)
		}
	}
}

// TestAuthLoginCoexistsWithNeighbouringAuthUnits locks rule attribution when all
// three auth switches are go at once: no unit may claim another unit's routes and
// the three registration keys stay distinct.
func TestAuthLoginCoexistsWithNeighbouringAuthUnits(t *testing.T) {
	rules := DefaultRules(ModeShadow, "")
	rules = WithAuthFactors(rules, string(ModeGo))
	rules = WithAccountSecurity(rules, string(ModeGo))
	rules = WithAuthLogin(rules, string(ModeGo))
	gateway, err := New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range authLoginGoRoutes() {
		if got := gateway.match(tc.method, tc.path); got.HandlerKey != AuthLoginKey {
			t.Fatalf("%s %s = %+v", tc.method, tc.path, got)
		}
	}
	for _, tc := range authFactorsGoRoutes() {
		if got := gateway.match(tc.method, tc.path); got.HandlerKey != AuthFactorsKey {
			t.Fatalf("%s %s = %+v", tc.method, tc.path, got)
		}
	}
	if AuthLoginKey == AuthFactorsKey || AuthLoginKey == AccountSecurityKey || AuthFactorsKey == AccountSecurityKey {
		t.Fatalf("auth unit keys collide: %s %s %s", AuthLoginKey, AuthFactorsKey, AccountSecurityKey)
	}
}
