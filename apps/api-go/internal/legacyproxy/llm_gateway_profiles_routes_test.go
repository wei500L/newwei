package legacyproxy

import (
	"net/http"
	"testing"
)

// llmGatewayProfilesBase is the prefix of the seven migrated routes.
const llmGatewayProfilesBase = "/api/system-settings/llm-gateways"

// llmGatewayProfilesGoRoutes are the seven route/method pairs this batch owns.
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
// claimed by this batch. The unmigrated static paths are included because their
// shape matches the dynamic :id rule.
func llmGatewayProfilesLegacyRoutes() []struct{ method, path string } {
	return []struct{ method, path string }{
		{http.MethodPut, llmGatewayProfilesBase},
		{http.MethodDelete, llmGatewayProfilesBase},
		{http.MethodGet, llmGatewayProfilesBase + "/profile-1"},
		{http.MethodPost, llmGatewayProfilesBase + "/profile-1"},
		{http.MethodPatch, llmGatewayProfilesBase + "/profile-1"},
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
		{http.MethodPut, llmGatewayProfilesBase + "/"},
		{http.MethodDelete, llmGatewayProfilesBase + "/"},
		{http.MethodPut, llmGatewayProfilesBase + "/profile-1/"},
		{http.MethodDelete, llmGatewayProfilesBase + "/profile-1/"},
	}
}

func TestLLMGatewayProfilesGoOwnsRoutes(t *testing.T) {
	gateway := New(WithLLMGatewayProfiles(BaseRules()))
	for _, tc := range llmGatewayProfilesGoRoutes() {
		rule, matched := gateway.matchRule(tc.method, tc.path)
		if !matched || rule.HandlerKey != LLMGatewayProfilesKey {
			t.Fatalf("%s %s rule=%+v matched=%v, want %q", tc.method, tc.path, rule, matched, LLMGatewayProfilesKey)
		}
	}

	// The collection is an exact rule for GET/POST, and the three activation
	// paths are exact rules for PUT that must win over the dynamic rule they
	// prefix. PUT on the collection itself is not a route at all.
	if collectionRule, _ := gateway.matchRule(http.MethodGet, llmGatewayProfilesBase); !collectionRule.Exact || collectionRule.OneSegment {
		t.Fatalf("GET collection rule=%+v, want exact", collectionRule)
	}
	if postRule, _ := gateway.matchRule(http.MethodPost, llmGatewayProfilesBase); !postRule.Exact || postRule.OneSegment {
		t.Fatalf("POST collection rule=%+v, want exact", postRule)
	}
	if _, matched := gateway.matchRule(http.MethodPut, llmGatewayProfilesBase); matched {
		t.Fatalf("PUT collection unexpectedly matched")
	}
	for _, path := range []string{
		llmGatewayProfilesBase + "/active",
		llmGatewayProfilesBase + "/embedding-active",
		llmGatewayProfilesBase + "/rerank-active",
	} {
		rule, moved := gateway.matchRule(http.MethodPut, path)
		if !moved || !rule.Exact || rule.OneSegment {
			t.Fatalf("PUT %s rule=%+v matched=%v, want exact", path, rule, moved)
		}
	}
	// :id is exactly one segment, without a tail.
	idRule, _ := gateway.matchRule(http.MethodPut, llmGatewayProfilesBase+"/profile-1")
	if !idRule.OneSegment || idRule.Exact || idRule.Tail != "" || idRule.TailSegment {
		t.Fatalf("PUT :id rule=%+v, want one-segment without tail", idRule)
	}

	// Preflight OPTIONS for the owned paths is answered by the Go handler.
	for _, path := range []string{
		llmGatewayProfilesBase,
		llmGatewayProfilesBase + "/active",
		llmGatewayProfilesBase + "/profile-1",
	} {
		if rule, matched := gateway.matchRule(http.MethodOptions, path); !matched || rule.HandlerKey != LLMGatewayProfilesKey {
			t.Fatalf("OPTIONS %s rule=%+v matched=%v, want go", path, rule, matched)
		}
	}
}

func TestLLMGatewayProfilesLongerPathsAndMethodsStayLegacy(t *testing.T) {
	gateway := New(WithLLMGatewayProfiles(BaseRules()))
	for _, tc := range llmGatewayProfilesLegacyRoutes() {
		if rule, matched := gateway.matchRule(tc.method, tc.path); matched {
			t.Fatalf("%s %s unexpectedly matched %q", tc.method, tc.path, rule.Prefix)
		}
	}
}

func TestLLMGatewayProfilesCoexistsWithOtherModes(t *testing.T) {
	gateway := New(WithLLMGatewayProfiles(WithRuntimeSettings(BaseRules())))

	// The runtime-settings unit keeps its own key and routes.
	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/api/system-settings/rate-limits"},
		{http.MethodPut, "/api/system-settings/auth-cache"},
		{http.MethodGet, "/api/system-settings/rate-limit-policies/unknown"},
	} {
		rule, matched := gateway.matchRule(tc.method, tc.path)
		if !matched || rule.HandlerKey != RuntimeSettingsKey {
			t.Fatalf("%s %s rule=%+v matched=%v, want the runtime settings key", tc.method, tc.path, rule, matched)
		}
	}

	// llm-gateways paths keep the profiles key.
	for _, tc := range llmGatewayProfilesGoRoutes() {
		rule, matched := gateway.matchRule(tc.method, tc.path)
		if !matched || rule.HandlerKey != LLMGatewayProfilesKey {
			t.Fatalf("%s %s rule=%+v matched=%v, want the llm gateway profiles key", tc.method, tc.path, rule, matched)
		}
	}

	// Every other /api/system-settings path is not claimed.
	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/api/system-settings/security"},
		{http.MethodPut, "/api/system-settings/security"},
		{http.MethodGet, llmGatewayProfilesBase + "/proxy-governance"},
	} {
		if rule, matched := gateway.matchRule(tc.method, tc.path); matched {
			t.Fatalf("%s %s unexpectedly matched %q", tc.method, tc.path, rule.Prefix)
		}
	}
}
