package legacyproxy

import (
	"net/http"
	"testing"
)

func TestWithEconomicDataLegacyAddsNothing(t *testing.T) {
	rules := []Rule{{Prefix: "/api/", Mode: ModeLegacy}}
	got := WithEconomicData(rules, "")
	if len(got) != len(rules) {
		t.Fatalf("legacy mode added %d rules", len(got)-len(rules))
	}
}

func TestWithEconomicDataExactPaths(t *testing.T) {
	rules := WithEconomicData([]Rule{{Prefix: "/api/", Mode: ModeLegacy}}, string(ModeGo))
	want := map[string]string{
		"/api/admin/akshare/version": http.MethodGet,
		"/api/admin/akshare/status":  http.MethodGet,
		"/api/admin/akshare/upgrade": http.MethodPost,
	}
	for _, rule := range rules {
		if method, ok := want[rule.Prefix]; ok {
			if rule.Mode != ModeGo || !rule.Exact || !rule.Methods[method] {
				t.Fatalf("rule %s = %+v", rule.Prefix, rule)
			}
			delete(want, rule.Prefix)
		}
	}
	if len(want) != 0 {
		t.Fatalf("missing rules: %v", want)
	}
}
