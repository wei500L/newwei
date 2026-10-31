package legacyproxy

import (
	"net/http"
	"testing"
)

type situationSettingsRoute struct{ method, path string }

// situationSettingsGoRoutes lists the four entries plus their OPTIONS preflight.
func situationSettingsGoRoutes() []situationSettingsRoute {
	return []situationSettingsRoute{
		{http.MethodGet, "/api/system-settings/situation-monitor"},
		{http.MethodPut, "/api/system-settings/situation-monitor"},
		{http.MethodDelete, "/api/system-settings/situation-monitor"},
		{http.MethodDelete, "/api/system-settings/situation-monitor/telegram-auth"},
		{http.MethodOptions, "/api/system-settings/situation-monitor"},
		{http.MethodOptions, "/api/system-settings/situation-monitor/telegram-auth"},
	}
}

// situationSettingsNestRoutes lists every path and method that must keep falling
// back to NestJS even when the switch is go.
func situationSettingsNestRoutes() []situationSettingsRoute {
	return []situationSettingsRoute{
		// The excluded MTProto and snapshot sub-paths.
		{http.MethodPost, "/api/system-settings/situation-monitor/telegram-auth/start"},
		{http.MethodPost, "/api/system-settings/situation-monitor/telegram-auth/complete"},
		{http.MethodPost, "/api/system-settings/situation-monitor/external-snapshot/refresh"},
		// Unlisted methods and paths on the base.
		{http.MethodPost, "/api/system-settings/situation-monitor"},
		{http.MethodPatch, "/api/system-settings/situation-monitor"},
		{http.MethodHead, "/api/system-settings/situation-monitor"},
		{http.MethodGet, "/api/system-settings/situation-monitor/telegram-auth"},
		{http.MethodPut, "/api/system-settings/situation-monitor/telegram-auth"},
		{http.MethodPost, "/api/system-settings/situation-monitor/telegram-auth"},
		// Trailing slashes, extra segments and similar prefixes.
		{http.MethodGet, "/api/system-settings/situation-monitor/"},
		{http.MethodGet, "/api/system-settings/situation-monitor/extra"},
		{http.MethodGet, "/api/system-settings/situation-monitor-extra"},
		{http.MethodDelete, "/api/system-settings/situation-monitor/telegram-auth/extra"},
		// Other settings groups.
		{http.MethodGet, "/api/system-settings/security"},
		{http.MethodGet, "/api/system-settings/realtime-signals"},
		{http.MethodGet, "/api/system-settings/email"},
	}
}

func TestSituationSettingsGoOwnsFourEntries(t *testing.T) {
	rules := BaseRules()
	rules = WithSituationSettings(rules)
	gateway := New(rules)
	for _, tc := range situationSettingsGoRoutes() {
		got := gateway.match(tc.method, tc.path)
		if got.Prefix == "" {
			t.Fatalf("%s %s mode=%s, want go", tc.method, tc.path, got.Prefix)
		}
		if !got.Exact {
			t.Fatalf("%s %s must be exact: %+v", tc.method, tc.path, got)
		}
		if got.HandlerKey != SituationSettingsKey {
			t.Fatalf("%s %s key=%s", tc.method, tc.path, got.HandlerKey)
		}
	}
}

func TestSituationSettingsExcludedRoutesStayNest(t *testing.T) {
	rules := BaseRules()
	rules = WithSituationSettings(rules)
	gateway := New(rules)
	for _, tc := range situationSettingsNestRoutes() {
		if got := gateway.match(tc.method, tc.path); got.Prefix != "" {
			t.Fatalf("%s %s mode=%s, want legacy", tc.method, tc.path, got.Prefix)
		}
	}
}

// TestSituationSettingsCoexistsWithOtherSwitches proves the exact path wins
// over the legacy /api/ fallback while the neighbouring units keep their own
// attribution.
func TestSituationSettingsCoexistsWithOtherSwitches(t *testing.T) {
	rules := BaseRules()
	rules = WithSituationSettings(rules)
	rules = WithDataRuntimeSettings(rules)
	rules = WithPlatformGovernanceSettings(rules)
	gateway := New(rules)
	if got := gateway.match(http.MethodGet, "/api/system-settings/situation-monitor"); got.Prefix == "" ||
		got.HandlerKey != SituationSettingsKey {
		t.Fatalf("situation settings attribution = %+v", got)
	}
	if got := gateway.match(http.MethodGet, "/api/system-settings/realtime-signals"); got.HandlerKey != DataRuntimeSettingsKey {
		t.Fatalf("data runtime attribution = %+v", got)
	}
	if got := gateway.match(http.MethodGet, "/api/system-settings/security"); got.HandlerKey != PlatformGovernanceSettingsKey {
		t.Fatalf("platform governance attribution = %+v", got)
	}
}
