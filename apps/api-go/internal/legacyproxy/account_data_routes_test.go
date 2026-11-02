package legacyproxy

import (
	"net/http"
	"testing"
)

// TestWithAccountDataRoutes pins the exact method/path ownership and proves the
// neighbouring auth rules cannot shadow the two entries.
func TestWithAccountDataRoutes(t *testing.T) {
	gateway := New(WithAccountData(WithAccountSecurity(BaseRules())))

	cases := []struct {
		method  string
		path    string
		wantKey string
	}{
		{http.MethodPost, "/api/auth/avatar/presigned-url", AvatarUploadKey},
		{http.MethodGet, "/api/auth/data-export", UserDataExportKey},
		{http.MethodOptions, "/api/auth/avatar/presigned-url", AvatarUploadKey},
		{http.MethodOptions, "/api/auth/data-export", UserDataExportKey},
		// The neighbouring account-security rules still own their own paths.
		{http.MethodGet, "/api/auth/me", AccountSecurityKey},
	}
	for _, tc := range cases {
		rule, matched := gateway.matchRule(tc.method, tc.path)
		if !matched {
			t.Errorf("%s %s matched nothing, want %q", tc.method, tc.path, tc.wantKey)
			continue
		}
		key := rule.Prefix
		if rule.HandlerKey != "" {
			key = rule.HandlerKey
		}
		if key != tc.wantKey {
			t.Errorf("%s %s key = %q, want %q", tc.method, tc.path, key, tc.wantKey)
		}
	}

	// Similar paths and other methods are not claimed.
	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/api/auth/avatar/presigned-url"},
		{http.MethodPost, "/api/auth/data-export"},
		{http.MethodPost, "/api/auth/avatar/presigned-url/extra"},
		{http.MethodGet, "/api/auth/data-export/extra"},
		{http.MethodGet, "/api/auth/avatar"},
	} {
		if _, matched := gateway.matchRule(tc.method, tc.path); matched {
			t.Errorf("%s %s unexpectedly matched", tc.method, tc.path)
		}
	}
}
