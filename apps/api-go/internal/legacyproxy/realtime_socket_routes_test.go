package legacyproxy

import (
	"net/http"
	"testing"
)

// TestWithRealtimeSocketOnlyAddsInGoMode pins the switch semantics: legacy
// leaves every rule untouched, go adds exactly one GET-only rule for the
// dedicated /socket.io-realtime path.
func TestWithRealtimeSocketOnlyAddsInGoMode(t *testing.T) {
	base := DefaultRulesWithWrite("", "", "")
	if got := WithRealtimeSocket(base, "legacy"); len(got) != len(base) {
		t.Fatalf("legacy mode added %d rules", len(got)-len(base))
	}
	rules := WithRealtimeSocket(base, string(ModeGo))
	if len(rules) != len(base)+1 {
		t.Fatalf("go mode added %d rules, want 1", len(rules)-len(base))
	}
	rule := rules[len(rules)-1]
	if rule.Prefix != "/socket.io-realtime" || rule.Mode != ModeGo {
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
