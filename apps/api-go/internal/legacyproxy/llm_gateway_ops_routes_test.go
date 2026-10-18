package legacyproxy

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/wei500L/newwei/apps/api-go/internal/httpx"
)

// llmGatewayOpsBase is the prefix shared with the profile routes.
const llmGatewayOpsBase = "/api/system-settings/llm-gateways"

// llmGatewayOpsGoRoutes are the twelve route/method pairs this batch owns.
func llmGatewayOpsGoRoutes() []struct{ method, path string } {
	return []struct{ method, path string }{
		{http.MethodGet, llmGatewayOpsBase + "/proxy-governance"},
		{http.MethodPut, llmGatewayOpsBase + "/proxy-governance"},
		{http.MethodDelete, llmGatewayOpsBase + "/proxy-governance"},
		{http.MethodPost, llmGatewayOpsBase + "/proxy-governance/preflight"},
		{http.MethodPost, llmGatewayOpsBase + "/proxy-governance/rotate-key"},
		{http.MethodPost, llmGatewayOpsBase + "/models-config"},
		{http.MethodPost, llmGatewayOpsBase + "/test-config"},
		{http.MethodGet, llmGatewayOpsBase + "/profile-1/models"},
		{http.MethodPost, llmGatewayOpsBase + "/profile-1/test"},
		{http.MethodGet, llmGatewayOpsBase + "/profile-1/proxy-health"},
		{http.MethodGet, llmGatewayOpsBase + "/profile-1/proxy-model-info"},
		{http.MethodPost, llmGatewayOpsBase + "/profile-1/proxy-lb-test"},
	}
}

// llmGatewayOpsLegacyRoutes are paths and methods that must never be claimed by
// this batch even when the switch is go. The profile CRUD routes, the LB
// configuration routes and every unknown longer path are included.
func llmGatewayOpsLegacyRoutes() []struct{ method, path string } {
	return []struct{ method, path string }{
		// Profile CRUD kept by WithLLMGatewayProfiles.
		{http.MethodGet, llmGatewayOpsBase},
		{http.MethodPost, llmGatewayOpsBase},
		{http.MethodPut, llmGatewayOpsBase + "/active"},
		{http.MethodPut, llmGatewayOpsBase + "/embedding-active"},
		{http.MethodPut, llmGatewayOpsBase + "/rerank-active"},
		{http.MethodPut, llmGatewayOpsBase + "/profile-1"},
		{http.MethodDelete, llmGatewayOpsBase + "/profile-1"},
		// LB configuration kept by WithProxyLoadBalancing.
		{http.MethodGet, llmGatewayOpsBase + "/proxy-load-balancing"},
		{http.MethodPut, llmGatewayOpsBase + "/proxy-load-balancing"},
		{http.MethodDelete, llmGatewayOpsBase + "/proxy-load-balancing"},
		// Wrong methods on owned paths.
		{http.MethodPost, llmGatewayOpsBase + "/proxy-governance"},
		{http.MethodDelete, llmGatewayOpsBase + "/proxy-governance/preflight"},
		{http.MethodGet, llmGatewayOpsBase + "/models-config"},
		{http.MethodGet, llmGatewayOpsBase + "/test-config"},
		{http.MethodDelete, llmGatewayOpsBase + "/profile-1/models"},
		// Unsupported tails and deeper paths.
		{http.MethodGet, llmGatewayOpsBase + "/profile-1/unknown"},
		{http.MethodPost, llmGatewayOpsBase + "/profile-1/test/extra"},
		{http.MethodGet, llmGatewayOpsBase + "/profile-1/models/extra"},
		{http.MethodPost, llmGatewayOpsBase + "/proxy-governance/preflight/extra"},
		// Trailing slash after the dynamic segment.
		{http.MethodGet, llmGatewayOpsBase + "/profile-1/models/"},
	}
}

func TestLLMGatewayOpsStayLegacyByDefault(t *testing.T) {
	rules := DefaultRules(ModeShadow, "")
	rules = WithLLMGatewayOps(rules, "")
	rules = WithLLMGatewayOps(rules, string(ModeLegacy))
	gateway, err := New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range append(llmGatewayOpsGoRoutes(), llmGatewayOpsLegacyRoutes()...) {
		if got := gateway.match(tc.method, tc.path); got.Mode != ModeLegacy {
			t.Fatalf("%s %s mode=%s, want legacy", tc.method, tc.path, got.Mode)
		}
	}
}

func TestLLMGatewayOpsGoOwnsRoutes(t *testing.T) {
	rules := DefaultRules(ModeShadow, "")
	rules = WithLLMGatewayOps(rules, string(ModeGo))
	gateway, err := New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range llmGatewayOpsGoRoutes() {
		got := gateway.match(tc.method, tc.path)
		if got.Mode != ModeGo {
			t.Fatalf("%s %s mode=%s, want go", tc.method, tc.path, got.Mode)
		}
		if got.HandlerKey != LLMGatewayOpsKey {
			t.Fatalf("%s %s key=%q, want %q", tc.method, tc.path, got.HandlerKey, LLMGatewayOpsKey)
		}
	}
	// The three governance verbs are one exact rule, so a PUT can never be read
	// as a profile id.
	governance := gateway.match(http.MethodPut, llmGatewayOpsBase+"/proxy-governance")
	if !governance.Exact || governance.OneSegment {
		t.Fatalf("PUT /proxy-governance rule=%+v, want exact", governance)
	}
	// The five sub-resources are one extra segment behind a fixed tail.
	models := gateway.match(http.MethodGet, llmGatewayOpsBase+"/profile-1/models")
	if !models.OneSegment || models.Exact || models.Tail != "/models" {
		t.Fatalf("GET :id/models rule=%+v, want one-segment with the /models tail", models)
	}
	for _, path := range []string{
		llmGatewayOpsBase + "/proxy-governance",
		llmGatewayOpsBase + "/models-config",
		llmGatewayOpsBase + "/profile-1/test",
	} {
		if got := gateway.match(http.MethodOptions, path); got.Mode != ModeGo {
			t.Fatalf("OPTIONS %s mode=%s, want go", path, got.Mode)
		}
	}
}

func TestLLMGatewayOpsDoesNotClaimProfileOrLBRoutes(t *testing.T) {
	rules := DefaultRules(ModeShadow, "")
	rules = WithLLMGatewayOps(rules, string(ModeGo))
	gateway, err := New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range llmGatewayOpsLegacyRoutes() {
		if got := gateway.match(tc.method, tc.path); got.Mode != ModeLegacy {
			t.Fatalf("%s %s mode=%s key=%q, want legacy", tc.method, tc.path, got.Mode, got.HandlerKey)
		}
	}
}

func TestLLMGatewayOpsWinsOverTheProfileDynamicRule(t *testing.T) {
	// Both switches go: the exact governance paths and the deeper sub-resources
	// must resolve to the ops handler, while the profile CRUD routes keep the
	// profiles handler.
	rules := DefaultRules(ModeShadow, "")
	rules = WithLLMGatewayProfiles(rules, string(ModeGo))
	rules = WithLLMGatewayOps(rules, string(ModeGo))
	gateway, err := New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range llmGatewayOpsGoRoutes() {
		got := gateway.match(tc.method, tc.path)
		if got.Mode != ModeGo || got.HandlerKey != LLMGatewayOpsKey {
			t.Fatalf("%s %s rule=%+v, want the ops key", tc.method, tc.path, got)
		}
	}
	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, llmGatewayOpsBase},
		{http.MethodPost, llmGatewayOpsBase},
		{http.MethodPut, llmGatewayOpsBase + "/active"},
		{http.MethodPut, llmGatewayOpsBase + "/profile-1"},
		{http.MethodDelete, llmGatewayOpsBase + "/profile-1"},
	} {
		got := gateway.match(tc.method, tc.path)
		if got.Mode != ModeGo || got.HandlerKey != LLMGatewayProfilesKey {
			t.Fatalf("%s %s rule=%+v, want the profiles key", tc.method, tc.path, got)
		}
	}
}

// newLLMGatewayOpsWiring reproduces the production wiring: only the twelve owned
// paths reach the Go handler.
func newLLMGatewayOpsWiring(t *testing.T, stub *legacyStub, goHits *[]string) http.Handler {
	t.Helper()
	rules := WithLLMGatewayOps(DefaultRules(ModeShadow, ""), string(ModeGo))
	gateway, err := New(stub.server.URL, rules)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	gateway.RegisterGoHandler(LLMGatewayOpsKey, func(w http.ResponseWriter, r *http.Request) {
		*goHits = append(*goHits, r.Method+" "+r.URL.Path)
		httpx.WriteJSON(w, http.StatusOK, struct {
			Upstream string `json:"upstream"`
		}{Upstream: "go"})
	})
	return httpx.TraceMiddleware(gateway)
}

func TestLLMGatewayOpsOwnedRequestsReachGo(t *testing.T) {
	stub := newLegacyStub(t)
	var goHits []string
	handler := newLLMGatewayOpsWiring(t, stub, &goHits)

	for _, tc := range llmGatewayOpsGoRoutes() {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest(tc.method, "http://gateway"+tc.path, nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("%s %s status=%d, want 200", tc.method, tc.path, rec.Code)
		}
		if got := strings.TrimSpace(rec.Body.String()); got != `{"upstream":"go"}` {
			t.Fatalf("%s %s body=%s, want the go payload", tc.method, tc.path, got)
		}
	}
	if len(stub.requests) != 0 {
		t.Fatalf("legacy stub saw %d requests, want none", len(stub.requests))
	}
	if len(goHits) != len(llmGatewayOpsGoRoutes()) {
		t.Fatalf("go handler served %v, want %d requests", goHits, len(llmGatewayOpsGoRoutes()))
	}
}

func TestLLMGatewayOpsUnownedPathsReachLegacyStub(t *testing.T) {
	stub := newLegacyStub(t)
	var goHits []string
	handler := newLLMGatewayOpsWiring(t, stub, &goHits)

	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, llmGatewayOpsBase},
		{http.MethodPut, llmGatewayOpsBase + "/profile-1"},
		{http.MethodPut, llmGatewayOpsBase + "/proxy-load-balancing"},
		{http.MethodPost, llmGatewayOpsBase + "/profile-1/test/extra"},
	} {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest(tc.method, "http://gateway"+tc.path, nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("%s %s status=%d, want the legacy stub's 200", tc.method, tc.path, rec.Code)
		}
		if got := strings.TrimSpace(rec.Body.String()); got != `{"upstream":"legacy"}` {
			t.Fatalf("%s %s body=%s, want the legacy stub payload", tc.method, tc.path, got)
		}
	}
	if len(goHits) != 0 {
		t.Fatalf("go handler served %v, want none", goHits)
	}
}
