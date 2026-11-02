package legacyproxy

import (
	"net/http"
	"testing"
)

// accountSecurityGoRoutes lists the eight routes (and their CORS preflight) the
// switch owns when it is go.
func accountSecurityGoRoutes() []struct{ method, path string } {
	return []struct{ method, path string }{
		{http.MethodGet, "/api/auth/me"},
		{http.MethodPatch, "/api/auth/profile"},
		{http.MethodPost, "/api/auth/change-password"},
		{http.MethodPost, "/api/auth/logout"},
		{http.MethodGet, "/api/auth/machine-tokens"},
		{http.MethodPost, "/api/auth/machine-tokens"},
		{http.MethodDelete, "/api/auth/machine-tokens/mtk_abc"},
		{http.MethodPost, "/api/auth/machine-tokens/mtk_abc/rotate"},
		{http.MethodOptions, "/api/auth/me"},
		{http.MethodOptions, "/api/auth/profile"},
		{http.MethodOptions, "/api/auth/change-password"},
		{http.MethodOptions, "/api/auth/logout"},
		{http.MethodOptions, "/api/auth/machine-tokens"},
		{http.MethodOptions, "/api/auth/machine-tokens/mtk_abc"},
		{http.MethodOptions, "/api/auth/machine-tokens/mtk_abc/rotate"},
	}
}

// accountSecurityNestRoutes lists method/path pairs that must keep falling back
// to NestJS even when the switch is go.
func accountSecurityNestRoutes() []struct{ method, path string } {
	return []struct{ method, path string }{
		// Every unmigrated auth endpoint.
		{http.MethodPost, "/api/auth/login"},
		{http.MethodPost, "/api/auth/refresh"},
		{http.MethodPost, "/api/auth/send-verification"},
		{http.MethodPost, "/api/auth/verify-email"},
		{http.MethodPost, "/api/auth/send-login-code"},
		{http.MethodPost, "/api/auth/login-with-code"},
		{http.MethodPost, "/api/auth/password/forgot"},
		{http.MethodPost, "/api/auth/password/reset"},
		{http.MethodGet, "/api/auth/mfa"},
		{http.MethodPost, "/api/auth/mfa/enroll"},
		{http.MethodPost, "/api/auth/mfa/verify-login"},
		{http.MethodGet, "/api/auth/admin/oidc-config"},
		{http.MethodPost, "/api/auth/avatar/presigned-url"},
		{http.MethodGet, "/api/auth/data-export"},
		{http.MethodGet, "/api/auth/invitations/token-1"},
		{http.MethodGet, "/api/auth/sso/oidc/start"},
		{http.MethodPost, "/api/auth/register/applications"},
		// Unlisted methods on taken-over paths.
		{http.MethodHead, "/api/auth/me"},
		{http.MethodPost, "/api/auth/me"},
		{http.MethodGet, "/api/auth/profile"},
		{http.MethodPut, "/api/auth/profile"},
		{http.MethodGet, "/api/auth/change-password"},
		{http.MethodGet, "/api/auth/logout"},
		{http.MethodPut, "/api/auth/machine-tokens"},
		{http.MethodDelete, "/api/auth/machine-tokens"},
		{http.MethodGet, "/api/auth/machine-tokens/mtk_abc"},
		{http.MethodPost, "/api/auth/machine-tokens/mtk_abc"},
		{http.MethodDelete, "/api/auth/machine-tokens/mtk_abc/rotate"},
		// Trailing slashes, missing/extra segments and similar prefixes.
		{http.MethodGet, "/api/auth/me/"},
		{http.MethodPatch, "/api/auth/profile/"},
		{http.MethodDelete, "/api/auth/machine-tokens/"},
		{http.MethodPost, "/api/auth/machine-tokens//rotate"},
		{http.MethodPost, "/api/auth/machine-tokens/a/b/rotate"},
		{http.MethodDelete, "/api/auth/machine-tokens/mtk_abc/extra"},
		{http.MethodPost, "/api/auth/machine-tokens/rotate"},
		{http.MethodPost, "/api/auth/machine-tokensx"},
		{http.MethodGet, "/api/auth/mefoo"},
	}
}

// TestAccountSecurityStaysLegacyByDefault locks the default and the explicit
// legacy value.

// TestAccountSecurityGoOwnsRoutes locks the eight rules and their handler key.
func TestAccountSecurityGoOwnsRoutes(t *testing.T) {
	rules := BaseRules()
	rules = WithAccountSecurity(rules)
	gateway := New(rules)
	for _, tc := range accountSecurityGoRoutes() {
		got := gateway.match(tc.method, tc.path)
		if got.Prefix == "" {
			t.Fatalf("%s %s mode=%s, want go", tc.method, tc.path, got.Prefix)
		}
		if got.HandlerKey != AccountSecurityKey {
			t.Fatalf("%s %s key=%s", tc.method, tc.path, got.HandlerKey)
		}
	}

	// The collection route is exact; the two dynamic routes require exactly one
	// non-empty segment and (for rotate) the /rotate tail.
	collection := gateway.match(http.MethodGet, "/api/auth/machine-tokens")
	if !collection.Exact {
		t.Fatalf("collection rule must be exact: %+v", collection)
	}
	revoke := gateway.match(http.MethodDelete, "/api/auth/machine-tokens/mtk_abc")
	if revoke.Exact || !revoke.OneSegment || revoke.Tail != "" {
		t.Fatalf("revoke rule = %+v", revoke)
	}
	rotate := gateway.match(http.MethodPost, "/api/auth/machine-tokens/mtk_abc/rotate")
	if rotate.Exact || !rotate.OneSegment || rotate.Tail != "/rotate" {
		t.Fatalf("rotate rule = %+v", rotate)
	}
}

// TestAccountSecurityUnmigratedRoutesStayNest locks every fallback.
func TestAccountSecurityUnmigratedRoutesStayNest(t *testing.T) {
	rules := BaseRules()
	rules = WithAccountSecurity(rules)
	gateway := New(rules)
	for _, tc := range accountSecurityNestRoutes() {
		if got := gateway.match(tc.method, tc.path); got.Prefix != "" {
			t.Fatalf("%s %s mode=%s, want legacy", tc.method, tc.path, got.Prefix)
		}
	}
}

// TestAccountSecurityCoexistsWithOtherAuthRoutes locks rule attribution when the
// account switch is go alongside the runtime settings switch.
func TestAccountSecurityCoexistsWithOtherAuthRoutes(t *testing.T) {
	rules := BaseRules()
	rules = WithRuntimeSettings(rules)
	rules = WithAccountSecurity(rules)
	gateway := New(rules)
	for _, tc := range accountSecurityGoRoutes() {
		got := gateway.match(tc.method, tc.path)
		if got.Prefix == "" || got.HandlerKey != AccountSecurityKey {
			t.Fatalf("%s %s = %+v", tc.method, tc.path, got)
		}
	}
	// The account switch must not have taken any settings route over.
	rateLimits := gateway.match(http.MethodGet, "/api/system-settings/rate-limits")
	if rateLimits.Prefix == "" || rateLimits.HandlerKey != RuntimeSettingsKey {
		t.Fatalf("runtime settings route = %+v", rateLimits)
	}
	if got := gateway.match(http.MethodGet, "/api/system-settings/vector-service"); got.HandlerKey == AccountSecurityKey {
		t.Fatalf("account security took a settings route: %+v", got)
	}
}
