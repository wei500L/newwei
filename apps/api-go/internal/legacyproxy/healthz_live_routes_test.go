package legacyproxy

import (
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	"github.com/wei500L/newwei/apps/api-go/internal/httpx"
)

// countLegacyRequests returns how many requests reached the NestJS stand-in.
func countLegacyRequests(stub *legacyStub) int {
	stub.mu.Lock()
	defer stub.mu.Unlock()
	return len(stub.requests)
}

// findHealthzLiveRule returns the single exact rule that owns the public
// liveness probe.
func findHealthzLiveRule(t *testing.T, rules []Rule) Rule {
	t.Helper()
	var found []Rule
	for _, rule := range rules {
		if rule.Prefix == healthzLivePath {
			found = append(found, rule)
		}
	}
	if len(found) != 1 {
		t.Fatalf("rules contain %d rules for %s, want exactly 1", len(found), healthzLivePath)
	}
	return found[0]
}

// TestWithHealthzLiveDefaultRuleTableUnchanged pins the default rule table to
// today's behaviour: mode "" and "shadow" must return the exact table
// DefaultRulesWithWrite produces, including the healthz-live rule's Exact flag
// and its GET-only Methods map.
func TestWithHealthzLiveDefaultRuleTableUnchanged(t *testing.T) {
	for _, mode := range []string{"", "shadow", string(ModeShadow)} {
		got := WithHealthzLive(DefaultRulesWithWrite(ModeShadow, "", ""), mode)
		want := DefaultRulesWithWrite(ModeShadow, "", "")
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("WithHealthzLive(base, %q) changed the default rule table:\ngot  %#v\nwant %#v", mode, got, want)
		}
	}

	rule := findHealthzLiveRule(t, DefaultRulesWithWrite(ModeShadow, "", ""))
	if rule.Mode != ModeShadow {
		t.Fatalf("default healthz-live mode = %q, want %q", rule.Mode, ModeShadow)
	}
	if !rule.Exact {
		t.Fatal("default healthz-live rule must stay exact")
	}
	if !reflect.DeepEqual(rule.Methods, map[string]bool{http.MethodGet: true}) {
		t.Fatalf("default healthz-live methods = %#v, want GET only", rule.Methods)
	}
}

// TestWithHealthzLiveModesOnlyTouchesTheProbe checks that legacy/go replace the
// existing rule in place — the table keeps its size and rule order, and every
// other rule (including the /api/ fallback) is unchanged.
func TestWithHealthzLiveModesOnlyTouchesTheProbe(t *testing.T) {
	base := DefaultRulesWithWrite(ModeShadow, "", "")
	cases := map[string]Mode{
		"legacy": ModeLegacy,
		"go":     ModeGo,
	}
	for mode, wantMode := range cases {
		input := DefaultRulesWithWrite(ModeShadow, "", "")
		got := WithHealthzLive(input, mode)
		if original := findHealthzLiveRule(t, input); original.Mode != ModeShadow {
			t.Fatalf("WithHealthzLive(base, %q) mutated the input table: mode = %q, want shadow", mode, original.Mode)
		}
		if len(got) != len(base) {
			t.Fatalf("WithHealthzLive(base, %q) returned %d rules, want %d (replace, not append)", mode, len(got), len(base))
		}
		for i, rule := range got {
			want := base[i]
			if rule.Prefix == healthzLivePath && rule.Exact {
				want.Mode = wantMode
			}
			if !reflect.DeepEqual(rule, want) {
				t.Fatalf("WithHealthzLive(base, %q) rule %d = %#v, want %#v", mode, i, rule, want)
			}
		}

		rule := findHealthzLiveRule(t, got)
		if rule.Mode != wantMode {
			t.Fatalf("WithHealthzLive(base, %q) healthz-live mode = %q, want %q", mode, rule.Mode, wantMode)
		}
		if !rule.Exact {
			t.Fatalf("WithHealthzLive(base, %q) dropped Exact on the healthz-live rule", mode)
		}
		if !reflect.DeepEqual(rule.Methods, map[string]bool{http.MethodGet: true}) {
			t.Fatalf("WithHealthzLive(base, %q) healthz-live methods = %#v, want GET only", mode, rule.Methods)
		}
	}
}

// TestWithHealthzLiveUnknownModeKeepsShadow documents the defensive default:
// config startup validation rejects unknown values, so the gateway must not
// invent a mode (and therefore must not change the rule table).
func TestWithHealthzLiveUnknownModeKeepsShadow(t *testing.T) {
	got := WithHealthzLive(DefaultRulesWithWrite(ModeShadow, "", ""), "bogus")
	want := DefaultRulesWithWrite(ModeShadow, "", "")
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("WithHealthzLive with an unknown mode changed the rule table")
	}
}

// TestWithHealthzLiveRouting pins the behaviour of the three modes plus the
// GET-only / exact boundaries: in go mode only GET on the exact path reaches
// the Go handler; POST, the trailing slash form and similar paths keep falling
// through to the /api/ legacy rule.
func TestWithHealthzLiveRouting(t *testing.T) {
	stub := newLegacyStub(t)
	rules := WithHealthzLive(DefaultRules(ModeShadow, ""), string(ModeGo))
	gateway, err := New(stub.server.URL, rules)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	goServed := 0
	gateway.RegisterGoHandler(healthzLivePath, func(w http.ResponseWriter, _ *http.Request) {
		goServed++
		w.WriteHeader(http.StatusOK)
	})
	handler := httpx.TraceMiddleware(gateway)

	serve := func(method, target string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest(method, "http://gateway"+target, nil))
		return rec
	}

	serve(http.MethodGet, healthzLivePath)
	if goServed != 1 {
		t.Fatalf("GET %s served by Go %d times, want 1", healthzLivePath, goServed)
	}
	if reached := countLegacyRequests(stub); reached != 0 {
		t.Fatalf("GET %s reached NestJS %d times, want 0", healthzLivePath, reached)
	}

	for _, tc := range []struct{ method, target string }{
		{http.MethodPost, healthzLivePath},
		{http.MethodHead, healthzLivePath},
		{http.MethodGet, healthzLivePath + "/"},
		{http.MethodGet, "/api/healthz/liveness"},
	} {
		before := countLegacyRequests(stub)
		serve(tc.method, tc.target)
		if after := countLegacyRequests(stub); after != before+1 {
			t.Fatalf("%s %s reached NestJS %d times, want 1 (must fall through to /api/)", tc.method, tc.target, after-before)
		}
	}

	// legacy mode keeps the same exact GET-only rule but routes it to NestJS.
	legacyGateway, err := New(stub.server.URL, WithHealthzLive(DefaultRules(ModeShadow, ""), string(ModeLegacy)))
	if err != nil {
		t.Fatalf("New legacy: %v", err)
	}
	legacyGateway.RegisterGoHandler(healthzLivePath, func(w http.ResponseWriter, _ *http.Request) {
		t.Error("legacy mode routed the probe to the Go handler")
	})
	before := countLegacyRequests(stub)
	rec := httptest.NewRecorder()
	httpx.TraceMiddleware(legacyGateway).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "http://gateway"+healthzLivePath, nil))
	if after := countLegacyRequests(stub); after != before+1 {
		t.Fatalf("legacy mode forwarded the probe %d times, want 1", after-before)
	}

	// shadow mode still forwards to NestJS (the Go implementation is only a
	// side-channel comparison), matching the pre-switch default.
	shadowGateway, err := New(stub.server.URL, WithHealthzLive(DefaultRules(ModeShadow, ""), ""))
	if err != nil {
		t.Fatalf("New shadow: %v", err)
	}
	before = countLegacyRequests(stub)
	httpx.TraceMiddleware(shadowGateway).ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "http://gateway"+healthzLivePath, nil))
	if after := countLegacyRequests(stub); after != before+1 {
		t.Fatalf("shadow mode forwarded the probe %d times, want 1", after-before)
	}
}
