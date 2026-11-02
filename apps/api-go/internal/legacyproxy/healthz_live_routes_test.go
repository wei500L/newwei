package legacyproxy

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestWithHealthzLiveAppendsExactGET pins the rule: one exact GET rule plus its
// OPTIONS preflight, with the GET-only method boundary preserved.
func TestWithHealthzLiveAppendsExactGET(t *testing.T) {
	base := BaseRules()
	rules := WithHealthzLive(base)
	if len(rules) != len(base)+2 {
		t.Fatalf("added %d rules, want 2 (GET + OPTIONS)", len(rules)-len(base))
	}
	gateway := New(rules)
	for _, method := range []string{http.MethodGet, http.MethodOptions} {
		rule, matched := gateway.matchRule(method, healthzLivePath)
		if !matched || !rule.Exact || rule.Prefix != healthzLivePath || !rule.Methods[method] {
			t.Fatalf("%s %s rule = %+v matched=%v", method, healthzLivePath, rule, matched)
		}
	}
	for _, tc := range []struct{ method, path string }{
		{http.MethodPost, healthzLivePath},
		{http.MethodHead, healthzLivePath},
		{http.MethodGet, healthzLivePath + "/"},
		{http.MethodGet, "/api/healthz/liveness"},
	} {
		if _, matched := gateway.matchRule(tc.method, tc.path); matched {
			t.Fatalf("%s %s unexpectedly matched", tc.method, tc.path)
		}
	}
}

// TestWithHealthzLiveServesThroughGateway proves the Go handler answers the
// probe and an unclaimed method is rejected with the NestJS 404 instead.
func TestWithHealthzLiveServesThroughGateway(t *testing.T) {
	gateway := New(WithHealthzLive(BaseRules()))
	served := 0
	gateway.RegisterGoHandler(healthzLivePath, func(w http.ResponseWriter, _ *http.Request) {
		served++
		w.WriteHeader(http.StatusOK)
	})

	rec := httptest.NewRecorder()
	gateway.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, healthzLivePath, nil))
	if served != 1 || rec.Code != http.StatusOK {
		t.Fatalf("GET served=%d status=%d, want 1/200", served, rec.Code)
	}

	served = 0
	rec = httptest.NewRecorder()
	gateway.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, healthzLivePath, nil))
	if served != 0 {
		t.Fatalf("POST reached the Go handler %d times, want 0", served)
	}
	if rec.Code != http.StatusNotFound {
		t.Fatalf("POST status = %d, want 404", rec.Code)
	}
}
