package legacyproxy

import (
	"net/http"
	"testing"
)

type situationTelegramAuthRoute struct{ method, path string }

func situationTelegramAuthGoRoutes() []situationTelegramAuthRoute {
	return []situationTelegramAuthRoute{
		{http.MethodPost, "/api/system-settings/situation-monitor/telegram-auth/start"},
		{http.MethodPost, "/api/system-settings/situation-monitor/telegram-auth/complete"},
		{http.MethodOptions, "/api/system-settings/situation-monitor/telegram-auth/start"},
		{http.MethodOptions, "/api/system-settings/situation-monitor/telegram-auth/complete"},
	}
}

func TestSituationTelegramAuthStaysLegacyByDefault(t *testing.T) {
	rules := DefaultRules(ModeShadow, "")
	rules = WithSituationTelegramAuth(rules, "")
	rules = WithSituationTelegramAuth(rules, "legacy")
	gateway, err := New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range situationTelegramAuthGoRoutes() {
		if got := gateway.match(tc.method, tc.path); got.Mode != ModeLegacy {
			t.Fatalf("%s %s mode=%s, want legacy", tc.method, tc.path, got.Mode)
		}
	}
}

func TestSituationTelegramAuthGoOwnsTwoPosts(t *testing.T) {
	rules := DefaultRules(ModeShadow, "")
	rules = WithSituationTelegramAuth(rules, string(ModeGo))
	gateway, err := New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range situationTelegramAuthGoRoutes() {
		got := gateway.match(tc.method, tc.path)
		if got.Mode != ModeGo {
			t.Fatalf("%s %s mode=%s, want go", tc.method, tc.path, got.Mode)
		}
		if !got.Exact {
			t.Fatalf("%s %s must be exact: %+v", tc.method, tc.path, got)
		}
		if got.HandlerKey != SituationTelegramAuthKey {
			t.Fatalf("%s %s key=%s", tc.method, tc.path, got.HandlerKey)
		}
	}
}

// TestSituationTelegramAuthExcludedRoutesStayNest proves that the exact,
// method-scoped rules never widen to the settings CRUD, the snapshot refresh or
// any other method on the same prefix.
func TestSituationTelegramAuthExcludedRoutesStayNest(t *testing.T) {
	rules := DefaultRules(ModeShadow, "")
	rules = WithSituationTelegramAuth(rules, string(ModeGo))
	gateway, err := New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	excluded := []situationTelegramAuthRoute{
		{http.MethodGet, "/api/system-settings/situation-monitor/telegram-auth/start"},
		{http.MethodPut, "/api/system-settings/situation-monitor/telegram-auth/complete"},
		{http.MethodDelete, "/api/system-settings/situation-monitor/telegram-auth"},
		{http.MethodPost, "/api/system-settings/situation-monitor/external-snapshot/refresh"},
		{http.MethodPost, "/api/system-settings/situation-monitor/telegram-auth/start/extra"},
		{http.MethodPost, "/api/system-settings/situation-monitor"},
	}
	for _, tc := range excluded {
		if got := gateway.match(tc.method, tc.path); got.Mode != ModeLegacy {
			t.Fatalf("%s %s mode=%s, want legacy", tc.method, tc.path, got.Mode)
		}
	}
}

// TestSituationTelegramAuthCoexistsWithSettings proves the two switches own
// disjoint methods on the shared prefix.
func TestSituationTelegramAuthCoexistsWithSettings(t *testing.T) {
	rules := DefaultRules(ModeShadow, "")
	rules = WithSituationSettings(rules, string(ModeGo))
	rules = WithSituationTelegramAuth(rules, string(ModeGo))
	gateway, err := New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	if got := gateway.match(http.MethodPost, "/api/system-settings/situation-monitor/telegram-auth/start"); got.HandlerKey != SituationTelegramAuthKey {
		t.Fatalf("start attribution = %+v", got)
	}
	if got := gateway.match(http.MethodPost, "/api/system-settings/situation-monitor/telegram-auth/complete"); got.HandlerKey != SituationTelegramAuthKey {
		t.Fatalf("complete attribution = %+v", got)
	}
	if got := gateway.match(http.MethodDelete, "/api/system-settings/situation-monitor/telegram-auth"); got.HandlerKey != SituationSettingsKey {
		t.Fatalf("delete attribution = %+v", got)
	}
	if got := gateway.match(http.MethodGet, "/api/system-settings/situation-monitor"); got.HandlerKey != SituationSettingsKey {
		t.Fatalf("get attribution = %+v", got)
	}
}
