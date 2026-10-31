package legacyproxy

import (
	"net/http"
	"testing"
)

// TestGdeltSnapshotRefreshStaysLegacyByDefault locks the default and the
// explicit legacy value: the POST and its preflight keep going to NestJS.

// TestGdeltSnapshotRefreshGoOwnsOneExactRoute proves the go rule is exactly the
// POST (and its preflight) and that everything around it keeps falling back.
func TestGdeltSnapshotRefreshGoOwnsOneExactRoute(t *testing.T) {
	rules := BaseRules()
	rules = WithGdeltSnapshotRefresh(rules)
	gateway := New(rules)

	for _, testCase := range []struct {
		method string
		path   string
	}{
		{http.MethodPost, GdeltSnapshotKey},
		{http.MethodOptions, GdeltSnapshotKey},
	} {
		got := gateway.match(testCase.method, testCase.path)
		if got.Prefix == "" || got.HandlerKey != GdeltSnapshotKey || !got.Exact {
			t.Errorf("%s %s = %+v, want the exact Go rule", testCase.method, testCase.path, got)
		}
	}

	for _, testCase := range []struct{ method, path string }{
		// Other methods on the taken-over path.
		{http.MethodGet, GdeltSnapshotKey},
		{http.MethodHead, GdeltSnapshotKey},
		{http.MethodPut, GdeltSnapshotKey},
		{http.MethodDelete, GdeltSnapshotKey},
		// Trailing slash and longer/neighbouring paths.
		{http.MethodPost, GdeltSnapshotKey + "/"},
		{http.MethodPost, GdeltSnapshotKey + "/extra"},
		{http.MethodPost, "/api/system-settings/situation-monitor/external-snapshot"},
		{http.MethodPost, "/api/system-settings/situation-monitor/external-snapshot/fresh"},
		// The deliberately unmigrated settings surface.
		{http.MethodGet, "/api/system-settings/situation-monitor"},
		{http.MethodPut, "/api/system-settings/situation-monitor"},
		{http.MethodDelete, "/api/system-settings/situation-monitor"},
		{http.MethodPost, "/api/system-settings/geo/nominatim/test"},
	} {
		if got := gateway.match(testCase.method, testCase.path); got.Prefix != "" {
			t.Errorf("%s %s mode=%s, want legacy", testCase.method, testCase.path, got.Prefix)
		}
	}
}

// TestGdeltSnapshotRefreshDoesNotShadowNeighbouringRules composes the three
// settings units with every switch go: each one keeps its own routes.
func TestGdeltSnapshotRefreshDoesNotShadowNeighbouringRules(t *testing.T) {
	rules := BaseRules()
	rules = WithPlatformGovernanceSettings(rules)
	rules = WithDataRuntimeSettings(rules)
	rules = WithGdeltSnapshotRefresh(rules)
	gateway := New(rules)

	if got := gateway.match(http.MethodPost, GdeltSnapshotKey); got.HandlerKey != GdeltSnapshotKey {
		t.Errorf("refresh POST handler = %q, want the GDELT snapshot key", got.HandlerKey)
	}
	if got := gateway.match(http.MethodGet, "/api/system-settings/realtime-signals"); got.HandlerKey != DataRuntimeSettingsKey {
		t.Errorf("realtime-signals handler = %q, want the data runtime key", got.HandlerKey)
	}
	if got := gateway.match(http.MethodPut, "/api/system-settings/security"); got.HandlerKey != PlatformGovernanceSettingsKey {
		t.Errorf("security PUT handler = %q, want the platform governance key", got.HandlerKey)
	}
	if got := gateway.match(http.MethodPost, "/api/system-settings/geo/nominatim/test"); got.Prefix != "" {
		t.Errorf("nominatim test mode = %s, want legacy", got.Prefix)
	}
}
