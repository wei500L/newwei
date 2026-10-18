package legacyproxy

import (
	"net/http"
	"testing"
)

func oidcLoginGoRoutes() []struct{ method, path string } {
	paths := []struct{ method, path string }{
		{http.MethodGet, "/api/auth/sso/oidc/start"},
		{http.MethodGet, "/api/auth/oidc/callback"},
		{http.MethodPost, "/api/auth/sso/handoff/exchange"},
	}
	out := make([]struct{ method, path string }, 0, len(paths)*2)
	for _, route := range paths {
		out = append(out, route)
		out = append(out, struct{ method, path string }{http.MethodOptions, route.path})
	}
	return out
}

func oidcLoginNestRoutes() []struct{ method, path string } {
	return []struct{ method, path string }{
		// OIDC configuration CRUD belongs to the auth-factors unit.
		{http.MethodGet, "/api/auth/admin/oidc-config"},
		{http.MethodPut, "/api/auth/admin/oidc-config"},
		// The login/account-security units' routes.
		{http.MethodPost, "/api/auth/login"},
		{http.MethodPost, "/api/auth/mfa/verify-login"},
		{http.MethodGet, "/api/auth/me"},
		// Unlisted methods on taken-over paths.
		{http.MethodPost, "/api/auth/sso/oidc/start"},
		{http.MethodPost, "/api/auth/oidc/callback"},
		{http.MethodGet, "/api/auth/sso/handoff/exchange"},
		// Trailing slashes and similar prefixes.
		{http.MethodGet, "/api/auth/sso/oidc/start/"},
		{http.MethodGet, "/api/auth/oidc/callback/"},
		{http.MethodPost, "/api/auth/sso/handoff/exchange/"},
		{http.MethodGet, "/api/auth/sso/oidc/start-extra"},
		{http.MethodGet, "/api/auth/oidc/callback-extra"},
		{http.MethodPost, "/api/auth/sso/handoff"},
	}
}

func TestOIDCLoginStaysLegacyByDefault(t *testing.T) {
	rules := DefaultRules(ModeShadow, "")
	rules = WithOIDCLogin(rules, "")
	rules = WithOIDCLogin(rules, "legacy")
	gateway, err := New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range append(oidcLoginGoRoutes(), oidcLoginNestRoutes()...) {
		if got := gateway.match(tc.method, tc.path); got.Mode != ModeLegacy {
			t.Fatalf("%s %s mode=%s, want legacy", tc.method, tc.path, got.Mode)
		}
	}
}

func TestOIDCLoginGoOwnsExactlyThreeRoutes(t *testing.T) {
	rules := DefaultRules(ModeShadow, "")
	rules = WithOIDCLogin(rules, string(ModeGo))
	gateway, err := New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range oidcLoginGoRoutes() {
		got := gateway.match(tc.method, tc.path)
		if got.Mode != ModeGo || !got.Exact || got.HandlerKey != OIDCLoginKey {
			t.Fatalf("%s %s = %+v", tc.method, tc.path, got)
		}
	}
	for _, tc := range oidcLoginNestRoutes() {
		if got := gateway.match(tc.method, tc.path); got.Mode != ModeLegacy {
			t.Fatalf("%s %s mode=%s, want legacy", tc.method, tc.path, got.Mode)
		}
	}
}

func TestOIDCLoginCoexistsWithOtherAuthUnits(t *testing.T) {
	rules := DefaultRules(ModeShadow, "")
	rules = WithAuthFactors(rules, string(ModeGo))
	rules = WithAccountSecurity(rules, string(ModeGo))
	rules = WithAuthLogin(rules, string(ModeGo))
	rules = WithIdentityOnboarding(rules, string(ModeGo))
	rules = WithOIDCLogin(rules, string(ModeGo))
	gateway, err := New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range oidcLoginGoRoutes() {
		if got := gateway.match(tc.method, tc.path); got.HandlerKey != OIDCLoginKey {
			t.Fatalf("%s %s = %+v", tc.method, tc.path, got)
		}
	}
	for _, tc := range authLoginGoRoutes() {
		if got := gateway.match(tc.method, tc.path); got.HandlerKey != AuthLoginKey {
			t.Fatalf("%s %s = %+v", tc.method, tc.path, got)
		}
	}
	keys := map[string]bool{
		OIDCLoginKey: true, AuthLoginKey: true, AuthFactorsKey: true,
		AccountSecurityKey: true, IdentityOnboardingKey: true,
	}
	if len(keys) != 5 {
		t.Fatalf("auth unit keys collide: %v", keys)
	}
}
