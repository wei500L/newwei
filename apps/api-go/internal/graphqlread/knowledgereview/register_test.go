package knowledgereview

import (
	"testing"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/exec"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/schema"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/settingscrawl"
)

// TestReviewMutationPlansToExecuteOnlyWhenRegistered pins the write-only
// wiring: the mutation is legacy until it is registered, a document mixing it
// with an unregistered mutation falls back as a whole before any write side
// effect, and registering the mutation plus its models takes over no query.
func TestReviewMutationPlansToExecuteOnlyWhenRegistered(t *testing.T) {
	loaded, err := schema.Load()
	if err != nil {
		t.Fatal(err)
	}
	reg := contract.NewRegistry()
	engine := exec.New(loaded, reg, 8, 2000, nil)

	const review = `mutation { reviewKnowledgeGraphEvidence(input: {evidenceId: "e1", status: "approved"}) { id confidence extractorVersion createdAt evidence edge { id type weight confidence properties fromEntity { id name type properties } toEntity { id } } article { id url title summary language crawlAt } } }`
	if got := engine.PlanDocument(review, nil, nil); got.Kind != exec.KindProtocol {
		t.Fatalf("unregistered mutation kind %s body %s", got.Kind, got.Result.Body)
	}

	// This is exactly the write-only wiring: the shared models are registered
	// without settingscrawl.Register, so no read root is taken over.
	settingscrawl.RegisterReviewModelTypes(reg)
	Register(reg, nil, nil, Options{})
	engine = exec.New(loaded, reg, 8, 2000, nil)

	if got := engine.PlanDocument(review, nil, nil); got.Kind != exec.KindExecute {
		t.Fatalf("registered mutation kind %s body %s", got.Kind, got.Result.Body)
	}

	for _, doc := range []string{
		// A sibling mutation the Go executor does not own forces the whole
		// document back to NestJS before the review resolver can run.
		`mutation { reviewKnowledgeGraphEvidence(input: {evidenceId: "e1", status: "approved"}) { id } createOrg(input: { name: "n", slug: "s" }) { id } }`,
		// The queue root stays owned by the read switches.
		`query { knowledgeGraphEvidenceReviewQueue(limit: 5) { id } }`,
		// The knowledge-graph settings read root is not widened either.
		`query { knowledgeGraphSettings { enabled } }`,
	} {
		if got := engine.PlanDocument(doc, nil, nil); got.Kind != exec.KindProtocol {
			t.Fatalf("%s kind %s body %s", doc, got.Kind, got.Result.Body)
		}
	}
}

// TestReviewMutationRegistersEitherPermission pins the OR permission gate.
func TestReviewMutationRegistersEitherPermission(t *testing.T) {
	reg := contract.NewRegistry()
	settingscrawl.RegisterReviewModelTypes(reg)
	Register(reg, nil, nil, Options{})

	root, ok := reg.Mutation("reviewKnowledgeGraphEvidence")
	if !ok {
		t.Fatal("mutation not registered")
	}
	if len(root.AnyPermissions) != 2 || root.AnyPermissions[0] != "settings.manage" || root.AnyPermissions[1] != "knowledgegraph.review" {
		t.Fatalf("permissions = %v", root.AnyPermissions)
	}
	if root.Permission != "" {
		t.Fatalf("single permission must stay empty, got %q", root.Permission)
	}
}

// TestRegisterReviewModelTypesIsIdempotent pins that the write-only path can
// register the models after the read path already did.
func TestRegisterReviewModelTypesIsIdempotent(t *testing.T) {
	reg := contract.NewRegistry()
	settingscrawl.RegisterReviewModelTypes(reg)
	settingscrawl.RegisterReviewModelTypes(reg)
	for _, name := range []string{
		"KnowledgeGraphEvidenceReviewItemModel",
		"KnowledgeGraphReviewEdgeModel",
		"KnowledgeGraphReviewArticleModel",
		"KnowledgeGraphNodeModel",
	} {
		if !reg.HasType(name) {
			t.Fatalf("type %s not registered", name)
		}
	}
}
