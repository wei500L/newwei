package kgimpact

import (
	"testing"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/exec"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/schema"
)

const kgImpactRootsQuery = `query {
  getExecutiveChangeImpact(input: { companyName: "Acme" }) { scenario generatedAt }
  getCommodityMoveImpact(input: { commodityName: "Gold" }) { scenario }
  getPolicyEventImpact(input: { policyName: "Rate cut" }) { scenario }
  getEntityImpactGraph { nodes { id name } links { source target type value } metadata { totalNodes totalLinks } }
}`

// API_GO_GRAPHQL_KG_IMPACT_MODE=legacy: no roots are registered, so any
// document containing them is proxied to NestJS as a whole.
func TestKgImpactRootsStayLegacyWhenUnregistered(t *testing.T) {
	loaded, err := schema.Load()
	if err != nil {
		t.Fatal(err)
	}
	engine := exec.New(loaded, contract.NewRegistry(), 8, 2000, nil)
	if got := engine.PlanDocument(kgImpactRootsQuery, nil, nil); got.Kind != exec.KindProtocol {
		t.Fatalf("legacy mode kind = %s", got.Kind)
	}
}

// API_GO_GRAPHQL_KG_IMPACT_MODE=go: the four roots run in Go. Mixing an
// unregistered root keeps the whole document on NestJS.
func TestKgImpactRootsExecuteWhenRegistered(t *testing.T) {
	loaded, err := schema.Load()
	if err != nil {
		t.Fatal(err)
	}
	reg := contract.NewRegistry()
	Register(reg, nil, nil, nil)
	engine := exec.New(loaded, reg, 8, 2000, nil)
	if got := engine.PlanDocument(kgImpactRootsQuery, nil, nil); got.Kind != exec.KindExecute {
		t.Fatalf("go mode kind = %s body %s", got.Kind, got.Result.Body)
	}
	mixed := engine.PlanDocument(`query { getExecutiveChangeImpact(input: { companyName: "Acme" }) { scenario } knowledgeGraphEvidenceReviewQueue { id } }`, nil, nil)
	if mixed.Kind != exec.KindProtocol {
		t.Fatalf("mixed document kind = %s", mixed.Kind)
	}
}
