package legacyproxy

import (
	"net/http"
	"testing"
)

func TestWithNotificationsSocketOnlyAddsInGoMode(t *testing.T) {
	base := DefaultRulesWithWrite("", "", "")
	if got := WithNotificationsSocket(base, "legacy"); len(got) != len(base) {
		t.Fatalf("legacy mode added %d rules", len(got)-len(base))
	}
	rules := WithNotificationsSocket(base, string(ModeGo))
	if len(rules) != len(base)+1 {
		t.Fatalf("go mode added %d rules, want 1", len(rules)-len(base))
	}
	rule := rules[len(rules)-1]
	if rule.Prefix != "/socket.io-notifications" || rule.Mode != ModeGo {
		t.Fatalf("unexpected rule: %#v", rule)
	}
	if !rule.matchesPath("/socket.io-notifications/") {
		t.Fatal("dedicated path must match")
	}
	if rule.Methods[http.MethodPost] {
		t.Fatal("only GET may be taken over")
	}
	if !rule.Methods[http.MethodGet] {
		t.Fatal("GET must be taken over")
	}
}
