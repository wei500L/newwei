package legacyproxy

import (
	"net/http"
	"testing"
)

// modelAccessSettingsRoutes lists the ten routes the go mode must own.
func modelAccessSettingsRoutes() []struct {
	method string
	path   string
	shape  string // "exact" or "one"
} {
	return []struct {
		method string
		path   string
		shape  string
	}{
		{http.MethodGet, "/api/system-settings/model-service", "exact"},
		{http.MethodPut, "/api/system-settings/model-service", "exact"},
		{http.MethodDelete, "/api/system-settings/model-service", "exact"},
		{http.MethodGet, "/api/system-settings/openai-keys", "exact"},
		{http.MethodPut, "/api/system-settings/openai-keys", "exact"},
		{http.MethodPost, "/api/system-settings/openai-keys", "exact"},
		{http.MethodDelete, "/api/system-settings/openai-keys/key/abc123", "one"},
		{http.MethodDelete, "/api/system-settings/openai-keys", "exact"},
		{http.MethodGet, "/api/internal/litellm/openai-keys", "exact"},
		{http.MethodPost, "/api/internal/litellm/openai-keys/applied", "exact"},
	}
}

// modelAccessSettingsNestRoutes lists paths and methods that must keep falling back
// to NestJS even in go mode.
func modelAccessSettingsNestRoutes() []struct{ method, path string } {
	return []struct{ method, path string }{
		// Similar prefixes and longer paths.
		{http.MethodGet, "/api/system-settings/model-service/"},
		{http.MethodGet, "/api/system-settings/model-service/extra"},
		{http.MethodGet, "/api/system-settings/model-service-x"},
		{http.MethodGet, "/api/system-settings/openai-keys/"},
		{http.MethodGet, "/api/system-settings/openai-keys/key"},
		{http.MethodGet, "/api/system-settings/openai-keys/key/abc/extra"},
		{http.MethodGet, "/api/system-settings/openai-keys/key/"},
		{http.MethodGet, "/api/system-settings/openai-keys/key"},
		{http.MethodGet, "/api/internal/litellm/openai-keys/extra"},
		{http.MethodGet, "/api/internal/litellm/openai-keys/applied/extra"},
		// The neighbouring internal endpoint must never be swallowed.
		{http.MethodGet, "/api/internal/litellm/proxy-load-balancing"},
		// Unlisted methods on taken-over paths.
		{http.MethodPatch, "/api/system-settings/model-service"},
		{http.MethodHead, "/api/system-settings/model-service"},
		{http.MethodPost, "/api/system-settings/model-service"},
		{http.MethodPatch, "/api/system-settings/openai-keys"},
		{http.MethodHead, "/api/system-settings/openai-keys"},
		{http.MethodPut, "/api/system-settings/openai-keys/key/abc123"},
		{http.MethodGet, "/api/system-settings/openai-keys/key/abc123"},
		{http.MethodPost, "/api/internal/litellm/openai-keys"},
		{http.MethodGet, "/api/internal/litellm/openai-keys/applied"},
		// Other /api/system-settings domains owned by other batches.
		{http.MethodGet, "/api/system-settings/llm-gateways"},
		{http.MethodPut, "/api/system-settings/llm-gateways"},
		{http.MethodGet, "/api/system-settings/security"},
		{http.MethodGet, "/api/system-settings/vector-service"},
		{http.MethodGet, "/api/system-settings/email"},
		{http.MethodGet, "/api/system-settings/rss-diagnostics/overview"},
	}
}

// newModelAccessGateway builds a gateway with the model access rules in go mode.
func newModelAccessGateway(t *testing.T, mode string) *Gateway {
	t.Helper()
	rules := DefaultRules(ModeShadow, "")
	rules = WithModelAccessSettings(rules, mode)
	gateway, err := New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	return gateway
}

// TestModelAccessSettingsStaysLegacyByDefault proves an unset/legacy mode adds
// nothing.
func TestModelAccessSettingsStaysLegacyByDefault(t *testing.T) {
	for _, mode := range []string{"", "legacy"} {
		gateway := newModelAccessGateway(t, mode)
		for _, testCase := range modelAccessSettingsRoutes() {
			if got := gateway.match(testCase.method, testCase.path); got.Mode != ModeLegacy {
				t.Fatalf("%s %s mode=%s, want legacy for mode %q", testCase.method, testCase.path, got.Mode, mode)
			}
		}
	}
}

// TestModelAccessSettingsGoOwnsTenRoutes proves the exact ownership and the rule
// shape.
func TestModelAccessSettingsGoOwnsTenRoutes(t *testing.T) {
	gateway := newModelAccessGateway(t, string(ModeGo))
	routes := modelAccessSettingsRoutes()
	if len(routes) != 10 {
		t.Fatalf("the batch owns ten routes, the table lists %d", len(routes))
	}
	for _, testCase := range routes {
		got := gateway.match(testCase.method, testCase.path)
		if got.Mode != ModeGo {
			t.Fatalf("%s %s mode=%s, want go", testCase.method, testCase.path, got.Mode)
		}
		if got.HandlerKey != ModelAccessSettingsKey {
			t.Fatalf("%s %s key=%s, want %s", testCase.method, testCase.path, got.HandlerKey, ModelAccessSettingsKey)
		}
		switch testCase.shape {
		case "exact":
			if !got.Exact || got.OneSegment {
				t.Fatalf("%s %s must be an exact rule: %+v", testCase.method, testCase.path, got)
			}
		case "one":
			if got.Exact || !got.OneSegment {
				t.Fatalf("%s %s must be a one-segment rule: %+v", testCase.method, testCase.path, got)
			}
		}
	}
	// CORS preflight on the taken-over paths is answered by Go.
	for _, testCase := range routes {
		if got := gateway.match(http.MethodOptions, testCase.path); got.Mode != ModeGo {
			t.Fatalf("OPTIONS %s mode=%s, want go", testCase.path, got.Mode)
		}
	}
}

// TestModelAccessSettingsUnmigratedRoutesStayNest proves nothing else is captured.
func TestModelAccessSettingsUnmigratedRoutesStayNest(t *testing.T) {
	gateway := newModelAccessGateway(t, string(ModeGo))
	for _, testCase := range modelAccessSettingsNestRoutes() {
		if got := gateway.match(testCase.method, testCase.path); got.Mode != ModeLegacy {
			t.Fatalf("%s %s mode=%s, want legacy", testCase.method, testCase.path, got.Mode)
		}
	}
}

// TestModelAccessSettingsCoexistsWithRuntimeSettings proves the two switches do
// not steal each other's routes: they share the /api/system-settings prefix and
// the runtime settings handler key is the bare prefix.
func TestModelAccessSettingsCoexistsWithRuntimeSettings(t *testing.T) {
	rules := DefaultRules(ModeShadow, "")
	rules = WithRuntimeSettings(rules, string(ModeGo))
	rules = WithModelAccessSettings(rules, string(ModeGo))
	gateway, err := New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	for _, testCase := range modelAccessSettingsRoutes() {
		got := gateway.match(testCase.method, testCase.path)
		if got.Mode != ModeGo || got.HandlerKey != ModelAccessSettingsKey {
			t.Fatalf("%s %s resolved to mode=%s key=%s", testCase.method, testCase.path, got.Mode, got.HandlerKey)
		}
	}
	for _, testCase := range []struct{ method, path string }{
		{http.MethodGet, "/api/system-settings/rate-limits"},
		{http.MethodPut, "/api/system-settings/auth-cache"},
		{http.MethodGet, "/api/system-settings/newsnow-personalization/metrics"},
	} {
		got := gateway.match(testCase.method, testCase.path)
		if got.Mode != ModeGo || got.HandlerKey != RuntimeSettingsKey {
			t.Fatalf("%s %s resolved to mode=%s key=%s", testCase.method, testCase.path, got.Mode, got.HandlerKey)
		}
	}
	// The neighbouring internal endpoint keeps its legacy route.
	if got := gateway.match(http.MethodGet, "/api/internal/litellm/proxy-load-balancing"); got.Mode != ModeLegacy {
		t.Fatalf("proxy-load-balancing mode=%s, want legacy", got.Mode)
	}
}

// TestModelAccessSettingsHandlerKeyIsDistinct guards the registration key choice:
// the runtime settings handler is registered on the bare prefix, so a shared key
// would route model access requests into the wrong handler.
func TestModelAccessSettingsHandlerKeyIsDistinct(t *testing.T) {
	if ModelAccessSettingsKey == RuntimeSettingsKey {
		t.Fatalf("the model access handler key must differ from the runtime settings key")
	}
	if ModelAccessSettingsKey == "/api/system-settings" {
		t.Fatalf("the model access handler key must not be the bare settings prefix")
	}
}
