package legacyproxy

import (
	"net/http"
	"testing"
)

// TestWithNotificationsSocketAppendsOneRule pins the rule: exactly one GET-only
// rule for the dedicated /socket.io-notifications path.
func TestWithNotificationsSocketAppendsOneRule(t *testing.T) {
	base := BaseRules()
	rules := WithNotificationsSocket(base)
	if len(rules) != len(base)+1 {
		t.Fatalf("added %d rules, want 1", len(rules)-len(base))
	}
	rule := rules[len(rules)-1]
	if rule.Prefix != "/socket.io-notifications" {
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
