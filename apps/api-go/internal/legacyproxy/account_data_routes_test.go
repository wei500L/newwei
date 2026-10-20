package legacyproxy

import (
	"net/http"
	"testing"
)

// TestWithAccountDataRoutes pins the exact method/path ownership and proves the
// neighbouring auth rules cannot shadow the two new entries.
func TestWithAccountDataRoutes(t *testing.T) {
	rules := DefaultRulesWithWrite("", "", "")
	rules = WithAccountSecurity(rules, string(ModeGo))
	rules = WithAccountData(rules, string(ModeGo), string(ModeGo))
	gateway := &Gateway{rules: rules}

	cases := []struct {
		method   string
		path     string
		wantKey  string
		wantMode Mode
	}{
		{http.MethodPost, "/api/auth/avatar/presigned-url", AvatarUploadKey, ModeGo},
		{http.MethodGet, "/api/auth/data-export", UserDataExportKey, ModeGo},
		{http.MethodOptions, "/api/auth/avatar/presigned-url", AvatarUploadKey, ModeGo},
		{http.MethodOptions, "/api/auth/data-export", UserDataExportKey, ModeGo},
		// Similar paths and other methods keep falling back to /api/.
		{http.MethodGet, "/api/auth/avatar/presigned-url", "/api/", ModeLegacy},
		{http.MethodPost, "/api/auth/data-export", "/api/", ModeLegacy},
		{http.MethodPost, "/api/auth/avatar/presigned-url/extra", "/api/", ModeLegacy},
		{http.MethodGet, "/api/auth/data-export/extra", "/api/", ModeLegacy},
		{http.MethodGet, "/api/auth/avatar", "/api/", ModeLegacy},
		// The neighbouring account-security rules still own their own paths.
		{http.MethodGet, "/api/auth/me", AccountSecurityKey, ModeGo},
	}
	for _, tc := range cases {
		rule := gateway.match(tc.method, tc.path)
		if rule.Mode != tc.wantMode {
			t.Errorf("%s %s mode = %q, want %q", tc.method, tc.path, rule.Mode, tc.wantMode)
		}
		if rule.HandlerKey != "" {
			if rule.HandlerKey != tc.wantKey {
				t.Errorf("%s %s key = %q, want %q", tc.method, tc.path, rule.HandlerKey, tc.wantKey)
			}
		} else if rule.Prefix != tc.wantKey {
			t.Errorf("%s %s prefix = %q, want %q", tc.method, tc.path, rule.Prefix, tc.wantKey)
		}
	}
}

// TestWithAccountDataLegacyAddsNothing proves the default deployment is
// untouched: empty and legacy modes register no rule.
func TestWithAccountDataLegacyAddsNothing(t *testing.T) {
	base := DefaultRulesWithWrite("", "", "")
	for _, mode := range []string{"", string(ModeLegacy)} {
		rules := WithAccountData(base, mode, mode)
		if len(rules) != len(base) {
			t.Fatalf("mode %q added %d rules", mode, len(rules)-len(base))
		}
	}
}
