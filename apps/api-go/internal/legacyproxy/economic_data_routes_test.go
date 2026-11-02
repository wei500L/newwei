package legacyproxy

import (
	"net/http"
	"testing"
)

// TestWithEconomicDataExactPaths locks the three exact AkShare routes and the
// method scoping.
func TestWithEconomicDataExactPaths(t *testing.T) {
	gateway := New(WithEconomicData(BaseRules()))
	want := map[string]string{
		"/api/admin/akshare/version": http.MethodGet,
		"/api/admin/akshare/status":  http.MethodGet,
		"/api/admin/akshare/upgrade": http.MethodPost,
	}
	for path, method := range want {
		rule, matched := gateway.matchRule(method, path)
		if !matched || rule.HandlerKey != EconomicDataKey || !rule.Exact || !rule.Methods[method] {
			t.Fatalf("%s %s = %+v matched=%v", method, path, rule, matched)
		}
	}
	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/api/admin/akshare/upgrade"},
		{http.MethodPost, "/api/admin/akshare/status"},
		{http.MethodGet, "/api/admin/akshare/version/extra"},
		{http.MethodGet, "/api/admin/akshare/version/"},
	} {
		if _, matched := gateway.matchRule(tc.method, tc.path); matched {
			t.Fatalf("%s %s unexpectedly matched a Go rule", tc.method, tc.path)
		}
	}
}
