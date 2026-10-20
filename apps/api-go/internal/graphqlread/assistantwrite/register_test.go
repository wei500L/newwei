package assistantwrite

import (
	"testing"

	"github.com/wei500L/newwei/apps/api-go/internal/assistantruns"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/history"
)

// TestRegisterUsesSharedAssistantRunModel pins the one-registration contract:
// the write batch must not register AssistantRunModel itself, so a caller that
// already registered the history models (the read batch or the workspace write
// batch) does not panic on a duplicate.
func TestRegisterUsesSharedAssistantRunModel(t *testing.T) {
	reg := contract.NewRegistry()
	Register(reg, &assistantruns.Service{})
	for _, name := range RegisteredMutations {
		root, ok := reg.Mutation(name)
		if !ok {
			t.Fatalf("mutation %s is not registered", name)
		}
		if root.Permission != "assistant.run" {
			t.Fatalf("mutation %s permission = %q", name, root.Permission)
		}
	}
	if reg.HasType("AssistantRunModel") {
		t.Fatal("assistantwrite must not register AssistantRunModel itself")
	}
	history.RegisterModels(reg)
	if !reg.HasType("AssistantRunModel") {
		t.Fatal("history.RegisterModels did not register AssistantRunModel")
	}
	if _, ok := reg.Mutation("deleteAssistantRun"); !ok {
		t.Fatal("deleteAssistantRun is missing")
	}
}
