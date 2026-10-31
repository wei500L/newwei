package legacyproxy

import (
	"net/http"
	"testing"
)

// TestWithRealtimeSocketAppendsOneRule pins the rule: exactly one GET-only rule
// for the dedicated /socket.io-realtime path.
func TestWithRealtimeSocketAppendsOneRule(t *testing.T) {
	base := BaseRules()
	rules := WithRealtimeSocket(base)
	if len(rules) != len(base)+1 {
		t.Fatalf("added %d rules, want 1", len(rules)-len(base))
	}
	rule := rules[len(rules)-1]
	if rule.Prefix != "/socket.io-realtime" {
		t.Fatalf("unexpected rule: %#v", rule)
	}
	if !rule.matchesPath("/socket.io-realtime/") {
		t.Fatal("dedicated path must match")
	}
	if !rule.Methods[http.MethodGet] {
		t.Fatal("GET must be taken over")
	}
	if rule.Methods[http.MethodPost] {
		t.Fatal("only GET may be taken over")
	}
}
