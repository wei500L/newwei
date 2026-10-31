package legacyproxy

import (
	"net/http"
	"testing"
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
// this batch. The profile CRUD routes, the LB configuration routes and every
// unknown longer path are included.
func llmGatewayOpsLegacyRoutes() []struct{ method, path string } {
	return []struct{ method, path string }{
		{http.MethodGet, llmGatewayOpsBase},
		{http.MethodPost, llmGatewayOpsBase},
		{http.MethodPut, llmGatewayOpsBase + "/active"},
		{http.MethodPut, llmGatewayOpsBase + "/embedding-active"},
		{http.MethodPut, llmGatewayOpsBase + "/rerank-active"},
		{http.MethodPut, llmGatewayOpsBase + "/profile-1"},
		{http.MethodDelete, llmGatewayOpsBase + "/profile-1"},
		{http.MethodGet, llmGatewayOpsBase + "/proxy-load-balancing"},
		{http.MethodPut, llmGatewayOpsBase + "/proxy-load-balancing"},
		{http.MethodDelete, llmGatewayOpsBase + "/proxy-load-balancing"},
		{http.MethodPost, llmGatewayOpsBase + "/proxy-governance"},
		{http.MethodDelete, llmGatewayOpsBase + "/proxy-governance/preflight"},
		{http.MethodGet, llmGatewayOpsBase + "/models-config"},
		{http.MethodGet, llmGatewayOpsBase + "/test-config"},
		{http.MethodDelete, llmGatewayOpsBase + "/profile-1/models"},
		{http.MethodGet, llmGatewayOpsBase + "/profile-1/unknown"},
		{http.MethodPost, llmGatewayOpsBase + "/profile-1/test/extra"},
		{http.MethodGet, llmGatewayOpsBase + "/profile-1/models/extra"},
		{http.MethodPost, llmGatewayOpsBase + "/proxy-governance/preflight/extra"},
		{http.MethodGet, llmGatewayOpsBase + "/profile-1/models/"},
	}
}

func TestLLMGatewayOpsGoOwnsRoutes(t *testing.T) {
	gateway := New(WithLLMGatewayOps(BaseRules()))
	for _, tc := range llmGatewayOpsGoRoutes() {
		rule, matched := gateway.matchRule(tc.method, tc.path)
		if !matched {
			t.Fatalf("%s %s matched nothing", tc.method, tc.path)
		}
		if rule.HandlerKey != LLMGatewayOpsKey {
			t.Fatalf("%s %s key=%q, want %q", tc.method, tc.path, rule.HandlerKey, LLMGatewayOpsKey)
		}
	}
	// The three governance verbs are one exact rule, so a PUT can never be read
	// as a profile id.
	governance, _ := gateway.matchRule(http.MethodPut, llmGatewayOpsBase+"/proxy-governance")
	if !governance.Exact || governance.OneSegment {
		t.Fatalf("PUT /proxy-governance rule=%+v, want exact", governance)
	}
	// The five sub-resources are one extra segment behind a fixed tail.
	models, _ := gateway.matchRule(http.MethodGet, llmGatewayOpsBase+"/profile-1/models")
	if !models.OneSegment || models.Exact || models.Tail != "/models" {
		t.Fatalf("GET :id/models rule=%+v, want one-segment with the /models tail", models)
	}
	for _, path := range []string{
		llmGatewayOpsBase + "/proxy-governance",
		llmGatewayOpsBase + "/models-config",
		llmGatewayOpsBase + "/profile-1/test",
	} {
		if rule, matched := gateway.matchRule(http.MethodOptions, path); !matched || rule.HandlerKey != LLMGatewayOpsKey {
			t.Fatalf("OPTIONS %s rule=%+v matched=%v, want go", path, rule, matched)
		}
	}
}

func TestLLMGatewayOpsDoesNotClaimProfileOrLBRoutes(t *testing.T) {
	gateway := New(WithLLMGatewayOps(BaseRules()))
	for _, tc := range llmGatewayOpsLegacyRoutes() {
		if rule, matched := gateway.matchRule(tc.method, tc.path); matched {
			t.Fatalf("%s %s unexpectedly matched %q", tc.method, tc.path, rule.Prefix)
		}
	}
}

func TestLLMGatewayOpsWinsOverTheProfileDynamicRule(t *testing.T) {
	// Both builders present: the exact governance paths and the deeper
	// sub-resources must resolve to the ops handler, while the profile CRUD
	// routes keep the profiles handler.
	gateway := New(WithLLMGatewayOps(WithLLMGatewayProfiles(BaseRules())))
	for _, tc := range llmGatewayOpsGoRoutes() {
		rule, matched := gateway.matchRule(tc.method, tc.path)
		if !matched || rule.HandlerKey != LLMGatewayOpsKey {
			t.Fatalf("%s %s rule=%+v matched=%v, want the ops key", tc.method, tc.path, rule, matched)
		}
	}
	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, llmGatewayOpsBase},
		{http.MethodPost, llmGatewayOpsBase},
		{http.MethodPut, llmGatewayOpsBase + "/active"},
		{http.MethodPut, llmGatewayOpsBase + "/profile-1"},
		{http.MethodDelete, llmGatewayOpsBase + "/profile-1"},
	} {
		rule, matched := gateway.matchRule(tc.method, tc.path)
		if !matched || rule.HandlerKey != LLMGatewayProfilesKey {
			t.Fatalf("%s %s rule=%+v matched=%v, want the profiles key", tc.method, tc.path, rule, matched)
		}
	}
}
