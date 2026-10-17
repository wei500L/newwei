package legacyproxy

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/wei500L/newwei/apps/api-go/internal/httpx"
	"github.com/wei500L/newwei/apps/api-go/internal/llmgatewayprofiles"
)

// llmGatewayProfilesBase is the prefix of the seven migrated routes.
const llmGatewayProfilesBase = "/api/system-settings/llm-gateways"

// llmGatewayProfilesGoRoutes are the seven route/method pairs this batch owns
// when the switch is go.
func llmGatewayProfilesGoRoutes() []struct{ method, path string } {
	return []struct{ method, path string }{
		{http.MethodGet, llmGatewayProfilesBase},
		{http.MethodPost, llmGatewayProfilesBase},
		{http.MethodPut, llmGatewayProfilesBase + "/active"},
		{http.MethodPut, llmGatewayProfilesBase + "/embedding-active"},
		{http.MethodPut, llmGatewayProfilesBase + "/rerank-active"},
		{http.MethodPut, llmGatewayProfilesBase + "/profile-1"},
		{http.MethodDelete, llmGatewayProfilesBase + "/profile-1"},
	}
}

// llmGatewayProfilesLegacyRoutes are paths and methods that must never be
// claimed by this batch even when the switch is go. The unmigrated static paths
// are included because their shape matches the dynamic :id rule.
func llmGatewayProfilesLegacyRoutes() []struct{ method, path string } {
	return []struct{ method, path string }{
		// Other methods on the collection and the dynamic segment.
		{http.MethodPut, llmGatewayProfilesBase},
		{http.MethodDelete, llmGatewayProfilesBase},
		{http.MethodGet, llmGatewayProfilesBase + "/profile-1"},
		{http.MethodPost, llmGatewayProfilesBase + "/profile-1"},
		{http.MethodPatch, llmGatewayProfilesBase + "/profile-1"},
		// Longer paths are never one segment.
		{http.MethodPost, llmGatewayProfilesBase + "/profile-1/test"},
		{http.MethodGet, llmGatewayProfilesBase + "/profile-1/models"},
		{http.MethodGet, llmGatewayProfilesBase + "/profile-1/proxy-health"},
		{http.MethodGet, llmGatewayProfilesBase + "/profile-1/proxy-model-info"},
		{http.MethodPost, llmGatewayProfilesBase + "/profile-1/proxy-lb-test"},
		{http.MethodPut, llmGatewayProfilesBase + "/profile-1/extra"},
		{http.MethodDelete, llmGatewayProfilesBase + "/profile-1/extra"},
		{http.MethodPost, llmGatewayProfilesBase + "/test-config"},
		{http.MethodPost, llmGatewayProfilesBase + "/models-config"},
		{http.MethodPost, llmGatewayProfilesBase + "/proxy-governance/preflight"},
		{http.MethodPost, llmGatewayProfilesBase + "/proxy-governance/rotate-key"},
		// Trailing slash is not one non-empty segment.
		{http.MethodPut, llmGatewayProfilesBase + "/"},
		{http.MethodDelete, llmGatewayProfilesBase + "/"},
		{http.MethodPut, llmGatewayProfilesBase + "/profile-1/"},
		{http.MethodDelete, llmGatewayProfilesBase + "/profile-1/"},
	}
}

func TestLLMGatewayProfilesStayLegacyByDefault(t *testing.T) {
	rules := DefaultRules(ModeShadow, "")
	rules = WithLLMGatewayProfiles(rules, "")
	rules = WithLLMGatewayProfiles(rules, string(ModeLegacy))
	gateway, err := New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range append(llmGatewayProfilesGoRoutes(), llmGatewayProfilesLegacyRoutes()...) {
		if got := gateway.match(tc.method, tc.path); got.Mode != ModeLegacy {
			t.Fatalf("%s %s mode=%s, want legacy", tc.method, tc.path, got.Mode)
		}
	}
}

func TestLLMGatewayProfilesGoOwnsRoutes(t *testing.T) {
	rules := DefaultRules(ModeShadow, "")
	rules = WithLLMGatewayProfiles(rules, string(ModeGo))
	gateway, err := New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range llmGatewayProfilesGoRoutes() {
		got := gateway.match(tc.method, tc.path)
		if got.Mode != ModeGo {
			t.Fatalf("%s %s mode=%s, want go", tc.method, tc.path, got.Mode)
		}
		if got.HandlerKey != LLMGatewayProfilesKey {
			t.Fatalf("%s %s key=%q, want %q", tc.method, tc.path, got.HandlerKey, LLMGatewayProfilesKey)
		}
	}

	// The three activation paths and the collection are exact rules; the
	// activation paths must win over the dynamic rule they prefix.
	for _, path := range []string{
		llmGatewayProfilesBase,
		llmGatewayProfilesBase + "/active",
		llmGatewayProfilesBase + "/embedding-active",
		llmGatewayProfilesBase + "/rerank-active",
	} {
		got := gateway.match(http.MethodPut, path)
		if !got.Exact || got.OneSegment {
			t.Fatalf("PUT %s rule=%+v, want exact", path, got)
		}
	}
	// :id is exactly one segment, without a tail.
	got := gateway.match(http.MethodPut, llmGatewayProfilesBase+"/profile-1")
	if !got.OneSegment || got.Exact || got.Tail != "" || got.TailSegment {
		t.Fatalf("PUT :id rule=%+v, want one-segment without tail", got)
	}

	// Preflight OPTIONS for the owned paths is answered by the Go handler.
	for _, path := range []string{
		llmGatewayProfilesBase,
		llmGatewayProfilesBase + "/active",
		llmGatewayProfilesBase + "/profile-1",
	} {
		if got := gateway.match(http.MethodOptions, path); got.Mode != ModeGo {
			t.Fatalf("OPTIONS %s mode=%s, want go", path, got.Mode)
		}
	}
}

func TestLLMGatewayProfilesLongerPathsAndMethodsStayLegacy(t *testing.T) {
	rules := DefaultRules(ModeShadow, "")
	rules = WithLLMGatewayProfiles(rules, string(ModeGo))
	gateway, err := New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range llmGatewayProfilesLegacyRoutes() {
		if got := gateway.match(tc.method, tc.path); got.Mode != ModeLegacy {
			t.Fatalf("%s %s mode=%s, want legacy", tc.method, tc.path, got.Mode)
		}
	}
}

// newLLMGatewayProfilesWiring reproduces the wiring decision under test: static
// paths that stay on NestJS are forwarded before CORS and authentication, real
// owned requests reach the Go handler.
func newLLMGatewayProfilesWiring(t *testing.T, stub *legacyStub, goHits *[]string) http.Handler {
	t.Helper()
	rules := WithLLMGatewayProfiles(DefaultRules(ModeShadow, ""), string(ModeGo))
	gateway, err := New(stub.server.URL, rules)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	gateway.RegisterGoHandler(LLMGatewayProfilesKey, func(w http.ResponseWriter, r *http.Request) {
		if llmgatewayprofiles.IsUnmigratedStaticPath(r.URL.Path) {
			gateway.ServeLegacy(w, r)
			return
		}
		*goHits = append(*goHits, r.Method+" "+r.URL.Path)
		httpx.WriteJSON(w, http.StatusOK, struct {
			Upstream string `json:"upstream"`
		}{Upstream: "go"})
	})
	return httpx.TraceMiddleware(gateway)
}

func TestLLMGatewayProfilesUnmigratedStaticPathsReachLegacyStub(t *testing.T) {
	stub := newLegacyStub(t)
	var goHits []string
	handler := newLLMGatewayProfilesWiring(t, stub, &goHits)

	// PUT/DELETE on the two one-segment static paths are shaped exactly like
	// :id, so the only way to avoid a Go profile 404 is the wiring check.
	for _, tc := range []struct{ method, path string }{
		{http.MethodPut, llmGatewayProfilesBase + "/proxy-governance"},
		{http.MethodDelete, llmGatewayProfilesBase + "/proxy-governance"},
		{http.MethodPut, llmGatewayProfilesBase + "/proxy-load-balancing"},
		{http.MethodDelete, llmGatewayProfilesBase + "/proxy-load-balancing"},
		{http.MethodPut, llmGatewayProfilesBase + "/test-config"},
		{http.MethodDelete, llmGatewayProfilesBase + "/test-config"},
		{http.MethodPut, llmGatewayProfilesBase + "/models-config"},
		{http.MethodDelete, llmGatewayProfilesBase + "/models-config"},
	} {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest(tc.method, "http://gateway"+tc.path, nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("%s %s status=%d, want the legacy stub's 200 (a Go 404 means the static path was treated as a profile id)", tc.method, tc.path, rec.Code)
		}
		if got := rec.Body.String(); got != `{"upstream":"legacy"}` {
			t.Fatalf("%s %s body=%s, want the legacy stub payload", tc.method, tc.path, got)
		}
	}
	if len(stub.requests) != 8 {
		t.Fatalf("legacy stub saw %d requests, want 8", len(stub.requests))
	}
	if len(goHits) != 0 {
		t.Fatalf("go handler served %v, want none", goHits)
	}
}

func TestLLMGatewayProfilesUnmigratedOptionsReachLegacyStub(t *testing.T) {
	stub := newLegacyStub(t)
	var goHits []string
	handler := newLLMGatewayProfilesWiring(t, stub, &goHits)

	// OPTIONS on /proxy-governance matches the dynamic rule, but it must be
	// forwarded: this batch's preflight logic must not claim an unmigrated
	// path.
	for _, path := range []string{
		llmGatewayProfilesBase + "/proxy-governance",
		llmGatewayProfilesBase + "/proxy-load-balancing",
	} {
		rec := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodOptions, "http://gateway"+path, nil)
		request.Header.Set("Origin", "http://console.example")
		request.Header.Set("Access-Control-Request-Method", http.MethodPut)
		handler.ServeHTTP(rec, request)
		if rec.Code != http.StatusOK {
			t.Fatalf("OPTIONS %s status=%d, want the legacy stub's 200", path, rec.Code)
		}
	}
	if len(stub.requests) != 2 {
		t.Fatalf("legacy stub saw %d requests, want 2", len(stub.requests))
	}
	for _, request := range stub.requests {
		if request.Method != http.MethodOptions {
			t.Fatalf("legacy stub method=%s, want OPTIONS", request.Method)
		}
	}
}

func TestLLMGatewayProfilesOwnedRequestsReachGo(t *testing.T) {
	stub := newLegacyStub(t)
	var goHits []string
	handler := newLLMGatewayProfilesWiring(t, stub, &goHits)

	for _, tc := range llmGatewayProfilesGoRoutes() {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest(tc.method, "http://gateway"+tc.path, nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("%s %s status=%d, want 200", tc.method, tc.path, rec.Code)
		}
		if got := rec.Body.String(); got != `{"upstream":"go"}` {
			t.Fatalf("%s %s body=%s, want the go payload", tc.method, tc.path, got)
		}
	}
	if len(stub.requests) != 0 {
		t.Fatalf("legacy stub saw %d requests, want none", len(stub.requests))
	}
	if len(goHits) != len(llmGatewayProfilesGoRoutes()) {
		t.Fatalf("go handler served %v, want %d requests", goHits, len(llmGatewayProfilesGoRoutes()))
	}
}

func TestLLMGatewayProfilesCoexistsWithOtherModes(t *testing.T) {
	rules := DefaultRules(ModeShadow, "")
	rules = WithRuntimeSettings(rules, string(ModeGo))
	rules = WithLLMGatewayProfiles(rules, string(ModeGo))
	gateway, err := New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}

	// The runtime-settings unit keeps its own key and routes.
	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/api/system-settings/rate-limits"},
		{http.MethodPut, "/api/system-settings/auth-cache"},
		{http.MethodGet, "/api/system-settings/rate-limit-policies/unknown"},
	} {
		got := gateway.match(tc.method, tc.path)
		if got.Mode != ModeGo || got.HandlerKey != RuntimeSettingsKey {
			t.Fatalf("%s %s rule=%+v, want the runtime settings key", tc.method, tc.path, got)
		}
	}

	// llm-gateways paths keep the profiles key.
	for _, tc := range llmGatewayProfilesGoRoutes() {
		got := gateway.match(tc.method, tc.path)
		if got.Mode != ModeGo || got.HandlerKey != LLMGatewayProfilesKey {
			t.Fatalf("%s %s rule=%+v, want the llm gateway profiles key", tc.method, tc.path, got)
		}
	}

	// Every other /api/system-settings path stays on the legacy proxy.
	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/api/system-settings/security"},
		{http.MethodPut, "/api/system-settings/security"},
		{http.MethodGet, llmGatewayProfilesBase + "/proxy-governance"},
	} {
		if got := gateway.match(tc.method, tc.path); got.Mode != ModeLegacy {
			t.Fatalf("%s %s mode=%s, want legacy", tc.method, tc.path, got.Mode)
		}
	}
}
